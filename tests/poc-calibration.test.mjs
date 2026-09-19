/**
 * scripts/poc-calibration.mjs（Confidence Calibration runner）の offline 検証。
 * 実ネットワーク・実 SDK は使わない（Jev Provider を注入）。本番 run は Human のシェル（キー export 済み）で行う。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, dryRun, runCases, analyze, analyzeToMarkdown, stripQuestionDesign, DEFAULT_CASES_PATH } from '../scripts/poc-calibration.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { assertValid } from '../src/schemas/validate.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';

const ENV = { EDL_ALLOW_NETWORK: 'true' };

/** 決定的な偽 Jev：case ごとに noul / choice を変え、B1 相当だけ五分五分（0.54）にする */
function fakeProvider({ failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    id: 'fake',
    available: () => ({ ok: true }),
    async send({ request }) {
      calls.push(request);
      if (failWith) throw new AdapterUnavailableError('jev', failWith, { route: 'fake', networked: true });
      const purpose = request.state.input.purpose ?? '';
      const coinFlip = purpose.includes('teaser');
      const answers = {};
      for (const [name, q] of Object.entries(request.questions)) {
        if (q.type === 'noul') answers[name] = { type: 'noul', noul: name === 'human_review_required' && coinFlip ? 0.54 : (name === 'paid_generation_required' ? 0.05 : 0.95) };
        else answers[name] = { type: 'choice', choice: 'remotion', confidence: 0.9 };
      }
      return { model: 'fake-jev', answers, usage: { input_tokens: 500, output_tokens: 20 } };
    },
  };
}

test('cases file: unique ids, every input validates against the decision_type schema, expectations pre-registered', () => {
  const doc = loadCases(DEFAULT_CASES_PATH);
  const dt = loadDecisionType(doc.decision_type);
  assert.ok(doc.cases.length >= 6 && doc.cases.length <= 10, 'PoC keeps to 6–10 representative cases');
  for (const c of doc.cases) {
    assertValid(dt.schema.properties.input, c.input, c.case_id);
    assert.ok(['rules', 'jev'].includes(c.expected.resolver), c.case_id);
    assert.ok(['low', 'medium', 'high'].includes(c.expected.ambiguity), c.case_id);
    assert.ok(typeof c.expected.route === 'string', c.case_id);
    assert.ok(!('__mock' in c.input), 'never uses mock control');
  }
  const cats = new Set(doc.cases.map((c) => c.category[0]));
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) assert.ok(cats.has(k), `category ${k} present`);
});

test('dry-run: Rules First cases resolve offline exactly as expected; the rest would send 5 questions and nothing is sent', async () => {
  const doc = loadCases();
  const res = await dryRun({ doc, variant: 'improved' });
  assert.equal(res.rules_first, 3);
  assert.equal(res.jev_candidates, doc.cases.length - 3);
  for (const c of res.cases) {
    assert.equal(c.matches_expectation, true, c.case_id);
    assert.equal(c.would_send_questions, c.rules_first_hit ? 0 : 5);
  }
  const base = await dryRun({ doc, variant: 'baseline' });
  assert.ok(base.cases[0].instruction_chars < res.cases[0].instruction_chars);
  assert.equal(base.cases[0].brief_chars, 0);
  assert.ok(res.cases[0].brief_chars > 0);
});

