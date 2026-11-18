/**
 * Task Hub の自律実行の安全（2026-11-18）：1 回の回しの時間の予算・Dropbox の障害を Task Hub 全体に広げない機能ごとの回路遮断・承認待ちが他の task を止めない。
 * 実の Dropbox・資格情報には接続しない（handler は作り物）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runOnce, GROUP_COOLDOWN_MS } from '../scripts/lib/task-hub/runner.mjs';
import { HANDLERS } from '../scripts/lib/task-hub/handlers.mjs';
import { fail } from '../scripts/lib/task-hub/handler-error.mjs';
import { submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { buildBrief } from '../scripts/lib/runtime-brief.mjs';
import { taskHubWorkItems } from '../scripts/lib/task-hub/audit-watch.mjs';
import { NOW, envelope, makeEnv } from './task-hub-helpers.mjs';

const submit = (env, over = {}) => submitLocal(envelope(over), { store: env.store, policy: env.policy, now: env.clock.t });
const run = (env, over = {}) => runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => env.clock.t, ...over });
const cleanup = (env) => rmSync(env.root, { recursive: true, force: true });
const note = (env, i = 0) => submit(env, { intent: 'note.record', params: { text: `memo ${i}` } });
const dbx = (env, i = 0) => submit(env, { intent: 'dropbox.list', params: { path: `/業務/現場${i}` } });
/** note.record を、決まった時間（作り物の時計）を使う handler にする */
const slow = (env, ms) => ({ ...HANDLERS, 'note.record': { resumable: false, run: async () => { env.clock.t += ms; return { result: { recorded: true } }; } } });
const dropboxWith = (impl) => ({ ...HANDLERS, 'dropbox.list': { resumable: true, group: 'dropbox', run: impl } });

test('時間の予算：次の task の timeout ＋猶予が残りに入らなければ始めず queued のまま次の回へ・最初の 1 件は予算より長くても必ず走る', async () => {
  const env = makeEnv();
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push((await note(env, i)).task_id);
  // note.record の timeout は 10 秒＋猶予 5 秒。1 件が 12 秒かかる＝予算 20 秒では 1 件走ると、次の 15 秒が入らない
  const out = await run(env, { handlers: slow(env, 12_000), budgetMs: 20_000 });
  assert.deepEqual([out.ran.length, out.deferred], [1, 3]);
  assert.deepEqual(env.store.listTasks({ state: 'queued' }).length, 3, '先送りは失敗ではない・queued のまま');
  const next = await run(env, { handlers: slow(env, 12_000), budgetMs: 30_000 });
  assert.deepEqual([next.ran.length, next.deferred], [2, 1], '30 秒の予算＝12 秒の後（15 秒が入る）・24 秒の後は残り 6 秒で 15 秒が入らず先送り');
  assert.deepEqual(env.store.listTasks({ state: 'queued' }).length, 1);
  const tiny = await run(env, { handlers: slow(env, 1_000), budgetMs: 1_000 });
  assert.deepEqual([tiny.ran.length, tiny.deferred], [1, 0], '予算が task の timeout より短くても、最初の 1 件は走る（永久に走れない task を作らない）');
  assert.equal(env.store.listTasks({ state: 'succeeded' }).length, 4);
  // 予算の指定が無ければ今までどおり全部走る
  const env2 = makeEnv();
  for (let i = 0; i < 3; i += 1) await note(env2, i);
  const all = await run(env2, { handlers: slow(env2, 12_000) });
  assert.deepEqual([all.ran.length, all.deferred], [3, 0]);
  cleanup(env);
  cleanup(env2);
});

