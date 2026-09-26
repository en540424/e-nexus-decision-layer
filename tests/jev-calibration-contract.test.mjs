/**
 * 実JEV Calibration（2026-09-26）で追加した Jev Adapter の汎用機構を固定する。
 *   x-jev-enum（Rules First 通過後に到達し得る選択肢だけを提示）／x-jev-derive（定義上従属する field は導出）／
 *   x-boolean-criteria（Vercel boolean criteria）／input_notes（input enum 値の意味）／x-outcome-invariants（自己矛盾 → confidence 0）
 * いずれも decision_type 固有のケースに効く分岐ではなく、schema 宣言だけで動く。実ネットワークは使わない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, loadDecisionType } from '../src/schemas/loader.mjs';
import { buildJevRequest, parseJevResponse, createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { toGatewayQuestions } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { toDirectRequest } from '../src/adapters/jev/jev-direct-provider.mjs';
import { checkOutcomeInvariants, outcomeInvariantsOf } from '../src/schemas/invariants.mjs';
import { createDecisionEngine } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { SchemaValidationError } from '../src/core/errors.mjs';

const TYPES = ['paid-generation-gate', 'channel-selection', 'content-publish-gate'];

test('x-jev-enum is justified by rule coverage: every value hidden from Jev is produced by some rule for that field', () => {
  for (const t of TYPES) {
    const outcome = loadDecisionType(t).schema.properties.outcome;
    const rules = readJson(`policies/routing/rules/${t}.json`).rules;
    for (const [name, prop] of Object.entries(outcome.properties)) {
      if (!prop['x-jev-enum']) continue;
      const hidden = prop.enum.filter((v) => !prop['x-jev-enum'].includes(v));
      for (const v of hidden) assert.ok(rules.some((r) => r.outcome[name] === v), `${t}.${name}=${v} is hidden from Jev but no rule produces it`);
    }
  }
});

test('every rule outcome satisfies the declared outcome invariants (rules and Jev share one meaning)', () => {
  for (const t of TYPES) {
    const outcome = loadDecisionType(t).schema.properties.outcome;
    assert.ok(outcomeInvariantsOf(outcome).length > 0, `${t} declares invariants`);
    for (const r of readJson(`policies/routing/rules/${t}.json`).rules) {
      assert.deepEqual(checkOutcomeInvariants(outcome, r.outcome, {}), [], `${t} rule ${r.id}`);
    }
  }
});

test('x-jev-derive maps cover every value Jev can give for the source field (no hole at runtime)', () => {
  for (const t of TYPES) {
    const outcome = loadDecisionType(t).schema.properties.outcome;
    for (const [name, prop] of Object.entries(outcome.properties)) {
      const d = prop['x-jev-derive'];
      if (!d) continue;
      const src = outcome.properties[d.from];
      const values = src['x-jev-enum'] ?? src.enum;
      for (const v of values) {
        const derived = Object.hasOwn(d.map, v) ? d.map[v] : d.default;
        assert.notEqual(derived, undefined, `${t}.${name} from ${d.from}=${v}`);
        if (prop.enum) assert.ok(prop.enum.includes(derived), `${t}.${name}=${derived} in enum`);
        else assert.equal(typeof derived, prop.type);
      }
    }
  }
});

test('a decision type without the new annotations produces the same request shape as before (no input_notes, no boolean criteria, full enum)', () => {
  const outcomeSchema = {
    description: 'plain brief',
    properties: {
      flag: { type: 'boolean', description: 'a flag' },
      route: { type: 'string', enum: ['a', 'b'], description: 'a route', 'x-enum-descriptions': { a: 'A', b: 'B' } },
    },
  };
  const { request, fieldPlans } = buildJevRequest({ decisionType: 'x', outcomeSchema, input: { k: 'a' }, candidates: [], model: 'm', inputSchema: { properties: { k: { type: 'string', enum: ['a'] } } } });
  assert.deepEqual(request, {
    model: 'm',
    state: { task: 'x', brief: 'plain brief', input: { k: 'a' }, candidates: [] },
    questions: {
      flag: { type: 'noul', instructions: 'a flag' },
      route: { type: 'choice', instructions: 'a route', criteria: { a: 'A', b: 'B' } },
    },
  });
  assert.deepEqual(Object.keys(fieldPlans), ['flag', 'route']);
});

test('invalid annotations fail loudly instead of guessing', () => {
  const bad1 = { properties: { r: { type: 'string', enum: ['a'], 'x-jev-enum': ['z'] } } };
  assert.throws(() => buildJevRequest({ decisionType: 'x', outcomeSchema: bad1, input: {}, candidates: [] }), /x-jev-enum/);
  const bad2 = { properties: { r: { type: 'string', enum: ['a'] }, d: { type: 'boolean', 'x-jev-derive': { from: 'missing', map: {} } } } };
  assert.throws(() => buildJevRequest({ decisionType: 'x', outcomeSchema: bad2, input: {}, candidates: [] }), /x-jev-derive/);
  // 写像に穴があり default も無い → 推測で埋めず malformed
  const plans = { r: { kind: 'choice', enumValues: ['a', 'b'] }, d: { kind: 'derived', from: 'r', map: { a: true } } };
  assert.throws(() => parseJevResponse({ answers: { r: { type: 'choice', choice: 'b', confidence: 0.9 } } }, { fieldPlans: plans }), (e) => e.details.reason === 'JEV_MALFORMED_RESPONSE');
});

test('boolean criteria reach the Vercel Gateway question but are stripped from the Direct API request', () => {
  const outcome = loadDecisionType('paid-generation-gate').schema.properties.outcome;
  const { request } = buildJevRequest({ decisionType: 'paid-generation-gate', outcomeSchema: outcome, input: { asset_kind: 'image', purpose: 'p' }, candidates: [] });
  assert.ok(request.questions.human_review_required.criteria.true.length > 20);
  const gw = toGatewayQuestions(request.questions);
  assert.deepEqual(gw.human_review_required.criteria, request.questions.human_review_required.criteria);
  assert.ok(gw.local_sufficient.criteria.true.length > 20);
  const plain = toGatewayQuestions({ f: { type: 'noul', instructions: 'i' } });
  assert.deepEqual(plain.f, { type: 'boolean', instructions: 'i' }, 'fields without x-boolean-criteria send none');
  const direct = toDirectRequest(request);
  assert.ok(!('criteria' in direct.questions.human_review_required));
  assert.deepEqual(direct.questions.recommended_route, request.questions.recommended_route, 'choice criteria untouched');
});

test('self-contradicting Jev answer → confidence 0 with invariant ids, raw field confidence and usage kept (paid=false with route en-generate-hub)', () => {
  const outcomeSchema = loadDecisionType('paid-generation-gate').schema.properties.outcome;
  const { fieldPlans } = buildJevRequest({ decisionType: 'paid-generation-gate', outcomeSchema, input: { asset_kind: 'scene', purpose: 'p' }, candidates: [] });
  const raw = {
    answers: {
      local_sufficient: { type: 'noul', noul: 0.05 },
      remotion_suitable: { type: 'noul', noul: 0.05 },
      paid_generation_required: { type: 'noul', noul: 0.1 },
      human_review_required: { type: 'noul', noul: 0.9 },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', confidence: 0.95 },
    },
    usage: { input_tokens: 1200, output_tokens: 100 },
  };
  const r = parseJevResponse(raw, { fieldPlans, outcomeSchema, input: {} });
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.invariant_violations, ['route-en-generate-hub-requires-paid']);
  assert.match(r.rationale, /^OUTCOME_INVARIANT_VIOLATION/);
  assert.equal(r.field_confidence.recommended_route, 0.95);
  assert.equal(r.usage.input_tokens, 1200);
  assert.equal(r.networked, true);
});

function fake(answers) {
  return { id: 'fake', available: () => ({ ok: true }), async send({ request }) {
    const out = {};
    for (const [n, q] of Object.entries(request.questions)) out[n] = q.type === 'noul' ? { type: 'noul', noul: answers[n] } : { type: 'choice', choice: answers[n][0], confidence: answers[n][1] };
    return { model: 'fake', answers: out, usage: { input_tokens: 10, output_tokens: 1 } };
  } };
}

test('content-publish-gate: publish_candidate is derived from the route, so a candidate can never sit on a non-review route', async () => {
  const env = { EDL_ALLOW_NETWORK: 'true' };
  const engine = createDecisionEngine({ adapters: [createRulesAdapter(), createJevAdapter({ env, provider: fake({ revision_needed: 0.9, risk_level: ['medium', 0.9], human_review_required: 0.1, recommended_route: ['needs-revision', 0.9], publish_candidate: 0.99 }) }), createHumanAdapter()], meter: createMemoryMeter() });
  const input = { content_id: 'c1', channel: 'note', channel_registered: true, prior_publication_state: 'unpublished', title: 't', summary: 's' };
  const r = await engine.decide({ decision_type: 'content-publish-gate', application_id: 'test', project_id: 'e-nexus-decision-layer', input });
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.recommended_route, 'needs-revision');
  assert.equal(r.outcome.publish_candidate, false, 'derived, the 0.99 answer is never asked or used');
});

test('content-publish-gate: caller flag confidential_or_secret stops deterministically (hold / high / human review) without calling Jev', async () => {
  let called = false;
  const provider = { id: 'fake', available: () => ({ ok: true }), async send() { called = true; throw new Error('must not be called'); } };
  const engine = createDecisionEngine({ adapters: [createRulesAdapter(), createJevAdapter({ env: { EDL_ALLOW_NETWORK: 'true' }, provider }), createHumanAdapter()], meter: createMemoryMeter() });
  const input = { content_id: 'c1', channel: 'note', channel_registered: true, prior_publication_state: 'unpublished', title: 't', summary: 's', risk_flags: { confidential_or_secret: true } };
  const r = await engine.decide({ decision_type: 'content-publish-gate', application_id: 'test', project_id: 'e-nexus-decision-layer', input });
  assert.equal(called, false);
  assert.equal(r.resolved_by, 'rules');
  assert.deepEqual(r.outcome, { publish_candidate: false, revision_needed: false, risk_level: 'high', human_review_required: true, recommended_route: 'hold' });
  assert.equal(r.tier, 'human');
});

test('LINE is not a channel-selection / content-publish-gate channel (CRM / direct communication, not public SNS): input is rejected', async () => {
  const engine = createDecisionEngine({ adapters: [createRulesAdapter(), createHumanAdapter()], meter: createMemoryMeter() });
  for (const [t, extra] of [['channel-selection', { channel_publication_state: 'not-published' }], ['content-publish-gate', { prior_publication_state: 'unpublished' }]]) {
    await assert.rejects(
      () => engine.decide({ decision_type: t, application_id: 'test', project_id: 'e-nexus-decision-layer', input: { content_id: 'c1', channel: 'line', channel_registered: true, title: 't', summary: 's', ...extra } }),
      SchemaValidationError,
    );
  }
});

test('Hybrid (follow-up ②): escalation-only field is excluded from the min but true still forces human at any confidence; auto still needs every other field ≥ auto_min', async () => {
  const env = { EDL_ALLOW_NETWORK: 'true' };
  const input = { content_id: 'c1', channel: 'note', channel_registered: true, channel_publication_state: 'not-published', title: 't', summary: 's' };
  const run = async (answers) => {
    const engine = createDecisionEngine({ adapters: [createRulesAdapter(), createJevAdapter({ env, provider: fake(answers) }), createHumanAdapter()], meter: createMemoryMeter() });
    return engine.decide({ decision_type: 'channel-selection', application_id: 'test', project_id: 'e-nexus-decision-layer', input });
  };
  // human_review_required=false（p=0.3 → 生 confidence 0.4）でも他が高ければ auto
  const a = await run({ channel_status: ['primary', 0.95], content_channel_fit: ['high', 0.93], human_review_required: 0.3 });
  assert.equal(a.tier, 'auto');
  assert.equal(a.confidence, 0.93);
  assert.match(a.rationale, /human_review_required=0\.40\(escalation-only, not in min\)/);
  // true はぎりぎり（p=0.51）でも human
  const b = await run({ channel_status: ['primary', 0.99], content_channel_fit: ['high', 0.99], human_review_required: 0.51 });
  assert.equal(b.tier, 'human');
  assert.equal(b.human_gate.reason, 'outcome.human_review_required=true');
  // 他の field が 1 つでも auto_min 未満なら auto にならない（min は維持）
  const c = await run({ channel_status: ['primary', 0.84], content_channel_fit: ['high', 0.99], human_review_required: 0.05 });
  assert.equal(c.tier, 'review');
});

test('every decision type marks exactly its human-escalation flag as escalation-only (not decision fields)', () => {
  const safety = readJson('policies/safety/human-only.json');
  for (const t of TYPES) {
    const props = loadDecisionType(t).schema.properties.outcome.properties;
    const marked = Object.entries(props).filter(([, p]) => p['x-jev-confidence'] === 'escalation-only').map(([k]) => k);
    assert.deepEqual(marked, ['human_review_required'], t);
    for (const k of marked) assert.ok(safety.force_human_when_outcome_keys.includes(k), `${k} must be a force-human key`);
  }
});
