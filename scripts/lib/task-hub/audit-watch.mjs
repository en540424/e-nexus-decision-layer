/**
 * Task Hub の監査の鎖の無人の見張り（2026-11-10・MA-24）。host-health の `--task-hub <dir>` の時だけ使う（既定は使わない＝休眠）。
 * 読むだけ（store を開かない・作らない・直さない）。正常なら ok の 1 項目＝通知しない。異常の時だけ host-health の通知の関所を通る。
 * 値は異常のコードだけ（task の id・中身・path は出さない）。docs/task-hub.md §13。
 */
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { readJsonSafe, readSmallFile } from './safe-read.mjs';
import { verifyAuditLines } from './store.mjs';

export const AUDIT_WATCH_ID = 'task_hub_audit';
/** 見張りの 1 回で読む上限（host-health の時間の枠を守る）。store の上限（256 MB）より小さい。超えたら warn で知らせる */
export const AUDIT_WATCH_MAX = 32 * 1024 * 1024;
/** 鎖そのものが壊れている（Human の確認が要る）コード */
const BROKEN = new Set(['chain_broken', 'unparseable', 'truncated', 'tip_mismatch', 'tip_missing']);

/** { id, level, value, kind } を 1 つ返す。投げない */
export function taskHubAuditItem(dir) {
  const item = (level, value) => ({ id: AUDIT_WATCH_ID, level, value, kind: 'state' });
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return item('warn', 'bad_dir');
    if (!existsSync(path.join(dir, 'tasks'))) return item('ok', 'not_used'); // まだ使っていない
    // tip を先に読む（読む間に書き手が足した行で末尾の削除と誤らない＝runtime-ops と同じ順）
    const tip = readJsonSafe(path.join(dir, 'audit.tip'), 4096);
    let lines;
    try {
      lines = readSmallFile(path.join(dir, 'audit.jsonl'), AUDIT_WATCH_MAX).split('\n').filter(Boolean);
    } catch (e) {
      if (e?.code === 'ENOENT') lines = [];
      else return item('warn', e?.code === 'bad_file' ? 'audit_unreadable_or_large' : 'audit_unreadable');
    }
    const v = verifyAuditLines(lines, tip);
    if (v.ok) return item('ok', 'ok');
    return item(BROKEN.has(v.code) ? 'crit' : 'warn', v.code);
  } catch {
    return item('warn', 'check_failed');
  }
}

/**
 * Task Hub の回（scripts/task-hub-cycle.mjs）の最後の結果（2026-11-11）。cycle-last.json が無ければ null（回していない＝項目を出さない）。
 * 値：ok／paused（Human の PAUSE）／paused_breaker（runner の回路遮断＝想定外の失敗が続いて止まった。warn）／not_configured（VPS の鍵が Keychain に無い＝受け渡しの休眠）／problem <段,…>／stale（30 分以上回っていない・時刻が未来）。
 * not_configured と stale は定期の job が登録されている時＝scheduled だけ warn（手で回すだけの間は項目なし）。どれも warn までで、通知は alert-policy の hold（2 回分）を過ぎて続いた時だけ
 */
export const CYCLE_WATCH_ID = 'task_hub_cycle';
const CYCLE_STALE_MS = 30 * 60_000;
const STEP_NAMES = new Set(['pull', 'intake', 'run', 'collect_hermes', 'push']);
export function taskHubCycleItem(dir, now = Date.now(), { scheduled = false } = {}) {
  const item = (level, value) => ({ id: CYCLE_WATCH_ID, level, value, kind: 'state' });
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    if (!existsSync(path.join(dir, 'cycle-last.json'))) return null;
    const j = readJsonSafe(path.join(dir, 'cycle-last.json'), 4096);
    const t = Date.parse(j?.at);
    if (!Number.isFinite(t) || now - t > CYCLE_STALE_MS || t - now > 5 * 60_000) return scheduled ? item('warn', 'stale') : null;
    if (j.code === 'ok') return item('ok', 'ok');
    if (j.code === 'paused') return item('ok', 'paused');
    if (j.code === 'paused_breaker') return item('warn', 'paused_breaker');
    if (j.code === 'not_configured') return scheduled ? item('warn', 'not_configured') : null;
    const failed = (Array.isArray(j.failed) ? j.failed : []).filter((x) => STEP_NAMES.has(x));
    return item('warn', failed.length ? `problem ${failed.join(',')}` : 'problem');
  } catch {
    return scheduled ? item('warn', 'stale') : null;
  }
}

