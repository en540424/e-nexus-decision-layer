/**
 * Hermes の 1 件実行の流れと記録（2026-11-13・MA-24・docs/hermes-work.md §11）。sudo・hermes・sandbox は模擬（sys）。通信なし・Keychain なし・課金なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { ingestInbox } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dismissJob, MAX_ATTEMPTS, RUN_GRACE_MS, pgrepAlive, recoverInterrupted, selectNext, startJob, summarizeJobs, WORK_LOCK, WORK_LOCK_MAX_AGE_MS } from '../scripts/lib/task-hub/hermes-jobs.mjs';
import { HERMES_RUN_MARK, pickUsage, runWork, workPrompt } from '../scripts/lib/task-hub/hermes-work.mjs';
import { main } from '../scripts/task-hub.mjs';
import { NOW, dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const cleanup = (env) => rmSync(env.root, { recursive: true, force: true });

/** bot から来た hermes.task を承認して inbox へ渡した状態を作る */
async function delivered(env, { title = '週報', body = 'notes を要約する', source = 'bot' } = {}) {
  const inbox = path.join(env.root, 'h-inbox');
  const outbox = path.join(env.root, 'h-outbox');
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  let id;
  if (source === 'bot') {
    const e = envelope({ intent: 'hermes.task', params: { title, body } });
    dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(e));
    const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
    id = r.task_id;
  } else {
    const { submitLocal } = await import('../scripts/lib/task-hub/intake.mjs');
    id = (await submitLocal(envelope({ intent: 'hermes.task', params: { title, body } }), { store: env.store, policy: env.policy, now: env.clock.t })).task_id;
  }
  const t = env.store.readTask(id);
  assert.equal(t.state, 'awaiting_approval');
  approve(env.store, id, { confirm: t.content_digest.slice(0, 12), isTTY: true, now: env.clock.t });
  const config = { ...env.config, hermes_inbox: inbox, hermes_outbox: outbox, brief_path: path.join(env.root, 'brief.json') };
  const ran = await runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: env.tick(1000) });
  assert.equal(ran.ran[0].state, 'succeeded');
  return { id, inbox, outbox, config };
}

