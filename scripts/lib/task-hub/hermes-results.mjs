/**
 * Hermes の結果を Task Hub へ取り込む（2026-11-10・MA-24）。休眠：local config の `hermes_outbox`（Hermes が書く専用のフォルダ。Human が作る）が無ければ何もしない。
 *
 * 往き：承認済みの `hermes.task` → `hermes_inbox/<task_id>.json`（handlers.mjs）。
 * 還り：Hermes が `hermes_outbox/<task_id>.json` に { v: 1, task_id, status: 'done'|'failed', summary } を書く → ここが読む。
 *
 * Hermes の出力は不信頼として扱う（依頼の本文と同じ）：
 *   - 名前は task の id の形だけ。普通の file だけ（symlink・FIFO・16 KiB 超は読まない＝safe-read.mjs）。未知の field は拒否
 *   - 対応する task が `hermes.task` で、Hermes へ渡し終えた（succeeded）ものだけ。task の business に記録する（Hermes が business を名乗っても使わない）
 *   - summary は envelope と同じ関所（NFKC・見えない文字・鍵の形・2000 字）を通す。通らなければ記録しない（理由のコードだけ監査へ）
 *   - 書くのは監査の 1 行（先に）と business の notes の記録（id `hermes:<task_id>`）と、取り込んだ印 `<store>/hermes-collected/<task_id>`（O_EXCL・以後その task の結果は読まない＝
 *     Hermes が file を書き換えても・notes が保持の上限で消えても、二度記録しない）。何も実行しない・承認の代わりにならない
 *   - Hermes の file は消さない・動かさない（Hermes の場所。Task Hub は読むだけ）
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkSpec, parseEnvelope } from './envelope.mjs';
import { readSmallFile } from './safe-read.mjs';
import { TASK_ID_RE } from './store.mjs';

export const RESULT_MAX_BYTES = 16 * 1024;
const RESULT_FIELDS = new Set(['v', 'task_id', 'status', 'summary']);
const SUMMARY_SPEC = { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } } };

export const MAX_RESULTS_PER_RUN = 200;

/** フォルダが使えるか（絶対 path・symlink でない・フォルダ）。作らない */
function usableDir(dir) {
  try { return typeof dir === 'string' && path.isAbsolute(dir) && !lstatSync(dir).isSymbolicLink() && statSync(dir).isDirectory(); } catch { return false; }
}

/** 1 file を検査する。{ ok, task, status, text } か { ok:false, code } */
function checkResult(dir, name, store) {
  const taskId = name.slice(0, -'.json'.length);
  let raw;
  let text;
  try { text = readSmallFile(path.join(dir, name), RESULT_MAX_BYTES); } catch (e) { return { ok: false, code: e?.code === 'bad_file' ? 'bad_file' : e?.code === 'EACCES' ? 'unreadable' : 'bad_file' }; }
  try { raw = JSON.parse(text); } catch { return { ok: false, code: 'bad_json' }; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => !RESULT_FIELDS.has(k))) return { ok: false, code: 'bad_shape' };
  if (raw.v !== 1 || raw.task_id !== taskId || !['done', 'failed'].includes(raw.status) || typeof raw.summary !== 'string') return { ok: false, code: 'bad_shape' };
  const task = store.readTask(taskId);
  if (!task || task.intent !== 'hermes.task') return { ok: false, code: 'unknown_task' };
  if (task.state !== 'succeeded') return { ok: false, code: 'task_not_delivered' };
  // envelope と同じ関所（business は task のもの・intent は記録の形を借りるだけ）
  const parsed = parseEnvelope({ v: 1, idempotency_key: `hermes-result-${taskId}`, business: task.business, intent: 'note.record', params: { text: raw.summary } });
  if (!parsed.ok) return { ok: false, code: `summary_${parsed.code}` };
  const bad = checkSpec(SUMMARY_SPEC, parsed.envelope.params);
  if (bad) return { ok: false, code: 'summary_invalid' };
  return { ok: true, task, status: raw.status, text: parsed.envelope.params.text };
}

/**
 * 結果を取り込む。戻り値：{ code: 'not_connected' } か { code: 'collected', recorded, already, rejected: [{ file, code }] }。
 * 同じ結果の取り込み直しは already（記録も監査も増やさない）。拒否した file は毎回数える（Hermes の場所なので動かさない）
 */
export function collectHermesResults({ store, config, now = Date.now() }) {
  const dir = config?.hermes_outbox;
  if (!usableDir(dir)) return { code: 'not_connected' };
  const out = { code: 'collected', recorded: 0, already: 0, rejected: [] };
  const marks = store.path('hermes-collected');
  mkdirSync(marks, { recursive: true, mode: 0o700 });
  const names = readdirSync(dir).filter((f) => f.endsWith('.json') && TASK_ID_RE.test(f.slice(0, -5))).sort();
  // 1 回に読む数の上限（2026-11-10 監査 F6）：拒否した file は動かさない（Hermes の場所）ので、数を限らないと毎回すべてを読み直す
  let read = 0;
  for (const name of names) {
    const taskId = name.slice(0, -5);
    const mark = path.join(marks, taskId);
    if (existsSync(mark)) { out.already += 1; continue; } // 取り込み済みの task の file はもう読まない
    if (read >= MAX_RESULTS_PER_RUN) { out.overflow = (out.overflow ?? 0) + 1; continue; } // 残りは次の回（数だけ返す）
    read += 1;
    const r = checkResult(dir, name, store);
    if (!r.ok) { out.rejected.push({ file: name, code: r.code }); continue; }
    const id = `hermes:${r.task.task_id}`;
    // 監査を先に（記録だけあって監査の無い形を作らない）→ 記録 → 印。途中で止まると次の回にもう一度記録しうる（notes は id ごとに最後の行を採る＝1 件に見える）
    store.audit({ task_id: r.task.task_id, event: 'hermes_result', code: r.status === 'done' ? 'hermes_done' : 'hermes_failed' }, now);
    if (!store.readRecords(r.task.business, 'notes').has(id)) {
      store.appendRecords(r.task.business, 'notes', [{ id, at: new Date(now).toISOString(), text: r.text, from: 'hermes', status: r.status, task_id: r.task.task_id }]);
    }
    closeSync(openSync(mark, 'wx', 0o600));
    out.recorded += 1;
  }
  return out;
}
