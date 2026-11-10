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
