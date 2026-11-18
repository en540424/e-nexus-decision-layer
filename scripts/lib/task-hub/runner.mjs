/**
 * Task Hub の runner（2026-11-09・MA-24）。queued と時刻の来た retry_wait を、lock を取って 1 件ずつ handler に渡す。常駐しない（呼ばれた時に 1 回回って終わる）。
 *
 * 約束：
 *   - 同じ task を黙って 2 回走らせない。running のまま lease が切れた task は、handler が resumable なら checkpoint を残して queued に戻し、
 *     そうでなければ stopped（interrupted_not_resumable＝Human が見る）。
 *   - 機能ごとの回路遮断（2026-11-18）：handler に group（'dropbox'）が在れば、その想定外の失敗（資格情報・障害）は Task Hub 全体の連続回数に数えず、機能ごとに数える。
 *     連続 failureLimit 回で、その機能の task を GROUP_COOLDOWN_MS の間、始めずに failed（<group>_suspended）で返す。Task Hub 全体の PAUSE にしない
 *     （Dropbox の資格情報が切れた・Dropbox が落ちたことで、状況の確認・承認待ち・Hermes まで止めない）。期限が過ぎた次の task が 1 件試され、成功で 0 に戻る。
 *     止めている間、Human が承認済みの task は失敗にせず先送り（queued のまま・承認を無駄にしない）
 *   - 実行の直前に必ず確かめ直す：台帳・config が変わっていないか／承認が要る task は digest と期限が合うか（違えば承認待ちに戻す）／handler があるか（無ければ blocked/no_handler）。
 *   - 回路遮断：想定外の handler の失敗が連続 failureLimit 回（既定 3）になったら PAUSE を書いて止まる。連続回数は store に残り、run の呼び出しをまたいで数える（成功で 0）。PAUSE があれば何もしない（消すのは Human）。
 *   - 1 回の回しの時間の予算（budgetMs・2026-11-18）：残りの時間に「次の task の timeout ＋猶予」が入らなければ、その task は始めずに次の回へ回す（先送りは失敗ではない）。
 *     呼び出し側（5 分の回）は run を時間切れで強制終了する＝handler が走っている途中で殺すと、再開できない handler の task が stopped になる。Dropbox の handler の timeout は
 *     30〜60 秒＝--max 5 件が重なれば 120 秒の枠を越えうる。最初の 1 件は予算より長い timeout でも必ず走る（永久に走れない task を作らない）
 *   - handler は process を起こさず通信しない。timeout は AbortSignal（handler が聞かなくても runner は timeout で先へ進み、結果は捨てる）。
 *     同期の handler は timer が回る前に終わるので、戻った後の実時間（performance.now）も測り、timeout_ms を超えていたら timeout として扱う（結果は捨てて retry の道）。
 */
import { approvalProblem, currentDigest, needsApproval } from './approval.mjs';
import { MAX_BODY_BYTES } from './wire.mjs';

export const DEFAULT_GRACE_MS = 5_000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 3_600_000;
export const AWAITING_EXPIRY_MS = 7 * 86_400_000;
export const GROUP_COOLDOWN_MS = 15 * 60_000;
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