/** 模擬の sys。write(ctx) が Hermes の書き込みの代わり */
function fakeSys(outbox, { write = () => {}, exec = {}, preflight = { ok: true }, usage = { model: 'm', api_calls: 2, input_tokens: 10, output_tokens: 5, note: 'drop me' } } = {}) {
  const calls = { exec: 0, kill: 0, preflight: 0, removed: [] };
  return {
    calls,
    preflight: async () => { calls.preflight += 1; return preflight; },
    exec: async (task, ctx) => { calls.exec += 1; calls.ctx = ctx; write(ctx, task); return { exit: 0, signal: null, timedOut: false, ...exec }; },
    readUsage: () => usage,
    listOutbox: () => readdirSync(outbox),
    readOutbox: (n) => { try { return readFileSync(path.join(outbox, n)); } catch { return null; } },
    quarantineOutbox: (n) => { calls.removed.push(n); unlinkSync(path.join(outbox, n)); },
    killStragglers: () => { calls.kill += 1; },
  };
}
const result = (ctx, task, over = {}) => writeFileSync(ctx.outboxFile, JSON.stringify({ v: 1, task_id: task.task_id, status: 'done', summary: '3 件を要約しました', ...over }));
const noWait = async () => null;
const boardOf = (env, id) => {
  const t = env.store.readTask(id);
  // VPS の結果の板と同じく、同じ task_ref の知らせは updated_at の新しい方が勝つ（先頭＝今の板の値）
  return env.store.listOutbox().map((o) => ({ ...o, body: JSON.parse(o.body) })).filter((o) => o.task_ref === t.idempotency_key && o.body.result?.hermes)
    .sort((x, y) => Number(y.updated_at) - Number(x.updated_at)); // updated_at は ms の数
};
const auditEvents = (env, id) => readFileSync(env.store.path('audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.task_id === id).map((l) => l.event);

test('Hermes の 1 件実行：paid の無い時は課金の前で止まる・成功で done・監査・記録・板の知らせ・印と排他を片付ける', async () => {
  const env = makeEnv();
  const { id, outbox, config } = await delivered(env);
  // 渡した直後の板の知らせ：hermes.status は waiting
  const t0 = env.store.readTask(id);
  assert.deepEqual(t0.result.hermes, { status: 'waiting' });
  const sys = fakeSys(outbox, { write: result });
  const dry = await runWork({ store: env.store, config, sys, now: () => env.clock.t, waitRunLock: noWait });
  assert.deepEqual([dry.code, dry.task_id, sys.calls.preflight, sys.calls.exec], ['paid_not_ok', id, 0, 0], '--paid-ok が無ければ preflight も実行もしない');
  assert.equal(env.store.readHermesJob(id), null);
  const r = await runWork({ store: env.store, config, sys, now: () => env.tick(10), paidOk: true, waitRunLock: noWait });
  assert.equal(r.code, 'done');
  const job = env.store.readHermesJob(id);
  assert.deepEqual([job.state, job.attempts, job.code], ['done', 1, 'hermes_done']);
  assert.deepEqual(job.usage, { model: 'm', api_calls: 2, input_tokens: 10, output_tokens: 5 }, 'usage は数だけ（知らない key は捨てる）');
  assert.deepEqual(auditEvents(env, id).slice(-3), ['hermes_started', 'hermes_result', 'hermes_job_closed']);
  assert.equal(env.store.readRecords('biz-a', 'notes').get(`hermes:${id}`)?.text, '3 件を要約しました');
  const [notice] = boardOf(env, id);
  assert.deepEqual(notice.body.result.hermes, { status: 'done', summary: '3 件を要約しました' });
  assert.equal(existsSync(env.store.path(HERMES_RUN_MARK)), false, '定期の回の印は消える');
  assert.equal(env.store.namedLockOwner(WORK_LOCK), null, '排他は返す');
  assert.match(sys.calls.ctx.prompt, new RegExp(`run ${sys.calls.ctx.runToken}`));
  // 終わった依頼はもう選ばない（--retry でも）
  assert.equal((await runWork({ store: env.store, config, sys, now: () => env.clock.t, paidOk: true })).code, 'nothing');
  assert.equal((await runWork({ store: env.store, config, sys, now: () => env.clock.t, paidOk: true, taskId: id, retry: true })).code, 'already_final');
  assert.equal(sys.calls.exec, 1);
  assert.equal(env.store.verifyAudit().ok, true);
  cleanup(env);
});

test('Hermes の 1 件実行：時間切れ・結果なしは自動でやり直さない。--task と --retry だけで、上限まで（二重の課金をしない）', async () => {
  const env = makeEnv();
  const { id, outbox, config } = await delivered(env);
  const slow = fakeSys(outbox, { exec: { timedOut: true, exit: null, signal: 'SIGALRM' } });
  const r = await runWork({ store: env.store, config, sys: slow, now: () => env.tick(10), paidOk: true, waitRunLock: noWait });
  assert.equal(r.code, 'timeout');
  assert.equal(slow.calls.kill, 1, '時間切れの後に残った process を止める');
  assert.equal(env.store.readHermesJob(id).state, 'timeout');
  assert.deepEqual(boardOf(env, id)[0].body.result.hermes, { status: 'timeout', code: 'timeout' }, '依頼元へも時間切れを返す');
  assert.equal((await runWork({ store: env.store, config, sys: slow, now: () => env.tick(10), paidOk: true })).code, 'nothing', '自動では選ばない');
  assert.equal((await runWork({ store: env.store, config, sys: slow, now: () => env.tick(10), paidOk: true, taskId: id })).code, 'not_retryable');
  const quiet = fakeSys(outbox);
  assert.equal((await runWork({ store: env.store, config, sys: quiet, now: () => env.tick(10), paidOk: true, taskId: id, retry: true, waitRunLock: noWait })).code, 'no_result');
  assert.deepEqual([env.store.readHermesJob(id).state, env.store.readHermesJob(id).attempts], ['no_result', 2]);
  assert.equal((await runWork({ store: env.store, config, sys: quiet, now: () => env.tick(10), paidOk: true, taskId: id, retry: true, waitRunLock: noWait })).code, 'no_result');
  assert.equal(env.store.readHermesJob(id).attempts, MAX_ATTEMPTS);
  assert.equal((await runWork({ store: env.store, config, sys: quiet, now: () => env.tick(10), paidOk: true, taskId: id, retry: true })).code, 'retry_limit');
  assert.equal(quiet.calls.exec, 2);
  // 上限に達した後に遅れて結果が置かれても、collect が記録して done に閉じる
  writeFileSync(path.join(outbox, `${id}.json`), JSON.stringify({ v: 1, task_id: id, status: 'failed', summary: 'メールの送信が要るので行いません' }));
  const { collectHermesResults } = await import('../scripts/lib/task-hub/hermes-results.mjs');
  assert.equal(collectHermesResults({ store: env.store, config, now: env.tick(10) }).recorded, 1);
  assert.equal(env.store.readHermesJob(id).state, 'failed');
  cleanup(env);
});

test('Hermes の 1 件実行：渡した 1 件以外の file（増えた・書き換えた）は取り込まずに消す・不信頼の結果は result_rejected', async () => {
  const env = makeEnv();
  const a = await delivered(env, { title: 'a' });
  const b = await delivered(env, { title: 'b' });
  // b の結果が先に置かれている（前の実行の残り）→ a を実行する Hermes が b を書き換える・別の file を足す
  writeFileSync(path.join(a.outbox, 'keep.txt'), 'old');
  const sys = fakeSys(a.outbox, {
    write: (ctx, task) => {
      result(ctx, task);
      writeFileSync(path.join(a.outbox, `${b.id}.json`), JSON.stringify({ v: 1, task_id: b.id, status: 'done', summary: '別の依頼の結果を偽る' }));
      writeFileSync(path.join(a.outbox, 'keep.txt'), 'changed');
    },
  });
  const r = await runWork({ store: env.store, config: a.config, sys, now: () => env.tick(10), paidOk: true, waitRunLock: noWait, taskId: a.id });
  assert.deepEqual([r.code, r.removed], ['done', 2]);
  assert.deepEqual(sys.calls.removed.sort(), [`${b.id}.json`, 'keep.txt'].sort());
  assert.equal(env.store.readRecords('biz-a', 'notes').has(`hermes:${b.id}`), false, 'b の偽の結果は記録しない');
  assert.equal(env.store.readHermesJob(b.id), null, 'b はまだ waiting');
  // b を実行：鍵の形の summary は記録しない＝result_rejected
  const bad = fakeSys(b.outbox, { write: (ctx, task) => result(ctx, task, { summary: 'here sk-abcdefghijklmnopqrstuvwx' }) });
  const r2 = await runWork({ store: env.store, config: b.config, sys: bad, now: () => env.tick(10), paidOk: true, waitRunLock: noWait });
  assert.equal(r2.code, 'result_rejected');
  assert.match(r2.reason, /^summary_/);
  assert.equal(env.store.readHermesJob(b.id).state, 'result_rejected');
  assert.deepEqual(boardOf(env, b.id)[0].body.result.hermes.status, 'result_rejected');
  cleanup(env);
});

test('Hermes の 1 件実行：同時に 2 つ走らせない（busy）・preflight が通らなければ始めない・途中で止まった実行は次の回で interrupted', async () => {
  const env = makeEnv();
  const { id, outbox, config } = await delivered(env);
  const held = env.store.acquireNamedLock(WORK_LOCK, env.clock.t, WORK_LOCK_MAX_AGE_MS);
  const sys = fakeSys(outbox, { write: result });
  assert.equal((await runWork({ store: env.store, config, sys, now: () => env.clock.t, paidOk: true })).code, 'busy');
  held();
  const no = fakeSys(outbox, { preflight: { ok: false, code: 'sandbox_env_readable' } });
  assert.equal((await runWork({ store: env.store, config, sys: no, now: () => env.clock.t, paidOk: true })).code, 'preflight_sandbox_env_readable');
  assert.deepEqual([no.calls.exec, env.store.readHermesJob(id)], [0, null], '課金の前に止まる・記録は waiting のまま');
  // running のまま持ち主が居なくなった（強制終了・再起動）。猶予の間・印の process が見える間は付け替えない（監査 F6）
  const task = env.store.readTask(id);
  startJob(env.store, task, { at: env.tick(10), runToken: 'abcdef012345' });
  assert.equal(env.store.readHermesJob(id).run_token, 'abcdef012345');
  assert.deepEqual(recoverInterrupted(env.store, { at: env.tick(60_000) }), [], 'まだ猶予の間（node が殺されても hermes は 120 秒まで動きうる）');
  assert.deepEqual(recoverInterrupted(env.store, { at: env.tick(RUN_GRACE_MS), alive: (j) => j.run_token === 'abcdef012345' }), [], '印の process が見える間は付け替えない');
  assert.deepEqual(recoverInterrupted(env.store, { at: env.tick(10) }), [id], '排他の持ち主も process も居なければ置き土産');
  assert.equal(env.store.readHermesJob(id).state, 'interrupted');
  assert.equal(boardOf(env, id)[0].body.result.hermes.status, 'interrupted');
  // 生きた持ち主が排他を持っている間は触らない
  const t2 = await delivered(env, { title: 'c' });
  startJob(env.store, env.store.readTask(t2.id), { at: env.tick(10) });
  const held2 = env.store.acquireNamedLock(WORK_LOCK, env.clock.t, WORK_LOCK_MAX_AGE_MS);
  assert.deepEqual(recoverInterrupted(env.store, { at: env.tick(RUN_GRACE_MS + 10) }), []);
  held2();
  assert.deepEqual(summarizeJobs(env.store), { running: 1, done: 0, failed: 0, timeout: 0, no_result: 0, result_rejected: 0, interrupted: 1, dismissed: 0 });
  // pgrepAlive：印が無い記録は false・ps が失敗（例外）なら動いているとみなす
  assert.equal(pgrepAlive({ run_token: null }), false);
  assert.equal(pgrepAlive({ run_token: 'abcdef012345' }, { run: () => ({ status: 0 }) }), true);
  assert.equal(pgrepAlive({ run_token: 'abcdef012345' }, { run: () => ({ status: 1 }) }), false);
  assert.equal(pgrepAlive({ run_token: 'abcdef012345' }, { run: () => { throw new Error('x'); } }), true);
  cleanup(env);
});

test('collect-hermes（定期の回）が途中で止まった実行を interrupted にして依頼元へ返す（再起動の後の続き）', async () => {
  const env = makeEnv();
  const { id, config } = await delivered(env);
  startJob(env.store, env.store.readTask(id), { at: env.tick(10) });
  env.tick(RUN_GRACE_MS + 10);
  const cfgFile = path.join(env.root, 'config.json');
  writeFileSync(cfgFile, JSON.stringify(config), { mode: 0o600 });
  const lines = [];
  const code = await main(['collect-hermes', '--store', env.store.dir, '--config', cfgFile], { out: (s) => lines.push(s), err: (s) => lines.push(s), now: env.tick(10) });
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes(`途中で止まった Hermes の実行 ${id}`)), lines.join(' | '));
  assert.equal(env.store.readHermesJob(id).state, 'interrupted');
  cleanup(env);
});

