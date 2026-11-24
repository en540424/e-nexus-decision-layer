/**
 * Task Hub の handler（2026-11-09・MA-24）。ここにあるものだけが無人で走りうる。どれも「読む・自分の記録に書く」だけ。
 * process を起こさない・メールや予定を操作しない（そういう handler はそもそも無い。intents.json の handler: null の intent は承認されても blocked/no_handler）。
 * 通信は Dropbox の業務の handler（business-handlers.mjs・2026-11-13）だけ：role ごとの資格情報（読みは書けない・書きは App folder の中だけ）と business ごとの許可フォルダ。
 *
 * handler の形：{ resumable, run({ task, store, config, signal, now }) → { result } }。result は JSON で 16 KiB まで。
 * 失敗は fail(code, { retryable, expected }) を throw する。expected: true は「想定内の終わり方」（休眠中・未設定）で、runner の連続失敗に数えない。
 */
import { closeSync, constants, existsSync, fchmodSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { readJsonSafe } from './safe-read.mjs';
import { RECORDS_FILE_MAX } from './store.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { readBriefFile } from '../runtime-brief.mjs';
import { analyzeEvents, keepEvent, keepMail, morningReport, parseTime } from './digest.mjs';
import { jobStatus, RETRYABLE } from './hermes-jobs.mjs';

import { fail, HandlerError } from './handler-error.mjs';
import { nextStepOf, nextStepsFor } from './next-step.mjs';
import { BUSINESS_HANDLERS } from './business-handlers.mjs';

export { fail, HandlerError };

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
  // 機能ごとの回路遮断（runner・2026-11-18）で止めている機能の名前だけ（Dropbox の資格情報・障害が続いた時。理由・時刻は返さない）
  const suspended = ['dropbox'].filter((g) => { const u = store.groupBreaker(g).until; return u && Date.parse(u) > now; });
  return {
    result: {
      ...base, ...(r.ok ? { monitor: r.brief.monitor, counts: r.brief.counts, sections } : {}),
      task_hub: hubCounts(store, task.business, now), hermes: hermesCounts(store, task.business, now),
      ...(suspended.length ? { suspended } : {}),
      cycle: cycle && typeof cycle.code === 'string' ? { code: cycle.code.slice(0, 40), at: typeof cycle.at === 'string' ? cycle.at.slice(0, 40) : null } : null,
    },
  };
};

const VIEWS = Object.freeze({
  recent: () => true,
  awaiting_approval: (t) => t.state === 'awaiting_approval',
  failed: (t) => ['failed', 'blocked', 'stopped', 'expired', 'rejected'].includes(t.state),
  succeeded: (t) => t.state === 'succeeded',
  hermes: (t) => t.intent === 'hermes.task',
});
/**
 * view の別名（2026-11-16）。依頼元は LLM の Bot で、台帳の語を知らないまま普通の語で呼ぶ：本番で `{}` と `{"view":"pending"}` が失敗した。
 * 意味が 1 つに決まる語だけを正式な view へ寄せる（結果の view は正式な語で返す）。台帳（intents.json）の enum は VIEWS と別名の和（test が照合する）
 */
export const VIEW_ALIASES = Object.freeze({
  pending: 'awaiting_approval', approval: 'awaiting_approval', awaiting: 'awaiting_approval',
  failure: 'failed', failures: 'failed', error: 'failed', errors: 'failed',
  success: 'succeeded', done: 'succeeded', completed: 'succeeded',
  all: 'recent', latest: 'recent',
});
export const VIEW_NAMES = Object.freeze(Object.keys(VIEWS));
export const VIEW_SUMMARY_ITEMS = 5;
export const VIEW_SUMMARY_CHARS = 200;
/** hermes.task の Hermes の状態（と結果の要約：その依頼元へ板で返したものと同じ文） */
function hermesOf(store, t) {
  if (t.intent !== 'hermes.task' || t.state !== 'succeeded') return undefined;
  const status = jobStatus(store, t.task_id);
  const note = store.readRecords(t.business, 'notes').get(`hermes:${t.task_id}`);
  return { status, ...(typeof note?.text === 'string' && (status === 'done' || status === 'failed') ? { summary: note.text } : {}) };
}

