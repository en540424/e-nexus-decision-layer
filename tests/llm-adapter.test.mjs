/**
 * LLM Adapter（Claude・2026-09-29 FB-21）。実ネットワーク・実鍵は使わない（偽 SDK module。実 SDK が入っていれば送信形だけを fetch の stub で確かめる）。
 * 固定すること：既定で呼ばれない（allow_paid_adapters・EDL_ALLOW_NETWORK・専用の鍵）／環境の ANTHROPIC_* を使わない／tier は review が上限／
 * 再試行しない・abort を渡す／拒否・max_tokens・不正な応答・HTTP の失敗は unavailable（→ 次・human）／実際に答えたモデルの単価で費用／cost gate／
 * 安全分類器の拒否を別モデルで迂回しない（server-side fallback を送らない・同梱 policy に書けない・別モデルの答えを採用しない。2026-09-29 独立監査）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmAdapter, classifySdkError, outputSchemaFor, costUsdMicros, loadLlmPolicy, SYSTEM_PROMPT, refusalFallbackViolations } from '../src/adapters/llm/llm-adapter.mjs';
import { createDecisionEngine, capTier } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { readJson } from '../src/schemas/loader.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';

const KEY = 'sk-test-llm-0123456789abcdef';
const ENV = Object.freeze({ EDL_ALLOW_NETWORK: 'true', ENEXUS_LLM_ANTHROPIC_API_KEY: KEY });
const INPUT = { asset_kind: 'scene', purpose: 'product hero shot we do not have locally', style: 'photoreal', estimated_paid_cost_usd_micros: 300000 };
const REQ = { decision_type: 'paid-generation-gate', application_id: 'claude-code', project_id: 'en-generate-hub', input: INPUT };
const GOOD = {
  local_sufficient: { probability_true: 0.03 },
  remotion_suitable: { probability_true: 0.03 },
  paid_generation_required: { probability_true: 0.97 },
  human_review_required: { probability_true: 0.03 },
  recommended_route: { choice: 'en-generate-hub', confidence: 0.99 },
};

class APIError extends Error { constructor(status, msg = 'x') { super(msg); this.status = status; } }
class APIUserAbortError extends APIError { constructor() { super(undefined, 'aborted'); } }
class APIConnectionError extends APIError { constructor() { super(undefined, 'conn'); } }
class APIConnectionTimeoutError extends APIConnectionError {}

/** 偽 SDK module：constructor の引数・create の body と request options を記録する */
function fakeSdk(respond) {
  const seen = { ctor: [], calls: [] };
  class Anthropic {
    constructor(opts) {
      seen.ctor.push(opts);
      this.beta = { messages: { create: async (body, reqOpts) => { seen.calls.push({ body, reqOpts }); return respond(body); } } };
    }
  }
  return { seen, loader: async () => ({ default: Anthropic, APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError }) };
}
const reply = (json, o = {}) => () => ({ model: o.model ?? 'claude-opus-5-5', stop_reason: o.stop ?? 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }], usage: { input_tokens: 1000, output_tokens: 200 }, ...(o.extra ?? {}) });

function engineWith(adapter) {
  return createDecisionEngine({ adapters: [createRulesAdapter(), adapter, createHumanAdapter()], meter: createMemoryMeter() });
}

test('既定で呼ばれない：allow_paid_adapters が無ければ cost gate で chain から外れ、SDK に触れない', async () => {
  const f = fakeSdk(reply(GOOD));
  const r = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: f.loader })).decide(REQ);
  assert.equal(r.tier, 'human');
  assert.ok(r.fallback.skipped.some((s) => s.adapter === 'llm' && s.reason === 'COST_GATE_PAID_ADAPTER_NOT_ALLOWED'));
  assert.equal(f.seen.ctor.length, 0);
});

