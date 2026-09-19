import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, gateRequest } from './helpers.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createMockJevAdapter } from '../src/adapters/jev/mock-jev-adapter.mjs';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { assertAdapterShape } from '../src/adapters/adapter-interface.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';

const PHOTOREAL = { asset_kind: 'scene', purpose: 'x', style: 'photoreal' };

test('adapter failure: provider unavailable (simulated) falls through to human, engine does not throw', async () => {
  const { engine } = makeEngine({ adapters: [createRulesAdapter(), createMockJevAdapter({ defaultUnavailable: true }), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.resolved_by, 'human');
  assert.ok(r.fallback.trace.some((t) => t.adapter === 'mock-jev' && t.reason === 'SIMULATED_UNAVAILABLE'));
});

test('adapter failure: adapter throwing a generic error is recorded and skipped', async () => {
  const broken = { id: 'broken', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true, decide: async () => { throw new Error('boom'); } };
  const { engine } = makeEngine({
    adapters: [broken, createMockJevAdapter(), createHumanAdapter()],
    routingPolicy: { default_chain: ['broken', 'mock-jev', 'human'], overrides: {} },
  });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.fallback.trace[0].status, 'unavailable');
  assert.match(r.fallback.trace[0].reason, /ERROR:boom/);
  assert.equal(r.resolved_by, 'mock-jev');
});

test('adapter failure: malformed result (confidence out of range) is treated as unavailable', async () => {
  const bad = { id: 'bad', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true, decide: async () => ({ outcome: {}, confidence: 7 }) };
  const { engine } = makeEngine({
    adapters: [bad, createHumanAdapter()],
    routingPolicy: { default_chain: ['bad', 'human'], overrides: {} },
  });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.resolved_by, 'human');
  assert.match(r.fallback.trace[0].reason, /confidence out of range/);
});

test('jev gates: key missing / network disabled block Jev before any request is built (never sends anything)', async () => {
  const noKey = createJevAdapter({ env: {} });
  await assert.rejects(() => noKey.decide({ decisionType: 'x' }), (e) => e instanceof AdapterUnavailableError && e.details.reason === 'JEV_API_KEY_MISSING');
  const keyNoNet = createJevAdapter({ env: { JEV_API_KEY: 'dummy-for-test' } });
  await assert.rejects(() => keyNoNet.decide({ decisionType: 'x' }), (e) => e.details.reason === 'NETWORK_DISABLED');
  // 例外メッセージにキー値が漏れないこと（Direct Provider の実送信テストは tests/jev-direct-provider.test.mjs 参照）
  try { await keyNoNet.decide({ decisionType: 'x' }); } catch (e) { assert.ok(!JSON.stringify({ m: e.message, d: e.details }).includes('dummy-for-test')); }
});

test('adapter interface: shape is enforced at engine construction', () => {
  assert.throws(() => assertAdapterShape({ id: 'x' }), /kind must be one of/);
  assert.throws(() => makeEngine({ adapters: [{ id: 'x', kind: 'human' }] }), /invalid adapter/);
});
