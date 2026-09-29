/**
 * 1 判定あたりの費用上限（policies/cost/limits.json per_decision_estimated_cost_usd_micros_max・2026-09-29 FB-14）。
 * null＝強制しない（従来どおり）。数値なら estimateCost() を持つ Adapter を送信前に止める。実ネットワークは使わない（fake provider）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine, costLimitOf } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, buildJevRequest, estimateRequestTokens } from '../src/adapters/jev/jev-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { loadDecisionType, readJson } from '../src/schemas/loader.mjs';

const ENV = { EDL_ALLOW_NETWORK: 'true' };
const INPUT = { asset_kind: 'scene', purpose: 'product hero shot we do not have locally', style: 'photoreal', estimated_paid_cost_usd_micros: 300000 };
const req = () => ({ decision_type: 'paid-generation-gate', application_id: 'claude-code', project_id: 'en-generate-hub', input: INPUT });

function engine(limit, { estimateThrows = false } = {}) {
  const seen = [];
  const provider = {
    id: 'fake', available: () => ({ ok: true }),
    async send({ request }) {
      seen.push(request);
      return {
        model: 'jev-1.13.0',
        answers: {
          local_sufficient: { type: 'noul', noul: 0.03 }, remotion_suitable: { type: 'noul', noul: 0.03 }, paid_generation_required: { type: 'noul', noul: 0.97 },
          human_review_required: { type: 'noul', noul: 0.03 }, recommended_route: { type: 'choice', choice: 'en-generate-hub', confidence: 0.95 },
        },
        usage: { input_tokens: 2000, output_tokens: 10 },
      };
    },
  };
  const jev = createJevAdapter({ env: ENV, provider });
  if (estimateThrows) jev.estimateCost = async () => { throw new Error('x'); };
  const costPolicy = { ...readJson('policies/cost/limits.json'), per_decision_estimated_cost_usd_micros_max: limit };
  const eng = createDecisionEngine({ adapters: [createRulesAdapter(), jev, createHumanAdapter()], meter: createMemoryMeter(), costPolicy });
  return { eng, seen };
}

test('costLimitOf: only a positive integer enables the gate (null / 0 / negative / string = not enforced)', () => {
  for (const v of [null, undefined, 0, -1, '500', 1.5]) assert.equal(costLimitOf({ per_decision_estimated_cost_usd_micros_max: v }), null, String(v));
  assert.equal(costLimitOf({ per_decision_estimated_cost_usd_micros_max: 500 }), 500);
  assert.equal(readJson('policies/cost/limits.json').per_decision_estimated_cost_usd_micros_max, null, 'shipped policy: not enforced (value is a Human decision)');
});

test('limit null: unchanged behaviour — Jev is called', async () => {
  const { eng, seen } = engine(null);
  const r = await eng.decide(req());
  assert.equal(seen.length, 1);
  assert.equal(r.resolved_by, 'jev');
});

test('limit below the estimate: Jev is NOT called (no send, cost 0 known) and the chain continues to human', async () => {
  const { eng, seen } = engine(1);
  const r = await eng.decide(req());
  assert.equal(seen.length, 0, 'nothing sent');
  const a = r.fallback.trace.find((t) => t.adapter === 'jev');
  assert.equal(a.reason, 'COST_GATE_ESTIMATE_OVER_LIMIT');
  assert.equal(a.networked, false);
  assert.equal(a.usage_known, true);
  assert.equal(a.estimated_cost_usd_micros, 0);
  assert.equal(r.tier, 'human');
});

test('a sensible limit (well above measured 64–114 µUSD) lets Jev through; the estimate is conservative but in that range', async () => {
  const dt = loadDecisionType('paid-generation-gate');
  const { request } = buildJevRequest({ decisionType: 'paid-generation-gate', outcomeSchema: dt.schema.properties.outcome, input: INPUT, candidates: [], model: 'jev-latest', inputSchema: dt.schema.properties.input });
  const est = Math.round((estimateRequestTokens(request) / 1_000_000) * 42000);
  assert.ok(est >= 64 && est <= 400, `estimate ${est} µUSD should be ≥ the measured low end and not absurdly high`);
  const { eng, seen } = engine(1000);
  const r = await eng.decide(req());
  assert.equal(seen.length, 1);
  assert.equal(r.resolved_by, 'jev');
});

test('an adapter whose cost cannot be estimated is not called when a limit is set (fail-closed)', async () => {
  const { eng, seen } = engine(1000, { estimateThrows: true });
  const r = await eng.decide(req());
  assert.equal(seen.length, 0);
  assert.equal(r.fallback.trace.find((t) => t.adapter === 'jev').reason, 'COST_GATE_ESTIMATE_UNAVAILABLE');
});
