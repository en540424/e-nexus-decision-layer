/**
 * Vercel AI Gateway Provider（Jev）— transport / mapping / contract tests。
 * 実ネットワーク・実 'ai' パッケージは一切使わない。evaluateImpl は常にテスト用関数で差し替える。
 * 参照仕様：jev-vercel-provider.mjs 冒頭コメント（一次情報：vercel.com/docs, ai-sdk.dev。2026-09-19取得）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVercelJevProvider,
  toGatewayModelId,
  DEFAULT_VERCEL_MODEL_ID,
  toGatewayQuestions,
  toDirectShapedResponse,
  classifyGatewayError,
  resolveEvaluationModel,
} from '../src/adapters/jev/jev-vercel-provider.mjs';
import { createJevAdapter, buildJevRequest, parseJevResponse } from '../src/adapters/jev/jev-adapter.mjs';
import { createDirectJevProvider } from '../src/adapters/jev/jev-direct-provider.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

const PAID_GATE_OUTCOME_SCHEMA = loadDecisionType('paid-generation-gate').schema.properties.outcome;

// ---- 内部 request/response ⇔ Gateway 形の変換 ----

test('toGatewayModelId: default is the canonical Gateway id typesafe-ai/jev (not a prefixed internal id); JEV_VERCEL_MODEL overrides fully', () => {
  assert.equal(DEFAULT_VERCEL_MODEL_ID, 'typesafe-ai/jev');
  assert.equal(toGatewayModelId({}), 'typesafe-ai/jev');
  assert.equal(toGatewayModelId({ JEV_MODEL: 'jev-preview' }), 'typesafe-ai/jev', 'JEV_MODEL is Direct-only and never leaks into the Gateway id');
  assert.equal(toGatewayModelId({ JEV_VERCEL_MODEL: 'typesafe-ai/jev-preview' }), 'typesafe-ai/jev-preview');
});

test('direct route: internal default model stays jev-latest regardless of the vercel default', async () => {
  let seenBody = null;
  const fetchImpl = async (url, init) => { seenBody = JSON.parse(init.body); return { status: 200, ok: true, headers: { get: () => null }, async json() { return { answers: {}, usage: {} }; } }; };
  const direct = createDirectJevProvider({ fetchImpl, sleepImpl: async () => {} });
  const jev = createJevAdapter({ env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }, provider: direct });
  await jev.decide({ decisionType: 'paid-generation-gate', input: {}, candidates: [] }).catch(() => {});
  assert.equal(seenBody.model, 'jev-latest');
});

test('toGatewayQuestions: noul→boolean; choice criteria carry x-enum-descriptions (null → empty string when absent); score criteria pass through', () => {
  const { request } = buildJevRequest({
    decisionType: 'paid-generation-gate',
    outcomeSchema: PAID_GATE_OUTCOME_SCHEMA,
    input: {},
    candidates: [],
  });
  const gw = toGatewayQuestions(request.questions);
  assert.equal(gw.local_sufficient.type, 'boolean');
  assert.equal(gw.recommended_route.type, 'choice');
  // 2026-09-19 Confidence Calibration: the real schema now describes every route (x-enum-descriptions)
  const expectedCriteria = PAID_GATE_OUTCOME_SCHEMA.properties.recommended_route['x-enum-descriptions'];
  assert.deepEqual(Object.keys(gw.recommended_route.criteria).sort(), ['en-generate-hub', 'human-review', 'local', 'remotion'].sort());
  assert.deepEqual(gw.recommended_route.criteria, expectedCriteria);
  for (const v of Object.values(gw.recommended_route.criteria)) assert.ok(typeof v === 'string' && v.length > 0);

  // schema without x-enum-descriptions → internal null → '' (AI SDK expects string descriptions)
  const bare = buildJevRequest({ decisionType: 'x', outcomeSchema: { properties: { r: { type: 'string', enum: ['a', 'b'] } } }, input: {}, candidates: [] });
  assert.deepEqual(toGatewayQuestions(bare.request.questions).r.criteria, { a: '', b: '' });

  const scoreQuestions = { rating: { type: 'score', instructions: 'x', criteria: ['rating = 1', 'rating = 2'] } };
  assert.deepEqual(toGatewayQuestions(scoreQuestions).rating, { type: 'score', instructions: 'x', criteria: ['rating = 1', 'rating = 2'] });
});

test('toGatewayQuestions: unsupported internal question type is rejected, never guessed', () => {
  assert.throws(
    () => toGatewayQuestions({ x: { type: 'mystery', instructions: 'x' } }),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_VERCEL_UNSUPPORTED_QUESTION_TYPE',
  );
});

test('toDirectShapedResponse: boolean→noul, choice/score confidence lifted from providerMetadata.typesafe.confidence, usage camelCase→snake_case', () => {
  const questions = {
    a: { type: 'noul' },
    b: { type: 'choice' },
    c: { type: 'score' },
  };
  const result = {
    answers: {
      a: { type: 'boolean', probability: 0.1 },
      b: { type: 'choice', choice: 'x', probabilities: { x: 0.7, y: 0.3 } },
      c: { type: 'score', score: 2.6, probabilities: { '0': 0, '1': 0.2, '2': 0.8 } },
    },
    providerMetadata: { typesafe: { confidence: { b: 0.55, c: 0.6 } } },
    usage: { inputTokens: 1000, outputTokens: 10 },
    response: { modelId: 'typesafe-ai/jev' },
  };
  const raw = toDirectShapedResponse(result, { questions });
  assert.deepEqual(raw.answers.a, { type: 'noul', noul: 0.1 });
  assert.deepEqual(raw.answers.b, { type: 'choice', choice: 'x', confidence: 0.55 });
  assert.deepEqual(raw.answers.c, { type: 'score', score: 2.6, confidence: 0.6 });
  assert.deepEqual(raw.usage, { input_tokens: 1000, output_tokens: 10 });
  assert.equal(raw.model, 'typesafe-ai/jev');
});

test('toDirectShapedResponse: missing confidence on choice/score is never synthesized from probabilities (parseJevResponse rejects it downstream)', () => {
  const questions = { b: { type: 'choice' } };
  const result = { answers: { b: { type: 'choice', choice: 'x', probabilities: { x: 0.99, y: 0.01 } } }, usage: {} };
  const raw = toDirectShapedResponse(result, { questions });
  assert.deepEqual(raw.answers.b, { type: 'choice', choice: 'x' }, 'no confidence field is fabricated from probabilities');
  assert.throws(
    () => parseJevResponse(raw, { fieldPlans: { b: { kind: 'choice', enumValues: ['x', 'y'] } } }),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_MALFORMED_RESPONSE',
  );
});

test('classifyGatewayError: duck-types on statusCode (no APICallError.isInstance dependency)', () => {
  assert.equal(classifyGatewayError({ statusCode: 401 }).details.reason, 'JEV_AUTH_FAILED');
  assert.equal(classifyGatewayError({ statusCode: 422 }).details.reason, 'JEV_REQUEST_REJECTED');
  assert.equal(classifyGatewayError({ statusCode: 429, isRetryable: true }).details.reason, 'JEV_RATE_LIMITED');
  assert.equal(classifyGatewayError({ statusCode: 503 }).details.reason, 'JEV_OVERLOADED');
  const forbidden = classifyGatewayError({ statusCode: 403 });
  assert.equal(forbidden.details.reason, 'JEV_FORBIDDEN', '403 (card/permission/policy) is distinct from 401 (bad key)');
  assert.equal(forbidden.details.retryable, false);
  assert.equal(classifyGatewayError({ statusCode: 408 }).details.reason, 'JEV_OVERLOADED');
  assert.equal(classifyGatewayError({ name: 'AbortError' }).details.reason, 'JEV_NETWORK_ERROR');
  assert.equal(classifyGatewayError(new Error('mystery')).details.reason, 'JEV_VERCEL_SDK_ERROR');
});

// ---- Provider: available() / Network Gate / SDK missing ----

test('vercel provider: available() reports missing AI_GATEWAY_API_KEY without exposing any value', () => {
  const provider = createVercelJevProvider();
  assert.deepEqual(provider.available({}), { ok: false, reason: 'JEV_VERCEL_API_KEY_MISSING' });
  assert.deepEqual(provider.available({ AI_GATEWAY_API_KEY: 'k' }), { ok: true });
});

test('vercel provider: send() refuses when network disabled or key missing — evaluateImpl is never invoked (defense in depth)', async () => {
  const calls = [];
  const evaluateImpl = async (args) => { calls.push(args); return { answers: {}, usage: {} }; };
  const provider = createVercelJevProvider({ evaluateImpl });
  await assert.rejects(
    () => provider.send({ request: { questions: {} }, env: { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'false' } }),
    (e) => e.details.reason === 'NETWORK_DISABLED',
  );
  await assert.rejects(
    () => provider.send({ request: { questions: {} }, env: { EDL_ALLOW_NETWORK: 'true' } }),
    (e) => e.details.reason === 'JEV_VERCEL_API_KEY_MISSING',
  );
  assert.equal(calls.length, 0, 'evaluateImpl is never invoked when either gate is closed');
});

test('vercel provider: successful request — model id, state, translated questions, ZDR provider option; raw response normalized', async () => {
  let seen = null;
  const evaluateImpl = async (args) => {
    seen = args;
    return {
      answers: { refunded: { type: 'boolean', probability: 0.9 } },
      usage: { inputTokens: 50, outputTokens: 5 },
    };
  };
  const provider = createVercelJevProvider({ evaluateImpl });
  const env = { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true', JEV_ZDR: 'true' };
  const request = { model: 'jev-latest', state: { task: 't' }, questions: { refunded: { type: 'noul', instructions: 'Was a refund issued?' } } };
  const raw = await provider.send({ request, env });
  assert.equal(seen.model, 'typesafe-ai/jev');
  assert.deepEqual(seen.state, { task: 't' });
  assert.deepEqual(seen.questions.refunded, { type: 'boolean', instructions: 'Was a refund issued?' });
  assert.deepEqual(seen.providerOptions, { gateway: { zeroDataRetention: true } });
  assert.deepEqual(raw.answers.refunded, { type: 'noul', noul: 0.9 });
  assert.deepEqual(raw.usage, { input_tokens: 50, output_tokens: 5 });
});

test('vercel provider: JEV_VERCEL_MODEL overrides the default typesafe-ai/<model> id sent to evaluate()', async () => {
  let seenModel = null;
  const evaluateImpl = async (args) => { seenModel = args.model; return { answers: {}, usage: {} }; };
  const provider = createVercelJevProvider({ evaluateImpl });
  await provider.send({
    request: { model: 'jev-latest', state: {}, questions: {} },
    env: { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true', JEV_VERCEL_MODEL: 'typesafe-ai/jev-preview' },
  });
  assert.equal(seenModel, 'typesafe-ai/jev-preview');
});

test('vercel provider: evaluateImpl error with statusCode is classified the same way as Direct HTTP errors', async () => {
  const evaluateImpl = async () => { const err = new Error('auth'); err.statusCode = 401; throw err; };
  const provider = createVercelJevProvider({ evaluateImpl });
  await assert.rejects(
    () => provider.send({ request: { model: 'jev-latest', state: {}, questions: {} }, env: { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }),
    (e) => e.details.reason === 'JEV_AUTH_FAILED',
  );
});

test('vercel provider: real import path fails closed without touching the network, whether or not "ai" is installed', async () => {
  // No evaluateImpl → the real dynamic import('ai') runs. If 'ai' is absent → JEV_VERCEL_SDK_MISSING.
  // If present (Human ran `npm install`), the injected gatewayFactory returns an object without
  // evaluationModel(), so resolveEvaluationModel() throws JEV_VERCEL_SDK_ERROR *before* evaluate() is
  // ever called. Either way nothing is sent. This test must never depend on install state.
  const provider = createVercelJevProvider({ gatewayFactory: () => ({}) });
  await assert.rejects(
    () => provider.send({ request: { model: 'jev-latest', state: {}, questions: {} }, env: { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }),
    (e) => e instanceof AdapterUnavailableError && ['JEV_VERCEL_SDK_MISSING', 'JEV_VERCEL_SDK_ERROR'].includes(e.details.reason),
  );
});

test('resolveEvaluationModel: throws JEV_VERCEL_SDK_ERROR (never guesses a request shape) when gateway.evaluationModel is missing', () => {
  assert.throws(
    () => resolveEvaluationModel({}, 'typesafe-ai/jev'),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_VERCEL_SDK_ERROR',
  );
  assert.throws(
    () => resolveEvaluationModel(null, 'typesafe-ai/jev'),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_VERCEL_SDK_ERROR',
  );
  const model = resolveEvaluationModel({ evaluationModel: (id) => ({ id }) }, 'typesafe-ai/jev');
  assert.deepEqual(model, { id: 'typesafe-ai/jev' });
});

test('secret redaction: AI_GATEWAY_API_KEY never appears in a thrown error message or details', async () => {
  const secret = 'vck_super-secret-gateway-key-do-not-leak';
  const evaluateImpl = async () => { const err = new Error('auth'); err.statusCode = 401; throw err; };
  const provider = createVercelJevProvider({ evaluateImpl });
  await assert.rejects(
    () => provider.send({ request: { model: 'jev-latest', state: {}, questions: {} }, env: { AI_GATEWAY_API_KEY: secret, EDL_ALLOW_NETWORK: 'true' } }),
    (e) => !JSON.stringify({ m: e.message, d: e.details }).includes(secret),
  );
});

// ---- Direct vs Vercel 契約一致（同じ内部 outcome へ収束すること） ----

test('direct vs vercel: same paid-generation-gate input converges to the same outcome shape via the two different transports', async () => {
  const directFetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    async json() {
      return {
        model: 'jev-1.13.0',
        answers: {
          local_sufficient: { type: 'noul', noul: 0.05 },
          remotion_suitable: { type: 'noul', noul: 0.05 },
          paid_generation_required: { type: 'noul', noul: 0.9 },
          human_review_required: { type: 'noul', noul: 0.9 },
          recommended_route: { type: 'choice', choice: 'en-generate-hub', confidence: 0.9 },
        },
        usage: { input_tokens: 200, output_tokens: 30 },
      };
    },
  });
  const vercelEvaluate = async (args) => ({
    answers: {
      local_sufficient: { type: 'boolean', probability: 0.05 },
      remotion_suitable: { type: 'boolean', probability: 0.05 },
      paid_generation_required: { type: 'boolean', probability: 0.9 },
      human_review_required: { type: 'boolean', probability: 0.9 },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', probabilities: { local: 0.02, remotion: 0.02, 'en-generate-hub': 0.9, 'human-review': 0.06 } },
    },
    providerMetadata: { typesafe: { confidence: { recommended_route: 0.9 } } },
    usage: { inputTokens: 200, outputTokens: 30 },
  });

  const directProvider = createDirectJevProvider({ fetchImpl: directFetch, sleepImpl: async () => {} });
  const vercelProvider = createVercelJevProvider({ evaluateImpl: vercelEvaluate });
  const directJev = createJevAdapter({ env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }, provider: directProvider });
  const vercelJev = createJevAdapter({ env: { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }, provider: vercelProvider });

  const input = { asset_kind: 'scene', purpose: 'x', style: 'photoreal' };
  const { engine: directEngine } = makeEngine({ adapters: [directJev, ...makeEngine().engine.adapters.filter((a) => a.id === 'human')], routingPolicy: { default_chain: ['jev', 'human'], overrides: {} } });
  const { engine: vercelEngine } = makeEngine({ adapters: [vercelJev, ...makeEngine().engine.adapters.filter((a) => a.id === 'human')], routingPolicy: { default_chain: ['jev', 'human'], overrides: {} } });

  const direct = await directEngine.decide(gateRequest(input));
  const vercel = await vercelEngine.decide(gateRequest(input));

  assert.deepEqual(direct.outcome, vercel.outcome, 'both transports converge on the same typed outcome for the same underlying answers');
  assert.equal(direct.tier, 'human');
  assert.equal(vercel.tier, 'human');
  assert.equal(direct.resolved_by, 'jev');
  assert.equal(vercel.resolved_by, 'jev');
  assert.equal(direct.provider, 'typesafe-ai');
  assert.equal(vercel.provider, 'typesafe-ai');
  for (const leaked of ['noul', 'choice', 'probabilities', 'legend', 'type', 'probability']) {
    assert.ok(!(leaked in vercel.outcome), `${leaked} must not leak into outcome`);
  }
});
