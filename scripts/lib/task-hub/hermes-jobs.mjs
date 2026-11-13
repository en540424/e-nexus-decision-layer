/**
 * Hermes の 1 件実行の記録（2026-11-13・MA-24・docs/hermes-work.md §11）。Task Hub の task（hermes.task）は「inbox へ渡した」で succeeded になる。
 * その後の Hermes の実行は task の state ではなく、この記録（<store>/hermes-jobs/<task_id>.json）で追う。
 *
 *   （記録なし）= waiting     承認済みで inbox へ渡した・まだ実行していない
 *   running                   実行中（scripts/hermes-work.mjs が名前つきの排他 hermes-work を持っている間だけ）
 *   done / failed             Hermes の結果を collect-hermes が取り込んだ（failed は Hermes 自身の判断）。終わり。やり直さない（新しい依頼にする）
 *   timeout                   時間切れで止めた（結果の file が無い）
 *   no_result                 Hermes が結果を書かずに終わった
 *   result_rejected           結果の file が不信頼の形（collect-hermes が拒否）
 *   interrupted               running のまま実行の持ち主が居なくなった（強制終了・再起動）＝次の回で見つけて付け替える
 *                             （始めてから RUN_GRACE_MS の間と、run の印を持つ hermes の process が見える間は付け替えない＝まだ動いている実行を二重にしない）
 *   dismissed                 Human が実行せずに閉じた（hermes-work.mjs dismiss）。終わり
 *
 * timeout・no_result・result_rejected・interrupted は Human が `--retry` を付けた時だけもう 1 回実行する（有料。自動ではやり直さない＝二重の課金・二重の実行をしない）。
 * どの変化も監査（audit.jsonl）に 1 行（値は書かない）と、依頼元が人以外なら結果の板への知らせ（store.hermesNotice）を残す。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TASK_ID_RE } from './store.mjs';

export const WORK_LOCK = 'hermes-work';
/** 名前つきの排他の持ち主の最長（preflight＋実行の上限＋取り込み。これより長く持つ本物の持ち主は居ない） */
export const WORK_LOCK_MAX_AGE_MS = 15 * 60_000;
export const JOB_STATES = Object.freeze(['running', 'done', 'failed', 'timeout', 'no_result', 'result_rejected', 'interrupted', 'dismissed']);
export const FINAL = new Set(['done', 'failed', 'dismissed']);
/** running を置き土産と見なすまでの最短（hermes-work の実行の上限 120 秒＋止めるまで＋取り込み）。2026-11-13 独立監査 F6 */
export const RUN_GRACE_MS = 4 * 60_000;
export const RETRYABLE = new Set(['timeout', 'no_result', 'result_rejected', 'interrupted']);
/** 自動ではやり直さない上限（--retry を付けても、これ以上は新しい依頼にする） */
export const MAX_ATTEMPTS = 3;
const CODE_RE = /^[a-z0-9_]{1,40}$/;
const iso = (ms) => new Date(ms).toISOString();

/** task の Hermes の状態（記録が無ければ waiting）。hermes.task で渡し終えた task だけ意味がある */
export function jobStatus(store, taskId) {
  const j = store.readHermesJob(taskId);
  return j ? j.state : 'waiting';
}

function audit(store, taskId, event, code, at) {
  store.audit({ task_id: taskId, event, ...(code ? { code } : {}) }, at);
}

/**
 * 状態を変える（監査→記録→板の知らせ）。from に無い今の状態からは変えない（null を返す）。
 * patch は記録の field（usage・ended_at など）。値の文は入れない（code は固定の語だけ）
 */
function move(store, task, to, { from, event, code = null, at, patch = {}, notice = true }) {
  if (!JOB_STATES.includes(to)) throw new Error(`bad job state ${to}`);
  if (code !== null && !CODE_RE.test(code)) code = 'unknown';
  let moved = null;
  store.updateHermesJob(task.task_id, (cur) => {
    const state = cur ? cur.state : 'waiting';
    if (!from.includes(state)) return null;
    audit(store, task.task_id, event, code, at); // 監査を先に（記録だけあって監査の無い形を作らない）
    const base = cur ?? { v: 1, task_id: task.task_id, business: task.business, attempts: 0, history: [] };
    moved = {
      ...base, ...patch,
      ...(to === 'running' ? { attempts: base.attempts + 1, started_at: iso(at), ended_at: null } : { ended_at: iso(at) }),
      state: to, code, updated_at: iso(at),
      history: [...(base.history ?? []), { at: iso(at), state: to, ...(code ? { code } : {}) }].slice(-20),
    };
    return moved;
  });
  if (moved && notice) store.hermesNotice(task, { status: to, code }, at);
  return moved;
}

/** 実行を始める（waiting から。retry の時は RETRYABLE からも）。始められない時は null */
export function startJob(store, task, { at, retry = false, runToken = null }) {
  const from = retry ? ['waiting', ...RETRYABLE] : ['waiting'];
  const cur = store.readHermesJob(task.task_id);
  if (cur && cur.attempts >= MAX_ATTEMPTS) return null;
  return move(store, task, 'running', { from, event: 'hermes_started', at, patch: { run_token: typeof runToken === 'string' && /^[0-9a-f]{8,32}$/.test(runToken) ? runToken : null } });
}

/** Human が実行せずに閉じる（waiting と RETRYABLE から）。依頼元へ dismissed を返す */
export function dismissJob(store, task, { at }) {
  return move(store, task, 'dismissed', { from: ['waiting', ...RETRYABLE], event: 'hermes_dismissed', code: 'dismissed_by_human', at });
}

