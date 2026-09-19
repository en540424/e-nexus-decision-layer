/**
 * Jev（TypeSafe AI）Adapter — stub。
 *
 * 現時点では実API仕様・APIキーとも未取得のため、ネットワーク送信を行わない。
 * - JEV_API_KEY 未設定 → AdapterUnavailableError('JEV_API_KEY_MISSING')
 * - EDL_ALLOW_NETWORK !== 'true' → AdapterUnavailableError('NETWORK_DISABLED')
 * - 上記を満たしても実装未完了のため AdapterUnavailableError('JEV_CLIENT_NOT_IMPLEMENTED')
 * いずれの場合も Engine は次の Adapter（mock-jev / llm / human）へフォールバックし、停止しない。
 *
 * 将来の実装方針（このファイル内で完結させる。Engine・他Adapterは変更しない）:
 *   buildJevRequest(): decision_type schema の outcome 定義を Jev の typed schema へ変換し、
 *                      input と candidates（Registryが絞った候補だけ）を渡す
 *   parseJevResponse(): 型付き値 + confidence を AdapterResult へ正規化する
 * APIキーの値をログ・例外メッセージ・結果へ含めない。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

export const JEV_ENV = Object.freeze({
  apiKey: 'JEV_API_KEY',
  baseUrl: 'JEV_API_BASE_URL',
  allowNetwork: 'EDL_ALLOW_NETWORK',
});

export function buildJevRequest({ decisionType, schema, input, candidates }) {
  // schema.properties.outcome が Jev へ渡す「返してほしい型」。候補はRegistry由来のものだけ。
  return {
    task: decisionType,
    output_schema: schema?.properties?.outcome ?? null,
    input,
    candidates: (candidates ?? []).map((c) => ({ id: c.id, description: c.description ?? '' })),
  };
}

export function parseJevResponse(raw) {
  if (!raw || typeof raw !== 'object') throw new AdapterUnavailableError('jev', 'EMPTY_RESPONSE');
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : null;
  if (confidence === null) throw new AdapterUnavailableError('jev', 'CONFIDENCE_MISSING');
  return {
    outcome: raw.value ?? raw.outcome ?? {},
    confidence,
    rationale: raw.rationale ?? 'jev',
    usage: {
      input_tokens: raw.usage?.input_tokens ?? 0,
      output_tokens: raw.usage?.output_tokens ?? 0,
      estimated_cost_usd_micros: raw.usage?.estimated_cost_usd_micros ?? 0,
    },
  };
}

export function createJevAdapter({ env = process.env } = {}) {
  return {
    id: 'jev',
    kind: 'probabilistic',
    provider: 'typesafe-ai',
    model: 'jev',
    supports() {
      return true; // 対応可否は decide 時に環境で判断する（型付き判定は全 decision_type が対象）
    },
    async decide({ decisionType }) {
      if (!env[JEV_ENV.apiKey]) throw new AdapterUnavailableError('jev', 'JEV_API_KEY_MISSING', { decisionType });
      if (env[JEV_ENV.allowNetwork] !== 'true') throw new AdapterUnavailableError('jev', 'NETWORK_DISABLED', { decisionType });
      throw new AdapterUnavailableError('jev', 'JEV_CLIENT_NOT_IMPLEMENTED', { decisionType });
    },
  };
}
