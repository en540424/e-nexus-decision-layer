/**
 * 2026-09-19 Confidence Calibration：Jev へ渡す question 設計（instructions / criteria / brief）が schema から
 * 正しく組み立てられること、baseline（description 無し）との差し替えができること、field-level confidence が
 * 結果に残ること。実ネットワークは使わない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJevRequest, parseJevResponse, createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { toGatewayQuestions } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { assertValid } from '../src/schemas/validate.mjs';
import { stripQuestionDesign } from '../scripts/poc-calibration.mjs';

const DT = loadDecisionType('paid-generation-gate');
const OUTCOME = DT.schema.properties.outcome;
const STEERING = [/answer true/i, /answer false/i, /always choose/i, /you must choose/i, /always say/i];

test('paid-generation-gate: every outcome field carries a description (question instructions), every route a criteria description, and a brief', () => {
  for (const [name, prop] of Object.entries(OUTCOME.properties)) {
    assert.ok(typeof prop.description === 'string' && prop.description.length > 40, `${name} needs a real description`);
  }
  const routes = OUTCOME.properties.recommended_route;
  for (const v of routes.enum) assert.ok(typeof routes['x-enum-descriptions'][v] === 'string' && routes['x-enum-descriptions'][v].length > 20, v);
  assert.ok(typeof OUTCOME.description === 'string' && OUTCOME.description.length > 100, 'outcome brief');
});

test('question text never steers toward a specific answer and states that it does not approve spending', () => {
  const texts = [OUTCOME.description, ...Object.values(OUTCOME.properties).map((p) => p.description), ...Object.values(OUTCOME.properties.recommended_route['x-enum-descriptions'])];
  for (const t of texts) for (const re of STEERING) assert.ok(!re.test(t), `steering phrase ${re} in: ${t.slice(0, 60)}`);
  assert.match(OUTCOME.description, /never approves spending/);
  assert.match(OUTCOME.properties.paid_generation_required.description, /not an approval/);
});

test('buildJevRequest: instructions come from schema descriptions, choice criteria from x-enum-descriptions, brief in state', () => {
  const { request } = buildJevRequest({ decisionType: 'paid-generation-gate', outcomeSchema: OUTCOME, input: { asset_kind: 'scene', purpose: 'x' }, candidates: [] });
  for (const [name, q] of Object.entries(request.questions)) {
    assert.equal(q.instructions, OUTCOME.properties[name].description, name);
    assert.ok(!q.instructions.startsWith('Determine '), `${name} still uses the generic fallback`);
  }
  assert.deepEqual(request.questions.recommended_route.criteria, OUTCOME.properties.recommended_route['x-enum-descriptions']);
  assert.equal(request.state.brief, OUTCOME.description);
  assert.equal(request.state.task, 'paid-generation-gate');
  assert.deepEqual(request.state.input, { asset_kind: 'scene', purpose: 'x' });
  // Vercel 経路でも説明が空文字にならない
  const gw = toGatewayQuestions(request.questions);
  for (const v of Object.values(gw.recommended_route.criteria)) assert.ok(v.length > 0);
});

test('baseline variant (stripQuestionDesign) reproduces the generic instructions of the first real connectivity run, with no brief', () => {
  const stripped = stripQuestionDesign(DT);
  const { request } = buildJevRequest({ decisionType: 'paid-generation-gate', outcomeSchema: stripped.schema.properties.outcome, input: { asset_kind: 'scene', purpose: 'x' }, candidates: [] });
  for (const [name, q] of Object.entries(request.questions)) assert.equal(q.instructions, `Determine ${name} for this paid-generation-gate decision.`);
  assert.deepEqual(request.questions.recommended_route.criteria, { local: null, remotion: null, 'en-generate-hub': null, 'human-review': null });
  assert.ok(!('brief' in request.state));
  // 元の decision type は変更されていない（deep clone）
  assert.ok(OUTCOME.properties.local_sufficient.description);
});

test('schema description / x-enum-descriptions are inert for outcome validation (validator subset ignores them)', () => {
  assertValid(OUTCOME, { local_sufficient: false, remotion_suitable: true, paid_generation_required: false, human_review_required: false, recommended_route: 'remotion' }, 'outcome');
  assert.throws(() => assertValid(OUTCOME, { local_sufficient: false, remotion_suitable: true, paid_generation_required: false, human_review_required: false, recommended_route: 'nope' }, 'outcome'));
});

test('parseJevResponse exposes field_confidence (per question) alongside the min-aggregated confidence', () => {
  const fieldPlans = { a: { kind: 'noul' }, b: { kind: 'noul' }, c: { kind: 'choice', enumValues: ['x', 'y'] } };
  const raw = { answers: { a: { type: 'noul', noul: 0.54 }, b: { type: 'noul', noul: 0.97 }, c: { type: 'choice', choice: 'x', confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } };
  const r = parseJevResponse(raw, { fieldPlans });
  assert.deepEqual(Object.keys(r.field_confidence).sort(), ['a', 'b', 'c']);
  assert.ok(Math.abs(r.field_confidence.a - 0.08) < 1e-9, 'noul 0.54 → |2p-1| = 0.08 (the observed first-run value)');
  assert.ok(Math.abs(r.field_confidence.b - 0.94) < 1e-9);
  assert.equal(r.field_confidence.c, 0.9);
  assert.ok(Math.abs(r.confidence - 0.08) < 1e-9, 'overall = min → one coin-flip question collapses the decision');
});

test('createJevAdapter: decisionTypeLoader injection changes the questions sent; default loader is the real schema', async () => {
  const seen = [];
  const provider = {
    id: 'fake',
    available: () => ({ ok: true }),
    async send({ request }) {
      seen.push(request);
      const answers = {};
      for (const [name, q] of Object.entries(request.questions)) answers[name] = q.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: 'remotion', confidence: 0.9 };
      return { model: 'fake', answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const env = { EDL_ALLOW_NETWORK: 'true' };
  const args = { decisionType: 'paid-generation-gate', input: { asset_kind: 'scene', purpose: 'x' }, candidates: [], context: {} };
  await createJevAdapter({ env, provider }).decide(args);
  await createJevAdapter({ env, provider, decisionTypeLoader: (id) => stripQuestionDesign(loadDecisionType(id)) }).decide(args);
  assert.equal(seen[0].state.brief, OUTCOME.description);
  assert.ok(!('brief' in seen[1].state));
  assert.notEqual(seen[0].questions.local_sufficient.instructions, seen[1].questions.local_sufficient.instructions);
});
