/**
 * Fallback：Router が決めた chain を順に試し、最初に「使える結果」を返した Adapter で確定する。
 * - AdapterUnavailableError / 例外 → trace に記録して次へ
 * - 結果の confidence が tier 'human' 相当でも、chain の途中なら次の Adapter を試す（低確信で止めない）
 * - chain を使い切ったら human adapter の結果（escalation）
 *
 * attempt record（2026-09-19 Intermediate Adapter Metering）:
 *   trace の1要素 = 「adapter.decide() を1回呼んだ」記録（attempt）。final decision とは別概念で、
 *   final が human でも途中で実際に呼んだ provider の usage / confidence / latency をここで失わない。
 *   同じ record を fallback 表示（result.fallback.trace）と metering（usage.jsonl の attempts[]）が共用する
 *   （二重管理しない。metering.mjs の attemptsFromTrace() は射影だけ）。
 *
 *   {
 *     adapter, status: 'ok'|'unavailable',
 *     provider, model, route,                  // model は AdapterResult.model（実応答のモデルID）があれば優先
 *     confidence, tier,                        // ok のみ
 *     reason,                                  // unavailable のみ
 *     ms, latency_ms,                          // 同値（ms は既存互換、latency_ms が正式名）
 *     networked: true|false|null,              // 外部 provider へ実際にリクエストを送ったか。null=不明（generic error）
 *     usage_known: boolean,                    // false のとき tokens/cost は null（0 と混同しない）
 *     input_tokens, output_tokens, estimated_cost_usd_micros,   // usage_known=false なら null
 *     retry_count: number|null,                // provider 内部の再試行回数（取得できた場合のみ。1 attempt=1 decide() 呼び出し）
 *     model_version, evidence,                 // 任意（2026-09-29）：AdapterResult が持つときだけ。実版（取れなければ null）と観測用記録
 *     final: boolean,                          // この attempt が decision を確定したか
 *     continue_reason,                         // ok だが final でない（tier human で chain 継続）ときだけ
 *   }
 *
 *   networked の決め方（core は Jev を知らない）:
 *     ok         → AdapterResult.networked（boolean）。無ければ null（不明）
 *     unavailable→ AdapterUnavailableError.details.networked（boolean。null=不明も明示可）。無ければ false
 *                  （事前ゲート・rules 不一致・stub は送信していない。送信後に失敗する箇所は throw 側が true を付ける）
 *     generic error → null（送信したか判断できない）
 *   「送っていない」と確定できるときだけ cost 0 を known として書く。送った可能性があるのに usage が無ければ unknown。
 */
import { AdapterUnavailableError, DecisionAbortedError, abortReasonOf } from './errors.mjs';
import { assertAdapterResult } from '../adapters/adapter-interface.mjs';
import { tierFor } from './confidence.mjs';

const UNKNOWN_USAGE = Object.freeze({ usage_known: false, input_tokens: null, output_tokens: null, estimated_cost_usd_micros: null });
const ZERO_USAGE = Object.freeze({ usage_known: true, input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0 });

function usageFields(usage, networked) {
  if (usage && typeof usage === 'object') {
    return {
      usage_known: true,
      input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      estimated_cost_usd_micros: typeof usage.estimated_cost_usd_micros === 'number' ? usage.estimated_cost_usd_micros : 0,
    };
  }
  // usage が無い：送っていないと確定できれば 0（known）、送った／不明なら unknown
  return networked === false ? { ...ZERO_USAGE } : { ...UNKNOWN_USAGE };
}

