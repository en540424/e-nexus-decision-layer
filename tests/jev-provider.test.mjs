/**
 * Jev Adapter が到達経路（Provider）に固定されていないことを確認する。
 * 実ネットワーク送信は一切行わない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { assertJevProviderShape, resolveJevProvider, createVercelJevProvider, createCloudflareJevProvider, JEV_PROVIDER_IDS } from '../src/adapters/jev/jev-provider-interface.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';
import { loadDecisionType, readJson } from '../src/schemas/loader.mjs';
import { makeEngine } from './helpers.mjs';

test('provider interface: shape is enforced; three routes are reserved', () => {
  assert.deepEqual([...JEV_PROVIDER_IDS], ['direct', 'vercel', 'cloudflare']);
  assert.throws(() => assertJevProviderShape({ id: 'x' }), /available\(\) missing/);
  assert.equal(resolveJevProvider({}).id, 'direct', 'default route is direct');
  assert.equal(resolveJevProvider({ JEV_PROVIDER: 'vercel' }).id, 'vercel');
  assert.throws(() => resolveJevProvider({ JEV_PROVIDER: 'nope' }), (e) => e instanceof AdapterUnavailableError && e.details.route === 'nope');
});

test('reserved routes (vercel / cloudflare) are unavailable, never sent', async () => {
  for (const p of [createVercelJevProvider(), createCloudflareJevProvider()]) {
    assert.equal(p.available({ JEV_API_KEY: 'dummy' }).ok, false);
    await assert.rejects(() => p.send({ request: {} }), (e) => e.details.reason === 'JEV_ROUTE_NOT_IMPLEMENTED');
  }
  const viaEnv = createJevAdapter({ env: { JEV_API_KEY: 'dummy', EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'cloudflare' } });
  assert.equal(viaEnv.route, 'cloudflare');
  await assert.rejects(() => viaEnv.decide({ decisionType: 'x' }), (e) => e.details.reason === 'JEV_ROUTE_NOT_IMPLEMENTED' && e.details.route === 'cloudflare');
});

test('a custom provider can be injected without touching the adapter or the engine', async () => {
  const calls = [];
  const fake = {
    id: 'fake-gateway',
    available: () => ({ ok: true }),
    async send({ request }) {
      calls.push(request);
      return { value: { local_sufficient: false, remotion_suitable: false, paid_generation_required: true, human_review_required: true, recommended_route: 'en-generate-hub' }, confidence: 0.9 };
    },
  };
  const jev = createJevAdapter({ env: { EDL_ALLOW_NETWORK: 'true' }, provider: fake });
  assert.equal(jev.route, 'fake-gateway');
  const { engine } = makeEngine({ adapters: [jev, ...makeEngine().engine.adapters.filter((a) => a.id === 'human')], routingPolicy: { default_chain: ['jev', 'human'], overrides: {} } });
  const r = await engine.decide({ decision_type: 'paid-generation-gate', application_id: 'test', project_id: 'openmontage', input: { asset_kind: 'scene', purpose: 'x', style: 'photoreal' } });
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.provider, 'typesafe-ai');
  assert.equal(r.tier, 'human', 'human_review_required still forces human even via a real-looking provider');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, 'paid-generation-gate');
  assert.ok(Array.isArray(calls[0].candidates));
});

test('reserved decision types exist by name only and cannot be decided', async () => {
  const idx = readJson('schemas/common/decision-types.json');
  for (const id of ['agent-action-micro', 'context-relevance', 'io-guard-assist', 'post-execution-verify']) {
    assert.ok(idx.reserved_decision_types[id], `${id} reserved`);
    assert.equal(loadDecisionType(id), null, `${id} has no schema yet`);
  }
  const { engine } = makeEngine();
  await assert.rejects(() => engine.decide({ decision_type: 'io-guard-assist', application_id: 'a', project_id: 'openmontage', input: {} }), (e) => e.code === 'UNKNOWN_DECISION_TYPE');
});

test('guard-assist release keys are forbidden outcome keys', () => {
  const safety = readJson('policies/safety/human-only.json');
  for (const k of ['safety_cleared', 'guard_released', 'unblock', 'release_block', 'allow_execution']) assert.ok(safety.forbidden_outcome_keys.includes(k), k);
});
