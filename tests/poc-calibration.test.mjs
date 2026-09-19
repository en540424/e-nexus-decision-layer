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

// ---- 2026-09-19 継続：RetryError 診断・merge・payload shape ----

test('runCases: a RetryError-wrapped 503 from the real provider path is recorded with diagnostic (status / retry_count / error_name), networked=true in attempts[], and the run continues (not an immediate stop)', async () => {
  const { mergeResults } = await import('../scripts/poc-calibration.mjs');
  const { createVercelJevProvider } = await import('../src/adapters/jev/jev-vercel-provider.mjs');
  let calls = 0;
  const inner = Object.assign(new Error('service unavailable'), { name: 'GatewayInternalServerError', statusCode: 503, isRetryable: true });
  const evaluateImpl = async ({ questions }) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('Failed after 3 attempts'), { name: 'RetryError', reason: 'maxRetriesExceeded', errors: [inner, inner, inner], lastError: inner });
    const answers = {};
    for (const [name, q] of Object.entries(questions)) answers[name] = q.type === 'boolean' ? { type: 'boolean', probability: 0.97 } : { type: 'choice', choice: 'remotion' };
    return { answers, usage: { inputTokens: 300, outputTokens: 20 }, response: { modelId: 'typesafe-ai/jev' }, providerMetadata: { typesafe: { confidence: { recommended_route: 0.9 } } } };
  };
  const provider = createVercelJevProvider({ evaluateImpl });
  const doc = loadCases();
  const env = { EDL_ALLOW_NETWORK: 'true', AI_GATEWAY_API_KEY: 'test-key-not-real-0000', JEV_PROVIDER: 'vercel' };
  const meter = createMemoryMeter();
  const { records, stopped } = await runCases({ doc, variant: 'improved', only: ['A3-motion-lower-third', 'B1-photoreal-scene-baseline'], env, meter, provider, delayMs: 1, pauseAfterRetryableMs: 1 });
  assert.equal(stopped, null, 'one retryable failure does not stop the run');
  const a3 = records[0];
  assert.equal(a3.jev.status, 'unavailable');
  assert.equal(a3.jev.reason, 'JEV_OVERLOADED');
  assert.deepEqual(a3.jev.diagnostic, { status: 503, retryable: true, retry_count: 2, retry_reason: 'maxRetriesExceeded', error_name: 'GatewayInternalServerError' });
  const jevAttempt = a3.usage_record.attempts.find((a) => a.adapter === 'jev');
  assert.equal(jevAttempt.networked, true, 'retried ⇒ dispatched');
  assert.equal(jevAttempt.retry_count, 2);
  assert.equal(jevAttempt.usage_known, false, 'unknown ≠ 0');
  assert.equal(a3.usage_record.usage_total.unknown_usage_attempts, 1);
  const b1 = records[1];
  assert.equal(b1.jev.status, 'ok');
  assert.equal(b1.final.resolved_by, 'jev');
  // secret never appears in the results shape
  assert.ok(!JSON.stringify(records).includes('test-key-not-real-0000'));

  // merge: latest ok record per case wins over an earlier failure; earlier ok survives a later failure
  const outFail = { variant: 'improved', started_at: '2026-09-19T09:49:57Z', thresholds: { auto_min: 0.85, review_min: 0.6 }, records: [a3, { ...b1, jev: { ...b1.jev, status: 'unavailable', reason: 'JEV_OVERLOADED' } }] };
  const outOk = { variant: 'improved', started_at: '2026-09-19T09:48:17Z', thresholds: { auto_min: 0.85, review_min: 0.6 }, records: [b1] };
  const outLater = { variant: 'improved', started_at: '2026-09-19T10:30:00Z', thresholds: { auto_min: 0.85, review_min: 0.6 }, records: [{ ...a3, jev: { ...b1.jev } }] };
  const merged = mergeResults([outFail, outOk, outLater]);
  assert.deepEqual(Object.keys(merged), ['improved']);
  const byId = Object.fromEntries(merged.improved.records.map((r) => [r.case_id, r]));
  assert.equal(byId['B1-photoreal-scene-baseline'].jev.status, 'ok', 'earlier ok kept over later failure');
  assert.equal(byId['B1-photoreal-scene-baseline'].source_started_at, '2026-09-19T09:48:17Z');
  assert.equal(byId['A3-motion-lower-third'].jev.status, 'ok', 'later ok replaces earlier failure');
  assert.equal(merged.improved.sources.length, 3);
  const md = analyzeToMarkdown(merged.improved);
  assert.ok(md.includes('merged from 3 run(s)'));
});

test('payload shape: the cases that failed in the real run (D2 / E1 / A3 / B1) build the same question structure as the cases that succeeded — no case-specific payload defect', async () => {
  const { buildJevRequest } = await import('../src/adapters/jev/jev-adapter.mjs');
  const { toGatewayQuestions } = await import('../src/adapters/jev/jev-vercel-provider.mjs');
  const doc = loadCases();
  const dt = loadDecisionType(doc.decision_type);
  const shapes = new Set();
  for (const c of doc.cases.filter((x) => x.expected.resolver === 'jev')) {
    const { request } = buildJevRequest({ decisionType: doc.decision_type, outcomeSchema: dt.schema.properties.outcome, input: c.input, candidates: [] });
    const gw = toGatewayQuestions(request.questions);
    JSON.parse(JSON.stringify(request.state)); // JSON-compatible state
    for (const [name, q] of Object.entries(gw)) {
      assert.ok(typeof q.instructions === 'string' && q.instructions.length > 0, `${c.case_id}.${name} instructions`);
      if (q.type === 'choice') for (const v of Object.values(q.criteria)) assert.ok(typeof v === 'string' && v.length > 0, `${c.case_id}.${name} criteria`);
    }
    shapes.add(JSON.stringify(Object.entries(gw).map(([n, q]) => [n, q.type, q.instructions.length, q.criteria ? Object.keys(q.criteria).length : 0])));
  }
  assert.equal(shapes.size, 1, 'all jev cases send an identical question structure; only state.input differs');
});

test('analyze with no arguments reads every committed results json (PowerShell does not expand globs for node)', async () => {
  const { resolveResultFiles, RESULTS_DIR } = await import('../scripts/poc-calibration.mjs');
  const files = resolveResultFiles([]);
  assert.ok(files.length >= 3, 'the three first-run result files are committed');
  assert.ok(files.every((f) => f.endsWith('.json') && f.startsWith(RESULTS_DIR)));
  assert.deepEqual(resolveResultFiles([RESULTS_DIR]), files, 'a directory argument behaves the same');
  assert.throws(() => resolveResultFiles(['docs/poc/calibration/results/*.json']), /not found/, 'an unexpanded glob fails loudly instead of silently');
});
