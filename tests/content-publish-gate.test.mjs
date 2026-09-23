/**
 * content-publish-gate（MA-31 G3・2026-09-23）。
 * 公開前の型付き判定ゲートであって公開実行装置ではないこと（Human-only publish）、Rules First、
 * Jev 経路（注入した fake provider。実ネットワークは使わない）、fallback、metering、privacy を機械的に確認する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, loadDecisionType } from '../src/schemas/loader.mjs';
import { assertValid } from '../src/schemas/validate.mjs';
import { createDecisionEngine } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, buildJevRequest } from '../src/adapters/jev/jev-adapter.mjs';
import { toGatewayQuestions } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { createDecisionLayer } from '../src/index.mjs';
import { AdapterUnavailableError, HumanGateViolationError, SchemaValidationError } from '../src/core/errors.mjs';

const DT_ID = 'content-publish-gate';
const DT = loadDecisionType(DT_ID);
const OUTCOME = DT.schema.properties.outcome;
const RULES = readJson('policies/routing/rules/content-publish-gate.json').rules;
const SAFETY = readJson('policies/safety/human-only.json');
const PUBLISH_KEYS = ['publish_now', 'auto_publish', 'publish_approved', 'publish_allowed', 'allow_publish', 'post_now'];
const STEERING = [/answer true/i, /answer false/i, /always choose/i, /you must choose/i, /always say/i];

/** 普通の無料 note 記事（どの rule にも当たらない → Jev へ） */
function baseInput(extra = {}) {
  return {
    content_id: 'vault:04_Note/下書き/2026-09-23_sample',
    source_type: 'note-draft',
    content_type: 'article',
    channel: 'note',
    channel_registered: true,
    title: '足場屋がAIで見積もりを速くした話',
    summary: '現場の見積もり作業をAIで半自動化した経緯と、うまくいかなかった点。',
    excerpt: '最初は表計算の関数だけで済むと思っていた。',
    language: 'ja',
    provenance: 'ai-draft-human-edited',
    prior_publication_state: 'unpublished',
    duplicate_confirmed: false,
    policy_state: 'clear',
    review_state: 'passed',
    risk_flags: { personal_information: false, identifiable_third_party: false, legal_or_financial_claim: false, company_representative_statement: false, sale_terms: false },
    ...extra,
  };
}

function req(input) {
  return { decision_type: DT_ID, application_id: 'claude-code', project_id: 'en-knowledge-vault', input };
}

/**
 * fake Jev provider：question 名ごとに回答を指定する（noul 確率 / choice + confidence）。
 * 送られた request を seen に残し、実ネットワークは使わない。
 */
function fakeProvider(answersByField, { seen = [], usage = { input_tokens: 520, output_tokens: 12 } } = {}) {
  return {
    id: 'fake',
    available: () => ({ ok: true }),
    async send({ request }) {
      seen.push(request);
      const answers = {};
      for (const [name, q] of Object.entries(request.questions)) {
        const a = answersByField[name];
        answers[name] = q.type === 'noul' ? { type: 'noul', noul: a } : { type: 'choice', choice: a.choice, confidence: a.confidence };
      }
      return { model: 'fake-jev', answers, usage };
    },
  };
}

function engineWith(provider) {
  const env = { EDL_ALLOW_NETWORK: 'true' };
  const meter = createMemoryMeter();
  const engine = createDecisionEngine({
    adapters: [createRulesAdapter(), createJevAdapter({ env, provider }), createLocalAdapterStub(), createLlmAdapterStub({ env: {} }), createHumanAdapter()],
    meter,
  });
  return { engine, meter };
}

const CLEAR_CANDIDATE = {
  publish_candidate: 0.97, revision_needed: 0.04, human_review_required: 0.05,
  risk_level: { choice: 'low', confidence: 0.91 },
  recommended_route: { choice: 'human-publish-review', confidence: 0.9 },
};

function assertNeverPublishes(r) {
  for (const k of [...PUBLISH_KEYS, 'approved', 'approval', 'authorized', 'bypass_human_gate', 'skip_human_review']) assert.ok(!(k in r.outcome), k);
  assert.equal(r.human_gate.preserved, true);
  assert.match(r.human_gate.note, /never approves/);
}

// ---------------------------------------------------------------- registry / schema

