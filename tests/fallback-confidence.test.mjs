import test from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, loadThresholds } from '../src/core/confidence.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

const PHOTOREAL = { asset_kind: 'scene', purpose: 'product hero', style: 'photoreal', duration_sec: 8 };

test('confidence: thresholds are loaded from policy, not hard-coded', () => {
  const t = loadThresholds('paid-generation-gate');
  assert.equal(typeof t.auto_min, 'number');
  assert.equal(typeof t.review_min, 'number');
  assert.ok(t.auto_min > t.review_min);
  assert.equal(tierFor(t.auto_min, t), 'auto');
  assert.equal(tierFor(t.review_min, t), 'review');
  assert.equal(tierFor(t.review_min - 0.01, t), 'human');
  assert.equal(tierFor(NaN, t), 'human');
});

test('fallback: rules miss → jev unavailable (no key) → mock-jev answers', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.resolved_by, 'mock-jev');
  assert.equal(r.fallback.occurred, true);
  const ids = r.fallback.trace.map((t) => `${t.adapter}:${t.status}`);
  assert.deepEqual(ids.slice(0, 3), ['rules:unavailable', 'jev:unavailable', 'mock-jev:ok']);
  assert.equal(r.fallback.trace[1].reason, 'JEV_API_KEY_MISSING');
});

test('fallback: high confidence → auto (unless human_review_required)', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({
    asset_kind: 'b-roll', purpose: 'x',
    __mock: { outcome: { local_sufficient: true, remotion_suitable: false, paid_generation_required: false, human_review_required: false, recommended_route: 'local' }, confidence: 0.95 },
  }));
  assert.equal(r.tier, 'auto');
  assert.equal(r.human_gate.required, false);
});

test('fallback: medium confidence → review tier', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({
    asset_kind: 'b-roll', purpose: 'x',
    __mock: { outcome: { local_sufficient: true, remotion_suitable: false, paid_generation_required: false, human_review_required: false, recommended_route: 'local' }, confidence: 0.7 },
  }));
  assert.equal(r.tier, 'review');
});

test('fallback: low confidence from mock-jev keeps going and ends at human escalation', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({
    asset_kind: 'b-roll', purpose: 'x',
    __mock: { outcome: { local_sufficient: true, remotion_suitable: false, paid_generation_required: false, human_review_required: false, recommended_route: 'local' }, confidence: 0.2 },
  }));
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.tier, 'human');
  assert.equal(r.outcome.escalated, true);
  assert.ok(r.fallback.trace.some((t) => t.adapter === 'mock-jev' && t.tier === 'human'));
  assert.ok(r.fallback.trace.some((t) => t.adapter === 'local' && t.status === 'unavailable'));
  assert.ok(r.fallback.skipped.some((s) => s.adapter === 'llm' && s.reason === 'COST_GATE_PAID_ADAPTER_NOT_ALLOWED'), 'llm (paid) is cost-gated by default');
});