test('鍵：専用の ENEXUS_LLM_ANTHROPIC_API_KEY だけ。ANTHROPIC_API_KEY／AUTH_TOKEN が環境にあっても使わず、client を作らない', async () => {
  const f = fakeSdk(reply(GOOD));
  const env = { EDL_ALLOW_NETWORK: 'true', ANTHROPIC_API_KEY: 'sk-ambient-0123456789abcdef', ANTHROPIC_AUTH_TOKEN: 'ambient-token' };
  const a = createLlmAdapter({ env, sdkLoader: f.loader });
  await assert.rejects(a.decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] }), (e) => e instanceof AdapterUnavailableError && e.details.reason === 'LLM_API_KEY_MISSING');
  assert.equal(f.seen.ctor.length, 0);
  await assert.rejects(createLlmAdapter({ env: { ...ENV, EDL_ALLOW_NETWORK: undefined }, sdkLoader: f.loader }).decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] }), (e) => e.details.reason === 'NETWORK_DISABLED');
  await assert.rejects(createLlmAdapter({ env: { ...ENV, EDL_LLM_MODEL: 'claude-fable-5-1' }, sdkLoader: f.loader }).decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] }), (e) => e.details.reason === 'LLM_MODEL_NOT_ALLOWED', 'env から一覧外の高額モデルを選べない');
  await assert.rejects(createLlmAdapter({ env: ENV, sdkLoader: async () => null }).decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] }), (e) => e.details.reason === 'LLM_SDK_NOT_INSTALLED');
});

test('送信：client は鍵・authToken=null・baseURL・maxRetries 0・timeout を明示。body は structured outputs・effort low、fallbacks・betas は無し、abort を渡す', async () => {
  const f = fakeSdk(reply(GOOD));
  const controller = new AbortController();
  const r = await createLlmAdapter({ env: ENV, sdkLoader: f.loader }).decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [], signal: controller.signal });
  const policy = loadLlmPolicy();
  assert.deepEqual(f.seen.ctor[0], { apiKey: KEY, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: policy.timeout_ms });
  assert.ok(policy.timeout_ms < 30000, 'Gateway の timeout（30 秒）より短い');
  const { body, reqOpts } = f.seen.calls[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.betas, undefined, 'server-side fallback の beta を送らない');
  assert.equal(body.fallbacks, undefined, '安全分類器の拒否を別モデルで迂回しない');
  assert.equal(body.tool_choice, undefined, 'forced tool_choice は Opus 5.5 で 400');
  assert.deepEqual(reqOpts, { signal: controller.signal, timeout: policy.timeout_ms, maxRetries: 0 });
  const sent = JSON.parse(body.messages[0].content);
  assert.deepEqual(sent.input, INPUT, 'input は data として JSON の中に入る');
  assert.ok(sent.questions.recommended_route.criteria['en-generate-hub'] !== undefined);
  assert.equal(r.outcome.recommended_route, 'en-generate-hub');
  assert.equal(r.outcome.paid_generation_required, true);
  assert.equal(r.model, 'claude-opus-5-5');
  assert.deepEqual(r.usage, { input_tokens: 1000, output_tokens: 200, estimated_cost_usd_micros: 8000 }, '1000×$4/M + 200×$20/M');
});

test('structured outputs の schema：API が受けない数値範囲を入れず、全 object が additionalProperties:false と required を持つ', () => {
  const s = outputSchemaFor({ a: { type: 'noul', instructions: 'A?' }, b: { type: 'choice', instructions: 'B?', criteria: { x: null, y: 'y' } }, c: { type: 'score', instructions: 'C?', criteria: ['c0', 'c1', 'c2'] } });
  const walk = (o) => {
    if (o && typeof o === 'object') {
      assert.ok(!('minimum' in o) && !('maximum' in o) && !('minLength' in o));
      if (o.type === 'object') { assert.equal(o.additionalProperties, false); assert.ok(Array.isArray(o.required)); }
      Object.values(o).forEach(walk);
    }
  };
  walk(s);
  assert.deepEqual(s.properties.b.properties.choice.enum, ['x', 'y']);
  assert.deepEqual(s.properties.c.properties.level.enum, [0, 1, 2]);
});

test('tier の上限は review：confidence 0.94 でも auto にならない（engine の max_tier_by_adapter）。Human へ上げる答えは human', async () => {
  const f = fakeSdk(reply(GOOD));
  const r = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: f.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
  assert.equal(r.resolved_by, 'llm');
  assert.ok(r.confidence >= 0.9);
  assert.equal(r.tier, 'review');
  assert.equal(readJson('policies/routing/default.json').max_tier_by_adapter.llm, 'review');
  const f2 = fakeSdk(reply({ ...GOOD, human_review_required: { probability_true: 0.9 } }));
  const r2 = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: f2.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
  assert.equal(r2.tier, 'human');
  assert.deepEqual([capTier('auto', 'review'), capTier('review', 'review'), capTier('human', 'review'), capTier('auto', undefined), capTier('auto', 'human')], ['review', 'review', 'human', 'auto', 'human']);
});