test('selectNext：承認待ち・渡していない・hermes.task でない・結果がもう在る依頼は選ばない。人の依頼は板へ返さない', async () => {
  const env = makeEnv();
  const { id, inbox, outbox } = await delivered(env, { source: 'human' });
  assert.equal(selectNext(env.store, { inbox, outbox }).task.task_id, id);
  writeFileSync(path.join(outbox, `${id}.json`), '{}');
  assert.equal(selectNext(env.store, { inbox, outbox, taskId: id }).code, 'result_waiting', '結果がもう在る＝もう一度実行しない');
  unlinkSync(path.join(outbox, `${id}.json`));
  assert.equal(selectNext(env.store, { inbox, outbox, taskId: 't-20261109090000-00000001' }).code, 'not_found');
  writeFileSync(path.join(inbox, 't-20261109090000-00000002.json'), '{}');
  assert.equal(selectNext(env.store, { inbox, outbox, taskId: 't-20261109090000-00000002' }).code, 'not_found');
  startJob(env.store, env.store.readTask(id), { at: env.tick(10) });
  assert.equal(env.store.listOutbox().filter((o) => JSON.parse(o.body).result?.hermes).length, 0, 'human-cli の依頼は板へ返さない');
  cleanup(env);
});

test('workPrompt・pickUsage：依頼は file で渡す・usage は数と model 名だけ', () => {
  const p = workPrompt({ inboxFile: '/w/in/t.json', briefFile: '/s/b.json', outboxFile: '/w/out/t.json', taskId: 't-1', runToken: 'abc123' });
  assert.match(p, /read_file to read \/w\/in\/t\.json/);
  assert.match(p, /"task_id":"t-1"/);
  assert.doesNotMatch(p, /週報/);
  assert.deepEqual(pickUsage({ model: 'claude-haiku-5-5', api_calls: 3, input_tokens: -1, output_tokens: 1.5, total_tokens: 99, extra: 'x' }), { model: 'claude-haiku-5-5', api_calls: 3, total_tokens: 99 });
  assert.equal(pickUsage({ model: 'bad model name with spaces' }), null);
  assert.equal(pickUsage(null), null);
  assert.equal(NOW > 0, true);
});

