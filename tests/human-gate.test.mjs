/**
 * Human Gate 保護。「Decision Layer は承認できない」ことを、主張ではなく機械的に確認する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/core/paths.mjs';
import { readJson } from '../src/schemas/loader.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { HumanGateViolationError } from '../src/core/errors.mjs';

const safety = readJson('policies/safety/human-only.json');

function walkSchemas(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkSchemas(p));
    else if (ent.name.endsWith('.schema.json')) out.push(p);
  }
  return out;
}

test('no outcome schema declares an approval-like key; all outcome schemas are closed', () => {
  for (const file of walkSchemas(join(ROOT, 'schemas'))) {
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    const outcome = schema.properties?.outcome;
    if (!outcome?.properties) continue; // common schemas は outcome の外枠（type: object）だけを定義する
    assert.equal(outcome.additionalProperties, false, `${file}: outcome must be closed`);
    const keys = Object.keys(outcome.properties ?? {});
    const bad = keys.filter((k) => safety.forbidden_outcome_keys.includes(k));
    assert.deepEqual(bad, [], `${file}: forbidden keys ${bad}`);
    // enum 値としても「approved」等を持たない
    for (const [k, def] of Object.entries(outcome.properties ?? {})) {
      for (const v of def.enum ?? []) assert.ok(!/approv|authoriz/i.test(String(v)), `${file}: ${k} enum ${v}`);
    }
  }
});

test('adapter returning an approval-like key is rejected with HumanGateViolationError', async () => {
  const rogue = {
    id: 'rogue', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true,
    decide: async () => ({ outcome: { approved: true, local_sufficient: false, remotion_suitable: false, paid_generation_required: true, human_review_required: false, recommended_route: 'en-generate-hub' }, confidence: 0.99 }),
  };
  const { engine } = makeEngine({ adapters: [rogue, createHumanAdapter()], routingPolicy: { default_chain: ['rogue', 'human'], overrides: {} } });
  await assert.rejects(() => engine.decide(gateRequest({ asset_kind: 'scene', purpose: 'x' })), HumanGateViolationError);
});

test('human_review_required=true forces tier=human even at confidence 0.99', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({
    asset_kind: 'scene', purpose: 'x',
    __mock: { outcome: { local_sufficient: false, remotion_suitable: false, paid_generation_required: true, human_review_required: true, recommended_route: 'en-generate-hub' }, confidence: 0.99 },
  }));
  assert.equal(r.tier, 'human');
  assert.equal(r.human_gate.required, true);
  assert.equal(r.human_gate.preserved, true);
  assert.match(r.human_gate.reason, /human_review_required/);
});

test('human-only decision types never invoke any automated adapter', async () => {
  const calls = [];
  const spy = { id: 'mock-jev', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true, decide: async () => { calls.push(1); return { outcome: {}, confidence: 1 }; } };
  const { engine } = makeEngine({
    adapters: [spy, createHumanAdapter()],
    safetyPolicy: { ...safety, human_only_decision_types: [...safety.human_only_decision_types, 'paid-generation-gate'] },
  });
  const r = await engine.decide(gateRequest({ asset_kind: 'subtitle', purpose: 'x' }));
  assert.equal(calls.length, 0);
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.tier, 'human');
  assert.ok(r.fallback.skipped.every((s) => s.reason === 'HUMAN_ONLY_DECISION_TYPE'));
});

test('safety policy lists the existing Human-only operations (deploy / paid API execution / git destructive / settings)', () => {
  for (const id of ['deploy-approval', 'paid-api-execution-approval', 'git-destructive-approval', 'settings-permission-change-approval', 'budget-gate-override']) {
    assert.ok(safety.human_only_decision_types.includes(id), id);
  }
});

test('human adapter outcome is escalation-only and cannot carry approval', async () => {
  const r = await createHumanAdapter().decide({ decisionType: 'x', context: {} });
  assert.equal(r.outcome.escalated, true);
  assert.equal(r.outcome.human_review_required, true);
  assert.equal(r.confidence, 0);
});

test('every escalation vocabulary (human_review_required / needs_human_review / human_required) forces tier=human for its decision type', async () => {
  const cases = [
    ['ocr-triage', 'travel-rate-camera', { ocr_text: '1,200' }, { currency_type: 'JPY', ocr_confidence: 0.9, needs_retake: false, needs_human_review: true, parsing_route: 'rule-extract' }],
    ['call-triage', 'ai-phone', { transcript_summary: 'x' }, { call_category: 'complaint', urgency: 'high', sales_lead: false, complaint: true, human_required: true }],
    ['cost-entry-classify', 'ai-cost-manager', { service_name: 'x' }, { billing_model: 'fixed', cadence: 'monthly', provider_category: 'saas', anomaly: true, review_candidate: 'downgrade' }],
    ['skill-route', 'en-knowledge-vault', { instruction: 'x' }, { skill_ids: ['common-dev-log'], human_review_required: true }],
  ];
  for (const [decision_type, project_id, input, outcome] of cases) {
    const stub = { id: 'mock-jev', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true, decide: async () => ({ outcome, confidence: 0.99 }) };
    const { engine } = makeEngine({ adapters: [stub, createHumanAdapter()], routingPolicy: { default_chain: ['mock-jev', 'human'], overrides: {} } });
    const r = await engine.decide({ decision_type, application_id: 'test', project_id, input });
    const flagged = ['human_review_required', 'needs_human_review', 'human_required'].some((k) => outcome[k] === true);
    assert.equal(r.tier, flagged ? 'human' : 'auto', decision_type + ': tier');
    assert.equal(r.human_gate.required, flagged, decision_type + ': human_gate.required');
  }
});

test('mock-jev ignores __mock unless allowMockControl=true (production default)', async () => {
  const { createMockJevAdapter } = await import('../src/adapters/jev/mock-jev-adapter.mjs');
  const prod = createMockJevAdapter();
  const r = await prod.decide({ decisionType: 'paid-generation-gate', input: { asset_kind: 'scene', purpose: 'x', style: 'photoreal', __mock: { outcome: { local_sufficient: true, remotion_suitable: true, paid_generation_required: false, human_review_required: false, recommended_route: 'local' }, confidence: 0.99 } } });
  assert.equal(r.outcome.paid_generation_required, true, '__mock was ignored');
});