export async function runOnce({ store, policy, handlers, config = policy?.config ?? {}, now, maxTasks = 10, graceMs = DEFAULT_GRACE_MS, failureLimit = 3, backoffBaseMs = BACKOFF_BASE_MS, budgetMs = null } = {}) {
  const clock = typeof now === 'function' ? now : () => (Number.isFinite(now) ? now : store.now());
  const summary = { ran: [], skipped: null, recovered: [], paused: false, deferred: 0 };
  const deadline = Number.isFinite(budgetMs) && budgetMs > 0 ? clock() + budgetMs : null;
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
    // 機能ごとの停止の期間か。期限が「今＋期間」より先＝壊れた印・時計の飛び＝止めない（永久に止めない）
    const suspendedNow = (g) => { const u = Date.parse(store.groupBreaker(g).until ?? ''); return Number.isFinite(u) && u > clock() && u <= clock() + GROUP_COOLDOWN_MS + 60_000; };
    const all = [...store.listTasks({ state: 'queued' }), ...store.listTasks({ state: 'retry_wait' }).filter((t) => Date.parse(t.next_try_at) <= clock())];
    // 止めている機能の承認済みの task は先に外す（先頭に居座って maxTasks の枠を使い切り、他の機能の task を止めない）
    // 先送りにするのは、承認済みの task と、再試行の途中（retry_wait＝回数が残っている）の task。新しく来た読む依頼などは、待たせずに理由を返す（下）
    const waitingGroup = (t) => typeof handlers[t.handler]?.group === 'string' && (needsApproval(t) || t.state === 'retry_wait') && suspendedNow(handlers[t.handler].group);
    summary.deferred += all.filter(waitingGroup).length;
    const due = all.filter((t) => !waitingGroup(t)).slice(0, maxTasks);
    let consecutive = store.breakerCount(); // 前の回から続く想定外の失敗
    let startedAny = false; // 予算の「最初の 1 件は必ず走る」は、handler を実際に始めた時だけ（blocked・停止で返した task は数えない）
    for (const t0 of due) {
      if (store.isPaused()) { summary.paused = true; break; }
      if (typeof release.owns === 'function' && !release.owns()) { summary.skipped = 'lock_lost'; break; } // 長く止まっていた間に lock を奪われた：もう 1 件も走らせない（別の runner と二重に実行しない）
      let t = store.readTask(t0.task_id); // 読み直す（別の process が動かしていないか）
      if (!t || !['queued', 'retry_wait'].includes(t.state)) continue;
      // 時間の予算：この task の timeout ＋猶予が残りに入らなければ始めない（queued のまま次の回へ。最初の 1 件は必ず走る）
      if (deadline !== null && startedAny && clock() + t.timeout_ms + graceMs > deadline) { summary.deferred += 1; continue; }
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

      // 機能ごとの回路遮断の期間中は、その機能の task を始めない（外の機能が壊れている間に叩き続けない・他の機能は止めない）
      const group = typeof handler.group === 'string' ? handler.group : null;
      if (group) {
        if (suspendedNow(group)) {
          // Human が承認した task（見積の AI 作業版など）は失敗にしない＝承認を無駄にせず、queued のまま期間の後に走る（承認の期限は実行の直前に見直す）。読む依頼などは、待たせずに理由を返す
          if (needsApproval(t) || t.state === 'retry_wait') { summary.deferred += 1; continue; }
          stop('failed', `${group}_suspended`, 'group_suspended');
          continue;
        }
      }
      // running（lease は timeout ＋猶予）
      const started = clock();
      if (typeof release.owns === 'function' && !release.owns()) { summary.skipped = 'lock_lost'; break; }
      startedAny = true;
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
        if (group) store.setGroupBreaker(group, {}); // その機能が動いた：機能ごとの数えを戻す。全体の連続回数（他の機能の失敗）は動かさない
        else { consecutive = 0; store.setBreakerCount(0); }
        continue;
      }
      let groupOpened = false;
      if (!err.expected && group) {
        // 同じ task の再試行（1 つの依頼が 3 回失敗）は 1 回に数える＝1 つの変な依頼で機能ごと止めない。別の task が続けて失敗した時に数える
        const cur = store.groupBreaker(group);
        const n = cur.last === t.task_id ? cur.count : cur.count + 1;
        groupOpened = n >= failureLimit;
        // 開いた時は count を limit-1 にしておく＝期間の後に試す 1 件が失敗すれば、すぐ開き直す（3 回やり直さない）
        store.setGroupBreaker(group, groupOpened ? { count: failureLimit - 1, until: iso(at + GROUP_COOLDOWN_MS), last: t.task_id } : { count: n, until: cur.until, last: t.task_id });
      } else if (!err.expected) { consecutive += 1; store.setBreakerCount(consecutive); }
      if (err.retryable && t.attempts < t.max_attempts) {
        const wait = Math.min(backoffBaseMs * 2 ** (t.attempts - 1), BACKOFF_MAX_MS);
        t = store.transition(t.task_id, 'retry_wait', { event: 'retry_scheduled', code: err.code, patch: { next_try_at: iso(at + wait), lease_until: null }, at });
      } else {
        // params の形の誤りで終わった時は、台帳の呼び方の 1 行を添える（依頼元の Bot が自分で直せる・2026-11-16）
        const hint = /^params_/.test(err.code) ? policy?.entry?.(t.intent)?.usage : undefined;
        t = store.transition(t.task_id, 'failed', { event: 'failed', code: err.code, hint, patch: { lease_until: null }, at });
      }
      push(t, err.code);
      if (groupOpened) summary.group_suspended = [...(summary.group_suspended ?? []), group];
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
