/**
 * Task Hub の handler（2026-11-09・MA-24）。ここにあるものだけが無人で走りうる。どれも「読む・自分の記録に書く」だけ。
 * process を起こさない・通信しない・メールや予定を操作しない（そういう handler はそもそも無い。intents.json の handler: null の intent は承認されても blocked/no_handler）。
 *
 * handler の形：{ resumable, run({ task, store, config, signal, now }) → { result } }。result は JSON で 16 KiB まで。
 * 失敗は fail(code, { retryable, expected }) を throw する。expected: true は「想定内の終わり方」（休眠中・未設定）で、runner の連続失敗に数えない。
 */
import { closeSync, constants, existsSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readBriefFile } from '../runtime-brief.mjs';
import { analyzeEvents, keepEvent, keepMail, morningReport, parseTime } from './digest.mjs';

export class HandlerError extends Error {
  constructor(code, { retryable = false, expected = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.expected = expected;
  }
}
export const fail = (code, opts) => new HandlerError(code, opts);

const iso = (ms) => new Date(ms).toISOString();
const sameRow = (a, b) => JSON.stringify({ ...a, ingested_at: 0 }) === JSON.stringify({ ...b, ingested_at: 0 });
const aborted = (signal) => { if (signal?.aborted) throw fail('aborted', { retryable: true }); };

/** 取り込み：id ごとに新規・更新・同じ、を数えて、変わった行だけ追記する。最後に保持（古い行・古い版・件数の上限）を適用して file を有限に保つ */
function ingestRows({ store, business, kind, items, now, keep, offsetMin = 0 }) {
  const prior = store.readRecords(business, kind);
  const batch = new Map();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const it of items) {
    const row = { ...it, ingested_at: iso(now) };
    const old = batch.get(it.id) ?? prior.get(it.id);
    if (!old) added += 1;
    else if (sameRow(old, row)) { unchanged += 1; continue; } else updated += 1;
    batch.set(it.id, row);
  }
  store.appendRecords(business, kind, [...batch.values()]);
  const pruned = store.compactRecords(business, kind, (r) => keep(r, now, offsetMin));
  return { added, updated, unchanged, pruned, merged: new Map([...prior, ...batch]) };
}

const statusQuery = ({ config, now }) => {
  if (!config.brief_path) throw fail('brief_not_configured', { expected: true });
  const r = readBriefFile(config.brief_path, { now: new Date(now) });
  // 値・項目名・文は返さない：水準・要確認の件数・生成時刻だけ
  if (!r.ok) return { result: { available: false, reason: String(r.reason).slice(0, 40) } };
  return { result: { available: true, overall: r.brief.overall, not_ok_count: r.brief.counts.open, generated_at: r.brief.generated_at } };
};

const taskStatus = ({ task, store }) => {
  const other = store.findByKey(task.source, task.params.task_ref); // 同じ依頼元の中でしか探せない
  // 無い・別の business は同じ答え not_found（存在を教えない）。自分自身の key を引けば found（state は running）
  if (!other || other.business !== task.business) return { result: { found: false, code: 'not_found' } };
  return { result: { found: true, state: other.state, intent: other.intent, updated_at: other.updated_at, ...(other.error?.code ? { code: other.error.code } : {}) } };
};

const mailIngest = ({ task, store, now, signal }) => {
  aborted(signal);
  const { added, updated, unchanged, pruned } = ingestRows({ store, business: task.business, kind: 'mail', items: task.params.items, now, keep: keepMail });
  const by_category = {};
  for (const it of task.params.items) by_category[it.category] = (by_category[it.category] ?? 0) + 1;
  return { result: { received: task.params.items.length, added, updated, unchanged, pruned, by_category } };
};

const calendarIngest = ({ task, store, config, now, signal }) => {
  aborted(signal);
  const off = config.utc_offset_minutes ?? 0;
  const { added, updated, unchanged, pruned, merged } = ingestRows({ store, business: task.business, kind: 'calendar', items: task.params.events, now, keep: keepEvent, offsetMin: off });
  // 古い予定は見ない（終わって 2 日以上）。照合の上限（件数・組）は analyzeEvents が持つ（取り込んだ予定を先に残す）
  const live = [...merged.values()].filter((e) => parseTime(e.end, off) >= now - 2 * 86_400_000);
  const { overlaps, duplicates, truncated } = analyzeEvents(live, { focus: new Set(task.params.events.map((e) => e.id)), offsetMin: off });
  return { result: { received: task.params.events.length, added, updated, unchanged, pruned, ...(truncated ? { analysis_truncated: true } : {}), overlap_count: overlaps.length, duplicate_count: duplicates.length, overlaps: overlaps.slice(0, 20), duplicates: duplicates.slice(0, 20) } };
};

const reportMorning = ({ task, store, config, now }) => {
  // この business の記録だけを読む（_recordFile が business で場所を決める＝他の business の場所は開かない）
  const mails = [...store.readRecords(task.business, 'mail').values()];
  const events = [...store.readRecords(task.business, 'calendar').values()];
  const awaiting = store.listTasks({ state: 'awaiting_approval', business: task.business }).length;
  return { result: morningReport({ business: task.business, mails, events, awaiting, now, offsetMin: config.utc_offset_minutes ?? 0 }) };
};

const noteRecord = ({ task, store, now }) => {
  const have = store.readRecords(task.business, 'notes');
  if (!have.has(task.task_id)) store.appendRecords(task.business, 'notes', [{ id: task.task_id, at: iso(now), text: task.params.text }]); // task_id が id：再実行しても 1 件
  return { result: { recorded: true } };
};

/** 休眠中：設定された inbox のフォルダが「もう在る」時だけ、承認済みの依頼を 1 ファイル書く。フォルダは作らない */
const hermesTask = ({ task, config }) => {
  const dir = config.hermes_inbox;
  let ok = false;
  try { ok = Boolean(dir) && path.isAbsolute(dir) && !lstatSync(dir).isSymbolicLink() && statSync(dir).isDirectory(); } catch { ok = false; }
  if (!ok) throw fail('hermes_inbox_not_connected', { expected: true });
  const real = realpathSync(dir);
  const file = path.join(real, `${task.task_id}.json`);
  if (existsSync(file)) return { result: { delivered: true, already: true } };
  const tmp = path.join(real, `.${task.task_id}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    // 承認の記録は別の名前で渡す（受け側が「承認済み」の主張と読み違えないように、確かめる材料＝digest を添える）
    writeSync(fd, `${JSON.stringify({ v: 1, task_id: task.task_id, business: task.business, title: task.params.title, body: task.params.body, approval_record: task.approval ? { at: task.approval.at, digest: task.approval.digest } : null })}\n`);
  } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* 済 */ } throw e; }
  return { result: { delivered: true } };
};

export const HANDLERS = Object.freeze({
  'status.query': { resumable: false, run: statusQuery },
  'task.status': { resumable: false, run: taskStatus },
  'mail.digest.ingest': { resumable: true, run: mailIngest }, // 同じ id は上書きなので、途中で止まっても再実行が安全
  'calendar.digest.ingest': { resumable: true, run: calendarIngest },
  'report.morning': { resumable: true, run: reportMorning }, // 読むだけ
  'note.record': { resumable: true, run: noteRecord }, // task_id で重複しない
  'hermes.task': { resumable: false, run: hermesTask }, // 外へ渡す：途中で止まったら二度書かない（Human が見る）
});