test('runCases: captures field-level confidence + limiting field, keeps rules-first cases out of jev stats, records jev attempt in usage.jsonl even when final=human', async () => {
  const doc = loadCases();
  const provider = fakeProvider();
  const meter = createMemoryMeter();
  const { records, stopped } = await runCases({ doc, variant: 'improved', env: ENV, meter, provider, delayMs: 0 });
  assert.equal(stopped, null);
  assert.equal(records.length, doc.cases.length);
  assert.equal(provider.calls.length, doc.cases.length - 3, 'rules-first cases never reach the provider');
  const rules = records.filter((r) => r.rules_first_hit);
  assert.equal(rules.length, 3);
  for (const r of rules) { assert.equal(r.jev, null); assert.equal(r.jev_called, false); }
  const b1 = records.find((r) => r.case_id === 'B1-photoreal-scene-baseline');
  assert.equal(b1.jev.status, 'ok');
  assert.ok(Math.abs(b1.jev.confidence - 0.08) < 1e-9, 'min aggregation reproduces 0.08 from one coin-flip question');
  assert.equal(b1.jev.limiting_field, 'human_review_required');
  assert.equal(b1.jev.tier, 'human');
  assert.equal(b1.final.resolved_by, 'human', 'chain continues to human escalation');
  // §19: final=human でも real jev attempt が usage record に残る
  const jevAttempt = b1.usage_record.attempts.find((a) => a.adapter === 'jev');
  assert.ok(jevAttempt);
  assert.equal(jevAttempt.networked, true);
  assert.equal(jevAttempt.usage_known, true);
  assert.equal(jevAttempt.model, 'fake-jev');
  assert.equal(jevAttempt.input_tokens, 500);
  assert.equal(b1.usage_record.resolved_by, 'human');
  assert.equal(b1.usage_record.estimated_cost_usd_micros, 0, 'top-level = final resolver (human)');
  assert.equal(b1.usage_record.usage_total.networked_attempts, 1);
  assert.equal(meter.readAll().length, doc.cases.length);
  // a clear case resolves at jev with high confidence (paid 0.05 → |2p-1| = 0.9; others 0.95 → 0.9; choice 0.9)
  const a3 = records.find((r) => r.case_id === 'A3-motion-lower-third');
  assert.equal(a3.final.resolved_by, 'jev');
  assert.equal(a3.jev.tier, 'auto');
  assert.deepEqual(Object.keys(a3.jev.field_confidence).sort(), ['human_review_required', 'local_sufficient', 'paid_generation_required', 'recommended_route', 'remotion_suitable']);
});

test('runCases: stops immediately on rate limit / auth failures (no automatic mass retries)', async () => {
  const doc = loadCases();
  const provider = fakeProvider({ failWith: 'JEV_RATE_LIMITED' });
  const { records, stopped } = await runCases({ doc, variant: 'improved', env: ENV, meter: createMemoryMeter(), provider, delayMs: 0 });
  assert.ok(stopped);
  assert.equal(stopped.reason, 'JEV_RATE_LIMITED');
  assert.equal(provider.calls.length, 1, 'one failed call, then stop');
  assert.ok(records.length < doc.cases.length);
});

test('analyze / analyzeToMarkdown: distribution, grouping, field-level, metering table; baseline variant uses stripped questions', async () => {
  const doc = loadCases();
  const provider = fakeProvider();
  const { thresholds, records } = await runCases({ doc, variant: 'baseline', env: ENV, meter: createMemoryMeter(), provider, delayMs: 0 });
  assert.ok(!('brief' in provider.calls[0].state), 'baseline sends no brief');
  const out = { variant: 'baseline', thresholds, records, started_at: 'x' };
  const a = analyze(out);
  assert.equal(a.counts.rules_first, 3);
  assert.equal(a.counts.jev_ok, doc.cases.length - 3);
  assert.equal(a.confidence.n, doc.cases.length - 3);
  assert.ok(a.confidence.min <= 0.08 + 1e-9);
  assert.equal(a.limiting_field_counts.human_review_required, 1);
  assert.ok(a.by_ambiguity.low && a.by_ambiguity.high);
  assert.equal(a.metering.length, doc.cases.length);
  assert.ok(a.metering.every((m) => m.jev_attempt_recorded === !doc.cases.find((c) => c.case_id === m.case_id).expected.resolver.startsWith('rules')));
  const md = analyzeToMarkdown(out, out);
  for (const h of ['## Per case', '## Field-level confidence', '## Alternative aggregates', '## Metering check', '## Compare']) assert.ok(md.includes(h), h);
  assert.ok(!md.includes('Authorization'));
  // stripQuestionDesign is a pure clone
  const dt = loadDecisionType(doc.decision_type);
  stripQuestionDesign(dt);
  assert.ok(dt.schema.properties.outcome.description);
});
