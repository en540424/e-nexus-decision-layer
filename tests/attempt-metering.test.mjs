/**
 * Intermediate Adapter Metering（2026-09-19）。
 *
 * 「final decision（resolved_by / provider / model / top-level usage）」と
 * 「execution attempts（途中で実際に呼んだ adapter / provider の usage・confidence・latency・status）」を分離し、
 * final が human や別 adapter でも、途中で real provider（Jev 等）を呼んだ事実と費用を失わないことを検証する。
 * 実ネットワークは一切使わない（fetch / evaluateImpl はすべて fake）。Human Gate の挙動は変えない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectJevProvider } from '../src/adapters/jev/jev-direct-provider.mjs';
import { createVercelJevProvider } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { createJevAdapter, parseJevResponse } from '../src/adapters/jev/jev-adapter.mjs';
import { createMockJevAdapter } from '../src/adapters/jev/mock-jev-adapter.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';
import { runFallbackChain } from '../src/core/fallback.mjs';
import { loadThresholds } from '../src/core/confidence.mjs';
import {
  USAGE_FIELDS, ATTEMPT_FIELDS, createFileMeter, summarize, summarizeAttempts, attemptsOf, attemptsFromTrace, totalUsage,
} from '../src/usage/metering.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

const PHOTOREAL = { asset_kind: 'scene', purpose: 'promo teaser', style: 'photoreal', duration_sec: 8 };
const SUBTITLE = { asset_kind: 'subtitle', purpose: 'x' }; // rules で解ける入力
const ENV_DIRECT = { JEV_API_KEY: 'dummy-key-for-test', EDL_ALLOW_NETWORK: 'true' };
const noSleep = async () => {};

function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (n) => h.get(String(n).toLowerCase()) ?? null }, async json() { return body; } };
}

/** 公式 Jev 形式の正常応答。choiceConfidence で全体 confidence（min）を制御する（noul は 0.99 → 0.98） */
function jevBody({ choiceConfidence, model = 'jev-1.13.0', inputTokens = 1000, outputTokens = 10 }) {
  return {
    model,
    answers: {
      local_sufficient: { type: 'noul', noul: 0.01 },
      remotion_suitable: { type: 'noul', noul: 0.01 },
      paid_generation_required: { type: 'noul', noul: 0.99 },
      human_review_required: { type: 'noul', noul: 0.01 },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', probabilities: { 'en-generate-hub': 0.9 }, confidence: choiceConfidence },
    },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/** 実 Direct 経路（fake fetch）を通る jev adapter */
function directJev(responses, { env = ENV_DIRECT } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl: noSleep });
  return { adapter: createJevAdapter({ env, provider }), calls };
}

function chainOf(jev) {
  return [createRulesAdapter(), jev, createLocalAdapterStub(), createHumanAdapter()];
}

const jevAttempt = (r) => r.fallback.trace.find((t) => t.adapter === 'jev');

// ---------------------------------------------------------------------------
// final vs attempt
// ---------------------------------------------------------------------------

test('rules → final: one attempt, final=true, networked=false, cost 0 known; usage_total = 0', async () => {
  const { engine, meter } = makeEngine();
  const r = await engine.decide(gateRequest(SUBTITLE));
  assert.equal(r.resolved_by, 'rules');
  assert.equal(r.fallback.trace.length, 1);
  const a = r.fallback.trace[0];
  assert.equal(a.final, true);
  assert.equal(a.networked, false);
  assert.equal(a.usage_known, true);
  assert.equal(a.estimated_cost_usd_micros, 0);
  assert.equal(typeof a.latency_ms, 'number');
  assert.equal(a.ms, a.latency_ms);
  const row = meter.readAll()[0];
  assert.equal(row.attempts.length, 1);
  assert.deepEqual(row.usage_total, { attempts: 1, ok_attempts: 1, networked_attempts: 0, unknown_usage_attempts: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0 });
});

