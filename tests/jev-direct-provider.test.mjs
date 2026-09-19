/**
 * TypeSafe Direct Provider（Jev）— transport / mapping / contract tests。
 * 実ネットワークは一切使わない。fetch はすべて fakeResponse / spy で差し替える。
 * 参照仕様：2026-09-19 MA-30開発ログ「Jev公式API仕様の確定」節（一次情報：docs.typesafe.ai）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectJevProvider } from '../src/adapters/jev/jev-direct-provider.mjs';
import { createJevAdapter, buildJevRequest, parseJevResponse } from '../src/adapters/jev/jev-adapter.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

const PAID_GATE_OUTCOME_SCHEMA = loadDecisionType('paid-generation-gate').schema.properties.outcome;
const noSleep = async () => {};

function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => h.get(String(name).toLowerCase()) ?? null },
    async json() { return body; },
  };
}

// ---- request mapping（buildJevRequest） ----

test('buildJevRequest: outcome schema → noul/choice questions; task/candidates carried in state', () => {
  const { request, fieldPlans } = buildJevRequest({
    decisionType: 'paid-generation-gate',
    outcomeSchema: PAID_GATE_OUTCOME_SCHEMA,
    input: { asset_kind: 'scene' },
    candidates: [{ id: 'c1', description: 'x' }],
    model: 'jev-latest',
  });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.state.task, 'paid-generation-gate');
  assert.deepEqual(request.state.input, { asset_kind: 'scene' });
  assert.deepEqual(request.state.candidates, [{ id: 'c1', description: 'x' }]);
  assert.equal(request.questions.local_sufficient.type, 'noul');
  assert.equal(request.questions.recommended_route.type, 'choice');
  assert.deepEqual(
    Object.keys(request.questions.recommended_route.criteria).sort(),
    ['en-generate-hub', 'human-review', 'local', 'remotion'].sort(),
  );
  assert.equal(fieldPlans.recommended_route.kind, 'choice');
  assert.equal(fieldPlans.local_sufficient.kind, 'noul');
});

test('buildJevRequest: unsupported outcome fields (free string / no 2-10 range) are rejected, never guessed', () => {
  assert.throws(
    () => buildJevRequest({ decisionType: 'x', outcomeSchema: { properties: { free_text: { type: 'string' } } }, input: {}, candidates: [] }),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_UNSUPPORTED_OUTCOME_FIELD' && e.details.fields.includes('free_text'),
  );
  assert.throws(
    () => buildJevRequest({ decisionType: 'x', outcomeSchema: { properties: { count: { type: 'integer', minimum: 0, maximum: 999 } } }, input: {}, candidates: [] }),
    (e) => e.details.reason === 'JEV_UNSUPPORTED_OUTCOME_FIELD' && e.details.fields.includes('count'),
  );
});

test('buildJevRequest: integer field with a 2-10 level range maps to score', () => {
  const outcomeSchema = { type: 'object', properties: { rating: { type: 'integer', minimum: 1, maximum: 4 } } };
  const { request, fieldPlans } = buildJevRequest({ decisionType: 'x', outcomeSchema, input: {}, candidates: [] });
  assert.equal(request.questions.rating.type, 'score');
  assert.equal(request.questions.rating.criteria.length, 4);
  assert.deepEqual(fieldPlans.rating, { kind: 'score', minimum: 1, levels: 4 });
});

// ---- response mapping / confidence（parseJevResponse） ----

test('parseJevResponse: noul → boolean (>=0.5); derived confidence |2n-1|; choice uses answer.confidence; overall = min across questions', () => {
  const fieldPlans = { a: { kind: 'noul' }, b: { kind: 'choice', enumValues: ['x', 'y'] } };
  const raw = {
    model: 'jev-1.13.0',
    answers: {
      a: { type: 'noul', noul: 0.1 }, // derived confidence = |0.2-1| = 0.8
      b: { type: 'choice', choice: 'x', probabilities: { x: 0.7, y: 0.3 }, confidence: 0.55 },
    },
    usage: { input_tokens: 1000, output_tokens: 10 },
  };
  const result = parseJevResponse(raw, { fieldPlans });
  assert.deepEqual(result.outcome, { a: false, b: 'x' });
  assert.equal(result.confidence, 0.55, 'overall confidence is the minimum across questions');
  assert.equal(result.usage.input_tokens, 1000);
  assert.equal(result.usage.estimated_cost_usd_micros, 42, '1000 input tokens * 42000 micros/1M tokens (registry pricing) = 42');
});

test('parseJevResponse: score rounds to nearest level and maps back through minimum', () => {
  const fieldPlans = { rating: { kind: 'score', minimum: 1, levels: 4 } };
  const raw = { answers: { rating: { type: 'score', score: 2.6, confidence: 0.6, legend: {} } }, usage: {} };
  const result = parseJevResponse(raw, { fieldPlans });
  assert.equal(result.outcome.rating, 4, 'minimum(1) + round(2.6)=3 → 4');
});

test('parseJevResponse: malformed/incomplete answers are rejected, never guessed', () => {
  const nounPlans = { a: { kind: 'noul' } };
  for (const bad of [{}, { answers: {} }, { answers: { a: { type: 'choice', choice: 'x' } } }, { answers: { a: { type: 'noul', noul: 1.5 } } }]) {
    assert.throws(() => parseJevResponse(bad, { fieldPlans: nounPlans }), (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_MALFORMED_RESPONSE');
  }
  const choicePlans = { b: { kind: 'choice', enumValues: ['x', 'y'] } };
  assert.throws(
    () => parseJevResponse({ answers: { b: { type: 'choice', choice: 'z', confidence: 0.9 } } }, { fieldPlans: choicePlans }),
    (e) => e.details.reason === 'JEV_MALFORMED_RESPONSE',
    'choice not in the declared enum is rejected',
  );
  assert.throws(
    () => parseJevResponse({ answers: { b: { type: 'choice', choice: 'x' } } }, { fieldPlans: choicePlans }),
    (e) => e.details.reason === 'JEV_MALFORMED_RESPONSE',
    'missing confidence on choice is rejected',
  );
});

// ---- transport: auth header / URL / retries / errors（Direct Providerのsend()） ----

test('direct provider: available() reports missing key without exposing any value', () => {
  const provider = createDirectJevProvider();
  assert.deepEqual(provider.available({}), { ok: false, reason: 'JEV_API_KEY_MISSING' });
  assert.deepEqual(provider.available({ JEV_API_KEY: 'k' }), { ok: true });
});

test('direct provider: send() refuses when network disabled or key missing — fetch is never invoked (defense in depth)', async () => {
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return fakeResponse({ status: 200 }); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(() => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'false' } }), (e) => e.details.reason === 'NETWORK_DISABLED');
  await assert.rejects(() => provider.send({ request: {}, env: { EDL_ALLOW_NETWORK: 'true' } }), (e) => e.details.reason === 'JEV_API_KEY_MISSING');
  assert.equal(calls.length, 0, 'fetch is never invoked when either gate is closed');
});

test('direct provider: successful request — correct URL, Bearer auth header, JSON body; raw response passed through untouched', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return fakeResponse({ status: 200, body: { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 5, output_tokens: 1 } } });
  };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  const env = { JEV_API_KEY: 'secret-key-xyz', EDL_ALLOW_NETWORK: 'true' };
  const request = { model: 'jev-latest', state: { task: 't' }, questions: {} };
  const raw = await provider.send({ request, env });
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-key-xyz');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.init.body), request);
  assert.deepEqual(raw, { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 5, output_tokens: 1 } });
});

test('direct provider: custom JEV_API_BASE_URL is respected (trailing slash trimmed)', async () => {
  let seenUrl = null;
  const fetchImpl = async (url) => { seenUrl = url; return fakeResponse({ status: 200, body: {} }); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true', JEV_API_BASE_URL: 'https://gateway.example.com/' } });
  assert.equal(seenUrl, 'https://gateway.example.com/v1/systemone');
});

test('direct provider: 401 → JEV_AUTH_FAILED, never retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeResponse({ status: 401 }); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(() => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }), (e) => e.details.reason === 'JEV_AUTH_FAILED');
  assert.equal(calls, 1, '401 must not be retried');
});

test('direct provider: 422 → JEV_REQUEST_REJECTED carrying the problem field, never retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeResponse({ status: 422, body: { error: { field: 'questions.foo' } } }); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(
    () => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }),
    (e) => e.details.reason === 'JEV_REQUEST_REJECTED' && e.details.problem === 'questions.foo',
  );
  assert.equal(calls, 1);
});

test('direct provider: other non-2xx (e.g. 403) → JEV_HTTP_ERROR, not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeResponse({ status: 403 }); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(
    () => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }),
    (e) => e.details.reason === 'JEV_HTTP_ERROR' && e.details.status === 403,
  );
  assert.equal(calls, 1);
});

test('direct provider: 429 is retried honoring retry-after-ms, then succeeds', async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return fakeResponse({ status: 429, headers: { 'retry-after-ms': '1' } });
    return fakeResponse({ status: 200, body: { model: 'jev-1.13.0', answers: {}, usage: {} } });
  };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); } });
  const raw = await provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1]);
  assert.deepEqual(raw, { model: 'jev-1.13.0', answers: {}, usage: {} });
});

test('direct provider: 529 overloaded exhausts retries (2) and raises JEV_OVERLOADED', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeResponse({ status: 529 }); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(() => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }), (e) => e.details.reason === 'JEV_OVERLOADED');
  assert.equal(calls, 3, '1 initial + 2 retries');
});

test('direct provider: per-attempt timeout aborts and is retried as JEV_TIMEOUT', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(
    () => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true', JEV_TIMEOUT_MS: '5' } }),
    (e) => e.details.reason === 'JEV_TIMEOUT',
  );
  assert.equal(calls, 3, '1 initial + 2 retries; timeouts are retryable');
});

test('direct provider: malformed JSON body on 200 → JEV_MALFORMED_RESPONSE', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, headers: { get: () => null }, async json() { throw new Error('not json'); } });
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(() => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }), (e) => e.details.reason === 'JEV_MALFORMED_RESPONSE');
});

test('direct provider: connection failure (non-abort) → JEV_NETWORK_ERROR, retried then raised', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('ECONNRESET'); };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  await assert.rejects(() => provider.send({ request: {}, env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' } }), (e) => e.details.reason === 'JEV_NETWORK_ERROR');
  assert.equal(calls, 3);
});

test('secret redaction: API key never appears in a thrown error message or details, across failure paths', async () => {
  const secret = 'sk-super-secret-jev-key-do-not-leak';
  const runs = [
    () => createDirectJevProvider({ fetchImpl: async () => fakeResponse({ status: 401 }), sleepImpl: noSleep })
      .send({ request: {}, env: { JEV_API_KEY: secret, EDL_ALLOW_NETWORK: 'true' } }),
    () => createDirectJevProvider({ fetchImpl: async () => { throw new Error('boom'); }, sleepImpl: noSleep })
      .send({ request: {}, env: { JEV_API_KEY: secret, EDL_ALLOW_NETWORK: 'true' } }),
  ];
  for (const run of runs) {
    await assert.rejects(run, (e) => !JSON.stringify({ m: e.message, d: e.details }).includes(secret));
  }
});

// ---- Mock / Direct 契約一致（同じ internal 契約へ変換されること） ----

test('mock vs direct: same paid-generation-gate input converges to the same outcome shape and never leaks jev-specific fields', async () => {
  const fetchImpl = async () => fakeResponse({
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: {
        local_sufficient: { type: 'noul', noul: 0.05 },
        remotion_suitable: { type: 'noul', noul: 0.05 },
        paid_generation_required: { type: 'noul', noul: 0.9 },
        human_review_required: { type: 'noul', noul: 0.9 },
        recommended_route: {
          type: 'choice', choice: 'en-generate-hub',
          probabilities: { local: 0.02, remotion: 0.02, 'en-generate-hub': 0.9, 'human-review': 0.06 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  });
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  const jev = createJevAdapter({ env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }, provider });
  const { engine: directEngine } = makeEngine({
    adapters: [jev, ...makeEngine().engine.adapters.filter((a) => a.id === 'human')],
    routingPolicy: { default_chain: ['jev', 'human'], overrides: {} },
  });
  const input = { asset_kind: 'scene', purpose: 'x', style: 'photoreal' };
  const direct = await directEngine.decide(gateRequest(input));
  const mock = await makeEngine().engine.decide(gateRequest(input));

  const expectedKeys = ['human_review_required', 'local_sufficient', 'paid_generation_required', 'recommended_route', 'remotion_suitable'].sort();
  for (const r of [direct, mock]) {
    assert.deepEqual(Object.keys(r.outcome).sort(), expectedKeys);
    assert.equal(typeof r.confidence, 'number');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.equal(r.tier, 'human', 'human_review_required forces human for both providers');
    assert.equal(r.outcome.paid_generation_required, true);
    for (const leaked of ['noul', 'choice', 'probabilities', 'legend', 'type']) {
      assert.ok(!(leaked in r.outcome), `${leaked} must not leak into outcome`);
    }
  }
  assert.equal(direct.resolved_by, 'jev');
  assert.equal(direct.provider, 'typesafe-ai');
  assert.equal(mock.resolved_by, 'mock-jev');
  assert.equal(mock.provider, 'mock');
  assert.ok(direct.usage.input_tokens > 0);
  assert.ok(direct.usage.estimated_cost_usd_micros >= 0);
});
