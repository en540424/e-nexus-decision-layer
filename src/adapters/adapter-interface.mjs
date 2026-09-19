/**
 * Adapter Interface。
 * すべての判定エンジン（Jev / Rules / LLM / Local / Human）はこの契約に従う。
 * Decision Layer本体はこの契約だけを知り、Jev固有のAPI形式を知らない。
 *
 *   adapter = {
 *     id: 'jev' | 'mock-jev' | 'rules' | 'llm' | 'local' | 'human' | ...,
 *     kind: 'deterministic' | 'probabilistic' | 'human',
 *     provider: string|null,   // metering用（例: 'typesafe-ai', 'anthropic', null）
 *     model: string|null,      // metering用
 *     supports(decisionType) -> boolean,
 *     decide({ decisionType, input, candidates, context }) -> Promise<AdapterResult>
 *   }
 *
 *   AdapterResult = {
 *     outcome: object,            // decision_type schema の outcome に一致する型付き値
 *     confidence: number 0..1,    // deterministic は 1.0
 *     rationale?: string,
 *     usage?: { input_tokens?, output_tokens?, estimated_cost_usd_micros? }
 *   }
 *
 * 判定不能・接続不可・キー未設定のときは AdapterUnavailableError を throw する（Engineが次へフォールバック）。
 */
import { AdapterUnavailableError } from '../core/errors.mjs';

export const ADAPTER_KINDS = Object.freeze(['deterministic', 'probabilistic', 'human']);

export function assertAdapterShape(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== 'object') problems.push('adapter is not an object');
  else {
    if (typeof adapter.id !== 'string' || !adapter.id) problems.push('id missing');
    if (!ADAPTER_KINDS.includes(adapter.kind)) problems.push(`kind must be one of ${ADAPTER_KINDS.join('|')}`);
    if (typeof adapter.supports !== 'function') problems.push('supports() missing');
    if (typeof adapter.decide !== 'function') problems.push('decide() missing');
  }
  if (problems.length) throw new Error(`invalid adapter: ${problems.join(', ')}`);
  return adapter;
}

export function assertAdapterResult(adapterId, result) {
  if (!result || typeof result !== 'object') throw new AdapterUnavailableError(adapterId, 'empty result');
  if (!result.outcome || typeof result.outcome !== 'object') throw new AdapterUnavailableError(adapterId, 'result.outcome missing');
  const c = result.confidence;
  if (typeof c !== 'number' || Number.isNaN(c) || c < 0 || c > 1) {
    throw new AdapterUnavailableError(adapterId, `confidence out of range: ${c}`);
  }
  return result;
}
