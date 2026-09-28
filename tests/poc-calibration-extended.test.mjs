/**
 * 拡張 Calibration（2026-09-29・Fable追加レビューP S4）の offline 検証：
 *   - run --repeat N：repeat_index 付きで N 回流れ、Rules First は 1 回だけ
 *   - mergeResults：case_id + repeat_index 単位で統合（repeat を潰さない）
 *   - analyze：再抽選一致率・tier 一致率・confidence std、敵対 holdout（injection_followed / dangerous）、model_version / probabilities
 *   - reordered variant：選択肢と question の並びだけ逆・名前は同じ
 *   - adversarial cases：input が schema に通り、Rules First に吸われず Jev まで届く（dry-run）
 * 実ネットワーク・実 SDK は使わない（Jev Provider を注入）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  loadCases, dryRun, runCases, analyze, analyzeToMarkdown, mergeResults, reorderQuestionDesign, consistencyOf, adversarialOf,
} from '../scripts/poc-calibration.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { buildJevRequest } from '../src/adapters/jev/jev-adapter.mjs';
import { assertValid } from '../src/schemas/validate.mjs';
import { ROOT } from '../src/core/paths.mjs';

const ENV = { EDL_ALLOW_NETWORK: 'true' };
const CAL = join(ROOT, 'docs', 'poc', 'calibration');
const ADVERSARIAL = ['paid-generation-gate.v2', 'content-publish-gate', 'channel-selection'].map((n) => join(CAL, `${n}.adversarial.cases.json`));

/** 呼ばれるたびに答えを変える偽 Jev（1 回目と 3 回目は local、2 回目だけ en-generate-hub）。version / probabilities を返す */
function flippingProvider() {
  let n = 0;
  return {
    id: 'fake',
    available: () => ({ ok: true }),
    async send({ request }) {
      n += 1;
      const flip = n % 3 === 2;
      const answers = {};
      for (const [name, q] of Object.entries(request.questions)) {
        if (q.type === 'noul') answers[name] = { type: 'noul', noul: name === 'paid_generation_required' ? (flip ? 0.9 : 0.05) : (name === 'local_sufficient' ? (flip ? 0.1 : 0.95) : 0.05) };
        else answers[name] = { type: 'choice', choice: flip ? 'en-generate-hub' : 'local', confidence: flip ? 0.7 : 0.95, probabilities: { local: flip ? 0.3 : 0.95, 'en-generate-hub': flip ? 0.7 : 0.05 } };
      }
      return { model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 20 } };
    },
  };
}

test('run --repeat: jev cases are re-sampled N times with repeat_index; Rules First cases run once; version / probabilities reach the record', async () => {
  const doc = loadCases(join(CAL, 'paid-generation-gate.v2.cases.json'));
  const only = ['PG-J1-local-crop-existing-photos', 'PG-R1-subtitle'];
  const { records, repeat } = await runCases({ doc, variant: 'improved', only, env: ENV, meter: createMemoryMeter(), delayMs: 0, provider: flippingProvider(), repeat: 3 });
  assert.equal(repeat, 3);
  const jev = records.filter((r) => r.case_id === 'PG-J1-local-crop-existing-photos');
  assert.deepEqual(jev.map((r) => r.repeat_index), [0, 1, 2]);
  assert.equal(records.filter((r) => r.case_id === 'PG-R1-subtitle').length, 1, 'rules-first is deterministic → not re-sampled');
  assert.equal(jev[0].jev.model_version, 'jev-1.13.0');
  assert.equal(jev[0].jev.evidence.probabilities.recommended_route.local, 0.95);

  const out = { schema: 'edl-poc-calibration-v1', decision_type: doc.decision_type, variant: 'improved', thresholds: { auto_min: 0.85, review_min: 0.6 }, records };
  const merged = mergeResults([out]).improved;
  assert.equal(merged.records.length, 4, 'merge keeps every repeat (case_id + repeat_index)');
  const a = analyze(out);
  assert.equal(a.consistency.cases, 1);
  assert.equal(a.consistency.per_case[0].n, 3);
  assert.equal(a.consistency.per_case[0].outcome_agreement, 0.667);
  assert.equal(a.consistency.per_case[0].distinct_outcomes, 2);
  assert.equal(a.consistency.per_case[0].field_agreement.recommended_route, 0.667);
  assert.equal(a.consistency.tier_flipping_cases, 1);
  assert.ok(a.consistency.per_case[0].confidence_std > 0);
  assert.deepEqual(a.model_versions_seen, { 'jev-1.13.0': 3 });
  assert.equal(a.probabilities_recorded, 3);
  const md = analyzeToMarkdown(out);
  assert.match(md, /Re-sampling consistency per case/);
  assert.match(md, /model_version seen/);
});

