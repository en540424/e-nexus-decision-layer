/**
 * Task Hub の承認（2026-11-09・MA-24）。承認できるのは Human だけ。Decision Layer も runner も承認しない。
 *
 * 守りの中身：端末（TTY）が無い呼び出し（agent・自動化・パイプ）は承認できない／確認コード（content_digest の先頭 12 桁。show で見る）を打つ＝見た内容に対する承認／
 * 承認は digest と 24 時間の期限つき。runner は実行の直前に digest が今の内容と同じか・期限内かを見て、違えば承認待ちに戻す。
 * 限界（正直に）：同じ OS ユーザーの別 process が pty を持てば TTY は満たせる。TTY と確認コードは「非対話の自動承認」を止めるもので、強い本人確認ではない。
 * より強い本人確認（別のユーザー・別の端末・鍵・生体）は Human の判断（docs/task-hub.md §6）。
 */
import { userInfo } from 'node:os';
import { contentDigest } from './envelope.mjs';

export const APPROVAL_TTL_MS = 24 * 3_600_000;
export const confirmCodeOf = (task) => String(task.content_digest).slice(0, 12);
/** 今の task の内容から計算し直した指紋（file が書き換えられていないか見る） */
export const currentDigest = (task) => contentDigest({ source: task.source, business: task.business, intent: task.intent, params: task.params });

/** 実行に Human の承認が要るか。human_required は常に。ai_check は Gateway が candidate と読んだ時だけ要らない */
export function needsApproval(task) {
  if (task.class === 'human_required' || task.class === 'forbidden') return true;
  return task.class === 'ai_check' && task.decision?.gateway?.next !== 'candidate';
}
/** 承認の状態の問題。null＝実行してよい。missing／digest_mismatch／expired */
export function approvalProblem(task, nowMs) {
  const a = task.approval;
  if (!a || typeof a.digest !== 'string') return 'missing';
  if (a.digest !== currentDigest(task)) return 'digest_mismatch';
  if (!(Date.parse(a.expires_at) > nowMs)) return 'expired';
  return null;
}

function gate(store, id, { confirm, isTTY }, from = 'awaiting_approval') {
  if (isTTY !== true) return { ok: false, code: 'tty_required' };
  let task = null;
  try { task = store.readTask(id); } catch { /* 形の悪い id */ }
  if (!task) return { ok: false, code: 'not_found' };
  if (task.class === 'forbidden' || task.state === 'blocked') return { ok: false, code: 'not_approvable' };
  if (task.state !== from) return { ok: false, code: from === 'stopped' ? 'not_stopped' : 'not_awaiting' };
  if (currentDigest(task) !== task.content_digest) return { ok: false, code: 'digest_tampered' };
  if (typeof confirm !== 'string' || confirm !== confirmCodeOf(task)) return { ok: false, code: 'confirm_mismatch' };
  return { ok: true, task };
}

/** beforeRecord(task)：記録する直前（TTY・確認コードが通った後）に、承認する task を Human に見せる口。ここで見せた内容が承認の対象 */
export function approve(store, id, { confirm, actor = userInfo().username, isTTY = false, now = store.now(), beforeRecord = null } = {}) {
  const g = gate(store, id, { confirm, isTTY });
  if (!g.ok) return g;
  beforeRecord?.(g.task);
  const approval = { by: actor, at: new Date(now).toISOString(), digest: g.task.content_digest, expires_at: new Date(now + APPROVAL_TTL_MS).toISOString() };
  const t = store.transition(id, 'queued', { event: 'approved', patch: { approval }, at: now });
  return { ok: true, task: t };
}

export function reject(store, id, { confirm, actor = userInfo().username, isTTY = false, now = store.now() } = {}) {
  const g = gate(store, id, { confirm, isTTY });
  if (!g.ok) return g;
  const t = store.transition(id, 'rejected', { event: 'rejected_by_human', code: 'rejected_by_human', patch: { rejection: { by: actor, at: new Date(now).toISOString() } }, at: now });
  return { ok: true, task: t };
}

/** 止まった task（stopped＝中断で再開不可）を Human が確認して閉じる：stopped → failed（dismissed_by_human）。再実行はしない（出し直すなら新しい idempotency_key）。端末と確認コードが要る */
export function dismiss(store, id, { confirm, actor = userInfo().username, isTTY = false, now = store.now() } = {}) {
  const g = gate(store, id, { confirm, isTTY }, 'stopped');
  if (!g.ok) return g;
  const t = store.transition(id, 'failed', { event: 'dismissed_by_human', code: 'dismissed_by_human', patch: { dismissal: { by: actor, at: new Date(now).toISOString() } }, at: now });
  return { ok: true, task: t };
}