test('機能ごとの回路遮断：Dropbox の資格情報・障害が続いても Task Hub 全体は PAUSE にならず、Dropbox の task だけ一時止める（他の機能は走る）', async () => {
  const env = makeEnv();
  const d = [];
  for (let i = 0; i < 5; i += 1) d.push((await dbx(env, i)).task_id);
  const n = (await note(env)).task_id;
  const calls = { n: 0 };
  const handlers = dropboxWith(async () => { calls.n += 1; throw fail('dropbox_auth'); });
  const out = await run(env, { handlers });
  assert.equal(calls.n, 3, '想定外の失敗が 3 回続いた所で、その機能を止める');
  assert.equal(out.paused, false);
  assert.equal(env.store.isPaused(), false, 'Task Hub 全体の PAUSE にしない');
  assert.deepEqual(out.group_suspended, ['dropbox']);
  const tasks = d.map((id) => env.store.readTask(id));
  assert.deepEqual(tasks.map((t) => t.state), ['failed', 'failed', 'failed', 'failed', 'failed']);
  const codes = tasks.map((t) => t.error?.code ?? t.code).sort();
  assert.deepEqual(codes, ['dropbox_auth', 'dropbox_auth', 'dropbox_auth', 'dropbox_suspended', 'dropbox_suspended'], '3 回失敗して止まり、止めている間の task は handler を呼ばずに返す');
  assert.equal(env.store.readTask(n).state, 'succeeded', '他の機能（メモ）は走る');
  assert.equal(env.store.breakerCount(), 0, '全体の連続回数には数えない');
  const gb = env.store.groupBreaker('dropbox');
  assert.deepEqual([gb.count, Date.parse(gb.until) - env.clock.t >= GROUP_COOLDOWN_MS - 5_000], [2, true], '開いた時は limit-1＝期間の後に試す 1 件が失敗すればすぐ開き直す');
  // 期間の途中：新しい task も handler を呼ばずに返す
  env.clock.t += 5 * 60_000;
  const mid = (await dbx(env, 9)).task_id;
  await run(env, { handlers });
  assert.deepEqual([env.store.readTask(mid).state, calls.n], ['failed', 3]);
  // 期間が過ぎた次の 1 件は試される：成功すれば止めていた印は消える
  env.clock.t += GROUP_COOLDOWN_MS;
  const after = (await dbx(env, 10)).task_id;
  await run(env, { handlers: dropboxWith(async () => ({ result: { ok: true } })) });
  assert.equal(env.store.readTask(after).state, 'succeeded');
  assert.deepEqual(env.store.groupBreaker('dropbox'), { count: 0, until: null, last: null });
  cleanup(env);
});

test('機能ごとの回路遮断：Dropbox が動いた時だけその数えを戻す・想定内の失敗（範囲の外）は数えない・他の機能の失敗は今までどおり全体の PAUSE', async () => {
  const env = makeEnv();
  for (let i = 0; i < 4; i += 1) await dbx(env, i);
  let k = 0;
  const handlers = dropboxWith(async () => { k += 1; if (k === 3) return { result: { ok: true } }; throw fail(k <= 2 ? 'dropbox_unavailable' : 'dropbox_path_not_allowed', { expected: k > 3 }); });
  const out = await run(env, { handlers });
  assert.deepEqual(out.ran.map((x) => x.state), ['failed', 'failed', 'succeeded', 'failed']);
  assert.deepEqual(env.store.groupBreaker('dropbox'), { count: 0, until: null, last: null }, '2 回の失敗の後に成功＝数えが戻る（想定内の 4 回目は数えない）');
  assert.equal(out.group_suspended, undefined);
  // 他の機能（グループ無し）の想定外の失敗が 3 回続けば、今までどおり全体の PAUSE
  for (let i = 0; i < 3; i += 1) await note(env, i);
  const boom = { ...HANDLERS, 'note.record': { resumable: false, run: () => { throw fail('boom'); } } };
  const o2 = await run(env, { handlers: boom });
  assert.deepEqual([o2.paused, env.store.pauseCode()], [true, 'circuit_open']);
  cleanup(env);
});

test('機能ごとの回路遮断：止めている間、Human が承認した task は失敗にせず先送り（承認を無駄にしない）・期間の後に走る', async () => {
  const env = makeEnv();
  const approval = await import('../scripts/lib/task-hub/approval.mjs');
  const params = { original_path: '/業務/見積書の原本/現場A_見積書.xlsx', sheet_name: 'AI_案1', title: 'テスト', rows: [{ item: '足場', qty: 1, price: 1 }] };
  const est = (await submit(env, { intent: 'estimate.ai.create', params })).task_id;
  assert.equal(env.store.readTask(est).state, 'awaiting_approval');
  approval.approve(env.store, est, { confirm: env.store.readTask(est).content_digest.slice(0, 12), isTTY: true, now: env.clock.t });
  const read = (await dbx(env, 1)).task_id;
  env.store.setGroupBreaker('dropbox', { count: 0, until: new Date(env.clock.t + 10 * 60_000).toISOString() });
  let ran = 0;
  const handlers = { ...HANDLERS, 'dropbox.list': { resumable: true, group: 'dropbox', run: async () => { ran += 1; return { result: { ok: true } }; } }, 'estimate.ai.create': { resumable: true, group: 'dropbox', run: async () => { ran += 1; return { result: { created: true } }; } } };
  const out = await run(env, { handlers });
  assert.deepEqual([env.store.readTask(est).state, env.store.readTask(read).state, ran, out.deferred], ['queued', 'failed', 0, 1], '承認済みは queued のまま・読む依頼は理由を返す');
  assert.equal(env.store.readTask(read).error?.code ?? env.store.readTask(read).code, 'dropbox_suspended');
  env.clock.t += 11 * 60_000;
  const later = await run(env, { handlers });
  assert.deepEqual([env.store.readTask(est).state, ran, later.deferred], ['succeeded', 1, 0], '期間の後に走る');
  cleanup(env);
});

