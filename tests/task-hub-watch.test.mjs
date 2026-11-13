/**
 * Task Hub の仕事の見張り（2026-11-13・audit-watch.taskHubWorkItems）：承認待ちの件数・止まった queue・Hermes の実行の問題を、件数とコードだけで host-health へ。
 * 通知の文は固定（alert-policy）・値は host-health の関所（safeValue）を通る。合成の id だけ・通信なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { taskHubWorkItems } from '../scripts/lib/task-hub/audit-watch.mjs';
import { safeValue } from '../scripts/host-health.mjs';
import { alertLine, ruleOf } from '../scripts/lib/alert-policy.mjs';
import { humanRequired, taskHubCounts } from '../scripts/runtime-ops.mjs';
import { makeEnv } from './task-hub-helpers.mjs';

const NOW = Date.parse('2026-11-13T09:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const id = () => `t-20261113000000-${String(++n).padStart(8, '0')}`;
function put(dir, t) { const tid = t.task_id ?? id(); writeFileSync(path.join(dir, 'tasks', `${tid}.json`), JSON.stringify({ task_id: tid, intent: 'status.query', business: 'biz-a', updated_at: iso(NOW), ...t })); return tid; }
function job(dir, j) { mkdirSync(path.join(dir, 'hermes-jobs'), { recursive: true }); writeFileSync(path.join(dir, 'hermes-jobs', `${j.task_id}.json`), JSON.stringify(j)); }
const byId = (items) => Object.fromEntries(items.map((x) => [x.id, [x.level, x.value]]));

test('taskHubWorkItems：使っていない store は項目なし・静かな時は ok だけ（Hermes の依頼が無ければ hermes_jobs も出さない）', () => {
  const env = makeEnv();
  assert.deepEqual(taskHubWorkItems(path.join(env.root, 'nothing'), NOW), []);
  put(env.store.dir, { state: 'succeeded' });
  assert.deepEqual(byId(taskHubWorkItems(env.store.dir, NOW)), { task_hub_approval: ['ok', '0'], task_hub_queue: ['ok', 'ok'] });
  rmSync(env.root, { recursive: true, force: true });
});

test('taskHubWorkItems：承認待ちの件数・30 分動かない queue・止まった task・Hermes の stuck／not_run／timeout（Hermes 自身の failed は知らせない）', () => {
  const env = makeEnv();
  const d = env.store.dir;
  put(d, { state: 'awaiting_approval' });
  put(d, { state: 'awaiting_approval', intent: 'hermes.task' });
  put(d, { state: 'queued', updated_at: iso(NOW - 31 * 60_000) });
  put(d, { state: 'retry_wait', next_try_at: iso(NOW + 60_000) }); // まだ時刻が来ていない＝止まっていない
  put(d, { state: 'stopped' });
  const run = put(d, { intent: 'hermes.task', state: 'succeeded' });
  job(d, { task_id: run, state: 'running', started_at: iso(NOW - 25 * 60_000), updated_at: iso(NOW - 25 * 60_000) });
  put(d, { intent: 'hermes.task', state: 'succeeded', updated_at: iso(NOW - 25 * 3_600_000) }); // 承認して渡したが 24 時間実行していない
  const to = put(d, { intent: 'hermes.task', state: 'succeeded' });
  job(d, { task_id: to, state: 'timeout', updated_at: iso(NOW - 3_600_000) });
  const old = put(d, { intent: 'hermes.task', state: 'succeeded' });
  job(d, { task_id: old, state: 'no_result', updated_at: iso(NOW - 2 * 86_400_000) }); // 24 時間より前＝もう知らせない
  const f = put(d, { intent: 'hermes.task', state: 'succeeded' });
  job(d, { task_id: f, state: 'failed', updated_at: iso(NOW) });
  const items = byId(taskHubWorkItems(d, NOW));
  assert.deepEqual(items, { task_hub_approval: ['warn', '2'], task_hub_queue: ['warn', 'stalled,stopped'], hermes_jobs: ['warn', 'stuck,not_run,timeout'] });
  // 値は host-health の関所を通る・文は固定
  for (const [k, [, v]] of Object.entries(items)) assert.equal(safeValue(k, v), v, k);
  assert.equal(safeValue('task_hub_approval', '2 件の秘密'), '[redacted]');
  assert.match(alertLine({ id: 'task_hub_approval', level: 'warn', value: '2', change: 'new' }), /Task Hub：承認待ちの依頼がある（件数）（2） → Mac の Terminal で node scripts\/task-hub\.mjs human/);
  assert.match(alertLine({ id: 'hermes_jobs', level: 'warn', value: 'stuck,timeout', change: 'new' }), /Hermes の業務：実行中のまま 20 分以上・時間切れ/);
  assert.deepEqual([ruleOf('task_hub_approval').hold, ruleOf('hermes_jobs').codes, ruleOf('task_hub_queue').codes], [0, true, true]);
  // Human の一覧にも出る
  const counts = taskHubCounts(d, NOW);
  assert.equal(counts.hermes, 'stuck,not_run,timeout');
  const rows = humanRequired({ taskHub: counts, now: new Date(NOW) });
  assert.ok(rows.some((r) => r.id === 'task-hub:hermes' && r.title.includes('hermes-work.mjs status')));
  rmSync(env.root, { recursive: true, force: true });
});

test('docomoFetchItem：fetch-last.json が無ければ項目なし・成功は ok・失敗は 3 回続いてから warn（コードだけ）', async () => {
  const { docomoFetchItem } = await import('../scripts/lib/docomo-watch.mjs');
  const env = makeEnv();
  const d = path.join(env.root, 'docomo');
  mkdirSync(d);
  assert.equal(docomoFetchItem(d), null);
  const put2 = (o) => writeFileSync(path.join(d, 'fetch-last.json'), JSON.stringify(o));
  put2({ at: iso(NOW), ok: true, new: 3, batches: 1, failures: 0 });
  assert.deepEqual(docomoFetchItem(d), { id: 'docomo_fetch', level: 'ok', value: 'ok', kind: 'state' });
  put2({ at: iso(NOW), ok: false, code: 'login_failed', failures: 2 });
  assert.deepEqual([docomoFetchItem(d).level, docomoFetchItem(d).value], ['ok', 'failed login_failed']);
  put2({ at: iso(NOW), ok: false, code: 'Login failed for user x', failures: 3 });
  assert.deepEqual([docomoFetchItem(d).level, docomoFetchItem(d).value], ['warn', 'failed error'], 'コードの形でない文は出さない');
  assert.equal(safeValue('docomo_fetch', 'failed login_failed'), 'failed login_failed');
  rmSync(env.root, { recursive: true, force: true });
});
