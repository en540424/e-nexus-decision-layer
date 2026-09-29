/**
 * 実版（model_version）・probabilities の記録（2026-09-29・Fable追加レビューP D1 / D3 / S2）。
 *
 *   - Direct 経路は応答 `model` が版（例 jev-1.13.0）なら記録し、alias（jev-latest / jev-preview）なら null（alias で埋めない）
 *   - 安全でない文字列は response_model にも載せない（推測しない）
 *   - probabilities は観測用（tier・confidence 合成には使わない）。attempts[]（usage）に残る
 *
 * 2026-09-29 Vercel 経路廃止：Vercel 固有の版探索（providerMetadata）・Gateway routing・403 診断の検査は、対象コードと一緒に削除した
 * （履歴は git の 88459ad 以前）。alias を版として記録しない／evidence が tier を変えない、という性質の検査は Direct へ移した。
 *
 * 実ネットワークは使わない（fetchImpl を注入）。memory meter。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { createMemoryMeter, ATTEMPT_FIELDS } from '../src/usage/metering.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, parseJevResponse } from '../src/adapters/jev/jev-adapter.mjs';
import { createDirectJevProvider } from '../src/adapters/jev/jev-direct-provider.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';

const DIRECT_ENV = Object.freeze({ EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'direct', JEV_API_KEY: 'test-key-not-real-0002' });
const INPUT = { asset_kind: 'scene', purpose: 'product hero shot we do not have locally', style: 'photoreal', estimated_paid_cost_usd_micros: 300000 };
const req = () => ({ decision_type: 'paid-generation-gate', application_id: 'test', project_id: 'test', input: INPUT });

/** docs.typesafe.ai/api.md の応答形 */
function directBody(model) {
  return {
    model,
    answers: {
      local_sufficient: { type: 'noul', noul: 0.03 },
      remotion_suitable: { type: 'noul', noul: 0.03 },
      paid_generation_required: { type: 'noul', noul: 0.97 },
      human_review_required: { type: 'noul', noul: 0.03 },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', confidence: 0.93, probabilities: { 'en-generate-hub': 0.93, 'human-review': 0.05, local: 0.02 } },
    },
    usage: { input_tokens: 420, output_tokens: 12 },
  };
}
const directProvider = (model) => createDirectJevProvider({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => directBody(model) }) });

async function decideVia(env, provider) {
  const adapters = [createRulesAdapter(), createJevAdapter({ env, provider }), createHumanAdapter()];
  const meter = createMemoryMeter();
  const gateway = createGateway({ engine: createDecisionLayerEngine({ env, mode: 'production', meter, adapters }), env });
  const envelope = await gateway.decide(req());
  const [row] = meter.readAll();
  return { envelope, row, jev: row.attempts.find((a) => a.adapter === 'jev') };
}

test('Direct: alias-only response (jev-latest) → model_version null; probabilities kept in attempts[]; no routing; secret never reaches usage', async () => {
  const { envelope, row, jev } = await decideVia(DIRECT_ENV, directProvider('jev-latest'));
  assert.equal(envelope.ok, true);
  assert.equal(jev.status, 'ok');
  assert.equal(jev.route, 'direct');
  assert.equal(jev.model, 'jev-latest', 'model stays the id the provider reports');
  assert.equal(jev.model_version, null, 'alias is not a version');
  assert.equal(jev.evidence.response_model, 'jev-latest');
  assert.equal(jev.evidence.model_version_source, null);
  assert.ok(!('routing' in jev.evidence));
  assert.deepEqual(jev.evidence.probabilities.recommended_route, { 'en-generate-hub': 0.93, 'human-review': 0.05, local: 0.02 });
  assert.deepEqual(jev.evidence.probabilities.paid_generation_required, { true: 0.97, false: 0.03 });
  for (const k of Object.keys(jev)) assert.ok(ATTEMPT_FIELDS.includes(k), `attempt field allowlisted: ${k}`);
  assert.ok(!JSON.stringify(row).includes(DIRECT_ENV.JEV_API_KEY), 'secret never reaches usage');
});

test('Direct: versioned vs alias response → version recorded with its source; confidence / tier are unchanged by evidence', async () => {
  const a = await decideVia(DIRECT_ENV, directProvider('jev-latest'));
  const b = await decideVia(DIRECT_ENV, directProvider('jev-1.13.0'));
  assert.equal(b.jev.model_version, 'jev-1.13.0');
  assert.equal(b.jev.evidence.model_version_source, 'response.model');
  assert.equal(a.envelope.decision.confidence, b.envelope.decision.confidence);
  assert.equal(a.envelope.decision.tier, b.envelope.decision.tier);
});

test('unsafe model strings are dropped (not recorded as response_model or version); nothing inferred', () => {
  const fieldPlans = { f: { kind: 'noul' } };
  const answers = { f: { type: 'noul', noul: 0.9 } };
  const bad = parseJevResponse({ model: 'jev 1.13 <script>', answers }, { fieldPlans });
  assert.equal(bad.model_version, null);
  assert.equal(bad.evidence.response_model, null);
  const none = parseJevResponse({ answers }, { fieldPlans });
  assert.equal(none.model_version, null);
  assert.equal(none.evidence.model_version_source, null);
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