test('content-publish-gate is registered (moved out of reserved) with a closed schema and final_action human-only', () => {
  const idx = readJson('schemas/common/decision-types.json');
  assert.ok(idx.decision_types[DT_ID]);
  assert.ok(!idx.reserved_decision_types[DT_ID]);
  assert.equal(DT.domain, 'growth');
  assert.equal(DT.final_action, 'human-only');
  assert.equal(DT.schema.properties.input.additionalProperties, false, 'input is closed (no arbitrary PII / full body fields)');
  assert.equal(OUTCOME.additionalProperties, false);
  // 他の Growth 予約は予約のまま
  for (const id of ['channel-selection', 'lead-triage', 'next-best-action', 'customer-reply-gate', 'automation-safety-gate']) {
    assert.ok(idx.reserved_decision_types[id], id);
    assert.equal(loadDecisionType(id), null, id);
  }
});

test('route vocabulary is next-stage only: no value means publish / post / approve', () => {
  const routes = OUTCOME.properties.recommended_route.enum;
  assert.deepEqual(routes, ['human-publish-review', 'needs-revision', 'hold', 'blocked']);
  for (const v of routes) assert.ok(!/^(publish|post|auto)|approv|authoriz/i.test(v), v);
  for (const k of Object.keys(OUTCOME.properties)) assert.ok(!SAFETY.forbidden_outcome_keys.includes(k), k);
  for (const k of PUBLISH_KEYS) assert.ok(SAFETY.forbidden_outcome_keys.includes(k), `${k} is a forbidden outcome key`);
});

test('every outcome field maps to a Jev question (boolean / enum only) so Jev is never unavailable for this type', () => {
  const { request, fieldPlans } = buildJevRequest({ decisionType: DT_ID, outcomeSchema: OUTCOME, input: baseInput(), candidates: [] });
  assert.deepEqual(Object.keys(fieldPlans).sort(), ['human_review_required', 'publish_candidate', 'recommended_route', 'revision_needed', 'risk_level']);
  assert.equal(request.questions.publish_candidate.type, 'noul');
  assert.equal(request.questions.risk_level.type, 'choice');
  assert.equal(request.questions.recommended_route.type, 'choice');
});

test('Vercel Gateway conversion (the Human smoke route) accepts this schema: no throw, non-empty criteria for both enums', () => {
  const { request } = buildJevRequest({ decisionType: DT_ID, outcomeSchema: OUTCOME, input: baseInput(), candidates: [] });
  const gw = toGatewayQuestions(request.questions);
  assert.deepEqual(Object.keys(gw).sort(), Object.keys(request.questions).sort());
  for (const field of ['risk_level', 'recommended_route']) {
    for (const [v, text] of Object.entries(gw[field].criteria)) assert.ok(typeof text === 'string' && text.length > 0, `${field}.${v}`);
  }
});

// ---------------------------------------------------------------- Jev question design（Calibration 方式）

test('question design: every field has concrete instructions, every enum value has criteria, the brief says it never publishes', () => {
  for (const [name, prop] of Object.entries(OUTCOME.properties)) {
    assert.ok(typeof prop.description === 'string' && prop.description.length > 60, `${name} needs a real description`);
    if (prop.enum) for (const v of prop.enum) assert.ok(typeof prop['x-enum-descriptions']?.[v] === 'string' && prop['x-enum-descriptions'][v].length > 20, `${name}.${v}`);
  }
  assert.match(OUTCOME.description, /never publishes anything/);
  assert.match(OUTCOME.description, /never a publishing approval/);
  assert.match(OUTCOME.properties.publish_candidate.description, /never means the content may be published automatically/);
  // human_review_required = 「内容に特定の懸念があるか」。「公開に Human 承認が要るか」（常に要る）と混同しない
  assert.match(OUTCOME.properties.human_review_required.description, /not about whether publishing needs human approval/);
  const texts = [OUTCOME.description, ...Object.values(OUTCOME.properties).flatMap((p) => [p.description, ...Object.values(p['x-enum-descriptions'] ?? {})])];
  for (const t of texts) for (const re of STEERING) assert.ok(!re.test(t), `steering phrase ${re} in: ${t.slice(0, 60)}`);
  const { request } = buildJevRequest({ decisionType: DT_ID, outcomeSchema: OUTCOME, input: baseInput(), candidates: [] });
  for (const [name, q] of Object.entries(request.questions)) assert.equal(q.instructions, OUTCOME.properties[name].description, name);
  assert.equal(request.state.brief, OUTCOME.description);
});