/**
 * Task Hub の仕事の見張り（2026-11-13・読むだけ・store を開かない）。docs/task-hub.md §12・§15。値は件数かコードだけ（task の id・中身は出さない）。
 *   task_hub_approval：承認待ちの件数（全 business・全依頼元）。1 件以上で warn・hold 0＝次の回に 1 通（続いている間は重ねない。0 に戻って新たに来れば次の 1 通）
 *   task_hub_queue：stalled（queued・時刻の来た retry_wait が 30 分以上動いていない＝定期の回が実行できていない）・stopped（途中で止まった task＝Human の dismiss 待ち）
 *   hermes_jobs：stuck（running のまま 20 分）・not_run（承認して渡したが 24 時間実行していない）・timeout・no_result・result_rejected・interrupted（24 時間以内。Human のやり直しの判断）。
 *     Hermes 自身の failed（「できない」の返事）は依頼元へ返る普通の結果なので知らせない
 */
export const APPROVAL_WATCH_ID = 'task_hub_approval';
export const QUEUE_WATCH_ID = 'task_hub_queue';
export const HERMES_JOBS_WATCH_ID = 'hermes_jobs';
const TASK_FILE_RE = /^t-\d{14}-[0-9a-f]{8}\.json$/;
const MAX_FILES = 5000;
const STALL_MS = 30 * 60_000;
const STUCK_MS = 20 * 60_000;
const DAY_MS = 86_400_000;
const HERMES_PROBLEMS = ['timeout', 'no_result', 'result_rejected', 'interrupted'];

function readDirJson(dir) {
  let names = [];
  try { names = readdirSync(dir).filter((f) => TASK_FILE_RE.test(f)).slice(0, MAX_FILES); } catch { return []; }
  return names.map((f) => readJsonSafe(path.join(dir, f), 256 * 1024)).filter(Boolean);
}

/** [approval, queue, hermes] の項目（使っていない store なら []）。投げない */
export function taskHubWorkItems(dir, now = Date.now()) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !existsSync(path.join(dir, 'tasks'))) return [];
    const tasks = readDirJson(path.join(dir, 'tasks'));
    const awaiting = tasks.filter((t) => t.state === 'awaiting_approval').length;
    const items = [{ id: APPROVAL_WATCH_ID, level: awaiting ? 'warn' : 'ok', value: String(Math.min(awaiting, 999)), kind: 'state' }];
    const q = [];
    if (tasks.some((t) => (t.state === 'queued' && now - Date.parse(t.updated_at) > STALL_MS) || (t.state === 'retry_wait' && now - Date.parse(t.next_try_at) > STALL_MS))) q.push('stalled');
    if (tasks.some((t) => t.state === 'stopped')) q.push('stopped');
    items.push({ id: QUEUE_WATCH_ID, level: q.length ? 'warn' : 'ok', value: q.length ? q.join(',') : 'ok', kind: 'state' });
    const jobs = new Map(readDirJson(path.join(dir, 'hermes-jobs')).map((j) => [j.task_id, j]));
    const h = new Set();
    for (const t of tasks) {
      if (t.intent !== 'hermes.task' || t.state !== 'succeeded') continue;
      const j = jobs.get(t.task_id);
      if (!j) { if (now - Date.parse(t.updated_at) > DAY_MS) h.add('not_run'); continue; }
      if (j.state === 'running' && now - Date.parse(j.started_at) > STUCK_MS) h.add('stuck');
      else if (HERMES_PROBLEMS.includes(j.state) && now - Date.parse(j.updated_at) <= DAY_MS) h.add(j.state);
    }
    const order = ['stuck', 'not_run', ...HERMES_PROBLEMS];
    const codes = order.filter((c) => h.has(c));
    if (jobs.size || tasks.some((t) => t.intent === 'hermes.task')) items.push({ id: HERMES_JOBS_WATCH_ID, level: codes.length ? 'warn' : 'ok', value: codes.length ? codes.join(',') : 'ok', kind: 'state' });
    return items;
  } catch {
    return [{ id: QUEUE_WATCH_ID, level: 'warn', value: 'check_failed', kind: 'state' }];
  }
}
