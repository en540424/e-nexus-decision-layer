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
import { AdapterUnavailableError } from './errors.mjs';
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

export async function runFallbackChain({ chain, decisionType, input, candidates, context, thresholds }) {
  const trace = [];
  let best = null;

  const finish = (entry) => {
    entry.attempt.final = true;
    for (const t of trace) if (t !== entry.attempt && t.status === 'ok') t.continue_reason ??= 'CONFIDENCE_TIER_HUMAN';
    return { chosen: entry, trace, fallback_occurred: trace.length > 1 };
  };

  for (const adapter of chain) {
    const started = Date.now();
    try {
      const raw = await adapter.decide({ decisionType, input, candidates, context });
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
      if (tier !== 'human' || adapter.kind === 'human') return finish(entry);
    } catch (err) {
      trace.push(buildFailedAttempt({ adapter, err, ms: Date.now() - started }));
    }
  }
  // ここに来るのは human adapter が未登録のときだけ（router が終端に human を足すので通常は到達しない）
  if (best) return finish(best);
  return { chosen: null, trace, fallback_occurred: trace.length > 1 };
}