/** 結果の file が無いまま終わった（timeout・no_result）／結果が拒否された（result_rejected） */
export function endJobWithoutResult(store, task, { state, code = null, at, usage = null }) {
  if (!['timeout', 'no_result', 'result_rejected'].includes(state)) throw new Error(`bad end state ${state}`);
  return move(store, task, state, { from: ['running'], event: `hermes_${state}`, code: code ?? state, at, patch: usage ? { usage } : {} });
}

/** collect-hermes が結果を取り込んだ（done・failed）。どの状態からでも（遅れて届いた結果・手で置いた結果も記録の通りにする）。板の知らせは collect が summary つきで書く */
export function recordJobResult(store, task, { status, at, usage = null }) {
  const to = status === 'done' ? 'done' : 'failed';
  return move(store, task, to, { from: ['waiting', 'running', ...RETRYABLE], event: 'hermes_job_closed', code: `hermes_${to}`, at, patch: usage ? { usage } : {}, notice: false });
}

/** 実行の usage（数だけ）を記録に足す。値の文は入れない */
export function noteUsage(store, taskId, usage) {
  if (!usage) return null;
  return store.updateHermesJob(taskId, (cur) => (cur ? { ...cur, usage } : null));
}

/**
 * running のまま持ち主の居ない記録を interrupted にする。名前つきの排他 hermes-work を生きた持ち主が持っている間は何もしない
 * （本当に実行中）。呼び出し側が排他を持っている時は ownLock: true（自分以外の running は全部置き土産）
 */
export function recoverInterrupted(store, { at, ownLock = false, tasks = (id) => store.readTask(id), alive = () => false }) {
  if (!ownLock) {
    const o = store.namedLockOwner(WORK_LOCK);
    if (o?.alive && Number.isFinite(o.started_at) && at - o.started_at < WORK_LOCK_MAX_AGE_MS) return [];
  }
  const out = [];
  for (const j of store.listHermesJobs()) {
    if (j.state !== 'running') continue;
    // 持ち主（node）が殺されても、sudo の先の hermes は 120 秒まで動きうる：猶予の間と、印の process が見える間は付け替えない
    if (!(at - Date.parse(j.started_at) >= RUN_GRACE_MS) || alive(j)) continue;
    const task = tasks(j.task_id);
    if (!task) continue;
    const m = move(store, task, 'interrupted', { from: ['running'], event: 'hermes_interrupted', code: 'run_interrupted', at });
    if (m) out.push(j.task_id);
  }
  return out;
}

/**
 * 次に渡す 1 件を選ぶ。inbox の file（Task Hub の task id の名前）のうち、task が hermes.task で succeeded（渡し終えた）・
 * Hermes の状態が waiting のもの（retry なら taskId を指定した RETRYABLE のもの）・outbox にまだ結果の file が無いもの。古い順。
 * 戻り値：{ task } か { code }（nothing・not_found・not_hermes_task・not_delivered・already_final・not_retryable・retry_limit・result_waiting）
 */
export function selectNext(store, { inbox, outbox, taskId = null, retry = false, exists }) {
  const has = exists ?? existsSync;
  const check = (id, again) => {
    const task = store.readTask(id);
    if (!task) return { code: 'not_found' };
    if (task.intent !== 'hermes.task') return { code: 'not_hermes_task' };
    if (task.state !== 'succeeded') return { code: 'not_delivered' };
    if (!has(path.join(inbox, `${id}.json`))) return { code: 'not_delivered' };
    const j = store.readHermesJob(id);
    const state = j ? j.state : 'waiting';
    if (FINAL.has(state)) return { code: 'already_final' };
    if (state === 'running') return { code: 'running' };
    // 結果がもう在る＝取り込みを待つ（もう一度実行しない）。ただし記録しなかった結果（result_rejected）の file はやり直しの邪魔なので隔離を求める
    if (has(path.join(outbox, `${id}.json`))) return { code: state === 'result_rejected' && again ? 'rejected_result_present' : 'result_waiting' };
    if (state !== 'waiting') {
      if (!again) return { code: 'not_retryable' };
      if ((j?.attempts ?? 0) >= MAX_ATTEMPTS) return { code: 'retry_limit' };
    }
    return { task };
  };
  if (taskId) {
    if (!TASK_ID_RE.test(taskId)) return { code: 'not_found' };
    return check(taskId, retry);
  }
  let names = [];
  try { names = readdirSync(inbox).filter((f) => f.endsWith('.json') && TASK_ID_RE.test(f.slice(0, -5))).sort(); } catch { return { code: 'inbox_unreadable' }; }
  for (const f of names) {
    const r = check(f.slice(0, -5), false); // 自動で選ぶのは waiting だけ（やり直しは id を指定して --retry）
    if (r.task) return r;
  }
  return { code: 'nothing' };
}

/** 一覧（Human の確認用・runtime の要約用）。値は出さない */
export function summarizeJobs(store) {
  const counts = { running: 0, done: 0, failed: 0, timeout: 0, no_result: 0, result_rejected: 0, interrupted: 0, dismissed: 0 };
  for (const j of store.listHermesJobs()) if (counts[j.state] !== undefined) counts[j.state] += 1;
  return counts;
}

/** run の印（prompt の "run <token>"）を持つ hermes の process が見えるか（ps は他の user の引数も読める・sudo 不要）。見えなければ false */
export function pgrepAlive(job, { user = 'hermes', run } = {}) {
  if (!job?.run_token || !/^[0-9a-f]{8,32}$/.test(job.run_token)) return false;
  try {
    const r = (run ?? spawnSync)('/usr/bin/pgrep', ['-U', user, '-f', `run ${job.run_token}`], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0;
  } catch { return true; } // 確かめられない時は動いているとみなす（二重にしない側）
}