test('Hermes の 1 件実行：記録しなかった結果は隔離してやり直せる（監査 F4）・Human は実行せずに閉じられる（dismiss・依頼元へ返す）', async () => {
  const env = makeEnv();
  const { id, outbox, config } = await delivered(env);
  const bad = fakeSys(outbox, { write: (ctx, task) => result(ctx, task, { summary: 'here sk-abcdefghijklmnopqrstuvwx' }) });
  assert.equal((await runWork({ store: env.store, config, sys: bad, now: () => env.tick(10), paidOk: true, waitRunLock: noWait })).code, 'result_rejected');
  assert.deepEqual(bad.calls.removed, [`${id}.json`], '拒否した結果は隔離（outbox に残さない）');
  // 隔離が途中で止まって file が残っていても、--retry は隔離してから実行する
  writeFileSync(path.join(outbox, `${id}.json`), '{bad');
  const good = fakeSys(outbox, { write: result });
  const r = await runWork({ store: env.store, config, sys: good, now: () => env.tick(10), paidOk: true, taskId: id, retry: true, waitRunLock: noWait });
  assert.equal(r.code, 'done');
  assert.ok(good.calls.removed.includes(`${id}.json`));
  assert.equal(env.store.readHermesJob(id).attempts, 2);
  // dismiss
  const b = await delivered(env, { title: 'b' });
  assert.equal(dismissJob(env.store, env.store.readTask(b.id), { at: env.tick(10) }).state, 'dismissed');
  assert.equal(boardOf(env, b.id)[0].body.result.hermes.status, 'dismissed');
  assert.equal((await runWork({ store: env.store, config, sys: good, now: () => env.tick(10), paidOk: true, taskId: b.id, retry: true })).code, 'already_final');
  assert.equal(dismissJob(env.store, env.store.readTask(id), { at: env.tick(10) }), null, '終わった記録は閉じ直さない');
  cleanup(env);
});

