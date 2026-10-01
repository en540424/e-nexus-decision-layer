/**
 * Gateway の envelope を Agent の次の行動へ写す参照実装（Agent Integration Contract・Vault MA-32-5・2026-10-02）。
 * 新しい Node consumer はこの file をコピーして持つ（repo をまたぐ runtime import はしない：docs/gateway.md §9-4）。
 * cases：consumer-kit/conformance/interpretation-cases.json（Python 版 consumer-kit/python/enexus_interpret.py と同じ結果）。
 *
 * next：candidate（tier auto＝次の段階の候補。許可ではない）／review（Advisor 相談か Human 確認）／human（Human へ返す）／stop（進めない）
 * approval は常に false。緩める方向の解釈はしない（迷ったら human）。
 */
const APPROVAL_KEYS = /^(approved|approval|approve|authorized|authorize|allow_execution|bypass_human_gate|skip_human_review)$/i;

export function interpretEnvelope(envelope, { expectedEnvironment = 'dev' } = {}) {
  const human = (reason) => ({ next: 'human', approval: false, reason });
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return human('invalid_envelope');
  if (envelope.contract_version !== '1') return human('unsupported_contract_version');
  if (envelope.ok !== true) {
    if (envelope.failure?.policy === 'deny') return { next: 'stop', approval: false, reason: 'failure_policy_deny' };
    return human('decision_unavailable');
  }
  const d = envelope.decision;
  if (!d || typeof d !== 'object') return human('decision_missing');
  if (envelope.gateway?.environment !== expectedEnvironment) return human('environment_mismatch');
  if (d.outcome && typeof d.outcome === 'object' && Object.keys(d.outcome).some((k) => APPROVAL_KEYS.test(k))) return human('approval_like_outcome');
  if (d.human_gate?.required === true) return human('human_gate_required');
  if (d.tier === 'human') return human('tier_human');
  if (d.tier === 'review') return { next: 'review', approval: false, reason: 'tier_review' };
  if (d.tier === 'auto') return { next: 'candidate', approval: false, reason: 'tier_auto' };
  return human('unknown_tier');
}