test('承認待ちは他の task を止めない：承認待ちの task があっても queued の task は走り、承認待ちは承認されるまで動かない', async () => {
  const env = makeEnv();
  const wait = await submit(env, { intent: 'hermes.task', params: { title: '承認待ち', body: '本文' } });
  assert.equal(env.store.readTask(wait.task_id).state, 'awaiting_approval');
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await note(env, i)).task_id);
  const out = await run(env);
  assert.deepEqual(out.ran.map((x) => x.state), ['succeeded', 'succeeded', 'succeeded']);
  assert.equal(env.store.readTask(wait.task_id).state, 'awaiting_approval');
  assert.equal(out.deferred, 0);
  cleanup(env);
});

test('status.query の detail：止めている機能の名前だけ返す（期間を過ぎれば出ない）', async () => {
  const env = makeEnv();
  const items = [{ id: 'disk_free_gib', level: 'ok', value: 90, kind: 'state' }];
  const state = { last_success_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), observed: { disk_free_gib: 'ok' }, items: { disk_free_gib: { level: 'ok', since: '2026-11-08T00:00:00.000Z' } } };
  const file = path.join(env.root, 'brief.json');
  writeFileSync(file, JSON.stringify(buildBrief(state, { items, now: new Date(NOW) })));
  env.config.brief_path = file;
  const ask = async () => { const r = await submit(env, { intent: 'status.query', params: { detail: true } }); await run(env); return env.store.readTask(r.task_id).result; };
  assert.equal((await ask()).suspended, undefined, '普段は出ない');
  env.store.setGroupBreaker('dropbox', { count: 0, until: new Date(env.clock.t + 600_000).toISOString() });
  assert.deepEqual((await ask()).suspended, ['dropbox']);
  env.clock.t += 700_000;
  assert.equal((await ask()).suspended, undefined, '期間を過ぎれば出ない');
  assert.throws(() => env.store.setGroupBreaker('Bad/Name', { count: 1 }), { code: 'bad_group' });
  assert.deepEqual(env.store.groupBreaker('Bad/Name'), { count: 0, until: null, last: null });
  cleanup(env);
});

test('機能ごとの回路遮断：期間の後に試すのは 1 件だけ（失敗すればすぐ開き直す）・同じ task の再試行は 1 回に数える・再試行の途中の task は失敗にせず先送り', async () => {
  const env = makeEnv();
  // 3 つの別々の task が失敗して開く
  for (let i = 0; i < 3; i += 1) await dbx(env, i);
  let calls = 0;
  const bad = dropboxWith(async () => { calls += 1; throw fail('dropbox_auth'); });
  await run(env, { handlers: bad });
  assert.equal(calls, 3);
  assert.equal(env.store.groupBreaker('dropbox').count, 2);
  // 期間の後：5 件が待っていても、試すのは 1 件（失敗でまた開く）
  env.clock.t += GROUP_COOLDOWN_MS + 1_000;
  for (let i = 10; i < 15; i += 1) await dbx(env, i);
  calls = 0;
  const probe = await run(env, { handlers: bad });
  assert.equal(calls, 1, '試すのは 1 件だけ');
  assert.deepEqual(probe.group_suspended, ['dropbox']);
  assert.equal(env.store.listTasks({ state: 'failed' }).filter((t) => (t.error?.code ?? t.code) === 'dropbox_suspended').length, 4, '残りの 4 件は handler を呼ばずに返った');
  cleanup(env);

  // 1 つの変な依頼が 3 回（再試行）失敗しても、1 回に数える＝別の健全な依頼を止めない
  const env2 = makeEnv();
  const poison = (await dbx(env2, 1)).task_id;
  const retryable = dropboxWith(async () => { throw fail('dropbox_unavailable', { retryable: true }); });
  for (let i = 0; i < 3; i += 1) { await run(env2, { handlers: retryable }); env2.clock.t += 3_700_000; }
  assert.equal(env2.store.readTask(poison).state, 'failed');
  assert.equal(env2.store.groupBreaker('dropbox').count, 1, '3 回の試行は 1 回');
  const healthy = (await dbx(env2, 2)).task_id;
  await run(env2, { handlers: dropboxWith(async () => ({ result: { ok: true } })) });
  assert.equal(env2.store.readTask(healthy).state, 'succeeded');
  cleanup(env2);

  // 止めている間、再試行の途中（retry_wait）の task は失敗にしない
  const env3 = makeEnv();
  const t3 = (await dbx(env3, 1)).task_id;
  await run(env3, { handlers: retryable });
  assert.equal(env3.store.readTask(t3).state, 'retry_wait');
  env3.store.setGroupBreaker('dropbox', { count: 2, until: new Date(env3.clock.t + 20 * 60_000).toISOString(), last: null });
  env3.clock.t += 3_700_000 - 20 * 60_000 + 60_000;
  env3.store.setGroupBreaker('dropbox', { count: 2, until: new Date(env3.clock.t + 5 * 60_000).toISOString(), last: null });
  const out = await run(env3, { handlers: dropboxWith(async () => ({ result: { ok: true } })) });
  assert.deepEqual([env3.store.readTask(t3).state, out.deferred], ['retry_wait', 1], '回数の残る task は先送り');
  assert.equal(env3.store.readTask(t3).attempts, 1);
  cleanup(env3);
});

