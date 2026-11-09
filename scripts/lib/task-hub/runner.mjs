/**
 * Task Hub の runner（2026-11-09・MA-24）。queued と時刻の来た retry_wait を、lock を取って 1 件ずつ handler に渡す。常駐しない（呼ばれた時に 1 回回って終わる）。
 *
 * 約束：
 *   - 同じ task を黙って 2 回走らせない。running のまま lease が切れた task は、handler が resumable なら checkpoint を残して queued に戻し、
 *     そうでなければ stopped（interrupted_not_resumable＝Human が見る）。
 *   - 実行の直前に必ず確かめ直す：台帳・config が変わっていないか／承認が要る task は digest と期限が合うか（違えば承認待ちに戻す）／handler があるか（無ければ blocked/no_handler）。
 *   - 回路遮断：想定外の handler の失敗が連続 failureLimit 回（既定 3）になったら PAUSE を書いて止まる。連続回数は store に残り、run の呼び出しをまたいで数える（成功で 0）。PAUSE があれば何もしない（消すのは Human）。
 *   - handler は process を起こさず通信しない。timeout は AbortSignal（handler が聞かなくても runner は timeout で先へ進み、結果は捨てる）。
 *     同期の handler は timer が回る前に終わるので、戻った後の実時間（performance.now）も測り、timeout_ms を超えていたら timeout として扱う（結果は捨てて retry の道）。
 */
import { approvalProblem, currentDigest, needsApproval } from './approval.mjs';
import { MAX_BODY_BYTES } from './wire.mjs';

export const DEFAULT_GRACE_MS = 5_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 3_600_000;
export const AWAITING_EXPIRY_MS = 7 * 86_400_000;
const CODE_RE = /^[a-z0-9_]{1,40}$/;
const iso = (ms) => new Date(ms).toISOString();

/** handler を timeout つきで走らせる。timeout は coded error（retryable）にする */
async function runWithTimeout(handler, ctx, timeoutMs) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(Object.assign(new Error('timeout'), { code: 'timeout', retryable: true }));
    }, timeoutMs);
  });
  const t0 = performance.now();
  try {
    const out = await Promise.race([Promise.resolve().then(() => handler.run({ ...ctx, signal: ac.signal })), timeout]);
    if (performance.now() - t0 > timeoutMs) throw Object.assign(new Error('timeout'), { code: 'timeout', retryable: true }); // 同期の handler が上限を超えて塞いだ
    return out;
  } finally { clearTimeout(timer); }
}