test('別のモデルが答えた応答は採用しない（LLM_UNEXPECTED_MODEL → human）。費用はそのモデルの単価、一覧外なら不明（0 と書かない）', async () => {
  const f = fakeSdk(reply(GOOD, { model: 'claude-opus-4-8' }));
  const r = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: f.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
  assert.equal(r.tier, 'human');
  assert.notEqual(r.resolved_by, 'llm');
  const att = r.fallback.trace.find((t) => t.adapter === 'llm');
  assert.equal(att.reason, 'LLM_UNEXPECTED_MODEL');
  assert.equal(att.usage_known, true, '送信済み・課金済みの usage は残す');
  assert.equal(att.estimated_cost_usd_micros, costUsdMicros(loadLlmPolicy().models['claude-opus-4-8'], 1000, 200));
  const u = fakeSdk(reply(GOOD, { model: 'claude-unknown-9' }));
  const r2 = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: u.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
  const att2 = r2.fallback.trace.find((t) => t.adapter === 'llm');
  assert.equal(att2.reason, 'LLM_UNEXPECTED_MODEL');
  assert.equal(att2.usage_known, false);
  assert.equal(att2.estimated_cost_usd_micros, null);
});

test('usage.iterations に fallback_message（要求モデル名のままでも）→ 採用しない。試行が複数なら top-level の usage は最後の分だけなので費用は不明', async () => {
  const iterations = [{ type: 'message', input_tokens: 1000, output_tokens: 0 }, { type: 'fallback_message', input_tokens: 1000, output_tokens: 200 }];
  const f = fakeSdk(reply(GOOD, { extra: { usage: { input_tokens: 1000, output_tokens: 200, iterations } } }));
  const r = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: f.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
  assert.equal(r.tier, 'human');
  const att = r.fallback.trace.find((t) => t.adapter === 'llm');
  assert.equal(att.reason, 'LLM_UNEXPECTED_MODEL');
  assert.equal(att.usage_known, false, '合計が分からないので 0 や最後の試行分で書かない');
});

test('安全分類器の拒否を迂回しない：同梱 policy は全モデル fallbacks=null。null 以外なら SDK に触れず LLM_REFUSAL_FALLBACK_FORBIDDEN（→ human）', async () => {
  const shipped = loadLlmPolicy();
  assert.deepEqual(refusalFallbackViolations(shipped), [], 'policies/llm/anthropic.json に fallbacks を書かない（2026-09-29 独立監査・decision-log）');
  for (const v of ['default', [{ model: 'claude-opus-4-8' }]]) {
    const policy = { ...shipped, models: { ...shipped.models, 'claude-opus-5-5': { ...shipped.models['claude-opus-5-5'], fallbacks: v } } };
    assert.deepEqual(refusalFallbackViolations(policy), ['claude-opus-5-5']);
    const f = fakeSdk(reply(GOOD));
    const r = await engineWith(createLlmAdapter({ env: ENV, policy, sdkLoader: f.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
    assert.equal(r.tier, 'human');
    assert.equal(r.fallback.trace.find((t) => t.adapter === 'llm').reason, 'LLM_REFUSAL_FALLBACK_FORBIDDEN');
    assert.equal(f.seen.ctor.length, 0, '送らない＝課金しない');
  }
});

test('拒否・max_tokens・不正な応答は unavailable（→ human）。送信済みの usage は失敗 attempt にも残る', async () => {
  for (const [respond, reason] of [
    [reply(GOOD, { stop: 'refusal', extra: { stop_details: { category: 'cyber' } } }), 'LLM_REFUSED'],
    [reply(GOOD, { stop: 'max_tokens' }), 'LLM_MAX_TOKENS'],
    [reply('not json'), 'LLM_MALFORMED_RESPONSE'],
    [reply({ ...GOOD, recommended_route: { choice: 'somewhere-else', confidence: 0.9 } }), 'LLM_MALFORMED_RESPONSE'],
    [reply({ ...GOOD, local_sufficient: { probability_true: 7 } }), 'LLM_MALFORMED_RESPONSE'],
  ]) {
    const f = fakeSdk(respond);
    const r = await engineWith(createLlmAdapter({ env: ENV, sdkLoader: f.loader })).decide({ ...REQ, options: { allow_paid_adapters: true } });
    assert.equal(r.tier, 'human', reason);
    const att = r.fallback.trace.find((t) => t.adapter === 'llm');
    assert.equal(att.reason, reason);
    assert.equal(att.usage_known, true, `${reason}: billed usage is kept`);
    assert.equal(att.estimated_cost_usd_micros, 8000);
  }
});

test('SDK の例外の分類：abort・timeout・接続・401・429・529・5xx・400（再試行しない＝呼び出しは 1 回）', async () => {
  const sdk = { APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError };
  const cases = [
    [new APIUserAbortError(), 'LLM_ABORTED'], [new APIConnectionTimeoutError(), 'LLM_TIMEOUT'], [new APIConnectionError(), 'LLM_NETWORK_ERROR'],
    [new APIError(401), 'LLM_UNAUTHORIZED'], [new APIError(429), 'LLM_RATE_LIMITED'], [new APIError(529), 'LLM_OVERLOADED'], [new APIError(503), 'LLM_HTTP_5XX'],
    [new APIError(400), 'LLM_BAD_REQUEST'], [new APIError(404), 'LLM_MODEL_NOT_FOUND'], [new Error('other'), 'LLM_CLIENT_ERROR'],
  ];
  for (const [err, reason] of cases) assert.equal(classifySdkError(err, sdk).details.reason, reason);
  let calls = 0;
  const f = fakeSdk(() => { calls += 1; throw new APIError(529); });
  await assert.rejects(createLlmAdapter({ env: ENV, sdkLoader: f.loader }).decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] }), (e) => e.details.reason === 'LLM_OVERLOADED');
  assert.equal(calls, 1);
});