const taskStatus = ({ task, store }) => {
  const { task_ref: ref } = task.params;
  // 何も無い＝自分の依頼の新しい順（recent）。「さっきの仕事は？」を params なしで聞けるようにする（2026-11-16）
  const asked = task.params.view ?? (ref === undefined ? 'recent' : undefined);
  const view = asked === undefined ? undefined : (Object.hasOwn(VIEW_ALIASES, asked) ? VIEW_ALIASES[asked] : asked);
  // task_ref と view の両方は受けない（どちらを聞いたのか決められない）。依頼元の形の誤りは想定内（runner の連続失敗に数えない＝Bot の誤った呼び方 3 回で queue 全体を PAUSE にしない・2026-11-13 監査 F3）
  if (ref !== undefined && view !== undefined) throw fail('params_task_ref_or_view', { expected: true });
  if (view !== undefined && !Object.hasOwn(VIEWS, view)) throw fail('params_view_unknown', { expected: true }); // 台帳の enum が先に止める。台帳と食い違った時の 2 重
  if (view !== undefined) {
    // 自分（同じ依頼元・同じ business）の依頼だけ。他の依頼元の承認待ちは件数だけ（存在の詳細を教えない）
    const limit = Number.isInteger(task.params.limit) ? Math.min(Math.max(task.params.limit, 1), 20) : 10;
    const mine = store.listTasks({ business: task.business }).filter((t) => t.source === task.source && t.task_id !== task.task_id && VIEWS[view](t))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    // hermes の一覧は、新しい方から VIEW_SUMMARY_ITEMS 件だけ結果の要約の頭（VIEW_SUMMARY_CHARS 字）も返す（2026-11-18：「実行した仕事の結果は？」を 1 回の往復で答える。
    // 要約は collect-hermes の関所を通って、この依頼元へ task_ref で返している文と同じ。全文は task_ref で引く）。結果の上限 16 KiB に収まる大きさ
    let withSummary = 0;
    const items = mine.slice(0, limit).map((t) => {
      const h = hermesOf(store, t);
      const cut = view === 'hermes' && typeof h?.summary === 'string' && withSummary < VIEW_SUMMARY_ITEMS ? (withSummary += 1, h.summary) : null;
      return {
        task_ref: t.idempotency_key, intent: t.intent, state: t.state, updated_at: t.updated_at, ...(t.error?.code && t.state !== 'succeeded' ? { code: t.error.code } : {}), ...(h ? { hermes: h.status } : {}),
        ...(cut !== null ? { summary: [...cut].slice(0, VIEW_SUMMARY_CHARS).join(''), ...([...cut].length > VIEW_SUMMARY_CHARS ? { summary_truncated: true } : {}) } : {}),
      };
    });
    const others = view === 'awaiting_approval' ? store.listTasks({ state: 'awaiting_approval', business: task.business }).filter((t) => t.source !== task.source).length : undefined;
    // 失敗した項目の code ごとの「次にやること」（決まった文だけ・2026-11-24・next-step.mjs）
    const problems = items.filter((i) => OPS_PROBLEM.has(i.state));
    return { result: { view, total: mine.length, items, ...(problems.length ? { next_steps: nextStepsFor(problems) } : {}), ...(others !== undefined ? { others_awaiting_approval: others } : {}) } };
  }
  const other = store.findByKey(task.source, ref); // 同じ依頼元の中でしか探せない
  // 無い・別の business は同じ答え not_found（存在を教えない）。自分自身の key を引けば found（state は running）
  if (!other || other.business !== task.business) return { result: { found: false, code: 'not_found' } };
  const h = hermesOf(store, other);
  return { result: { found: true, state: other.state, intent: other.intent, updated_at: other.updated_at, ...(other.error?.code ? { code: other.error.code } : {}), ...(OPS_PROBLEM.has(other.state) ? { next: nextStepOf(other.error?.code, other.state) } : {}), ...(h ? { hermes: h } : {}) } };
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

/**
 * 現場の口述（2026-11-24・Human 決定 E）：原文・現場名・日付・入力の経路を、business の口述の記録（追記だけ・prune で消さない）へ。
 * Mac は構造化しない（寸法の抽出・確定は APP 側の karte-adapter の dictation-diff と Human）。同じ現場・同じ日・同じ文の出し直しは 1 件（duplicate）。
 * 結果に内部の ID（task の ID・記録の ID）を出さない（Human 決定 G）。返すのは現場名と日付だけ
 */
const DICTATION_FULL_BYTES = Math.floor(RECORDS_FILE_MAX * 0.8);
function recordDictation({ task, store, now }) {
  const p = task.params;
  const shown = { kind: 'dictation', ...(p.site ? { site: p.site } : {}), ...(p.recorded_on ? { recorded_on: p.recorded_on } : {}) };
  if (!p.site && !p.case_ref) throw fail('params_dictation_site', { expected: true });
  try { if (statSync(store._recordFile(task.business, 'dictation')).size > DICTATION_FULL_BYTES) throw fail('dictation_store_full'); } catch (e) { if (e instanceof HandlerError) throw e; }
  const digest = createHash('sha256').update(`${p.case_ref ?? ''}\n${p.site ?? ''}\n${p.recorded_on ?? ''}\n${p.text}`, 'utf8').digest('hex');
  const have = store.readRecords(task.business, 'dictation');
  if (have.has(task.task_id)) return { result: { recorded: true, ...shown } };
  if ([...have.values()].some((r) => r.digest === digest)) return { result: { recorded: true, duplicate: true, ...shown } };
  store.appendRecords(task.business, 'dictation', [{ id: task.task_id, at: iso(now), source: task.source, text: p.text, digest, channel: p.channel ?? 'unknown', ...(p.site ? { site: p.site } : {}), ...(p.case_ref ? { case_ref: p.case_ref } : {}), ...(p.recorded_on ? { recorded_on: p.recorded_on } : {}) }]);
  return { result: { recorded: true, ...shown } };
}

const noteRecord = ({ task, store, now }) => {
  if (task.params.kind === 'dictation') return recordDictation({ task, store, now });
  if (task.params.site !== undefined || task.params.recorded_on !== undefined || task.params.channel !== undefined) throw fail('params_dictation_only', { expected: true }); // 口述の項目はメモでは使わない（どちらのつもりか決められない）
  const have = store.readRecords(task.business, 'notes');
  if (!have.has(task.task_id)) store.appendRecords(task.business, 'notes', [{ id: task.task_id, at: iso(now), text: task.params.text, ...(task.params.case_ref ? { case_ref: task.params.case_ref } : {}) }]); // task_id が id：再実行しても 1 件
  return { result: { recorded: true } };
};

export function inboxModeSafe(st, platform = process.platform) {
  if ((st.mode & 0o007) !== 0) return false;
  if (platform === 'darwin' && st.gid === 20 && (st.mode & 0o070) !== 0) return false;
  return true;
}

export const OPS_CONTEXT_MAX_BYTES = 8 * 1024;
const OPS_WINDOW_MS = 7 * DAY_MS;
const OPS_PROBLEM = new Set(['failed', 'blocked', 'stopped', 'expired', 'rejected']);
export const OPS_MAX_CODE_KEYS = 20;
const OPS_CODE_RE = /^[a-z0-9_]{1,48}$/;
const CATALOG_FILE = fileURLToPath(new URL('../../../policies/task-hub/intents.json', import.meta.url));
let catalogNames = null;
/**
 * 台帳の intent の名前だけ（2026-11-18 監査 F1）。台帳に無い intent は依頼元（Bot）が書いた文字列なので、Hermes へ渡す状況には名前を出さず unknown_intent にする
 * （名前の形の検査には長さの上限が無い＝「指示」を名前に混ぜて、状況のデータとして Hermes に読ませられる）。読めなければ全部 unknown（投げない）
 */
function knownIntent(name) {
  if (catalogNames === null) { try { catalogNames = new Set(Object.keys(JSON.parse(readFileSync(CATALOG_FILE, 'utf8')).intents ?? {})); } catch { catalogNames = new Set(); } }
  return catalogNames.has(name) ? name : 'unknown_intent';
}
const opsCode = (c) => (typeof c === 'string' && OPS_CODE_RE.test(c) ? c : 'other');
/**
 * hermes.task の kind "ops_review"（2026-11-18）が Hermes へ渡す Task Hub の状況。渡す時（承認の後）に作る。
 * 入れるのは件数・state・code・intent・時刻だけ（依頼の params・summary・Hermes の結果の文・path・Secret は入れない）。
 * 一覧は task.status と同じ範囲＝同じ依頼元・同じ business の依頼だけ。他の依頼元の分は hubCounts の件数だけ。8 KiB に収まるまで一覧を減らす
 */
export function opsReviewContext({ task, store, config, now }) {
  let runtime = null;
  try { runtime = statusQuery({ task: { ...task, params: { detail: true } }, store, config, now }).result; } catch (e) { runtime = { available: false, reason: e instanceof HandlerError && OPS_CODE_RE.test(e.code ?? '') ? e.code : 'status_unavailable' }; }
  const mine = store.listTasks({ business: task.business })
    .filter((t) => t.source === task.source && t.task_id !== task.task_id && now - Date.parse(t.updated_at) <= OPS_WINDOW_MS)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const counted = {};
  for (const t of mine) if (OPS_PROBLEM.has(t.state)) { const k = `${t.state}:${opsCode(t.error?.code ?? 'none')}`; counted[k] = (counted[k] ?? 0) + 1; }
  // 多い順に OPS_MAX_CODE_KEYS 個まで（残りは other_codes に件数だけ・監査 F2）
  const ranked = Object.entries(counted).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byCode = Object.fromEntries(ranked.slice(0, OPS_MAX_CODE_KEYS));
  const otherCodes = ranked.slice(OPS_MAX_CODE_KEYS).reduce((n, [, v]) => n + v, 0);
  const row = (t) => {
    let h = null;
    let hermes;
    if (t.intent === 'hermes.task' && t.state === 'succeeded') {
      try { h = store.readHermesJob(t.task_id); hermes = h ? opsCode(h.state) : 'waiting'; } catch { hermes = 'unknown'; } // 壊れた記録 1 つで依頼全体を失敗にしない（監査 F8）
    }
    return {
      intent: knownIntent(t.intent), state: t.state, updated_at: t.updated_at, attempts: t.attempts,
      ...(t.error?.code && t.state !== 'succeeded' ? { code: opsCode(t.error.code) } : {}),
      ...(hermes !== undefined ? { hermes, ...(h?.code ? { hermes_code: opsCode(h.code) } : {}) } : {}),
    };
  };
  const paused = store.isPaused();
  const make = (n) => {
    const recent = mine.slice(0, n).map(row);
    return {
      kind: 'ops_review', generated_at: iso(now), window_days: 7, scope: 'same source and business; other sources as counts only',
      runtime, paused, problems_by_state_code: byCode, ...(otherCodes ? { other_codes: otherCodes } : {}), recent_total: mine.length, recent,
      ...(recent.length < mine.length ? { recent_truncated: true } : {}), // 一覧が全部でない時は必ず印（監査 F3）
    };
  };
  for (const n of [30, 15, 5, 0]) { const c = make(n); if (Buffer.byteLength(JSON.stringify(c), 'utf8') <= OPS_CONTEXT_MAX_BYTES) return c; }
  // ここに来るのは runtime が大きすぎる時だけ（code の数は上で限った）。水準と PAUSE は残す
  return { kind: 'ops_review', generated_at: iso(now), truncated: true, paused, runtime: runtime ? { available: runtime.available, overall: runtime.overall } : null };
}
const HERMES_CONTEXTS = Object.freeze({ ops_review: opsReviewContext });

/** 休眠中：設定された inbox のフォルダが「もう在る」時だけ、承認済みの依頼を 1 ファイル書く。フォルダは作らない */
const hermesTask = ({ task, store, config, now }) => {
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
  // 依頼の種類があれば、決まった形の状況を添える（作れなければ渡さない＝失敗で返す。種類の無い依頼は今までどおり）
  const kind = task.params.kind;
  let context;
  if (kind !== undefined) {
    if (!Object.hasOwn(HERMES_CONTEXTS, kind)) throw fail('params_kind_unknown', { expected: true });
    context = HERMES_CONTEXTS[kind]({ task, store, config, now });
  }
  const tmp = path.join(real, `.${task.task_id}.${randomBytes(4).toString('hex')}.tmp`);
  const doc = { v: 1, task_id: task.task_id, business: task.business, title: task.params.title, body: task.params.body, ...(kind !== undefined ? { kind, context } : {}), approval_record: task.approval ? { at: task.approval.at, digest: task.approval.digest } : null };
  // 0640：inbox のフォルダの group（Human が hermes を入れた group にする。macOS は新しい file がフォルダの group を継ぐ）だけが読める。other は読めない
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o640);
  try {
    fchmodSync(fd, 0o640); // umask に左右されない
    // 承認の記録は別の名前で渡す（受け側が「承認済み」の主張と読み違えないように、確かめる材料＝digest を添える）
    // 種類つきは行に分けて書く（状況で 1 行が長くなる＝読む側の 1 行の上限で切られないように・監査 F7）。種類の無い依頼は今までどおり 1 行
    writeSync(fd, `${kind !== undefined ? JSON.stringify(doc, null, 1) : JSON.stringify(doc)}\n`);
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
  ...BUSINESS_HANDLERS,
});
