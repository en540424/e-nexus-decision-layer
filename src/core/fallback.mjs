/**
 * Fallback：Router が決めた chain を順に試し、最初に「使える結果」を返した Adapter で確定する。
 * - AdapterUnavailableError / 例外 → trace に記録して次へ
 * - 結果の confidence が tier 'human' 相当でも、chain の途中なら次の Adapter を試す（低確信で止めない）
 * - chain を使い切ったら human adapter の結果（escalation）
 */
import { AdapterUnavailableError } from './errors.mjs';
import { assertAdapterResult } from '../adapters/adapter-interface.mjs';
import { tierFor } from './confidence.mjs';

export async function runFallbackChain({ chain, decisionType, input, candidates, context, thresholds }) {
  const trace = [];
  let best = null;

  for (const adapter of chain) {
    const started = Date.now();
    try {
      const result = assertAdapterResult(adapter.id, await adapter.decide({ decisionType, input, candidates, context }));
      const tier = tierFor(result.confidence, thresholds);
      trace.push({ adapter: adapter.id, status: 'ok', confidence: result.confidence, tier, ms: Date.now() - started });
      const entry = { adapter, result, tier };
      // 最良の結果は保持しつつ、auto/review に達したら確定。human 相当なら次の Adapter へ
      if (!best || result.confidence > best.result.confidence) best = entry;
      if (tier !== 'human' || adapter.kind === 'human') return { chosen: entry, trace, fallback_occurred: trace.length > 1 };
    } catch (err) {
      const reason = err instanceof AdapterUnavailableError ? err.details.reason : `ERROR:${err.message}`;
      trace.push({ adapter: adapter.id, status: 'unavailable', reason, ms: Date.now() - started });
    }
  }
  // ここに来るのは human adapter が未登録のときだけ（router が終端に human を足すので通常は到達しない）
  return { chosen: best, trace, fallback_occurred: trace.length > 1 };
}