// ---------------------------------------------------------------- rules table（runtime では一致時にしか検証されないため表全体を検査）

test('rules table: every rule outcome passes the outcome schema and is route-consistent; no rule can emit a publish key', () => {
  const ids = new Set();
  for (const rule of RULES) {
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assertValid(OUTCOME, rule.outcome, `rule ${rule.id}`);
    const o = rule.outcome;
    assert.equal(o.publish_candidate, o.recommended_route === 'human-publish-review', `${rule.id}: publish_candidate ⇔ human-publish-review`);
    assert.equal(o.revision_needed, o.recommended_route === 'needs-revision', `${rule.id}: revision_needed ⇔ needs-revision`);
    for (const k of Object.keys(o)) assert.ok(!SAFETY.forbidden_outcome_keys.includes(k), `${rule.id}: ${k}`);
    // rules は公開候補を確定しない（候補判定は content を読む Jev / Human 側）
    assert.notEqual(o.recommended_route, 'human-publish-review', `${rule.id}: rules never promote to publish review`);
  }
  // 名前で止めるのは方針が固定済みの3媒体だけ（planned / manual は caller の channel_registered で判定。Channel Registry を複製しない）
  const namedChannels = new Set(RULES.map((r) => r.when.channel).filter((c) => typeof c === 'string'));
  assert.deepEqual([...namedChannels].sort(), ['discord', 'facebook', 'linkedin', 'threads', 'x']);
  const blockedByName = RULES.filter((r) => typeof r.when.channel === 'string' && Object.keys(r.when).length === 1).map((r) => r.when.channel).sort();
  assert.deepEqual(blockedByName, ['discord', 'facebook', 'linkedin']);
});

// ---------------------------------------------------------------- representative cases A〜J

test('A: ordinary free note article → Jev → publish candidate on route human-publish-review; still never a publish (Human publish required)', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE, { seen }));
  const r = await engine.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.publish_candidate, true);
  assert.equal(r.outcome.recommended_route, 'human-publish-review');
  assert.equal(r.outcome.risk_level, 'low');
  assert.equal(r.outcome.human_review_required, false);
  // tier=auto は「この事前判定に確信がある」であって公開許可ではない（paid-generation-gate の tier=auto 固定と同じ意味論）
  assert.equal(r.tier, 'auto');
  assert.equal(r.human_gate.required, false);
  assertNeverPublishes(r);
  assert.equal(DT.final_action, 'human-only', 'the publish itself stays Human-only regardless of tier');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].state.input, baseInput(), 'Jev receives exactly the (closed, minimal) input');
});

test('A2: same article but one uncertain question → min aggregation → review / human tier (thresholds untouched)', async () => {
  const { engine } = engineWith(fakeProvider({ ...CLEAR_CANDIDATE, human_review_required: 0.3 }));
  const r = await engine.decide(req(baseInput()));
  const jev = r.fallback.trace.find((t) => t.adapter === 'jev');
  assert.equal(jev.status, 'ok');
  assert.ok(Math.abs(jev.confidence - 0.4) < 1e-9, '|2*0.3-1| = 0.4 is the min');
  assert.equal(jev.tier, 'human');
  assert.equal(jev.continue_reason, 'CONFIDENCE_TIER_HUMAN');
  assert.deepEqual(r.thresholds, { auto_min: 0.85, review_min: 0.6 });
  // 既存 fallback 設計どおり local → llm → human へ進み、human escalation で確定（Jev の低確信を上書きしない）
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.tier, 'human');
  assertNeverPublishes(r);
});

test('B: explicit policy block → deterministic blocked, Jev not called', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE, { seen }));
  const r = await engine.decide(req(baseInput({ policy_state: 'blocked' })));
  assert.equal(r.resolved_by, 'rules');
  assert.match(r.rationale, /^rule:policy-state-blocked/);
  assert.equal(r.outcome.recommended_route, 'blocked');
  assert.equal(r.outcome.publish_candidate, false);
  assert.equal(seen.length, 0);
});

