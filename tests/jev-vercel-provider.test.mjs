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

test('toGatewayModelId: internal model → typesafe-ai/<model>; JEV_VERCEL_MODEL overrides fully', () => {
  assert.equal(toGatewayModelId('jev-latest', {}), 'typesafe-ai/jev-latest');
  assert.equal(toGatewayModelId('jev-latest', { JEV_VERCEL_MODEL: 'typesafe-ai/jev-preview' }), 'typesafe-ai/jev-preview');
});

test('toGatewayQuestions: noul→boolean; choice null-description criteria → empty string; score criteria pass through', () => {
  const { request } = buildJevRequest({
    decisionType: 'paid-generation-gate',
    outcomeSchema: PAID_GATE_OUTCOME_SCHEMA,
    input: {},
    candidates: [],
  });
  const gw = toGatewayQuestions(request.questions);
  assert.equal(gw.local_sufficient.type, 'boolean');
  assert.equal(gw.recommended_route.type, 'choice');
  assert.deepEqual(gw.recommended_route.criteria, { local: '', remotion: '', 'en-generate-hub': '', 'human-review': '' });

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
  assert.equal(classifyGatewayError({ statusCode: 403 }).details.reason, 'JEV_AUTH_FAILED');
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
  assert.equal(seen.model, 'typesafe-ai/jev-latest');
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

test('vercel provider: SDK not installed (dynamic import fails) → JEV_VERCEL_SDK_MISSING, fails closed, never reaches the network', async () => {
  // 'ai' is an optionalDependency (package.json) and is deliberately NOT installed in this repo's
  // node_modules today (Human must `npm install` before real connectivity — see docs/decision-log.md).
  // This exercises the real dynamic import('ai') path with no evaluateImpl injected.
  const provider = createVercelJevProvider();
  await assert.rejects(
    () => provider.send({ request: { model: 'jev-latest', state: {}, questions: {} }, env: { AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_VERCEL_SDK_MISSING',
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