test('機能ごとの回路遮断：止めている機能の承認済みの task が maxTasks の枠を使い切らない・壊れた期限で永久には止まらない', async () => {
  const env = makeEnv();
  const approval = await import('../scripts/lib/task-hub/approval.mjs');
  for (let i = 0; i < 5; i += 1) {
    const e = (await submit(env, { intent: 'estimate.ai.create', params: { original_path: `/業務/見積書の原本/現場${i}_見積書.xlsx`, sheet_name: 'AI_案1', title: `テスト${i}`, rows: [{ item: '足場', qty: 1, price: 1 }] } })).task_id;
    approval.approve(env.store, e, { confirm: env.store.readTask(e).content_digest.slice(0, 12), isTTY: true, now: env.clock.t });
  }
  const n = (await note(env)).task_id;
  env.store.setGroupBreaker('dropbox', { count: 0, until: new Date(env.clock.t + 10 * 60_000).toISOString() });
  const handlers = { ...HANDLERS, 'estimate.ai.create': { resumable: true, group: 'dropbox', run: async () => ({ result: { created: true } }) } };
  const out = await run(env, { handlers, maxTasks: 5 });
  assert.equal(env.store.readTask(n).state, 'succeeded', '承認済みの 5 件が先頭に居座っても、他の機能の task は走る');
  assert.equal(out.deferred, 5);
  // 期限が「今＋期間」より先（壊れた印・時計の飛び）は止めない
  env.store.setGroupBreaker('dropbox', { count: 0, until: new Date(env.clock.t + 10 * 86_400_000).toISOString() });
  const out2 = await run(env, { handlers, maxTasks: 5 });
  assert.equal(out2.deferred, 0);
  assert.equal(env.store.listTasks({ state: 'succeeded' }).length, 6, '壊れた期限では止めず、承認済みの task も走る');
  cleanup(env);
});

test('CLI：--budget は秒（1〜999）・誤りは断る', async () => {
  const { parse, validate } = await import('../scripts/task-hub.mjs');
  assert.deepEqual(validate(parse(['run', '--budget', '90'])), []);
  for (const bad of ['0', '1.5', 'abc', '1000']) assert.ok(validate(parse(['run', '--budget', bad])).some((m) => /--budget/.test(m)), `誤り：${bad}`);
  assert.throws(() => parse(['run', '--budget']), /needs a value/);
});

test('見張り：Dropbox の機能の停止の印があれば host-health の task_hub_queue が suspended（24 時間以内）・無い／古い印・壊れた印は ok', async () => {
  const env = makeEnv();
  const q = (now) => taskHubWorkItems(env.store.dir, now).find((i) => i.id === 'task_hub_queue');
  assert.deepEqual([q(env.clock.t).level, q(env.clock.t).value], ['ok', 'ok']);
  env.store.setGroupBreaker('dropbox', { count: 2, until: new Date(env.clock.t + 600_000).toISOString(), last: 't-20261118000000-abcd1234' });
  assert.deepEqual([q(env.clock.t).level, q(env.clock.t).value], ['warn', 'suspended'], '止めている間');
  assert.equal(q(env.clock.t + 20 * 3_600_000).value, 'suspended', '期間が過ぎても、回復の印（成功）が無い間は 24 時間まで');
  assert.equal(q(env.clock.t + 25 * 3_600_000).value, 'ok', '24 時間より古い印は出さない');
  writeFileSync(env.store.path('breaker-dropbox.json'), '{broken');
  assert.equal(q(env.clock.t).value, 'ok', '壊れた印は止めていない扱い');
  cleanup(env);
});

