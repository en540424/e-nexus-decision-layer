/**
 * Task Hub の読むだけの見方（2026-11-13・MA-24）：status.query の detail・task.status の view と Hermes の結果・朝のまとめの稼働状況と Hermes と
 * 予定に関係するメモ。依頼元（source）と business の境を越えないこと。合成の id だけ・通信なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { startJob } from '../scripts/lib/task-hub/hermes-jobs.mjs';
import { collectHermesResults } from '../scripts/lib/task-hub/hermes-results.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const cleanup = (env) => rmSync(env.root, { recursive: true, force: true });
const brief = (over = {}) => ({
  schema: 'runtime-brief/v1', generated_at: '2026-11-09T08:50:00.000Z', source_updated_at: '2026-11-09T08:50:00.000Z', valid_until: '2026-11-09T10:20:00.000Z', monitor: 'running', overall: 'ok',
  counts: { open: 0, human: 0, ai: 0, auto: 0 },
  sections: { host: { level: 'ok', not_ok: 0 }, hermes: { level: 'ok', not_ok: 0 }, jobs: { level: 'ok', not_ok: 0 }, repos: { level: 'ok', not_ok: 0 }, github: { level: 'ok', not_ok: 0, repos: 6, ci_failing: 0, token_days_left: 82 }, backup: { level: 'ok', not_ok: 0, age_days: 2, restore_age_days: 9, failing: false, history: 'history_ok', token_days_left: 82 }, heartbeat: { state: 'sent' }, notify: { state: 'ok' }, relay: { outbox: 0, unacked: 0 } },
  open_items: [],
  ...over,
});

async function setup() {
  const env = makeEnv();
  const briefPath = path.join(env.root, 'brief.json');
  writeFileSync(briefPath, JSON.stringify(brief()));
  const inbox = path.join(env.root, 'h-inbox');
  const outbox = path.join(env.root, 'h-outbox');
  mkdirSync(inbox, { mode: 0o700 });
  mkdirSync(outbox, { mode: 0o700 });
  const config = { ...env.config, brief_path: briefPath, hermes_inbox: inbox, hermes_outbox: outbox, utc_offset_minutes: 540 };
  const policy = { ...env.policy, config };
  const fromBot = async (e, opts) => { dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(e, opts)); const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy }); return r; };
  const run = () => runOnce({ store: env.store, policy, handlers: env.handlers, now: () => env.tick(10) });
  const resultOf = (id) => env.store.readTask(id).result;
  return { env, config, policy, fromBot, run, resultOf, outbox };
}

test('status.query：detail が無ければ今までと同じ形。detail は区分の水準だけ（文・日数・値・項目の理由は返さない）と business の件数', async () => {
  const { env, fromBot, run, resultOf } = await setup();
  const a = await fromBot(envelope({ intent: 'status.query' }));
  const b = await fromBot(envelope({ intent: 'status.query', params: { detail: true } }));
  await fromBot(envelope({ intent: 'hermes.task', params: { title: 't', body: 'b' } })); // 承認待ちを 1 件
  writeFileSync(env.store.path('cycle-last.json'), JSON.stringify({ at: '2026-11-09T08:55:00.000Z', code: 'ok', failed: [] }));
  await run();
  assert.deepEqual(Object.keys(resultOf(a.task_id)).sort(), ['available', 'generated_at', 'not_ok_count', 'overall']);
  const d = resultOf(b.task_id);
  assert.deepEqual(d.sections, { host: 'ok', hermes: 'ok', jobs: 'ok', repos: 'ok', github: 'ok', backup: 'ok' }, '水準のある区分だけ（heartbeat・relay などの値は返さない）');
  assert.deepEqual(d.counts, { open: 0, human: 0, ai: 0, auto: 0 });
  assert.equal(d.task_hub.awaiting_approval, 1);
  assert.deepEqual(d.cycle, { code: 'ok', at: '2026-11-09T08:55:00.000Z' });
  const text = JSON.stringify(d);
  for (const leak of ['token_days_left', 'age_days', 'unacked', 'ci_failing', 'history_ok']) assert.ok(!text.includes(leak), `${leak} は返さない`);
  // 不正な detail は取り込みで rejected
  const bad = await fromBot(envelope({ intent: 'status.query', params: { detail: 'yes' } }));
  assert.equal(bad.state, 'rejected');
  cleanup(env);
});

test('task.status：view は自分の依頼だけ（他の依頼元・他の business は数えない）・承認待ちは他の依頼元を件数だけ・task_ref と view は 1 つだけ', async () => {
  const { env, policy, fromBot, run, resultOf } = await setup();
  const mine1 = await fromBot(envelope({ intent: 'note.record', params: { text: 'a' } }));
  const mine2 = await fromBot(envelope({ intent: 'hermes.task', params: { title: 't', body: 'b' } }));
  await fromBot(envelope({ intent: 'status.query', business: 'biz-b' })); // 別の business
  await fromBot(envelope({ intent: 'status.query', business: 'biz-b' }), { channel: 'chan-research', source: 'bot-research', key: Buffer.alloc(32, 0xb2) }); // 別の依頼元
  await submitLocal(envelope({ intent: 'hermes.task', params: { title: 'h', body: 'human' } }), { store: env.store, policy, now: env.clock.t }); // 人の承認待ち（biz-a）
  const list = await fromBot(envelope({ intent: 'task.status', params: { view: 'recent', limit: 50 } }));
  const pend = await fromBot(envelope({ intent: 'task.status', params: { view: 'awaiting_approval' } }));
  const both = await fromBot(envelope({ intent: 'task.status', params: { view: 'recent', task_ref: 'abcdefgh' } }));
  const none = await fromBot(envelope({ intent: 'task.status', params: {} }));
  await run();
  const l = resultOf(list.task_id);
  assert.equal(l.view, 'recent');
  assert.deepEqual(new Set(l.items.map((x) => x.task_ref)), new Set([env.store.readTask(mine1.task_id).idempotency_key, env.store.readTask(mine2.task_id).idempotency_key, env.store.readTask(pend.task_id).idempotency_key, env.store.readTask(both.task_id).idempotency_key, env.store.readTask(none.task_id).idempotency_key]), '自分（bot-front・biz-a）の依頼だけ・自分自身は除く');
  const p = resultOf(pend.task_id);
  assert.deepEqual([p.total, p.items[0].intent, p.others_awaiting_approval], [1, 'hermes.task', 1], '人の承認待ちは件数だけ');
  assert.equal(env.store.readTask(both.task_id).state, 'failed');
  assert.equal(env.store.readTask(both.task_id).error.code, 'params_task_ref_or_view');
  assert.equal(env.store.readTask(none.task_id).error.code, 'params_task_ref_or_view');
  cleanup(env);
});

test('task.status：hermes.task の task_ref は Hermes の状態（waiting → running → done と要約）を返す。view hermes も状態を出す', async () => {
  const { env, config, policy, fromBot, run, resultOf, outbox } = await setup();
  const h = await fromBot(envelope({ intent: 'hermes.task', params: { title: '週報', body: 'b' } }));
  const t = env.store.readTask(h.task_id);
  approve(env.store, t.task_id, { confirm: t.content_digest.slice(0, 12), isTTY: true, now: env.clock.t });
  await run();
  const ask = async () => { const q = await fromBot(envelope({ intent: 'task.status', params: { task_ref: t.idempotency_key } })); await run(); return resultOf(q.task_id); };
  assert.deepEqual((await ask()).hermes, { status: 'waiting' });
  startJob(env.store, env.store.readTask(t.task_id), { at: env.tick(10) });
  assert.deepEqual((await ask()).hermes, { status: 'running' });
  writeFileSync(path.join(outbox, `${t.task_id}.json`), JSON.stringify({ v: 1, task_id: t.task_id, status: 'done', summary: '3 件を要約' }));
  collectHermesResults({ store: env.store, config, now: env.tick(10) });
  assert.deepEqual((await ask()).hermes, { status: 'done', summary: '3 件を要約' });
  const v = await fromBot(envelope({ intent: 'task.status', params: { view: 'hermes' } }));
  await run();
  assert.deepEqual(resultOf(v.task_id).items.map((x) => [x.intent, x.hermes]), [['hermes.task', 'done']]);
  // 別の依頼元からは同じ task_ref でも not_found（存在を教えない）
  const o = await fromBot(envelope({ intent: 'task.status', business: 'biz-b', params: { task_ref: t.idempotency_key } }), { channel: 'chan-research', source: 'bot-research', key: Buffer.alloc(32, 0xb2) });
  assert.equal(o.state, 'awaiting_approval', 'bot-research は task.status を許されていない＝承認待ち（実行されない）');
  assert.equal(policy.config.brief_path.endsWith('brief.json'), true);
  cleanup(env);
});

test('report.morning：稼働状況（水準と件数だけ）・Hermes の件数・予定とメモを case_ref で結ぶ。記録は business の中だけ', async () => {
  const { env, fromBot, run, resultOf } = await setup();
  await fromBot(envelope({ intent: 'calendar.digest.ingest', params: { events: [{ id: 'e1', start: '2026-11-09T10:00:00+09:00', end: '2026-11-09T11:00:00+09:00', title: '現場A 打合せ', case_ref: 'case-a' }] } }));
  await fromBot(envelope({ intent: 'note.record', params: { text: '図面の版を確認する', case_ref: 'case-a' } }));
  await fromBot(envelope({ intent: 'note.record', params: { text: '別件', case_ref: 'case-z' } }));
  await fromBot(envelope({ intent: 'note.record', business: 'biz-b', params: { text: '他の business のメモ', case_ref: 'case-a' } }));
  const bad = await fromBot(envelope({ intent: 'note.record', params: { text: 'x', case_ref: 'has space' } }));
  assert.equal(bad.state, 'rejected');
  await run();
  const m = await fromBot(envelope({ intent: 'report.morning' }));
  await run();
  const r = resultOf(m.task_id);
  assert.match(r.text, /現場A 打合せ（case-a・メモ 1 件）/);
  assert.match(r.text, /■ 予定に関係するメモ 1 件\n- （case-a）図面の版を確認する/);
  assert.doesNotMatch(r.text, /他の business のメモ|別件/);
  assert.match(r.text, /■ Mac の稼働状況：ok（要確認 0 件）/);
  assert.deepEqual([r.counts.linked_notes, r.counts.system], [1, 'ok']);
  cleanup(env);
});