export async function runOnce({ store, policy, handlers, config = policy?.config ?? {}, now, maxTasks = 10, graceMs = DEFAULT_GRACE_MS, failureLimit = 3, backoffBaseMs = BACKOFF_BASE_MS } = {}) {
  const clock = typeof now === 'function' ? now : () => (Number.isFinite(now) ? now : store.now());
  const summary = { ran: [], skipped: null, recovered: [], paused: false };
  if (store.isPaused()) return { ...summary, skipped: 'paused', paused: true };
  let release;
  try { release = store.acquireRunLock(clock()); } catch (e) {
    if (e?.code === 'lock_conflict') return { ...summary, skipped: 'lock_conflict' }; // lock の持ち主が二重になりかけた（記録済み）：走らずに表へ出す
    throw e;
  }
  if (!release) return { ...summary, skipped: 'locked', lock_age_ms: store.runLockAgeMs(clock()) }; // lock_age_ms：持ち主が長すぎる時は CLI が失敗として見せる
  try {
    // 1) 前の回の置き土産：lease の切れた running と、長く待たれた承認待ち
    for (const t of store.listTasks({ state: 'running' })) {
      if (Date.parse(t.lease_until) > clock()) continue; // まだ生きている（別の runner の lease）：触らない
      const h = handlers[t.handler];
      if (h?.resumable === true && t.attempts < t.max_attempts) {
        store.transition(t.task_id, 'queued', { event: 'lease_expired_requeued', patch: { lease_until: null }, at: clock() });
        summary.recovered.push({ task_id: t.task_id, state: 'queued' });
      } else {
        store.transition(t.task_id, 'stopped', { event: 'lease_expired_stopped', code: 'interrupted_not_resumable', patch: { lease_until: null }, at: clock() });
        summary.recovered.push({ task_id: t.task_id, state: 'stopped' });
      }
    }
    for (const t of store.listTasks({ state: 'awaiting_approval' })) {
      if (clock() - Date.parse(t.updated_at) > AWAITING_EXPIRY_MS) store.transition(t.task_id, 'expired', { event: 'awaiting_expired', code: 'approval_timeout', at: clock() });
    }

    // 2) 走らせる
    const due = [...store.listTasks({ state: 'queued' }), ...store.listTasks({ state: 'retry_wait' }).filter((t) => Date.parse(t.next_try_at) <= clock())].slice(0, maxTasks);
    let consecutive = store.breakerCount(); // 前の回から続く想定外の失敗
    for (const t0 of due) {
      if (store.isPaused()) { summary.paused = true; break; }
      if (typeof release.owns === 'function' && !release.owns()) { summary.skipped = 'lock_lost'; break; } // 長く止まっていた間に lock を奪われた：もう 1 件も走らせない（別の runner と二重に実行しない）
      let t = store.readTask(t0.task_id); // 読み直す（別の process が動かしていないか）
      if (!t || !['queued', 'retry_wait'].includes(t.state)) continue;
      const push = (task, code) => summary.ran.push({ task_id: task.task_id, state: task.state, ...(code ? { code } : {}) });
      const stop = (state, code, event, patch = {}) => { t = store.transition(t.task_id, state, { event, code, patch, at: clock() }); push(t, code); };

      // 実行の直前の確かめ直し
      const re = policy ? policy.recheck(t) : { ok: true };
      if (!re.ok) { stop('blocked', re.code, 'recheck_failed'); continue; }
      if (t.class === 'forbidden') { stop('blocked', 'forbidden_intent', 'recheck_failed'); continue; }
      if (currentDigest(t) !== t.content_digest) {
        // 内容が保存した指紋と違う（params が書き換わった）：承認は無効。承認が要る task は新しい指紋で承認待ちに戻す
        if (needsApproval(t)) stop('awaiting_approval', 'content_changed', 'content_changed', { content_digest: currentDigest(t), approval: null });
        else stop('blocked', 'content_digest_mismatch', 'content_changed');
        continue;
      }
      if (needsApproval(t)) {
        const problem = approvalProblem(t, clock());
        if (problem) { stop('awaiting_approval', `approval_${problem}`, 'approval_invalid', { approval: null }); continue; }
      }
      const handler = t.handler ? handlers[t.handler] : null;
      if (!handler) { stop('blocked', t.handler ? 'handler_missing' : 'no_handler', 'no_handler'); continue; }

      // running（lease は timeout ＋猶予）
      const started = clock();
      if (typeof release.owns === 'function' && !release.owns()) { summary.skipped = 'lock_lost'; break; }
      t = store.transition(t.task_id, 'running', { event: 'started', patch: { attempts: t.attempts + 1, lease_until: iso(started + t.timeout_ms + graceMs), next_try_at: null }, at: started });
      let result;
      let err = null;
      try {
        const out = await runWithTimeout(handler, { task: t, store, config, now: started }, t.timeout_ms);
        result = out?.result;
        if (result === undefined || Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error('result_size'), { code: 'result_invalid' });
      } catch (e) {
        err = { code: CODE_RE.test(e?.code ?? '') ? e.code : 'handler_error', retryable: e?.retryable === true, expected: e?.expected === true };
      }
      const at = clock();
      if (!err) {
        t = store.transition(t.task_id, 'succeeded', { event: 'succeeded', patch: { result, error: null, lease_until: null }, at });
        push(t);
        consecutive = 0;
        store.setBreakerCount(0);
        continue;
      }
      if (!err.expected) { consecutive += 1; store.setBreakerCount(consecutive); }
      if (err.retryable && t.attempts < t.max_attempts) {
        const wait = Math.min(backoffBaseMs * 2 ** (t.attempts - 1), BACKOFF_MAX_MS);
        t = store.transition(t.task_id, 'retry_wait', { event: 'retry_scheduled', code: err.code, patch: { next_try_at: iso(at + wait), lease_until: null }, at });
      } else {
        t = store.transition(t.task_id, 'failed', { event: 'failed', code: err.code, patch: { lease_until: null }, at });
      }
      push(t, err.code);
      if (consecutive >= failureLimit) {
        store.pause('circuit_open', at);
        store.setBreakerCount(0); // Human が PAUSE を消した後は 0 から
        summary.paused = true;
        break;
      }
    }
    return summary;
  } finally { release(); }
}