test('consistencyOf: single-sample cases are not counted; identical repeats → agreement 1 and std 0', () => {
  const rec = (id, route, conf) => ({ case_id: id, jev: { status: 'ok', outcome: { recommended_route: route }, confidence: conf } });
  const k = consistencyOf([rec('a', 'x', 0.9), rec('a', 'x', 0.9), rec('b', 'y', 0.5)], { auto_min: 0.85, review_min: 0.6 });
  assert.equal(k.cases, 1);
  assert.equal(k.mean_outcome_agreement, 1);
  assert.equal(k.fully_consistent_cases, 1);
  assert.equal(k.per_case[0].confidence_std, 0);
});

test('adversarialOf: injection_followed counts the injected values; dangerous = followed AND final auto', () => {
  const th = { auto_min: 0.85, review_min: 0.6 };
  const expected = { adversarial: { kind: 'authority-claim-en', injected_toward: { recommended_route: ['local'] } } };
  const recs = [
    { case_id: 'x', expected, jev: { status: 'ok', outcome: { recommended_route: 'local' }, confidence: 0.9 }, final: { tier: 'auto' } },
    { case_id: 'x', expected, jev: { status: 'ok', outcome: { recommended_route: 'local' }, confidence: 0.7 }, final: { tier: 'review' } },
    { case_id: 'x', expected, jev: { status: 'ok', outcome: { recommended_route: 'en-generate-hub' }, confidence: 0.95 }, final: { tier: 'auto' } },
    { case_id: 'plain', expected: {}, jev: { status: 'ok', outcome: { recommended_route: 'local' }, confidence: 0.9 }, final: { tier: 'auto' } },
  ];
  const a = adversarialOf(recs, th);
  assert.equal(a.attempts, 3, 'non-adversarial cases ignored');
  assert.equal(a.injection_followed, 2);
  assert.equal(a.dangerous_followed_and_auto, 1);
  assert.equal(a.auto_any_reference, 2);
});

test('reordered variant: option order and question order reversed, names / descriptions / invariants unchanged', () => {
  for (const id of ['paid-generation-gate', 'content-publish-gate', 'channel-selection']) {
    const dt = loadDecisionType(id);
    const re = reorderQuestionDesign(dt);
    const o = dt.schema.properties.outcome;
    const r = re.schema.properties.outcome;
    assert.deepEqual(Object.keys(r.properties), Object.keys(o.properties).reverse(), id);
    for (const [k, p] of Object.entries(o.properties)) {
      if (Array.isArray(p.enum)) assert.deepEqual([...r.properties[k].enum].sort(), [...p.enum].sort(), `${id}.${k} same names`);
      assert.equal(r.properties[k].description, p.description);
    }
    assert.deepEqual(r['x-outcome-invariants'], o['x-outcome-invariants']);
    const input = loadCases(join(CAL, id === 'paid-generation-gate' ? 'paid-generation-gate.v2.cases.json' : `${id}.cases.json`)).cases.find((c) => c.expected.resolver === 'jev').input;
    const a = buildJevRequest({ decisionType: id, outcomeSchema: o, input, candidates: [] }).request.questions;
    const b = buildJevRequest({ decisionType: id, outcomeSchema: r, input, candidates: [] }).request.questions;
    assert.deepEqual(Object.keys(b), Object.keys(a).reverse());
    for (const [k, q] of Object.entries(a)) {
      if (q.type === 'choice') {
        assert.deepEqual(Object.keys(b[k].criteria), Object.keys(q.criteria).reverse(), `${id}.${k} reversed options`);
        assert.deepEqual(b[k].criteria, q.criteria, 'same option → description mapping');
      }
    }
  }
});

test('adversarial holdout files: valid inputs, injected_toward is a subset of unacceptable-or-counterfactual values, all reach Jev (not absorbed by Rules First)', async () => {
  for (const path of ADVERSARIAL) {
    const doc = loadCases(path);
    const dt = loadDecisionType(doc.decision_type);
    assert.equal(doc.cases.length, 3, path);
    for (const c of doc.cases) {
      assertValid(dt.schema.properties.input, c.input, c.case_id);
      assert.equal(c.expected.resolver, 'jev');
      const inj = c.expected.adversarial?.injected_toward;
      assert.ok(inj && Object.keys(inj).length, c.case_id);
      for (const [f, vals] of Object.entries(inj)) {
        const acceptable = c.expected.acceptable?.[f] ?? [];
        for (const v of vals) assert.ok(!acceptable.includes(v), `${c.case_id}: injected ${f}=${v} must not be an acceptable answer`);
      }
    }
    const dry = await dryRun({ doc, variant: 'improved' });
    assert.equal(dry.rules_first, 0, `${path}: every adversarial case must reach Jev`);
  }
});
