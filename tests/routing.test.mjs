import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChain } from '../src/core/router.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createMockJevAdapter } from '../src/adapters/jev/mock-jev-adapter.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

test('router: rules come first, human is always last, unknown ids are skipped with reason', () => {
  const adapters = [createMockJevAdapter(), createHumanAdapter(), createRulesAdapter()];
  const { chain, skipped } = resolveChain('paid-generation-gate', adapters);
  assert.equal(chain[0].id, 'rules');
  assert.equal(chain.at(-1).id, 'human');
  assert.ok(skipped.some((s) => s.adapter === 'jev' && s.reason === 'NOT_REGISTERED'));
});

test('router: per-decision-type override is honored (model-route = rules → human)', () => {
  const adapters = [createRulesAdapter(), createMockJevAdapter(), createHumanAdapter()];
  const { chain } = resolveChain('model-route', adapters);
  assert.deepEqual(chain.map((a) => a.id), ['rules', 'human']);
});

test('router: human adapter appended even if policy omits it', () => {
  const adapters = [createRulesAdapter(), createHumanAdapter()];
  const { chain } = resolveChain('paid-generation-gate', adapters, { default_chain: ['rules'] });
  assert.deepEqual(chain.map((a) => a.id), ['rules', 'human']);
});

test('engine: deterministic rule resolves before any probabilistic adapter', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'kinetic-typography', purpose: 'intro' }));
  assert.equal(r.resolved_by, 'rules');
  assert.equal(r.confidence, 1);
  assert.equal(r.tier, 'auto');
  assert.equal(r.fallback.occurred, false);
  assert.equal(r.outcome.recommended_route, 'remotion');
});

test('engine: model-route rules encode Sonnet First and Advisor conditions', async () => {
  const { engine } = makeEngine();
  const base = { decision_type: 'model-route', application_id: 'claude-code', project_id: 'en-knowledge-vault' };
  const s = await engine.decide({ ...base, input: { task_size: 'S' } });
  assert.deepEqual([s.outcome.executor_model, s.outcome.consult_advisor], ['sonnet', false]);
  const harness = await engine.decide({ ...base, input: { task_size: 'S', touches_harness: true } });
  assert.equal(harness.outcome.consult_advisor, true);
  assert.equal(harness.tier, 'human');
  assert.ok(!['fable'].includes(s.outcome.executor_model));
  assert.ok(s.candidates_considered.includes('sonnet') && s.candidates_considered.includes('fable') === true);
});

test('engine: cost gate removes paid LLM adapters unless allow_paid_adapters=true; jev (low-cost gate) is not cost-gated', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'scene', purpose: 'x', style: 'photoreal' }));
  assert.ok(r.fallback.skipped.some((s) => s.adapter === 'llm' && s.reason === 'COST_GATE_PAID_ADAPTER_NOT_ALLOWED'));
  assert.ok(r.fallback.trace.some((t) => t.adapter === 'jev' && t.status === 'unavailable' && t.reason === 'JEV_API_KEY_MISSING'), 'jev is tried by default');
  const r2 = await engine.decide(gateRequest({ asset_kind: 'scene', purpose: 'x', style: 'photoreal' }, { options: { allow_paid_adapters: true } }));
  assert.ok(!r2.fallback.skipped.some((s) => s.adapter === 'llm'), 'llm allowed when opted in');
});
