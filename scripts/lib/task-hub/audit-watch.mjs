/**
 * Task Hub の監査の鎖の無人の見張り（2026-11-10・MA-24）。host-health の `--task-hub <dir>` の時だけ使う（既定は使わない＝休眠）。
 * 読むだけ（store を開かない・作らない・直さない）。正常なら ok の 1 項目＝通知しない。異常の時だけ host-health の通知の関所を通る。
 * 値は異常のコードだけ（task の id・中身・path は出さない）。docs/task-hub.md §13。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
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
