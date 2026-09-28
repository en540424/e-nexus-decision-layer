/**
 * 実版（model_version）・probabilities・Gateway routing の記録（2026-09-29・Fable追加レビューP D1 / D3 / S2）。
 *
 *   - Vercel 経路の response.modelId はリクエストした alias（typesafe-ai/jev）をそのまま返すだけなので、版として記録しない
 *   - 版は providerMetadata 等の allowlist キーに「数字.数字」を含む値があるときだけ記録し、無ければ null（alias で埋めない）
 *   - Direct 経路は応答 `model` が版なら記録する
 *   - probabilities は観測用（tier・confidence 合成には使わない）。attempts[]（usage）に残る
 *   - 2026-09-29 の実 403（RestrictedModelsError / no_providers_available・resolvedProvider digitalocean）を診断に残す
 *
 * 実ネットワーク・実 'ai' パッケージは使わない（evaluateImpl / fetchImpl を注入）。memory meter。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { createMemoryMeter, ATTEMPT_FIELDS } from '../src/usage/metering.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, parseJevResponse } from '../src/adapters/jev/jev-adapter.mjs';
import {
  createVercelJevProvider, toDirectShapedResponse, modelVersionOf, gatewayRoutingOf, classifyGatewayError,
} from '../src/adapters/jev/jev-vercel-provider.mjs';
import { createDirectJevProvider } from '../src/adapters/jev/jev-direct-provider.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';

const VERCEL_ENV = Object.freeze({ EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'test-key-not-real-0001' });
const DIRECT_ENV = Object.freeze({ EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'direct', JEV_API_KEY: 'test-key-not-real-0002' });
const INPUT = { asset_kind: 'scene', purpose: 'product hero shot we do not have locally', style: 'photoreal', estimated_paid_cost_usd_micros: 300000 };
const req = () => ({ decision_type: 'paid-generation-gate', application_id: 'test', project_id: 'test', input: INPUT });

function vercelResult(extra = {}) {
  return {
    answers: {
      local_sufficient: { type: 'boolean', probability: 0.03 },
      remotion_suitable: { type: 'boolean', probability: 0.03 },
      paid_generation_required: { type: 'boolean', probability: 0.97 },
      human_review_required: { type: 'boolean', probability: 0.03 },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', probabilities: { 'en-generate-hub': 0.93, 'human-review': 0.05, local: 0.02 } },
    },
    providerMetadata: { typesafe: { confidence: { recommended_route: 0.93 } }, ...(extra.providerMetadata ?? {}) },
    usage: { inputTokens: 420, outputTokens: 12 },
    response: { modelId: 'typesafe-ai/jev', ...(extra.response ?? {}) },
  };
}

async function decideVia(env, provider) {
  const adapters = [createRulesAdapter(), createJevAdapter({ env, provider }), createHumanAdapter()];
  const meter = createMemoryMeter();
  const gateway = createGateway({ engine: createDecisionLayerEngine({ env, mode: 'production', meter, adapters }), env });
  const envelope = await gateway.decide(req());
  const [row] = meter.readAll();
  return { envelope, row, jev: row.attempts.find((a) => a.adapter === 'jev') };
}

test('Vercel: alias-only response → model_version null (the alias is never recorded as a version); probabilities and routing kept in attempts[]', async () => {
  const provider = createVercelJevProvider({
    evaluateImpl: async () => vercelResult({ providerMetadata: { gateway: { routing: { resolvedProvider: 'typesafe-ai', canonicalSlug: 'typesafe-ai/jev' }, generationId: 'gen_01TEST' } } }),
  });
  const { envelope, row, jev } = await decideVia(VERCEL_ENV, provider);
  assert.equal(envelope.ok, true);
  assert.equal(jev.status, 'ok');
  assert.equal(jev.model, 'typesafe-ai/jev', 'model stays the id the provider reports (unchanged behavior)');
  assert.equal(jev.model_version, null, 'alias is not a version');
  assert.equal(jev.evidence.response_model, 'typesafe-ai/jev');
  assert.equal(jev.evidence.model_version_source, null);
  assert.deepEqual(jev.evidence.routing, { resolved_provider: 'typesafe-ai', canonical_slug: 'typesafe-ai/jev', generation_id: 'gen_01TEST' });
  assert.deepEqual(jev.evidence.probabilities.recommended_route, { 'en-generate-hub': 0.93, 'human-review': 0.05, local: 0.02 });
  assert.deepEqual(jev.evidence.probabilities.paid_generation_required, { true: 0.97, false: 0.03 });
  for (const k of Object.keys(jev)) assert.ok(ATTEMPT_FIELDS.includes(k), `attempt field allowlisted: ${k}`);
  assert.ok(!JSON.stringify(row).includes(VERCEL_ENV.AI_GATEWAY_API_KEY), 'secret never reaches usage');
});

test('Vercel: a versioned id in providerMetadata.typesafe is recorded with its source; confidence / tier are unchanged by evidence', async () => {
  const base = createVercelJevProvider({ evaluateImpl: async () => vercelResult() });
  const versioned = createVercelJevProvider({ evaluateImpl: async () => vercelResult({ providerMetadata: { typesafe: { confidence: { recommended_route: 0.93 }, model: 'jev-1.13.0' } } }) });
  const a = await decideVia(VERCEL_ENV, base);
  const b = await decideVia(VERCEL_ENV, versioned);
  assert.equal(b.jev.model_version, 'jev-1.13.0');
  assert.equal(b.jev.evidence.model_version_source, 'providerMetadata.typesafe.model');
  assert.equal(a.envelope.decision.confidence, b.envelope.decision.confidence);
  assert.equal(a.envelope.decision.tier, b.envelope.decision.tier);
});

test('modelVersionOf / gatewayRoutingOf: allowlisted keys only, unsafe strings dropped, nothing inferred', () => {
  assert.equal(modelVersionOf({ providerMetadata: { typesafe: { model: 'jev-latest' } } }), null);
  assert.equal(modelVersionOf({ providerMetadata: { typesafe: { model: 'jev 1.13 <script>' } } }), null);
  assert.deepEqual(modelVersionOf({ response: { body: { model: 'jev-1.13.0' } } }), { value: 'jev-1.13.0', source: 'response.body.model' });
  assert.equal(modelVersionOf({}), null);
  assert.equal(gatewayRoutingOf(undefined), null);
  assert.deepEqual(gatewayRoutingOf({ gateway: { routing: { resolvedProvider: 'digitalocean', canonicalSlug: 'typesafe-ai/jev' } } }), { resolved_provider: 'digitalocean', canonical_slug: 'typesafe-ai/jev' });
  assert.deepEqual(gatewayRoutingOf({ gateway: { routing: { resolvedProvider: 'x y z' } } }), null);
});

test('toDirectShapedResponse: model_version only when versioned; routing only when present', () => {
  const questions = { recommended_route: { type: 'choice' } };
  const plain = toDirectShapedResponse(vercelResult(), { questions });
  assert.ok(!('model_version' in plain));
  assert.ok(!('routing' in plain));
  const v = toDirectShapedResponse(vercelResult({ response: { body: { model: 'jev-1.13.0' } } }), { questions });
  assert.equal(v.model_version, 'jev-1.13.0');
  assert.equal(v.model_version_source, 'response.body.model');
});

test('Direct: versioned response `model` is the version; `jev-latest` alias → null', () => {
  const fieldPlans = { f: { kind: 'noul' }, c: { kind: 'choice', enumValues: ['a', 'b'] } };
  const answers = { f: { type: 'noul', noul: 0.8 }, c: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } };
  const v = parseJevResponse({ model: 'jev-1.13.0', answers }, { fieldPlans });
  assert.equal(v.model_version, 'jev-1.13.0');
  assert.equal(v.evidence.model_version_source, 'response.model');
  assert.deepEqual(v.evidence.probabilities, { f: { true: 0.8, false: 0.2 }, c: { a: 0.9, b: 0.1 } });
  const alias = parseJevResponse({ model: 'jev-latest', answers }, { fieldPlans });
  assert.equal(alias.model_version, null);
  const none = parseJevResponse({ answers: { ...answers, c: { type: 'choice', choice: 'a', confidence: 0.9 } } }, { fieldPlans });
  assert.equal(none.evidence.probabilities.c, null, 'missing probabilities are null, not synthesized');
});

test('Direct end-to-end: version reaches attempts[] through the real Direct provider (injected fetch)', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({
      model: 'jev-1.13.0',
      answers: {
        local_sufficient: { type: 'noul', noul: 0.03 },
        remotion_suitable: { type: 'noul', noul: 0.03 },
        paid_generation_required: { type: 'noul', noul: 0.97 },
        human_review_required: { type: 'noul', noul: 0.03 },
        recommended_route: { type: 'choice', choice: 'en-generate-hub', confidence: 0.93, probabilities: { 'en-generate-hub': 0.93 } },
      },
      usage: { input_tokens: 400, output_tokens: 10 },
    }),
  });
  const { jev } = await decideVia(DIRECT_ENV, createDirectJevProvider({ fetchImpl }));
  assert.equal(jev.route, 'direct');
  assert.equal(jev.model_version, 'jev-1.13.0');
});

test('classifyGatewayError: the 2026-09-29 403 (free tier / RestrictedModelsError) keeps its real cause in allowlisted diagnostics', () => {
  const err = {
    name: 'GatewayInternalServerError', statusCode: 403, type: 'internal_server_error', isRetryable: false,
    cause: { data: {
      error: { message: 'Free tier users do not have access to this model. Upgrade ...', type: 'no_providers_available', param: { name: 'RestrictedModelsError', statusCode: 403 } },
      providerMetadata: { gateway: { routing: { originalModelId: 'typesafe-ai/jev', resolvedProvider: 'digitalocean', canonicalSlug: 'typesafe-ai/jev' }, generationId: 'gen_x' } },
    } },
  };
  const e = classifyGatewayError(err);
  assert.equal(e.details.reason, 'JEV_FORBIDDEN');
  assert.equal(e.details.error_cause_name, 'RestrictedModelsError');
  assert.equal(e.details.error_cause_type, 'no_providers_available');
  assert.equal(e.details.resolved_provider, 'digitalocean');
  assert.ok(!JSON.stringify(e.details).includes('Free tier'), 'message text is not copied');
});
