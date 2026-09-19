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
 *     usage?: { input_tokens?, output_tokens?, estimated_cost_usd_micros? },
 *     // ---- attempt metering 用（2026-09-19 追加。すべて任意・後方互換） ----
 *     networked?: boolean,        // 外部 provider へ実際にリクエストを送ったか。省略時は「不明（null）」として記録される。
 *                                 //   送っていない Adapter（rules / human / mock / local）は false を明示する
 *     model?: string,             // provider が実際に使ったモデルID（adapter.model の上書き。実応答から取れる場合のみ）
 *     route?: string,             // 到達経路（例: jev の 'direct' / 'vercel'）
 *     retry_count?: number,       // provider 内部の再試行回数（取得できる場合のみ。捏造しない）
 *   }
 *
 * 判定不能・接続不可・キー未設定のときは AdapterUnavailableError を throw する（Engineが次へフォールバック）。
 * 送信「後」に失敗した場合（HTTPエラー・timeout・応答不正）は details.networked=true を付けて throw する
 * （課金対象の通信が起きた事実を attempt record に残すため）。details に無ければ core は「送っていない」と扱う。
 * usage が取得できない失敗で tokens/cost を 0 として返さない（core が usage_known=false / null として記録する）。
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