test('hermes-work.mjs の CLI：引数の検査・status は読むだけ・dismiss は端末と確認コードだけ（sudo を使わない段）', async () => {
  const { main, parse } = await import('../scripts/hermes-work.mjs');
  assert.throws(() => parse(['run', '--retry']), /--retry needs --task/);
  assert.throws(() => parse(['dismiss', 't-20261113000000-0000abcd']), /--confirm/);
  assert.throws(() => parse(['approve']), /run\|status\|dismiss/);
  assert.deepEqual(parse(['run', '--paid-ok', '--task', 't-20261113000000-0000abcd', '--retry']).retry, true);
  const env = makeEnv();
  const { id, config } = await delivered(env);
  writeFileSync(path.join(env.store.dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const lines = [];
  const io = { out: (s) => lines.push(s), err: (s) => lines.push(s) };
  assert.equal(await main(['status', '--store', env.store.dir], io), 0);
  assert.ok(lines.some((l) => l.startsWith(id) && l.includes('hermes=waiting')), lines.join(' | '));
  const code = env.store.readTask(id).content_digest.slice(0, 12);
  assert.equal(await main(['dismiss', id, '--confirm', code, '--store', env.store.dir], { ...io, isTTY: false }), 1, '端末でなければ閉じない');
  assert.equal(await main(['dismiss', id, '--confirm', '000000000000', '--store', env.store.dir], { ...io, isTTY: true }), 1, '確認コードが違えば閉じない');
  assert.equal(env.store.readHermesJob(id), null);
  assert.equal(await main(['dismiss', id, '--confirm', code, '--store', env.store.dir], { ...io, isTTY: true }), 0);
  assert.equal(env.store.readHermesJob(id).state, 'dismissed');
  // run（--paid-ok なし）は承認・課金・sudo の前で止まる：渡す依頼が無い
  lines.length = 0;
  let sudoCalled = false;
  assert.equal(await main(['run', '--no-approve', '--store', env.store.dir], { ...io, isTTY: false, sudoValidate: () => { sudoCalled = true; return false; } }), 0);
  assert.equal(sudoCalled, false, '--paid-ok が無ければ sudo を聞かない');
  assert.ok(lines.some((l) => l.includes('渡す依頼がありません')), lines.join(' | '));
  cleanup(env);
});
