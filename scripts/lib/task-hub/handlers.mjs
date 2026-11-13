/**
 * Task Hub の handler（2026-11-09・MA-24）。ここにあるものだけが無人で走りうる。どれも「読む・自分の記録に書く」だけ。
 * process を起こさない・通信しない・メールや予定を操作しない（そういう handler はそもそも無い。intents.json の handler: null の intent は承認されても blocked/no_handler）。
 *
 * handler の形：{ resumable, run({ task, store, config, signal, now }) → { result } }。result は JSON で 16 KiB まで。
 * 失敗は fail(code, { retryable, expected }) を throw する。expected: true は「想定内の終わり方」（休眠中・未設定）で、runner の連続失敗に数えない。
 */
import { closeSync, constants, existsSync, fchmodSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { readJsonSafe } from './safe-read.mjs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readBriefFile } from '../runtime-brief.mjs';
import { analyzeEvents, keepEvent, keepMail, morningReport, parseTime } from './digest.mjs';
import { jobStatus, RETRYABLE } from './hermes-jobs.mjs';

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

const LEVELS = new Set(['ok', 'warn', 'crit', 'unknown']);
const DAY_MS = 86_400_000;
/** その business の Hermes の業務の件数（実行待ち・実行中・24 時間で完了・うまくいかなかった）。値は返さない */
function hermesCounts(store, business, now) {
  const c = { waiting: 0, running: 0, done_24h: 0, problem_24h: 0 };
  for (const t of store.listTasks({ business })) {
    if (t.intent !== 'hermes.task' || t.state !== 'succeeded') continue;
    const s = jobStatus(store, t.task_id);
    const j = s === 'waiting' ? null : store.readHermesJob(t.task_id);
    const recent = j && now - Date.parse(j.updated_at) <= DAY_MS;
    if (s === 'waiting') c.waiting += 1;
    else if (s === 'running') c.running += 1;
    else if (s === 'done' && recent) c.done_24h += 1;
    else if ((s === 'failed' || RETRYABLE.has(s)) && recent) c.problem_24h += 1;
  }
  return c;
}
/** その business の Task Hub の件数（どの依頼元の分も件数だけ） */
function hubCounts(store, business, now) {
  const c = { awaiting_approval: 0, queued: 0, running: 0, failed_24h: 0, stopped: 0 };
  for (const t of store.listTasks({ business })) {
    if (t.state === 'awaiting_approval') c.awaiting_approval += 1;
    else if (t.state === 'queued' || t.state === 'retry_wait') c.queued += 1;
    else if (t.state === 'running') c.running += 1;
    else if (t.state === 'stopped') c.stopped += 1;
    else if (t.state === 'failed' && now - Date.parse(t.updated_at) <= DAY_MS) c.failed_24h += 1;
  }
  return c;
}

const statusQuery = ({ task, store, config, now }) => {
  if (!config.brief_path) throw fail('brief_not_configured', { expected: true });
  const r = readBriefFile(config.brief_path, { now: new Date(now) });
  // 値・項目名・文は返さない：水準・要確認の件数・生成時刻だけ
  const base = r.ok ? { available: true, overall: r.brief.overall, not_ok_count: r.brief.counts.open, generated_at: r.brief.generated_at } : { available: false, reason: String(r.reason).slice(0, 40) };
  if (task?.params?.detail !== true) return { result: base };
  // detail（2026-11-13）：区分ごとの水準だけ（runtime-brief の externalView と同じく文・日数・値は渡さない）と、その business の件数
  const sections = {};
  if (r.ok) for (const [k, v] of Object.entries(r.brief.sections ?? {})) if (/^[a-z_]{1,20}$/.test(k) && LEVELS.has(v?.level)) sections[k] = v.level;
  const cycle = readJsonSafe(store.path('cycle-last.json'), 4096);
  return {
    result: {
      ...base, ...(r.ok ? { monitor: r.brief.monitor, counts: r.brief.counts, sections } : {}),
      task_hub: hubCounts(store, task.business, now), hermes: hermesCounts(store, task.business, now),
      cycle: cycle && typeof cycle.code === 'string' ? { code: cycle.code.slice(0, 40), at: typeof cycle.at === 'string' ? cycle.at.slice(0, 40) : null } : null,
    },
  };
};

const VIEWS = Object.freeze({
  recent: () => true,
  awaiting_approval: (t) => t.state === 'awaiting_approval',
  failed: (t) => ['failed', 'blocked', 'stopped', 'expired', 'rejected'].includes(t.state),
  hermes: (t) => t.intent === 'hermes.task',
});
/** hermes.task の Hermes の状態（と結果の要約：その依頼元へ板で返したものと同じ文） */
function hermesOf(store, t) {
  if (t.intent !== 'hermes.task' || t.state !== 'succeeded') return undefined;
  const status = jobStatus(store, t.task_id);
  const note = store.readRecords(t.business, 'notes').get(`hermes:${t.task_id}`);
  return { status, ...(typeof note?.text === 'string' && (status === 'done' || status === 'failed') ? { summary: note.text } : {}) };
}

const taskStatus = ({ task, store }) => {
  const { task_ref: ref, view } = task.params;
  // どちらか 1 つ。依頼元の形の誤りは想定内（runner の連続失敗に数えない＝Bot の誤った呼び方 3 回で queue 全体を PAUSE にしない・2026-11-13 監査 F3）
  if ((ref === undefined) === (view === undefined)) throw fail('params_task_ref_or_view', { expected: true });
  if (view !== undefined) {
    // 自分（同じ依頼元・同じ business）の依頼だけ。他の依頼元の承認待ちは件数だけ（存在の詳細を教えない）
    const limit = Number.isInteger(task.params.limit) ? Math.min(Math.max(task.params.limit, 1), 20) : 10;
    const mine = store.listTasks({ business: task.business }).filter((t) => t.source === task.source && t.task_id !== task.task_id && VIEWS[view](t))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const items = mine.slice(0, limit).map((t) => {
      const h = hermesOf(store, t);
      return { task_ref: t.idempotency_key, intent: t.intent, state: t.state, updated_at: t.updated_at, ...(t.error?.code && t.state !== 'succeeded' ? { code: t.error.code } : {}), ...(h ? { hermes: h.status } : {}) };
    });
    const others = view === 'awaiting_approval' ? store.listTasks({ state: 'awaiting_approval', business: task.business }).filter((t) => t.source !== task.source).length : undefined;
    return { result: { view, total: mine.length, items, ...(others !== undefined ? { others_awaiting_approval: others } : {}) } };
  }
  const other = store.findByKey(task.source, ref); // 同じ依頼元の中でしか探せない
  // 無い・別の business は同じ答え not_found（存在を教えない）。自分自身の key を引けば found（state は running）
  if (!other || other.business !== task.business) return { result: { found: false, code: 'not_found' } };
  const h = hermesOf(store, other);
  return { result: { found: true, state: other.state, intent: other.intent, updated_at: other.updated_at, ...(other.error?.code ? { code: other.error.code } : {}), ...(h ? { hermes: h } : {}) } };
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
  const notes = [...store.readRecords(task.business, 'notes').values()];
  // Mac の稼働状況（水準と件数だけ・2026-11-13）。brief_path が無ければ行を出さない
  let system;
  if (config.brief_path) { const r = readBriefFile(config.brief_path, { now: new Date(now) }); system = r.ok ? { overall: r.brief.overall, open: r.brief.counts.open } : null; }
  return { result: morningReport({ business: task.business, mails, events, awaiting, now, offsetMin: config.utc_offset_minutes ?? 0, system, hermes: hermesCounts(store, task.business, now), notes }) };
};

const noteRecord = ({ task, store, now }) => {
  const have = store.readRecords(task.business, 'notes');
  if (!have.has(task.task_id)) store.appendRecords(task.business, 'notes', [{ id: task.task_id, at: iso(now), text: task.params.text, ...(task.params.case_ref ? { case_ref: task.params.case_ref } : {}) }]); // task_id が id：再実行しても 1 件
  return { result: { recorded: true } };
};

export function inboxModeSafe(st, platform = process.platform) {
  if ((st.mode & 0o007) !== 0) return false;
  if (platform === 'darwin' && st.gid === 20 && (st.mode & 0o070) !== 0) return false;
  return true;
}

/** 休眠中：設定された inbox のフォルダが「もう在る」時だけ、承認済みの依頼を 1 ファイル書く。フォルダは作らない */
const hermesTask = ({ task, config }) => {
  const dir = config.hermes_inbox;
  let ok = false;
  try { ok = Boolean(dir) && path.isAbsolute(dir) && !lstatSync(dir).isSymbolicLink() && statSync(dir).isDirectory(); } catch { ok = false; }
  if (!ok) throw fail('hermes_inbox_not_connected', { expected: true });
  const real = realpathSync(dir);
  // 承認済みの依頼の本文を、Hermes 以外の local user に読ませない（2026-11-10 監査 F14）：other に権限のあるフォルダ、
  // macOS で全員の group（staff＝gid 20）に読み・入る権限のあるフォルダには書かない（docs/hermes-work.md §4 の 3：専用の group にする）
  if (!inboxModeSafe(statSync(real))) throw fail('hermes_inbox_unsafe');
  const file = path.join(real, `${task.task_id}.json`);
  if (existsSync(file)) return { result: { delivered: true, already: true, hermes: { status: 'waiting' } } };
  const tmp = path.join(real, `.${task.task_id}.${randomBytes(4).toString('hex')}.tmp`);
  // 0640：inbox のフォルダの group（Human が hermes を入れた group にする。macOS は新しい file がフォルダの group を継ぐ）だけが読める。other は読めない
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
  try {
    fchmodSync(fd, 0o640); // umask に左右されない
    // 承認の記録は別の名前で渡す（受け側が「承認済み」の主張と読み違えないように、確かめる材料＝digest を添える）
    writeSync(fd, `${JSON.stringify({ v: 1, task_id: task.task_id, business: task.business, title: task.params.title, body: task.params.body, approval_record: task.approval ? { at: task.approval.at, digest: task.approval.digest } : null })}\n`);
  } finally { closeSync(fd); }
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* 済 */ } throw e; }
  // hermes.status：waiting＝渡した・まだ実行していない（実行・結果は hermes-jobs と結果の板の知らせで続きを返す。2026-11-13）
  return { result: { delivered: true, hermes: { status: 'waiting' } } };
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