test('cost gate（FB-14）：見積もりは入力＋max_tokens 全部の出力。上限を下回れば送らない', async () => {
  const f = fakeSdk(reply(GOOD));
  const a = createLlmAdapter({ env: ENV, sdkLoader: f.loader });
  const est = await a.estimateCost({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] });
  const policy = loadLlmPolicy();
  assert.ok(est >= costUsdMicros(policy.models['claude-opus-5-5'], 0, policy.max_tokens), 'output side is counted in full');
  const costPolicy = { ...readJson('policies/cost/limits.json'), per_decision_estimated_cost_usd_micros_max: est - 1 };
  const eng = createDecisionEngine({ adapters: [createRulesAdapter(), a, createHumanAdapter()], meter: createMemoryMeter(), costPolicy });
  const r = await eng.decide({ ...REQ, options: { allow_paid_adapters: true } });
  assert.equal(r.fallback.trace.find((t) => t.adapter === 'llm').reason, 'COST_GATE_ESTIMATE_OVER_LIMIT');
  assert.equal(f.seen.calls.length, 0);
});

// 実 SDK（optionalDependencies）が入っていれば、送信形を fetch の stub で確かめる（network 無し）
let realSdk = null;
try { realSdk = await import('@anthropic-ai/sdk'); } catch { realSdk = null; }
test('実 SDK の送信形：POST /v1/messages・x-api-key・anthropic-version・body（server-side fallback の header・field 無し）。環境の ANTHROPIC_AUTH_TOKEN／BASE_URL は使われない', { skip: realSdk ? false : '@anthropic-ai/sdk が入っていない（optionalDependencies）' }, async () => {
  const saved = { t: process.env.ANTHROPIC_AUTH_TOKEN, b: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token-must-not-be-sent';
  process.env.ANTHROPIC_BASE_URL = 'https://ambient.example.invalid';
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: JSON.stringify(GOOD) }], usage: { input_tokens: 900, output_tokens: 150 } }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  };
  try {
    const r = await createLlmAdapter({ env: ENV, fetchImpl }).decide({ decisionType: 'paid-generation-gate', input: INPUT, candidates: [] });
    assert.equal(r.outcome.recommended_route, 'en-generate-hub');
    assert.equal(seen.length, 1, 'no retries');
    const s = seen[0];
    assert.equal(s.method, 'POST');
    assert.match(s.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(s.headers.get('x-api-key'), KEY);
    assert.ok(s.headers.get('anthropic-version'));
    assert.ok(!(s.headers.get('anthropic-beta') ?? '').includes('server-side-fallback'), 'server-side fallback の beta を送らない');
    assert.equal(s.headers.get('authorization'), null, 'ambient ANTHROPIC_AUTH_TOKEN is not sent');
    assert.equal(s.body.model, 'claude-opus-5-5');
    assert.equal(s.body.output_config.format.type, 'json_schema');
    assert.equal(s.body.fallbacks, undefined, '安全分類器の拒否を別モデルで迂回しない');
    assert.equal(s.body.betas, undefined, 'betas は body に入らない');
  } finally {
    if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
    if (saved.b === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saved.b;
  }
});
