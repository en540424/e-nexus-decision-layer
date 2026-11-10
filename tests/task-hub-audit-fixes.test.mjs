// 2026-11-10 独立監査（Task Hub の未 commit の変更）の指摘 F1〜F7 と、監査の鎖の無人の見張り（docs/task-hub.md §13）の回帰の試験。
// 監査者の再現の試験（壊れた挙動を確かめる形）を、直った挙動を確かめる形に反転したもの。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { readSmallFile } from '../scripts/lib/task-hub/safe-read.mjs';
import { MAX_RESULTS_PER_RUN, collectHermesResults } from '../scripts/lib/task-hub/hermes-results.mjs';
import { AUDIT_WATCH_ID, taskHubAuditItem } from '../scripts/lib/task-hub/audit-watch.mjs';
import { humanRequired, taskHubCounts } from '../scripts/runtime-ops.mjs';
import { alertLine, ruleOf } from '../scripts/lib/alert-policy.mjs';
import { classify } from '../scripts/lib/ops-classify.mjs';
import { NOW, dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('F1: 追記の後・tip の前の強制終了は、次の書き込みで直る（tip_mismatch の永久の警報にならない）', async () => {
  const env = makeEnv();
  await submitLocal(envelope(), { store: env.store, policy: env.policy, now: NOW });
  const file = path.join(env.store.dir, 'audit.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  appendFileSync(file, `${JSON.stringify({ at: new Date(NOW).toISOString(), task_id: null, event: 'x', state: null, prev: sha(lines.at(-1)) })}\n`);
  assert.equal(env.store.verifyAudit().ok, true, '止まった直後も鎖は正しい');
  for (let i = 0; i < 3; i += 1) env.store.audit({ event: 'after_kill' }, NOW + i);
  assert.deepEqual(env.store.verifyAudit(), { ok: true, lines: lines.length + 4 });
  assert.equal(taskHubCounts(env.store.dir).audit, null);
  rmSync(env.root, { recursive: true, force: true });
});

test('F1: 末尾の削除は直さない（次の書き込みの後も truncated か tip_mismatch のまま）', async () => {
  const env = makeEnv();
  await submitLocal(envelope(), { store: env.store, policy: env.policy, now: NOW });
  env.store.audit({ event: 'a' }, NOW + 1);
  env.store.audit({ event: 'b' }, NOW + 2);
  const file = path.join(env.store.dir, 'audit.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  writeFileSync(file, `${lines.slice(0, -2).join('\n')}\n`); // 末尾の 2 行を消す
  env.store.audit({ event: 'after_cut' }, NOW + 3);
  const v = env.store.verifyAudit();
  assert.equal(v.ok, false);
  assert.ok(['truncated', 'tip_mismatch'].includes(v.code), v.code);
  rmSync(env.root, { recursive: true, force: true });
});

test('F2: audit.jsonl が無く tip がある＝runtime-ops も truncated を出す', async () => {
  const env = makeEnv();
  await submitLocal(envelope(), { store: env.store, policy: env.policy, now: NOW });
  renameSync(path.join(env.store.dir, 'audit.jsonl'), path.join(env.root, 'moved.jsonl'));
  assert.equal(taskHubCounts(env.store.dir).audit, 'truncated');
  const row = humanRequired({ taskHub: taskHubCounts(env.store.dir), now: NOW, last: { items: [] } }).find((r) => r.id === 'task-hub:audit');
  assert.equal(row.priority, 1);
  assert.match(row.title, /確かめるまで承認しない/);
  assert.doesNotMatch(row.title, /直すまで承認・実行を止める/);
  rmSync(env.root, { recursive: true, force: true });
});

test('F3: 壊れた nonce の印は replay にしない（file は inbox に残り、task も rejected も作らない）', async () => {
  for (const corrupt of [`${NOW}\npend`, '\0'.repeat(21), 'garbage', `${NOW}\ndone\nx`]) {
    const env = makeEnv();
    const rec = seal(envelope());
    writeFileSync(path.join(env.store.dir, 'nonces', rec.nonce), corrupt);
    dropInbox(env.inbox, 'a.json', rec);
    const r = await ingestInbox(env.inbox, { keyFor, now: NOW + 3_600_000, store: env.store, policy: env.policy });
    assert.equal(r[0].code, 'inbox_error', JSON.stringify(corrupt));
    assert.ok(existsSync(path.join(env.inbox, 'a.json')), 'inbox に残る');
    assert.equal(existsSync(path.join(env.inbox, 'rejected', 'a.json')), false);
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('F3: 終わった印（done・1 行の古い形）は今までどおり replay', async () => {
  for (const done of [`${NOW}\ndone`, `${NOW}`]) {
    const env = makeEnv();
    const rec = seal(envelope());
    writeFileSync(path.join(env.store.dir, 'nonces', rec.nonce), done);
    dropInbox(env.inbox, 'a.json', rec);
    const r = await ingestInbox(env.inbox, { keyFor, now: NOW + 1000, store: env.store, policy: env.policy });
    assert.equal(r[0].code, 'replay', JSON.stringify(done));
    assert.ok(existsSync(path.join(env.inbox, 'rejected', 'a.json')));
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('F4: 止まっていた古い書き手が再開しても、終わった task を上書きしない（2 回目の実行が無い）', async () => {
  const env = makeEnv();
  const r = await submitLocal(envelope({ intent: 'note.record', params: { text: 'hello' } }), { store: env.store, policy: env.policy, now: NOW });
  const stale = structuredClone(env.store.readTask(r.task_id));
  const ran1 = await runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => NOW + 1000 });
  assert.equal(ran1.ran[0].state, 'succeeded');
  const back = env.store._create(stale, NOW);
  assert.equal(back.state, 'succeeded', '既にある task を返す');
  assert.equal(env.store.readTask(r.task_id).state, 'succeeded');
  const ran2 = await runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => NOW + 2000 });
  assert.equal(ran2.ran.length, 0);
  rmSync(env.root, { recursive: true, force: true });
});

test('F5: readSmallFile は fstat の大きさまでしか読まない・上限を超える file は bad_file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'th-f5-'));
  const f = path.join(root, 'a.json');
  writeFileSync(f, 'x'.repeat(10));
  assert.equal(readSmallFile(f, 10), 'x'.repeat(10));
  writeFileSync(f, 'x'.repeat(11));
  assert.throws(() => readSmallFile(f, 10), (e) => e.code === 'bad_file');
  writeFileSync(f, '');
  assert.equal(readSmallFile(f, 10), '');
  rmSync(root, { recursive: true, force: true });
});

test('F6: collect-hermes は 1 回に読む数を限り、残りを overflow に数える', async () => {
  const env = makeEnv();
  const out = mkdtempSync(path.join(tmpdir(), 'th-f6-'));
  for (let i = 0; i < MAX_RESULTS_PER_RUN + 5; i += 1) writeFileSync(path.join(out, `t-20261110000000-${i.toString(16).padStart(8, '0')}.json`), '{}');
  const r = collectHermesResults({ store: env.store, config: { hermes_outbox: out }, now: NOW });
  assert.equal(r.rejected.length, MAX_RESULTS_PER_RUN);
  assert.equal(r.overflow, 5);
  rmSync(out, { recursive: true, force: true });
  rmSync(env.root, { recursive: true, force: true });
});

test('F7: 取り込みは done へ移す前に syncIntake を呼ぶ（呼べなければ移さない＝inbox に残る）', async () => {
  const env = makeEnv();
  dropInbox(env.inbox, 'a.json', seal(envelope()));
  const calls = [];
  const store = Object.create(env.store);
  store.syncIntake = (id) => { calls.push(id); throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  const r = await ingestInbox(env.inbox, { keyFor, now: NOW, store, policy: env.policy });
  assert.equal(calls.length, 1);
  assert.equal(r[0].code, 'inbox_error');
  assert.ok(existsSync(path.join(env.inbox, 'a.json')));
  env.store.syncIntake(null); // 本物は投げない
  rmSync(env.root, { recursive: true, force: true });
});

test('見張り：使っていない・正常は ok（通知しない）・壊れた鎖は crit とコードだけ・読めないは warn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'th-watch-'));
  assert.deepEqual(taskHubAuditItem(path.join(root, 'none')), { id: AUDIT_WATCH_ID, level: 'ok', value: 'not_used', kind: 'state' });
  assert.equal(taskHubAuditItem('relative/dir').value, 'bad_dir');
  const env = makeEnv();
  await submitLocal(envelope(), { store: env.store, policy: env.policy, now: NOW });
  env.store.audit({ event: 'a' }, NOW + 1);
  env.store.audit({ event: 'b' }, NOW + 2);
  assert.deepEqual(taskHubAuditItem(env.store.dir), { id: AUDIT_WATCH_ID, level: 'ok', value: 'ok', kind: 'state' });
  const file = path.join(env.store.dir, 'audit.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const o = JSON.parse(lines[0]);
  lines[0] = JSON.stringify({ ...o, event: 'edited' });
  writeFileSync(file, `${lines.join('\n')}\n`);
  const it = taskHubAuditItem(env.store.dir);
  assert.deepEqual([it.level, it.value], ['crit', 'chain_broken']);
  assert.doesNotMatch(JSON.stringify(it), /t-\d{14}/, 'task の id を出さない');
  rmSync(file);
  mkdirSync(file); // file でない（フォルダ）
  assert.equal(taskHubAuditItem(env.store.dir).level, 'warn');
  // 通知の文と分類
  assert.equal(ruleOf(AUDIT_WATCH_ID).hold, 0);
  assert.match(alertLine({ id: AUDIT_WATCH_ID, level: 'crit', value: 'chain_broken' }), /^【重大】Task Hub の監査の記録：鎖が壊れている.*（chain_broken） → 確かめるまで承認しない/);
  assert.equal(classify(AUDIT_WATCH_ID).class, 'human');
  rmSync(env.root, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('F14：Hermes の inbox は other に権限があれば・macOS で staff の group に権限があれば書かない', async () => {
  const { inboxModeSafe } = await import('../scripts/lib/task-hub/handlers.mjs');
  assert.equal(inboxModeSafe({ mode: 0o40750, gid: 501 }, 'darwin'), true, '専用の group・0750');
  assert.equal(inboxModeSafe({ mode: 0o40700, gid: 20 }, 'darwin'), true, 'staff でも group に権限が無ければよい');
  assert.equal(inboxModeSafe({ mode: 0o40750, gid: 20 }, 'darwin'), false, 'staff に読める');
  assert.equal(inboxModeSafe({ mode: 0o40755, gid: 501 }, 'darwin'), false, 'other に読める');
  assert.equal(inboxModeSafe({ mode: 0o40750, gid: 20 }, 'linux'), true, 'gid 20 が staff なのは macOS だけ');
});
