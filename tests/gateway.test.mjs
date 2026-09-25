/**
 * Common Decision Gateway（src/gateway/）— contract / guardrail / engine 差し替え / failure policy。
 * ネットワーク無し・キー無し・memory meter（usage.jsonl に書かない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, loadFailurePolicy, GATEWAY_CONTRACT_VERSION } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine, gatewayAdapters, assertEngineShape } from '../src/gateway/engine.mjs';
import { createMemoryMeter, USAGE_FIELDS } from '../src/usage/metering.mjs';
import { HumanGateViolationError } from '../src/core/errors.mjs';
import { readJson } from '../src/schemas/loader.mjs';
import { validate } from '../src/schemas/validate.mjs';

const NO_NET = {}; // EDL_ALLOW_NETWORK 無し・キー無し

function gw({ mode = 'production', env = NO_NET, ...rest } = {}) {
  const meter = createMemoryMeter();
  const gateway = createGateway({ engine: createDecisionLayerEngine({ env, mode, meter }), env, ...rest });
  return { gateway, meter };
}

const req = (input, extra = {}) => ({
  decision_type: 'paid-generation-gate', application_id: 'claude-code', project_id: 'en-generate-hub', input, ...extra,
});

test('contract v1: ok envelope wraps the existing DecisionResult unchanged (no duplicated tier / human_required fields)', async () => {
  const { gateway } = gw();
  const env = await gateway.decide(req({ asset_kind: 'subtitle', purpose: 'jp caption' }), { via: 'sdk' });
  assert.equal(env.contract_version, GATEWAY_CONTRACT_VERSION);
  assert.equal(env.ok, true);
  assert.match(env.request_id, /^req_/);
  assert.equal(env.correlation_id, null);
  assert.deepEqual(Object.keys(env).sort(), ['contract_version', 'correlation_id', 'decision', 'gateway', 'ok', 'request_id']);
  const errs = validate(readJson('schemas/common/decision-result.schema.json'), env.decision);
  assert.deepEqual(errs, []);
  assert.equal(env.decision.resolved_by, 'rules');
  assert.equal(env.decision.outcome.recommended_route, 'remotion');
  assert.deepEqual(Object.keys(env.gateway).sort(), ['engine', 'latency_ms', 'timestamp', 'via']);
  assert.equal(env.gateway.engine.id, 'e-nexus-decision-layer');
  assert.equal(env.gateway.engine.mode, 'production');
});

test('request_id / correlation_id / via reach usage metering; consumer-supplied via is overwritten', async () => {
  const { gateway, meter } = gw();
  const env = await gateway.decide(req({ asset_kind: 'subtitle', purpose: 'x' }, { request_id: 'r-1', correlation_id: 'hash:abc', via: 'mcp' }), { via: 'cli' });
  assert.equal(env.request_id, 'r-1');
  assert.equal(env.gateway.via, 'cli');
  const [row] = meter.readAll();
  assert.equal(row.request_id, 'r-1');
  assert.equal(row.correlation_id, 'hash:abc');
  assert.equal(row.via, 'cli');
  for (const f of ['request_id', 'correlation_id', 'via']) assert.ok(USAGE_FIELDS.includes(f));
});

test('direct decide() (no Gateway) still records null request_id / correlation_id / via (backward compatible)', async () => {
  const meter = createMemoryMeter();
  const engine = createDecisionLayerEngine({ env: NO_NET, meter });
  await engine.decide(req({ asset_kind: 'subtitle', purpose: 'x' }));
  const [row] = meter.readAll();
  assert.equal(row.request_id, null);
  assert.equal(row.correlation_id, null);
  assert.equal(row.via, null);
});

test('production mode: no mock-jev in the chain; without a usable Jev, unresolved requests escalate to human', async () => {
  assert.equal(gatewayAdapters({ env: NO_NET, mode: 'production' }).some((a) => a.id === 'mock-jev'), false);
  const { gateway } = gw();
  const env = await gateway.decide(req({ asset_kind: 'scene', purpose: 'product hero', style: 'photoreal' }));
  assert.equal(env.ok, true);
  assert.equal(env.decision.resolved_by, 'human');
  assert.equal(env.decision.tier, 'human');
  assert.equal(env.decision.human_gate.required, true);
  assert.equal(env.decision.fallback.trace.some((t) => t.adapter === 'mock-jev'), false);
});

test('verification mode: mock-jev is used only when real Jev is unusable (pipeline check, never a production fallback)', async () => {
  assert.equal(gatewayAdapters({ env: NO_NET, mode: 'verification' }).some((a) => a.id === 'mock-jev'), true);
  const usable = { EDL_ALLOW_NETWORK: 'true', JEV_API_KEY: 'k' };
  assert.equal(gatewayAdapters({ env: usable, mode: 'verification' }).some((a) => a.id === 'mock-jev'), false);
  const { gateway } = gw({ mode: 'verification' });
  const env = await gateway.decide(req({ asset_kind: 'scene', purpose: 'product hero', style: 'photoreal' }));
  assert.equal(env.gateway.engine.mode, 'verification');
  assert.equal(env.decision.provider === 'mock' || env.decision.resolved_by === 'human', true);
});

test('Rules first is preserved through the Gateway: >= $5 estimate is always human tier with route en-generate-hub', async () => {
  const { gateway } = gw();
  const env = await gateway.decide(req({ asset_kind: 'scene', purpose: 'x', estimated_paid_cost_usd_micros: 6_000_000 }));
  assert.equal(env.decision.resolved_by, 'rules');
  assert.equal(env.decision.outcome.recommended_route, 'en-generate-hub');
  assert.equal(env.decision.tier, 'human');
});

test('invalid requests return ok=false + structured error + fail-closed failure policy (never proceed automatically)', async () => {
  const { gateway } = gw();
  const cases = [
    [null, 'INVALID_ENVELOPE'],
    [[], 'INVALID_ENVELOPE'],
    [{ ...req({ asset_kind: 'scene', purpose: 'x' }), contract_version: '2' }, 'UNSUPPORTED_CONTRACT_VERSION'],
    [req({ asset_kind: 'scene', purpose: 'x' }, { request_id: 'has space' }), 'INVALID_ENVELOPE'],
    [req({ asset_kind: 'scene', purpose: 'x' }, { decision_type: 'no-such-type' }), 'UNKNOWN_DECISION_TYPE'],
    [req({ asset_kind: 'not-an-enum', purpose: 'x' }), 'SCHEMA_INVALID'],
    [{ decision_type: 'paid-generation-gate' }, 'SCHEMA_INVALID'],
  ];
  for (const [raw, code] of cases) {
    const env = await gateway.decide(raw);
    assert.equal(env.ok, false, code);
    assert.equal(env.decision, null);
    assert.equal(env.error.code, code);
    assert.equal(env.error.kind, 'invalid_request');
    assert.equal(env.failure.human_required, true);
    assert.equal(env.failure.proceed_automatically, false);
    assert.ok(['human-required', 'deny'].includes(env.failure.policy));
  }
});

function fakeEngine(decide, extra = {}) {
  return assertEngineShape({ id: 'fake-engine', version: '9.9.9', mode: 'production', decide, health: () => ({ fake: true }), ...extra });
}

test('Human Gate violation from the engine becomes ok=false and the offending outcome is not returned', async () => {
  const gateway = createGateway({ engine: fakeEngine(async () => { throw new HumanGateViolationError('outcome contains forbidden approval-like keys: approved', { keys: ['approved'] }); }) });
  const env = await gateway.decide(req({ asset_kind: 'scene', purpose: 'x' }));
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'HUMAN_GATE_VIOLATION');
  assert.equal(env.decision, null);
  assert.equal(JSON.stringify(env).includes('"approved":'), false);
  assert.equal(env.failure.human_required, true);
});

test('timeout and engine errors fail closed; raw engine error messages are not leaked', async () => {
  const slow = createGateway({ engine: fakeEngine(() => new Promise((r) => setTimeout(r, 200))), timeoutMs: 20 });
  const t = await slow.decide(req({ asset_kind: 'scene', purpose: 'x' }));
  assert.equal(t.error.code, 'GATEWAY_TIMEOUT');
  assert.equal(t.error.retryable, true);
  assert.equal(t.failure.policy, 'human-required');

  const boom = createGateway({ engine: fakeEngine(async () => { throw new Error('POST https://api.example/v1?key=SECRET failed body=...'); }) });
  const e = await boom.decide(req({ asset_kind: 'scene', purpose: 'x' }));
  assert.equal(e.error.code, 'ENGINE_ERROR');
  assert.equal(JSON.stringify(e).includes('SECRET'), false);
});

test('concurrency cap returns GATEWAY_BUSY without calling the engine', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const gateway = createGateway({ engine: fakeEngine(async () => { calls += 1; await gate; return { tier: 'auto', fallback: { occurred: false } }; }), maxConcurrent: 1 });
  const first = gateway.decide(req({ asset_kind: 'scene', purpose: 'x' }));
  const second = await gateway.decide(req({ asset_kind: 'scene', purpose: 'x' }));
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'GATEWAY_BUSY');
  assert.equal(calls, 1);
  release();
  assert.equal((await first).ok, true);
});

test('engine swap: a different decision engine keeps the consumer contract identical (only gateway.engine changes)', async () => {
  const fixed = { decision_id: 'd1', decision_type: 'paid-generation-gate', tier: 'review', outcome: {}, fallback: { occurred: false } };
  const a = await createGateway({ engine: fakeEngine(async () => fixed) }).decide(req({ asset_kind: 'scene', purpose: 'x' }, { request_id: 'same' }));
  const { gateway } = gw();
  const b = await gateway.decide(req({ asset_kind: 'subtitle', purpose: 'x' }, { request_id: 'same' }));
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(a.gateway.engine.id, 'fake-engine');
  assert.equal(b.gateway.engine.id, 'e-nexus-decision-layer');
});

test('failure policy: fail-open values are rejected at load time; shipped policy covers the implemented gate types', () => {
  assert.throws(() => loadFailurePolicy({ allowed: ['human-required', 'deny', 'allow'], default: 'allow', overrides: {} }), /fail-open/);
  assert.throws(() => loadFailurePolicy({ allowed: ['human-required', 'deny'], default: 'human-required', overrides: { 'paid-generation-gate': 'proceed' } }), /not allowed/);
  const p = loadFailurePolicy();
  assert.equal(p.overrides['paid-generation-gate'], 'human-required');
});

test('health / version expose no secret values and report Jev route status by key presence only', async () => {
  const env = { EDL_ALLOW_NETWORK: 'true', JEV_API_KEY: 'sk-super-secret-value', AI_GATEWAY_API_KEY: 'gw-secret' };
  const gateway = createGateway({ engine: createDecisionLayerEngine({ env, meter: createMemoryMeter() }), env });
  const h = gateway.health();
  const text = JSON.stringify(h);
  assert.equal(text.includes('sk-super-secret-value'), false);
  assert.equal(text.includes('gw-secret'), false);
  assert.equal(h.engine_health.jev.usable, true);
  assert.equal(h.engine_health.adapters.includes('mock-jev'), false);
  assert.deepEqual(Object.keys(gateway.version()).sort(), ['contract_version', 'engine']);
  const types = gateway.decisionTypes();
  assert.ok(types.find((t) => t.decision_type === 'paid-generation-gate' && t.failure_policy === 'human-required'));
});

test('stats count ok / failed / fallbacks / human tier / by_via', async () => {
  const { gateway } = gw();
  await gateway.decide(req({ asset_kind: 'subtitle', purpose: 'x' }), { via: 'http' });
  await gateway.decide(req({ asset_kind: 'scene', purpose: 'x', style: 'photoreal' }), { via: 'mcp' });
  await gateway.decide(null, { via: 'cli' });
  const s = gateway.health().stats;
  assert.equal(s.requests, 3);
  assert.equal(s.ok, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.human_tier, 1);
  assert.ok(s.fallbacks >= 1);
  assert.deepEqual(s.by_via, { http: 1, mcp: 1, cli: 1 });
  assert.equal(s.in_flight, 0);
});

test('Gateway never returns approval keys for any implemented decision_type (tier=auto is not permission)', async () => {
  const forbidden = readJson('policies/safety/human-only.json').forbidden_outcome_keys;
  const { gateway } = gw({ mode: 'verification' });
  const samples = [
    req({ asset_kind: 'subtitle', purpose: 'x' }),
    req({ asset_kind: 'image', purpose: 'x', has_local_assets: true, style: 'flat' }),
    req({ asset_kind: 'scene', purpose: 'x', style: 'cinematic', has_reference_media: true }),
  ];
  for (const s of samples) {
    const env = await gateway.decide(s);
    for (const k of forbidden) assert.equal(k in (env.decision?.outcome ?? {}), false, k);
    assert.equal(env.decision.human_gate.preserved, true);
  }
});