test('C / D / E: facebook (excluded) / discord (internal) / linkedin (future) → deterministic blocked by channel policy', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE, { seen }));
  for (const [channel, ruleId] of [['facebook', 'channel-facebook-excluded'], ['discord', 'channel-discord-internal'], ['linkedin', 'channel-linkedin-future']]) {
    const r = await engine.decide(req(baseInput({ channel })));
    assert.equal(r.resolved_by, 'rules', channel);
    assert.match(r.rationale, new RegExp(`^rule:${ruleId}`), channel);
    assert.equal(r.outcome.recommended_route, 'blocked', channel);
    assert.equal(r.outcome.publish_candidate, false, channel);
    assert.equal(r.confidence, 1);
    assertNeverPublishes(r);
  }
  assert.equal(seen.length, 0, 'channel policy is never asked to Jev');
});

test('F: already published → blocked (no duplicate publish candidate); duplicate_confirmed → blocked', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  const a = await engine.decide(req(baseInput({ prior_publication_state: 'published' })));
  assert.match(a.rationale, /^rule:already-published/);
  assert.equal(a.outcome.recommended_route, 'blocked');
  const b = await engine.decide(req(baseInput({ duplicate_confirmed: true })));
  assert.match(b.rationale, /^rule:duplicate-confirmed/);
  assert.equal(b.outcome.publish_candidate, false);
  const c = await engine.decide(req(baseInput({ prior_publication_state: 'unknown' })));
  assert.match(c.rationale, /^rule:publication-state-unknown/);
  assert.equal(c.outcome.recommended_route, 'hold');
});

test('semantics pinned: deterministic blocked / hold without a content concern are tier=auto and human_gate.required=false — callers must key on recommended_route, not on human_gate.required', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  const cases = [
    [{ policy_state: 'blocked' }, 'blocked'],
    [{ channel: 'facebook' }, 'blocked'],
    [{ channel: 'discord' }, 'blocked'],
    [{ channel: 'linkedin' }, 'blocked'],
    [{ prior_publication_state: 'published' }, 'blocked'],
    [{ prior_publication_state: 'unknown' }, 'hold'],
    [{ channel: 'instagram', channel_registered: false }, 'hold'],
    [{ channel: 'x', content_type: 'post' }, 'hold'],
  ];
  for (const [extra, route] of cases) {
    const r = await engine.decide(req(baseInput(extra)));
    assert.equal(r.outcome.recommended_route, route, JSON.stringify(extra));
    assert.equal(r.outcome.publish_candidate, false, JSON.stringify(extra));
    // tier は「この事前判定の確信度」。hold / blocked の意味（進めない）は route が持つ
    assert.equal(r.tier, 'auto', JSON.stringify(extra));
    assert.equal(r.human_gate.required, false, JSON.stringify(extra));
    assertNeverPublishes(r);
  }
});

test('known gap (Hybrid follow-up must close): Jev risk_level=high with human_review_required=false at high confidence → tier auto; safe only because publishing is always Human', async () => {
  const { engine } = engineWith(fakeProvider({ ...CLEAR_CANDIDATE, risk_level: { choice: 'high', confidence: 0.92 } }));
  const r = await engine.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.risk_level, 'high');
  assert.equal(r.outcome.human_review_required, false);
  assert.equal(r.tier, 'auto', 'no field-consistency check exists yet (MA-30 follow-up ② Hybrid / contradiction detection)');
  assertNeverPublishes(r);
  assert.equal(DT.final_action, 'human-only');
});

test('G: brand / legal risk → Human review + hold (rules via caller flags; Jev via human_review_required=true)', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider({ ...CLEAR_CANDIDATE, human_review_required: 0.96, publish_candidate: 0.1, risk_level: { choice: 'high', confidence: 0.88 }, recommended_route: { choice: 'hold', confidence: 0.86 } }, { seen }));
  for (const [flag, ruleId] of [['legal_or_financial_claim', 'legal-or-financial-claim'], ['company_representative_statement', 'company-representative-statement'], ['identifiable_third_party', 'identifiable-third-party'], ['sale_terms', 'sale-terms']]) {
    const r = await engine.decide(req(baseInput({ risk_flags: { ...baseInput().risk_flags, [flag]: true } })));
    assert.equal(r.resolved_by, 'rules', flag);
    assert.match(r.rationale, new RegExp(`^rule:${ruleId}`), flag);
    assert.equal(r.outcome.recommended_route, 'hold', flag);
    assert.equal(r.outcome.human_review_required, true, flag);
    assert.equal(r.tier, 'human', `${flag}: forced human by human_review_required`);
  }
  assert.equal(seen.length, 0, 'flagged risk is deterministic, Jev is not asked');
  // フラグが無くても Jev が内容から高リスクと判断すれば tier=human に固定
  const j = await engine.decide(req(baseInput()));
  assert.equal(j.resolved_by, 'jev');
  assert.equal(j.outcome.human_review_required, true);
  assert.equal(j.tier, 'human');
  assert.match(j.human_gate.reason, /human_review_required/);
  // 個人情報は除去が先（needs-revision）
  const p = await engine.decide(req(baseInput({ risk_flags: { ...baseInput().risk_flags, personal_information: true } })));
  assert.equal(p.outcome.recommended_route, 'needs-revision');
  assert.equal(p.tier, 'human');
});

