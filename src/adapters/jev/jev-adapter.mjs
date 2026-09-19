/**
 * Jev（TypeSafe AI）Adapter — stub。
 *
 * 現時点では実API仕様・APIキーとも未取得のため、ネットワーク送信を行わない。
 * - EDL_ALLOW_NETWORK !== 'true' → AdapterUnavailableError('NETWORK_DISABLED')
 * - Provider.available(env) が ok でない → その reason（例: JEV_API_KEY_MISSING）
 * - 上記を満たしても Provider の send() が未実装 → AdapterUnavailableError('JEV_CLIENT_NOT_IMPLEMENTED')
 * いずれの場合も Engine は次の Adapter（mock-jev / llm / human）へフォールバックし、停止しない。
 *
 * 構造（経路を固定しない）:
 *   Decision Layer → Jev Adapter（この file：変換だけ）→ Jev Provider（jev-provider-interface.mjs：経路だけ）
 *                                                         ├─ direct（TypeSafe Direct API）
 *                                                         ├─ vercel（Vercel AI Gateway）
 *                                                         └─ cloudflare（Cloudflare 経由）
 *   経路の追加は Provider 1ファイルで済み、この Adapter・Engine は変更しない。
 *
 * 将来の実装方針（このファイル内で完結させる）:
 *   buildJevRequest(): decision_type schema の outcome 定義を Jev の typed schema へ変換し、
 *                      input と candidates（Registryが絞った候補だけ）を渡す
 *   parseJevResponse(): 型付き値 + confidence を AdapterResult へ正規化する
 * APIキーの値をログ・例外メッセージ・結果へ含めない。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';
import { assertJevProviderShape, resolveJevProvider } from './jev-provider-interface.mjs';

export const JEV_ENV = Object.freeze({
  apiKey: 'JEV_API_KEY',
  baseUrl: 'JEV_API_BASE_URL',
  provider: 'JEV_PROVIDER',
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

/**
 * @param {object} opts
 * @param {object} [opts.env]       環境変数（テストでは注入）
 * @param {object} [opts.provider]  Jev Provider（省略時は env.JEV_PROVIDER から解決、既定 direct）
 */
export function createJevAdapter({ env = process.env, provider = null } = {}) {
  const resolveProvider = () => (provider ? assertJevProviderShape(provider) : resolveJevProvider(env));
  return {
    id: 'jev',
    kind: 'probabilistic',
    provider: 'typesafe-ai',
    model: 'jev',
    get route() {
      try { return resolveProvider().id; } catch { return null; }
    },
    supports() {
      return true; // 対応可否は decide 時に環境で判断する（型付き判定は全 decision_type が対象）
    },
    async decide({ decisionType, schema, input, candidates }) {
      const p = resolveProvider();
      const avail = p.available(env);
      if (!avail.ok) throw new AdapterUnavailableError('jev', avail.reason ?? 'JEV_PROVIDER_UNAVAILABLE', { decisionType, route: p.id });
      if (env[JEV_ENV.allowNetwork] !== 'true') throw new AdapterUnavailableError('jev', 'NETWORK_DISABLED', { decisionType, route: p.id });
      const request = buildJevRequest({ decisionType, schema, input, candidates });
      const raw = await p.send({ request, env });
      return parseJevResponse(raw);
    },
  };
}
