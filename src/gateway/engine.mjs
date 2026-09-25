/**
 * Decision Engine 境界（Common Decision Gateway 用）。
 *
 *   consumer → Gateway（src/gateway/gateway.mjs）→ DecisionEngine → [Decision Layer core → Adapter → Jev Provider]
 *
 * Gateway が知るのはこの小さな契約だけで、Decision Layer core も Jev も知らない。
 * 将来 Decision Layer ごと別の判断エンジンへ差し替える場合も、この契約を満たす engine を渡せば
 * consumer 側の契約（docs/gateway.md の Common Decision Contract v1）は変わらない。
 * Jev だけを別エンジンへ替える場合は、従来どおり Adapter / Provider の差し替え（architecture §7・§9）で済み、ここも変わらない。
 *
 *   engine = {
 *     id: string,                  // 例 'e-nexus-decision-layer'
 *     version: string,             // engine の版（package.json version）
 *     mode: 'production' | 'verification',
 *     decide(request) -> Promise<DecisionResult>   // schemas/common/decision-result.schema.json
 *     health() -> object           // Secret を含まない状態（キーの値は読まない・返さない）
 *   }
 *
 * mode（2026-09-25 決定・decision-log）：
 *   production   = rules → jev → local → llm → human。mock-jev は入れない。Jev が使えない環境（キー無し／Network Gate OFF）では
 *                  rules で解けなければ human へ上がる。mock のヒューリスティックを Jev の判断として consumer へ返さない。
 *   verification = 実 Jev が使えないときだけ mock-jev を入れる（従来の createDecisionLayer() 既定と同じ）。配管の検証専用。
 */
import { createDecisionEngine } from '../core/decision-engine.mjs';
import { createRulesAdapter } from '../adapters/rules/rules-adapter.mjs';
import { createJevAdapter } from '../adapters/jev/jev-adapter.mjs';
import { createMockJevAdapter } from '../adapters/jev/mock-jev-adapter.mjs';
import { createLlmAdapterStub } from '../adapters/llm/llm-adapter-stub.mjs';
import { createLocalAdapterStub } from '../adapters/local/local-adapter-stub.mjs';
import { createHumanAdapter } from '../adapters/human/human-adapter.mjs';
import { resolveJevProvider } from '../adapters/jev/jev-provider-interface.mjs';
import { createFileMeter } from '../usage/metering.mjs';
import { readJson } from '../schemas/loader.mjs';

export const ENGINE_MODES = Object.freeze(['production', 'verification']);
export const DECISION_LAYER_ENGINE_ID = 'e-nexus-decision-layer';

export function assertEngineShape(engine) {
  const problems = [];
  if (!engine || typeof engine !== 'object') problems.push('engine is not an object');
  else {
    if (typeof engine.id !== 'string' || !engine.id) problems.push('id missing');
    if (typeof engine.version !== 'string' || !engine.version) problems.push('version missing');
    if (!ENGINE_MODES.includes(engine.mode)) problems.push(`mode must be one of ${ENGINE_MODES.join('|')}`);
    if (typeof engine.decide !== 'function') problems.push('decide() missing');
    if (typeof engine.health !== 'function') problems.push('health() missing');
  }
  if (problems.length) throw new Error(`invalid decision engine: ${problems.join(', ')}`);
  return engine;
}

/** Jev 経路の状態。キーの「有無」だけを見る（値は読まない・返さない） */
export function jevRouteStatus(env = process.env) {
  const networkEnabled = env.EDL_ALLOW_NETWORK === 'true';
  let provider = env.JEV_PROVIDER || 'direct';
  let available;
  try {
    const p = resolveJevProvider(env);
    provider = p.id;
    available = p.available(env);
  } catch (err) {
    available = { ok: false, reason: err.details?.reason ?? 'JEV_PROVIDER_UNKNOWN' };
  }
  return {
    provider,
    network_enabled: networkEnabled,
    usable: networkEnabled && available.ok === true,
    reason: networkEnabled ? (available.ok ? null : available.reason ?? 'UNAVAILABLE') : 'NETWORK_DISABLED',
  };
}

export function gatewayAdapters({ env = process.env, mode = 'production' } = {}) {
  const useMock = mode === 'verification' && !jevRouteStatus(env).usable;
  return [
    createRulesAdapter(),
    createJevAdapter({ env }),
    ...(useMock ? [createMockJevAdapter()] : []),
    createLocalAdapterStub(),
    createLlmAdapterStub({ env }),
    createHumanAdapter(),
  ];
}

/** 既定 engine：この repo の Decision Layer core */
export function createDecisionLayerEngine({ env = process.env, mode = 'production', meter, adapters, ...rest } = {}) {
  if (!ENGINE_MODES.includes(mode)) throw new Error(`engine mode must be one of ${ENGINE_MODES.join('|')}`);
  const core = createDecisionEngine({
    adapters: adapters ?? gatewayAdapters({ env, mode }),
    meter: meter ?? createFileMeter(),
    ...rest,
  });
  return assertEngineShape({
    id: DECISION_LAYER_ENGINE_ID,
    version: readJson('package.json').version,
    mode,
    decide: (request) => core.decide(request),
    health: () => ({
      adapters: core.adapters.map((a) => a.id),
      jev: jevRouteStatus(env),
    }),
  });
}