test('H: missing information → needs-revision by rule (typed result, not a schema error); open review issues → needs-revision', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  const noTitle = baseInput();
  delete noTitle.title;
  const a = await engine.decide(req(noTitle));
  assert.match(a.rationale, /^rule:title-missing/);
  assert.equal(a.outcome.recommended_route, 'needs-revision');
  assert.equal(a.outcome.revision_needed, true);
  const noSummary = baseInput();
  delete noSummary.summary;
  assert.match((await engine.decide(req(noSummary))).rationale, /^rule:summary-missing/);
  const issues = await engine.decide(req(baseInput({ review_state: 'issues-open' })));
  assert.match(issues.rationale, /^rule:review-issues-open/);
  // planned 媒体（Hub に実物 channel 無し）は hold
  const planned = await engine.decide(req(baseInput({ channel: 'instagram', channel_registered: false })));
  assert.match(planned.rationale, /^rule:channel-not-registered/);
  assert.equal(planned.outcome.recommended_route, 'hold');
});

test('I: X / Threads without Human opt-in → not a publish candidate (hold)', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  for (const channel of ['x', 'threads']) {
    const missing = await engine.decide(req(baseInput({ channel, content_type: 'post' })));
    assert.match(missing.rationale, new RegExp(`^rule:${channel}-opt-in-missing`));
    assert.equal(missing.outcome.publish_candidate, false);
    assert.equal(missing.outcome.recommended_route, 'hold');
    const no = await engine.decide(req(baseInput({ channel, content_type: 'post', human_opt_in: false })));
    assert.match(no.rationale, new RegExp(`^rule:${channel}-opt-in-false`));
  }
});

test('J: X / Threads with Human opt-in → reaches Jev and can be a candidate, but publishing stays Human-only', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  for (const channel of ['x', 'threads']) {
    const r = await engine.decide(req(baseInput({ channel, content_type: 'post', human_opt_in: true })));
    assert.equal(r.resolved_by, 'jev', channel);
    assert.equal(r.outcome.publish_candidate, true);
    assert.equal(r.outcome.recommended_route, 'human-publish-review');
    assertNeverPublishes(r);
  }
});

// ---------------------------------------------------------------- Human-only publish（機械的な壁）

test('an adapter returning a publish-execution key is rejected with HumanGateViolationError', async () => {
  for (const key of PUBLISH_KEYS) {
    const rogue = {
      id: 'rogue', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true,
      decide: async () => ({ outcome: { publish_candidate: true, revision_needed: false, risk_level: 'low', human_review_required: false, recommended_route: 'human-publish-review', [key]: true }, confidence: 0.99 }),
    };
    const engine = createDecisionEngine({ adapters: [rogue, createHumanAdapter()], meter: createMemoryMeter(), routingPolicy: { default_chain: ['rogue', 'human'], overrides: {} } });
    await assert.rejects(() => engine.decide(req(baseInput())), HumanGateViolationError, key);
  }
});

// ---------------------------------------------------------------- fallback（既存 chain をそのまま使う）