function retryCountOf(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/** ok 結果の attempt record */
export function buildOkAttempt({ adapter, result, tier, ms }) {
  const networked = typeof result.networked === 'boolean' ? result.networked : null;
  return {
    adapter: adapter.id,
    status: 'ok',
    provider: adapter.provider ?? null,
    model: typeof result.model === 'string' && result.model ? result.model : (adapter.model ?? null),
    route: typeof result.route === 'string' ? result.route : null,
    confidence: result.confidence,
    tier,
    ms,
    latency_ms: ms,
    networked,
    ...usageFields(result.usage, networked),
    retry_count: retryCountOf(result.retry_count),
    // 観測用（tier には使わない）。adapter が key を返したときだけ付ける（rules / human 等の record は従来どおり）
    ...('model_version' in result ? { model_version: typeof result.model_version === 'string' ? result.model_version : null } : {}),
    ...(result.evidence && typeof result.evidence === 'object' ? { evidence: result.evidence } : {}),
    final: false,
  };
}

/** 失敗（unavailable / generic error）の attempt record */
export function buildFailedAttempt({ adapter, err, ms }) {
  const unavailable = err instanceof AdapterUnavailableError;
  const d = unavailable ? err.details : {};
  const reason = unavailable ? d.reason : `ERROR:${err.message}`;
  let networked;
  if (typeof d.networked === 'boolean' || d.networked === null) networked = d.networked; // throw 側が明示（null=不明も明示できる）
  else networked = unavailable ? false : null;
  return {
    adapter: adapter.id,
    status: 'unavailable',
    provider: adapter.provider ?? null,
    model: adapter.model ?? null,
    route: typeof d.route === 'string' ? d.route : null,
    reason,
    ms,
    latency_ms: ms,
    networked,
    ...usageFields(null, networked),
    retry_count: retryCountOf(d.retry_count),
    final: false,
  };
}

/**
 * signal（任意・2026-09-29 FB-01）：呼び出し元（Gateway の timeout・client 切断）が abort したら、以降の Adapter を呼ばずに
 * DecisionAbortedError を投げる（details.trace＝それまでの attempt。送信済みの Jev 等の usage を metering で失わないため）。
 * in-flight の Adapter には decide({ ..., signal }) で渡す（signal を使わない Adapter はそのまま完了してよい）。
 */
/**
 * costLimitUsdMicros（任意・2026-09-29 FB-14）：policies/cost/limits.json の per_decision_estimated_cost_usd_micros_max。数値のときだけ、
 * estimateCost() を持つ Adapter を呼ぶ前に「この判定で既に使った既知の費用＋その Adapter の見積もり」を上限と比べ、超えるなら呼ばずに
 * COST_GATE_ESTIMATE_OVER_LIMIT（networked:false＝送っていない・費用 0 が確定）で次の Adapter へ進む。null は強制しない（記録だけ）。
 */
export async function runFallbackChain({ chain, decisionType, input, candidates, context, thresholds, signal, costLimitUsdMicros = null }) {
  const trace = [];
  let best = null;
  const abortIfNeeded = () => {
    if (signal?.aborted) throw new DecisionAbortedError(abortReasonOf(signal), { trace });
  };

  const finish = (entry) => {
    entry.attempt.final = true;
    for (const t of trace) if (t !== entry.attempt && t.status === 'ok') t.continue_reason ??= 'CONFIDENCE_TIER_HUMAN';
    return { chosen: entry, trace, fallback_occurred: trace.length > 1 };
  };

  const spentSoFar = () => trace.reduce((a, t) => a + (t.usage_known === true ? (t.estimated_cost_usd_micros ?? 0) : 0), 0);
  for (const adapter of chain) {
    abortIfNeeded();
    const started = Date.now();
    let done = null;
    if (typeof costLimitUsdMicros === 'number' && typeof adapter.estimateCost === 'function') {
      let estimate = null;
      try { estimate = await adapter.estimateCost({ decisionType, input, candidates }); } catch { estimate = null; }
      // 見積もれない有料 Adapter は上限を守れると言えないので呼ばない（fail-closed）
      if (typeof estimate !== 'number' || !Number.isFinite(estimate) || spentSoFar() + estimate > costLimitUsdMicros) {
        const err = new AdapterUnavailableError(adapter.id, typeof estimate === 'number' ? 'COST_GATE_ESTIMATE_OVER_LIMIT' : 'COST_GATE_ESTIMATE_UNAVAILABLE', { networked: false });
        trace.push(buildFailedAttempt({ adapter, err, ms: Date.now() - started }));
        continue;
      }
    }
    try {
      const raw = await adapter.decide({ decisionType, input, candidates, context, ...(signal ? { signal } : {}) });
      let result;
      try {
        result = assertAdapterResult(adapter.id, raw);
      } catch (err) {
        // 形が不正でも「送信した」事実（AdapterResult.networked）は失わない
        if (err instanceof AdapterUnavailableError && typeof raw?.networked === 'boolean') err.details.networked ??= raw.networked;
        throw err;
      }
      const tier = tierFor(result.confidence, thresholds);
      const attempt = buildOkAttempt({ adapter, result, tier, ms: Date.now() - started });
      trace.push(attempt);
      const entry = { adapter, result, tier, attempt };
      // 最良の結果は保持しつつ、auto/review に達したら確定。human 相当なら次の Adapter へ
      if (!best || result.confidence > best.result.confidence) best = entry;
      if (tier !== 'human' || adapter.kind === 'human') done = entry;
    } catch (err) {
      trace.push(buildFailedAttempt({ adapter, err, ms: Date.now() - started }));
    }
    // abort 後に届いた結果（signal を無視する Adapter）で decision を確定しない。human への escalation も作らない
    abortIfNeeded();
    if (done) return finish(done);
  }
  // ここに来るのは human adapter が未登録のときだけ（router が終端に human を足すので通常は到達しない）
  if (best) return finish(best);
  return { chosen: null, trace, fallback_occurred: trace.length > 1 };
}
