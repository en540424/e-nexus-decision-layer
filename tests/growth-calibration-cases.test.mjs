/**
 * MA-31 実働化 3 type（automation-safety-gate / customer-reply-gate / lead-triage）の Calibration cases（2026-09-29 FB-15）を offline で固める：
 *   - 全 case の input が decision type の input schema に通る（閉じた schema・PII を持てない形）
 *   - expected の値がすべて outcome の enum に入り、acceptable と unacceptable が重ならず、injected_toward は unacceptable の内側
 *   - dry-run で Rules First／Jev の振り分けが expected.resolver どおり。rules case は rule の outcome が acceptable を満たし invariant も破らない
 *   - adversarial は base_case が main か holdout にあり、Rules First に吸われず Jev まで届く
 *   - 偽 Jev で run が最後まで流れ、analyze が敵対 holdout を数える（実ネットワーク・課金なし。実 run の go は Human：Full Build ログ L07）
 *   - PII の形（メール・電話番号・LINE userId）が case のどこにも無い
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadCases, dryRun, runCases, analyze, evaluateConstraints } from '../scripts/poc-calibration.mjs';
import { createDecisionEngine } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { assertValid } from '../src/schemas/validate.mjs';
import { ROOT } from '../src/core/paths.mjs';

const CAL = join(ROOT, 'docs', 'poc', 'calibration');
const TYPES = ['automation-safety-gate', 'customer-reply-gate', 'lead-triage'];
const KINDS = ['cases', 'holdout.cases', 'adversarial.cases'];
const fileOf = (t, k) => join(CAL, `${t}.${k}.json`);

for (const t of TYPES) {
  const dt = loadDecisionType(t);
  const inputSchema = dt.schema.properties.input;
  const outProps = dt.schema.properties.outcome.properties;
  const docs = Object.fromEntries(KINDS.map((k) => [k, loadCases(fileOf(t, k))]));

  test(`${t}: every case input validates, expected values are real enum members, sets are consistent`, () => {
    const ids = new Set();
    for (const [k, doc] of Object.entries(docs)) {
      assert.equal(doc.decision_type, t, k);
      assert.ok(doc.cases.length >= 3, `${k} has cases`);
      for (const c of doc.cases) {
        assert.ok(!ids.has(c.case_id), `unique case_id ${c.case_id}`);
        ids.add(c.case_id);
        assertValid(inputSchema, c.input, `${t}/${c.case_id}.input`);
        const { acceptable = {}, unacceptable = {} } = c.expected;
        for (const [f, vals] of [...Object.entries(acceptable), ...Object.entries(unacceptable)]) {
          const p = outProps[f];
          assert.ok(p, `${c.case_id}: ${f} is an outcome field`);
          const allowed = p.type === 'boolean' ? [true, false] : p.enum;
          for (const v of vals) assert.ok(allowed.includes(v), `${c.case_id}: ${f}=${v} is a valid value`);
        }
        for (const [f, vals] of Object.entries(unacceptable)) {
          for (const v of vals) assert.ok(!(acceptable[f] ?? []).includes(v), `${c.case_id}: ${f}=${v} is not both acceptable and unacceptable`);
        }
        const inj = c.expected.adversarial?.injected_toward;
        if (inj) for (const [f, vals] of Object.entries(inj)) for (const v of vals) assert.ok((unacceptable[f] ?? []).includes(v), `${c.case_id}: injected ${f}=${v} is unacceptable`);
      }
    }
  });

  test(`${t}: dry-run routes each case as expected; holdout / adversarial reach Jev`, async () => {
    for (const [k, doc] of Object.entries(docs)) {
      const r = await dryRun({ doc, variant: 'improved' });
      const bad = r.cases.filter((c) => !c.matches_expectation).map((c) => `${c.case_id}→${c.rule ?? 'jev'}`);
      assert.deepEqual(bad, [], `${k}: resolver mismatch`);
      if (k !== 'cases') assert.equal(r.rules_first, 0, `${k}: nothing is absorbed by Rules First`);
      for (const c of r.cases.filter((x) => !x.rules_first_hit)) assert.ok(c.would_send_questions >= 3, `${c.case_id}: questions built`);
    }
    const main = await dryRun({ doc: docs.cases, variant: 'improved' });
    assert.ok(main.rules_first >= 5 && main.jev_candidates >= 4, 'main set has both rules and jev cases');
  });

  test(`${t}: rules cases — the rule outcome satisfies expected.acceptable and the outcome invariants`, async () => {
    const engine = createDecisionEngine({ adapters: [createRulesAdapter(), createHumanAdapter()], meter: createMemoryMeter() });
    for (const c of docs.cases.cases.filter((x) => x.expected.resolver === 'rules')) {
      const r = await engine.decide({ decision_type: t, application_id: docs.cases.application_id, project_id: docs.cases.project_id, input: structuredClone(c.input) });
      assert.equal(r.resolved_by, 'rules', c.case_id);
      const ev = evaluateConstraints(t, r.outcome, c.expected, c.input);
      assert.equal(ev.pass, true, `${c.case_id}: ${JSON.stringify(ev)}`);
    }
  });

  test(`${t}: adversarial base cases exist and are Jev cases`, () => {
    const base = new Map([...docs.cases.cases, ...docs['holdout.cases'].cases].map((c) => [c.case_id, c]));
    for (const c of docs['adversarial.cases'].cases) {
      const b = base.get(c.base_case);
      assert.ok(b, `${c.case_id}: base_case ${c.base_case} exists`);
      assert.equal(b.expected.resolver, 'jev', `${c.case_id}: base is a Jev case`);
      assert.ok(c.expected.adversarial?.injected_toward, `${c.case_id}: has injected_toward`);
    }
  });

  test(`${t}: a fake Jev run completes end to end and analyze counts the adversarial set (no network, no cost)`, async () => {
    const doc = docs['adversarial.cases'];
    // injected_toward に全部従う偽 Jev（最悪ケース）。enum は injected 値、無ければ先頭、boolean は false
    const provider = {
      id: 'fake',
      available: () => ({ ok: true }),
      async send({ request }) {
        const inputRef = JSON.stringify(request.state ?? {});
        const c = doc.cases.find((x) => inputRef.includes(x.input.automation_ref ?? x.input.reply_ref ?? x.input.subject_ref));
        const inj = c?.expected.adversarial.injected_toward ?? {};
        const answers = {};
        for (const [name, q] of Object.entries(request.questions)) {
          if (q.type === 'noul') answers[name] = { type: 'noul', noul: inj[name]?.[0] === true ? 0.97 : 0.03 };
          else answers[name] = { type: 'choice', choice: inj[name]?.[0] ?? q.choices?.[0] ?? outProps[name].enum[0], confidence: 0.95 };
        }
        return { model: 'jev-1.13.0', answers, usage: { input_tokens: 400, output_tokens: 20 } };
      },
    };
    const { records } = await runCases({ doc, variant: 'improved', env: { EDL_ALLOW_NETWORK: 'true' }, meter: createMemoryMeter(), delayMs: 0, provider });
    assert.equal(records.length, doc.cases.length);
    assert.ok(records.every((r) => r.jev?.status === 'ok'), JSON.stringify(records.map((r) => r.jev?.status)));
    const a = analyze({ schema: 'edl-poc-calibration-v1', decision_type: t, variant: 'improved', thresholds: { auto_min: 0.85, review_min: 0.6 }, records });
    assert.equal(a.adversarial.attempts, doc.cases.length);
    assert.equal(a.adversarial.injection_followed, doc.cases.length, 'the worst-case fake follows every injection and analyze sees it');
  });
}

test('no PII shapes anywhere in the growth calibration cases (email, phone, LINE userId)', () => {
  for (const t of TYPES) for (const k of KINDS) {
    const raw = readFileSync(fileOf(t, k), 'utf8');
    assert.doesNotMatch(raw, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, `${t}.${k}: email`);
    assert.doesNotMatch(raw, /0\d{1,4}-\d{1,4}-\d{3,4}/, `${t}.${k}: phone`);
    assert.doesNotMatch(raw, /\bU[0-9a-f]{32}\b/, `${t}.${k}: LINE userId`);
  }
});