test('no key / network gate off: rules miss → jev NETWORK_DISABLED → mock-jev is not used for this type → human escalation', async () => {
  const meter = createMemoryMeter();
  const edl = createDecisionLayer({ env: {}, meter });
  const r = await edl.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.tier, 'human');
  assert.equal(r.outcome.escalated, true);
  const byAdapter = Object.fromEntries(r.fallback.trace.map((t) => [t.adapter, t]));
  assert.equal(byAdapter.rules.reason, 'NO_RULE_MATCHED');
  assert.match(byAdapter.jev.reason, /KEY_MISSING|NETWORK_DISABLED/, 'send-before gate');
  assert.equal(byAdapter.jev.networked, false);
  assert.ok(!('mock-jev' in byAdapter), 'mock-jev never decides a publish gate (no heuristic → UNSUPPORTED)');
  assert.ok(r.fallback.skipped.some((s) => s.adapter === 'mock-jev' && s.reason === 'UNSUPPORTED'));
  assert.equal(meter.readAll().length, 1);
});

test('real Jev fails after sending (429) → attempt keeps networked=true / unknown usage → falls through to human', async () => {
  const provider = {
    id: 'fake',
    available: () => ({ ok: true }),
    async send() { throw new AdapterUnavailableError('jev', 'JEV_RATE_LIMITED', { status: 429, networked: true, retry_count: 2 }); },
  };
  const { engine, meter } = engineWith(provider);
  const r = await engine.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'human');
  const jev = r.fallback.trace.find((t) => t.adapter === 'jev');
  assert.equal(jev.status, 'unavailable');
  assert.equal(jev.reason, 'JEV_RATE_LIMITED');
  assert.equal(jev.networked, true);
  assert.equal(jev.usage_known, false);
  assert.equal(jev.retry_count, 2);
  assert.equal(meter.readAll()[0].usage_total.unknown_usage_attempts, 1);
});

// ---------------------------------------------------------------- metering

test('metering: Jev decision records provider / model / route / confidence / latency / tokens / cost / networked in attempts[]', async () => {
  const { engine, meter } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  const r = await engine.decide(req(baseInput()));
  assert.equal(meter.readAll().length, 1);
  const row = meter.readAll()[0];
  assert.equal(row.decision_type, DT_ID);
  assert.equal(row.resolved_by, 'jev');
  assert.equal(row.provider, 'typesafe-ai');
  assert.equal(row.tier, 'auto');
  const jev = row.attempts.find((a) => a.adapter === 'jev');
  assert.equal(jev.final, true);
  assert.equal(jev.model, 'fake-jev');
  assert.equal(jev.route, 'fake');
  assert.equal(jev.networked, true);
  assert.equal(jev.input_tokens, 520);
  assert.equal(typeof jev.estimated_cost_usd_micros, 'number');
  assert.equal(typeof jev.latency_ms, 'number');
  assert.ok(Math.abs(jev.confidence - r.confidence) < 1e-9);
  assert.equal(row.attempts[0].adapter, 'rules');
  assert.equal(row.attempts[0].reason, 'NO_RULE_MATCHED');
  assert.equal(row.usage_total.networked_attempts, 1);
});

test('metering: rule decision is one free, non-networked attempt', async () => {
  const { engine, meter } = engineWith(fakeProvider(CLEAR_CANDIDATE));
  await engine.decide(req(baseInput({ channel: 'facebook' })));
  const row = meter.readAll()[0];
  assert.equal(row.resolved_by, 'rules');
  assert.equal(row.estimated_cost_usd_micros, 0);
  assert.equal(row.attempts.length, 1);
  assert.equal(row.attempts[0].networked, false);
  assert.equal(row.usage_total.estimated_cost_usd_micros, 0);
});

// ---------------------------------------------------------------- privacy（input は閉じていて有限）

test('privacy: unknown input fields (e.g. author email / full body) and over-long free text are rejected before any adapter runs', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE, { seen }));
  await assert.rejects(() => engine.decide(req(baseInput({ author_email: 'x@example.com' }))), SchemaValidationError);
  await assert.rejects(() => engine.decide(req(baseInput({ body: 'full text' }))), SchemaValidationError);
  await assert.rejects(() => engine.decide(req(baseInput({ excerpt: 'あ'.repeat(1201) }))), SchemaValidationError);
  await assert.rejects(() => engine.decide(req(baseInput({ risk_flags: { customer_name: 'x' } }))), SchemaValidationError);
  assert.equal(seen.length, 0);
});

test('sample request for the Human smoke run is valid and reaches Jev (no rule match)', async () => {
  const sample = readJson('docs/growth/content-publish-gate.sample-request.json');
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_CANDIDATE, { seen }));
  const r = await engine.decide(sample);
  assert.equal(r.resolved_by, 'jev');
  assert.equal(seen.length, 1);
});