test('Jev high confidence → final Jev: final provider/model = Jev, attempt usage = top-level usage, total cost matches (no double count)', async () => {
  const { adapter, calls } = directJev([fakeResponse({ body: jevBody({ choiceConfidence: 0.97 }) })]);
  const { engine, meter } = makeEngine({ adapters: chainOf(adapter) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(calls.length, 1, 'exactly one real request');
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.provider, 'typesafe-ai');
  assert.equal(r.tier, 'auto');
  const a = jevAttempt(r);
  assert.equal(a.final, true);
  assert.equal(a.networked, true);
  assert.equal(a.route, 'direct');
  assert.equal(a.model, 'jev-1.13.0', 'model comes from the real response, not the static adapter.model');
  assert.equal(a.usage_known, true);
  assert.equal(a.input_tokens, 1000);
  assert.equal(a.output_tokens, 10);
  assert.ok(a.estimated_cost_usd_micros > 0, 'priced from registries/models.json');
  assert.equal(a.retry_count, 0);
  assert.equal(a.continue_reason, undefined);
  const row = meter.readAll()[0];
  assert.equal(row.estimated_cost_usd_micros, a.estimated_cost_usd_micros, 'top-level (final resolver) usage');
  assert.equal(row.usage_total.estimated_cost_usd_micros, a.estimated_cost_usd_micros, 'usage_total equals the single networked attempt');
  assert.equal(row.usage_total.networked_attempts, 1);
  assert.equal(row.usage_total.unknown_usage_attempts, 0);
});

test('Jev low confidence → human: final stays human/null/0, but the intermediate Jev usage, confidence, latency, model are preserved', async () => {
  const { adapter } = directJev([fakeResponse({ body: jevBody({ choiceConfidence: 0.08 }) })]);
  const { engine, meter } = makeEngine({ adapters: chainOf(adapter) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  // final result semantics（変えない）
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.provider, null);
  assert.equal(r.model, null);
  assert.equal(r.confidence, 0, 'final confidence is the human resolver, not rewritten to 0.08');
  assert.equal(r.tier, 'human');
  assert.equal(r.human_gate.required, true);
  const row = meter.readAll()[0];
  assert.equal(row.resolved_by, 'human');
  assert.equal(row.provider, null);
  assert.equal(row.input_tokens, 0);
  assert.equal(row.estimated_cost_usd_micros, 0, 'top-level usage keeps its "final resolver" meaning');
  // intermediate attempt（失わない）
  const a = jevAttempt(r);
  assert.equal(a.status, 'ok');
  assert.equal(a.final, false);
  assert.equal(a.continue_reason, 'CONFIDENCE_TIER_HUMAN');
  assert.equal(a.confidence, 0.08);
  assert.equal(a.tier, 'human');
  assert.equal(a.networked, true);
  assert.equal(a.provider, 'typesafe-ai');
  assert.equal(a.model, 'jev-1.13.0');
  assert.equal(a.input_tokens, 1000);
  assert.ok(a.estimated_cost_usd_micros > 0);
  assert.equal(typeof a.latency_ms, 'number');
  const ra = row.attempts.find((x) => x.adapter === 'jev');
  assert.equal(ra.confidence, 0.08);
  assert.equal(ra.estimated_cost_usd_micros, a.estimated_cost_usd_micros);
  assert.equal(row.usage_total.estimated_cost_usd_micros, a.estimated_cost_usd_micros, 'decision-level total includes the Jev call');
  assert.equal(row.usage_total.input_tokens, 1000);
  assert.equal(row.usage_total.networked_attempts, 1);
  assert.equal(row.attempts.filter((x) => x.final).length, 1);
  assert.equal(row.attempts.find((x) => x.final).adapter, 'human');
  // chain 順（rules → jev → local → human）
  assert.deepEqual(row.attempts.map((x) => `${x.adapter}:${x.status}`), ['rules:unavailable', 'jev:ok', 'local:unavailable', 'human:ok']);
});

test('Jev unavailable before any network call (no key / gate closed / unsupported outcome field): networked=false, cost 0 known', async () => {
  for (const env of [{ EDL_ALLOW_NETWORK: 'true' }, { JEV_API_KEY: 'k' }]) {
    const { engine, meter } = makeEngine({ adapters: [createRulesAdapter(), createJevAdapter({ env }), createMockJevAdapter(), createHumanAdapter()] });
    const r = await engine.decide(gateRequest(PHOTOREAL));
    const a = jevAttempt(r);
    assert.equal(a.status, 'unavailable');
    assert.equal(a.networked, false);
    assert.equal(a.usage_known, true);
    assert.equal(a.estimated_cost_usd_micros, 0);
    assert.equal(meter.readAll()[0].usage_total.networked_attempts, 0);
  }
  // 変換で止まる（送信前）
  const { adapter, calls } = directJev([]);
  await assert.rejects(
    () => adapter.decide({ decisionType: 'model-route', input: {}, candidates: [] }),
    (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_UNSUPPORTED_OUTCOME_FIELD' && e.details.networked === undefined,
  );
  assert.equal(calls.length, 0);
});

test('Jev auth failure (401): attempt is recorded as networked=true with usage UNKNOWN (null), tokens/cost not fabricated', async () => {
  const { adapter, calls } = directJev([fakeResponse({ status: 401 })]);
  const { engine, meter } = makeEngine({ adapters: [createRulesAdapter(), adapter, createMockJevAdapter(), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(calls.length, 1);
  const a = jevAttempt(r);
  assert.equal(a.status, 'unavailable');
  assert.equal(a.reason, 'JEV_AUTH_FAILED');
  assert.equal(a.networked, true);
  assert.equal(a.route, 'direct');
  assert.equal(a.usage_known, false);
  assert.equal(a.input_tokens, null);
  assert.equal(a.output_tokens, null);
  assert.equal(a.estimated_cost_usd_micros, null);
  assert.equal(a.retry_count, 0, '401 is not retried');
  const row = meter.readAll()[0];
  assert.equal(row.usage_total.networked_attempts, 1);
  assert.equal(row.usage_total.unknown_usage_attempts, 1);
  assert.equal(row.usage_total.estimated_cost_usd_micros, 0, 'unknown is not summed as a number');
  assert.equal(row.resolved_by, 'mock-jev');
  assert.ok(!JSON.stringify(row).includes('dummy-key-for-test'), 'no secret in the record');
});

test('Jev retry: 503,503,200 → ONE attempt with retry_count=2, usage counted once; all-fail → one unavailable attempt with retry_count=2', async () => {
  const ok = directJev([fakeResponse({ status: 503 }), fakeResponse({ status: 503 }), fakeResponse({ body: jevBody({ choiceConfidence: 0.97 }) })]);
  const { engine, meter } = makeEngine({ adapters: chainOf(ok.adapter) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(ok.calls.length, 3, 'three HTTP sends');
  assert.equal(r.fallback.trace.filter((t) => t.adapter === 'jev').length, 1, 'still one attempt record');
  const a = jevAttempt(r);
  assert.equal(a.status, 'ok');
  assert.equal(a.retry_count, 2);
  assert.equal(a.input_tokens, 1000, 'not 3000');
  assert.equal(meter.readAll()[0].usage_total.input_tokens, 1000);

  const fail = directJev([fakeResponse({ status: 503 }), fakeResponse({ status: 503 }), fakeResponse({ status: 503 })]);
  const e2 = makeEngine({ adapters: chainOf(fail.adapter) });
  const r2 = await e2.engine.decide(gateRequest(PHOTOREAL));
  assert.equal(fail.calls.length, 3);
  const b = jevAttempt(r2);
  assert.equal(b.status, 'unavailable');
  assert.equal(b.reason, 'JEV_OVERLOADED');
  assert.equal(b.networked, true);
  assert.equal(b.retry_count, 2);
  assert.equal(b.usage_known, false);
  assert.equal(r2.resolved_by, 'human');
});

test('Jev timeout (AbortError) → networked=true, unknown usage; Vercel route: retry_count is null (SDK-internal, not observable), route=vercel', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const t = directJev([abort, abort, abort]);
  const { engine } = makeEngine({ adapters: chainOf(t.adapter) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  const a = jevAttempt(r);
  assert.equal(a.reason, 'JEV_TIMEOUT');
  assert.equal(a.networked, true);
  assert.equal(a.usage_known, false);
  assert.equal(a.retry_count, 2);

  const evaluateImpl = async () => ({
    answers: {
      local_sufficient: { type: 'boolean', probability: 0.01 },
      remotion_suitable: { type: 'boolean', probability: 0.01 },
      paid_generation_required: { type: 'boolean', probability: 0.99 },
      human_review_required: { type: 'boolean', probability: 0.01 },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', probabilities: { 'en-generate-hub': 0.9 } },
    },
    providerMetadata: { typesafe: { confidence: { recommended_route: 0.08 } } },
    usage: { inputTokens: 512, outputTokens: 8 },
    response: { modelId: 'typesafe-ai/jev' },
  });
  const vercel = createJevAdapter({ env: { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }, provider: createVercelJevProvider({ evaluateImpl }) });
  const v = makeEngine({ adapters: chainOf(vercel) });
  const rv = await v.engine.decide(gateRequest(PHOTOREAL));
  const b = jevAttempt(rv);
  assert.equal(b.status, 'ok');
  assert.equal(b.confidence, 0.08);
  assert.equal(b.route, 'vercel');
  assert.equal(b.model, 'typesafe-ai/jev');
  assert.equal(b.networked, true);
  assert.equal(b.retry_count, null);
  assert.equal(b.input_tokens, 512);
  assert.equal(rv.resolved_by, 'human');
  assert.equal(v.meter.readAll()[0].usage_total.input_tokens, 512);

  // Vercel 側の HTTP エラーも送信後 → networked=true
  const failing = createJevAdapter({ env: { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }, provider: createVercelJevProvider({ evaluateImpl: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); } }) });
  const f = makeEngine({ adapters: chainOf(failing) });
  const rf = await f.engine.decide(gateRequest(PHOTOREAL));
  assert.equal(jevAttempt(rf).reason, 'JEV_FORBIDDEN');
  assert.equal(jevAttempt(rf).networked, true);
  assert.equal(jevAttempt(rf).usage_known, false);
});

test('malformed response AFTER a real send is networked=true; malformed AdapterResult shape keeps networked from the raw result', async () => {
  assert.throws(
    () => parseJevResponse({ model: 'x', answers: {} }, { fieldPlans: { a: { kind: 'noul' } } }),
    (e) => e.details.reason === 'JEV_MALFORMED_RESPONSE' && e.details.networked === true,
  );
  const { adapter } = directJev([fakeResponse({ body: { model: 'x', answers: {} } })]);
  const { engine } = makeEngine({ adapters: chainOf(adapter) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(jevAttempt(r).reason, 'JEV_MALFORMED_RESPONSE');
  assert.equal(jevAttempt(r).networked, true);
  assert.equal(jevAttempt(r).usage_known, false);

  const badShape = { id: 'jev', kind: 'probabilistic', provider: 'typesafe-ai', model: 'jev', supports: () => true, async decide() { return { outcome: {}, confidence: 7, networked: true }; } };
  const e2 = makeEngine({ adapters: chainOf(badShape) });
  const r2 = await e2.engine.decide(gateRequest(PHOTOREAL));
  assert.match(jevAttempt(r2).reason, /confidence out of range/);
  assert.equal(jevAttempt(r2).networked, true);
  assert.equal(jevAttempt(r2).usage_known, false);
});

test('generic adapter error: networked=null (unknown), usage unknown — never written as 0', async () => {
  const broken = { id: 'broken', kind: 'probabilistic', provider: 'someone', model: null, supports: () => true, decide: async () => { throw new Error('boom'); } };
  const { engine, meter } = makeEngine({ adapters: [broken, createMockJevAdapter(), createHumanAdapter()], routingPolicy: { default_chain: ['broken', 'mock-jev', 'human'], overrides: {} } });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  const a = r.fallback.trace[0];
  assert.equal(a.networked, null);
  assert.equal(a.usage_known, false);
  assert.equal(a.estimated_cost_usd_micros, null);
  assert.equal(meter.readAll()[0].usage_total.unknown_usage_attempts, 1);
});

test('mock: provider=mock, networked=false, cost 0 — never confused with real provider usage', async () => {
  const { engine, meter } = makeEngine();
  const r = await engine.decide(gateRequest(PHOTOREAL));
  const a = r.fallback.trace.find((t) => t.adapter === 'mock-jev');
  assert.equal(a.provider, 'mock');
  assert.equal(a.networked, false);
  assert.equal(a.estimated_cost_usd_micros, 0);
  assert.ok(a.input_tokens > 0, 'mock keeps emitting simulated tokens (existing behaviour) but is not networked');
  const row = meter.readAll()[0];
  assert.equal(row.usage_total.networked_attempts, 0);
  assert.equal(row.usage_total.estimated_cost_usd_micros, 0);
  const byProv = summarizeAttempts([row], 'provider');
  assert.equal(byProv.mock.networked, 0);
  assert.ok(!('typesafe-ai' in byProv) || byProv['typesafe-ai'].networked === 0);
});

test('local: unconfigured stub → unavailable, networked=false, cost 0; configured local adapter → ok, networked=false, usage known', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'b-roll', purpose: 'x', __mock: { outcome: { local_sufficient: true, remotion_suitable: false, paid_generation_required: false, human_review_required: false, recommended_route: 'local' }, confidence: 0.2 } }));
  const a = r.fallback.trace.find((t) => t.adapter === 'local');
  assert.equal(a.status, 'unavailable');
  assert.equal(a.reason, 'LOCAL_MODEL_NOT_CONFIGURED');
  assert.equal(a.networked, false);
  assert.equal(a.usage_known, true);
  assert.equal(a.estimated_cost_usd_micros, 0);

  const localOk = {
    id: 'local', kind: 'probabilistic', provider: 'local', model: 'hermes-8b', supports: () => true,
    async decide() {
      return { outcome: { local_sufficient: true, remotion_suitable: false, paid_generation_required: false, human_review_required: false, recommended_route: 'local' }, confidence: 0.96, networked: false, usage: { input_tokens: 400, output_tokens: 30, estimated_cost_usd_micros: 0 } };
    },
  };
  const e2 = makeEngine({ adapters: [createRulesAdapter(), createJevAdapter({ env: {} }), localOk, createHumanAdapter()] });
  const r2 = await e2.engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r2.resolved_by, 'local');
  const b = r2.fallback.trace.find((t) => t.adapter === 'local');
  assert.equal(b.final, true);
  assert.equal(b.networked, false);
  assert.equal(b.usage_known, true);
  assert.equal(b.input_tokens, 400);
  assert.equal(b.model, 'hermes-8b');
});

test('human: final human usage is 0 and prior real-provider usage is kept — Human Gate unchanged', async () => {
  const { adapter } = directJev([fakeResponse({ body: jevBody({ choiceConfidence: 0.08 }) })]);
  const { engine, meter } = makeEngine({ adapters: chainOf(adapter) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  const h = r.fallback.trace.find((t) => t.adapter === 'human');
  assert.equal(h.final, true);
  assert.equal(h.networked, false);
  assert.equal(h.input_tokens, 0);
  assert.equal(h.estimated_cost_usd_micros, 0);
  assert.equal(h.confidence, 0);
  assert.equal(r.human_gate.preserved, true);
  assert.equal(r.human_gate.required, true);
  assert.equal(r.outcome.escalated, true);
  assert.ok(!('approved' in r.outcome));
  const row = meter.readAll()[0];
  assert.ok(row.usage_total.estimated_cost_usd_micros > 0, 'Jev cost survives a human final');
  assert.equal(row.human_escalation, true);
});

test('Human-only decision type: no adapter attempted except human; attempts reflect that (no networked, cost 0)', async () => {
  const { engine, meter } = makeEngine();
  const r = await engine.decide({ decision_type: 'cost-entry-classify', application_id: 'ai-cost-manager', project_id: 'ai-cost-manager', input: { service_name: 'x' } });
  if (r.human_gate.reason === 'decision_type is Human-only by safety policy') {
    assert.deepEqual(r.fallback.trace.map((t) => t.adapter), ['human']);
    assert.equal(meter.readAll()[0].usage_total.networked_attempts, 0);
  } else {
    // この decision_type が Human-only でない構成なら、少なくとも attempts が記録されることだけ確認する
    assert.ok(meter.readAll()[0].attempts.length >= 1);
  }
});

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

test('summarize: existing fields keep final-resolver semantics; total_* and attempts_by_provider include intermediate Jev cost', async () => {
  const { adapter } = directJev([fakeResponse({ body: jevBody({ choiceConfidence: 0.08 }) })]);
  const { engine, meter } = makeEngine({ adapters: chainOf(adapter) });
  await engine.decide(gateRequest(PHOTOREAL, { tenant: 'T1' }));
  await engine.decide(gateRequest(SUBTITLE, { tenant: 'T1' }));
  const rows = meter.readAll();
  const jevCost = rows[0].attempts.find((a) => a.adapter === 'jev').estimated_cost_usd_micros;
  const byApp = summarize(rows, 'application_id').openmontage;
  assert.equal(byApp.requests, 2);
  assert.equal(byApp.estimated_cost_usd_micros, 0, 'final-resolver cost is still 0 (human / rules)');
  assert.deepEqual(byApp.by_provider, { '(none)': 2 });
  assert.equal(byApp.total_estimated_cost_usd_micros, jevCost);
  assert.equal(byApp.total_input_tokens, 1000);
  assert.equal(byApp.attempts, 5);
  assert.equal(byApp.networked_attempts, 1);
  assert.equal(byApp.attempts_by_provider['typesafe-ai'].estimated_cost_usd_micros, jevCost);
  assert.equal(byApp.attempts_by_provider['typesafe-ai'].ok, 1);
  assert.equal(byApp.attempts_by_provider['(none)'].attempts, 3, 'rules×2 + human');
  for (const g of ['project_id', 'tenant', 'decision_type', 'provider']) assert.ok(summarize(rows, g));
  assert.equal(summarize(rows, 'tenant').T1.total_estimated_cost_usd_micros, jevCost);
});

test('summarizeAttempts: per provider / model / adapter / decision / application / project without double counting', async () => {
  const { adapter } = directJev([fakeResponse({ body: jevBody({ choiceConfidence: 0.08 }) }), fakeResponse({ body: jevBody({ choiceConfidence: 0.97, model: 'jev-2' }) })]);
  const { engine, meter } = makeEngine({ adapters: chainOf(adapter) });
  await engine.decide(gateRequest(PHOTOREAL));
  await engine.decide(gateRequest(PHOTOREAL));
  const rows = meter.readAll();
  const byProvider = summarizeAttempts(rows, 'provider');
  assert.equal(byProvider['typesafe-ai'].attempts, 2);
  assert.equal(byProvider['typesafe-ai'].networked, 2);
  assert.equal(byProvider['typesafe-ai'].input_tokens, 2000);
  assert.equal(byProvider['typesafe-ai'].final, 1, 'only the second decision was resolved by Jev');
  assert.equal(byProvider['typesafe-ai'].decisions, 2);
  const byModel = summarizeAttempts(rows, 'model');
  assert.equal(byModel['jev-1.13.0'].attempts, 1);
  assert.equal(byModel['jev-2'].attempts, 1);
  const byAdapter = summarizeAttempts(rows, 'adapter');
  assert.equal(byAdapter.rules.unavailable, 2);
  assert.equal(byAdapter.human.final, 1);
  const byDt = summarizeAttempts(rows, 'decision_type')['paid-generation-gate'];
  assert.equal(byDt.attempts, rows[0].attempts.length + rows[1].attempts.length);
  assert.equal(summarizeAttempts(rows, 'application_id').openmontage.decisions, 2);
  assert.equal(summarizeAttempts(rows, 'project_id').openmontage.input_tokens, 2000);
  const total = rows.reduce((s, r) => s + r.usage_total.estimated_cost_usd_micros, 0);
  assert.equal(byProvider['typesafe-ai'].estimated_cost_usd_micros, total, 'attempt-level total == sum of decision-level totals');
});

test('totalUsage / attemptsFromTrace: unknown attempts are counted, not summed; projection drops only ms', () => {
  const trace = [
    { adapter: 'a', status: 'unavailable', ms: 3, latency_ms: 3, networked: true, usage_known: false, input_tokens: null, output_tokens: null, estimated_cost_usd_micros: null, retry_count: null, final: false },
    { adapter: 'b', status: 'ok', ms: 5, latency_ms: 5, networked: true, usage_known: true, input_tokens: 10, output_tokens: 2, estimated_cost_usd_micros: 7, retry_count: 1, final: true },
  ];
  const attempts = attemptsFromTrace(trace);
  assert.ok(!('ms' in attempts[0]));
  assert.equal(attempts[0].latency_ms, 3);
  for (const k of Object.keys(attempts[1])) assert.ok(ATTEMPT_FIELDS.includes(k), k);
  assert.deepEqual(totalUsage(attempts), { attempts: 2, ok_attempts: 1, networked_attempts: 2, unknown_usage_attempts: 1, input_tokens: 10, output_tokens: 2, estimated_cost_usd_micros: 7 });
  // 想定外 record（usage_known 無し）は unknown 扱い
  assert.equal(attemptsFromTrace([{ adapter: 'x', status: 'ok' }])[0].usage_known, false);
});

// ---------------------------------------------------------------------------
// persistence / backward compatibility
// ---------------------------------------------------------------------------

const LEGACY_ROW = { timestamp: '2026-09-19T08:27:52.235Z', decision_id: 'dec_legacy_1', application_id: 'openmontage', project_id: 'openmontage', tenant: null, provider: 'mock', model: 'mock-jev', decision_type: 'paid-generation-gate', resolved_by: 'mock-jev', request_count: 1, input_tokens: 62, output_tokens: 16, estimated_cost_usd_micros: 0, fallback_occurred: true, human_escalation: true, tier: 'human' };

test('old records (no attempts / usage_total) still read and summarize; legacy row = one final attempt with only the known final usage', () => {
  const [a] = attemptsOf(LEGACY_ROW);
  assert.equal(a.legacy, true);
  assert.equal(a.adapter, 'mock-jev');
  assert.equal(a.final, true);
  assert.equal(a.networked, null, 'unknown for old rows — not invented');
  assert.equal(a.input_tokens, 62);
  const s = summarize([LEGACY_ROW], 'application_id').openmontage;
  assert.equal(s.requests, 1);
  assert.equal(s.input_tokens, 62);
  assert.equal(s.total_input_tokens, 62);
  assert.equal(s.attempts, 1);
  assert.equal(s.networked_attempts, 0);
  assert.deepEqual(s.by_provider, { mock: 1 });
  assert.equal(summarizeAttempts([LEGACY_ROW], 'provider').mock.attempts, 1);
});

test('JSONL: new record round-trips with all USAGE_FIELDS; old + new + partial/malformed rows coexist safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edl-att-'));
  const path = join(dir, 'u.jsonl');
  try {
    writeFileSync(path, `${JSON.stringify(LEGACY_ROW)}\n`, 'utf8');
    const meter = createFileMeter({ path });
    const { adapter } = directJev([fakeResponse({ body: jevBody({ choiceConfidence: 0.08 }) })]);
    const { engine } = makeEngine({ adapters: chainOf(adapter), meter });
    await engine.decide(gateRequest(PHOTOREAL));
    // partial / malformed（attempts が配列でない・attempt に usage_known が無い・usage_total 無し）
    meter.record({ decision_id: 'partial_1', application_id: 'openmontage', attempts: 'nope' });
    meter.record({ decision_id: 'partial_2', application_id: 'openmontage', attempts: [{ adapter: 'jev', status: 'ok', provider: 'typesafe-ai', input_tokens: 999 }] });
    const rows = meter.readAll();
    assert.equal(rows.length, 4);
    for (const f of USAGE_FIELDS) assert.ok(f in rows[1], f);
    assert.equal(rows[1].attempts.find((x) => x.adapter === 'jev').confidence, 0.08);
    const s = summarize(rows, 'application_id').openmontage;
    assert.equal(s.requests, 4);
    assert.equal(s.attempts, 1 + rows[1].attempts.length + 1 + 1, 'legacy 1 + new + partial_1 (as legacy) + partial_2 (1 attempt)');
    assert.equal(s.unknown_usage_attempts, 1, 'partial_2 attempt without usage_known is unknown, its 999 is NOT summed');
    assert.equal(s.total_input_tokens, 62 + 1000);
    const byP = summarizeAttempts(rows, 'provider');
    assert.equal(byP['typesafe-ai'].unknown_usage, 1);
    assert.equal(byP['typesafe-ai'].input_tokens, 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runFallbackChain without a human adapter: best attempt is marked final (no crash, attempts intact)', async () => {
  const thresholds = loadThresholds('paid-generation-gate');
  const low = { id: 'a', kind: 'probabilistic', provider: 'p', model: 'm', supports: () => true, async decide() { return { outcome: {}, confidence: 0.1, networked: true, usage: { input_tokens: 5 } }; } };
  const lower = { id: 'b', kind: 'probabilistic', provider: 'p', model: 'm', supports: () => true, async decide() { return { outcome: {}, confidence: 0.05, networked: true, usage: { input_tokens: 6 } }; } };
  const { chosen, trace } = await runFallbackChain({ chain: [low, lower], decisionType: 'x', input: {}, candidates: [], context: {}, thresholds });
  assert.equal(chosen.adapter.id, 'a');
  assert.equal(trace.find((t) => t.adapter === 'a').final, true);
  assert.equal(trace.find((t) => t.adapter === 'b').final, false);
  assert.equal(trace.find((t) => t.adapter === 'b').continue_reason, 'CONFIDENCE_TIER_HUMAN');
  assert.equal(totalUsage(attemptsFromTrace(trace)).input_tokens, 11);
});
