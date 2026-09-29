/**
 * MA-31 予約 decision_type の実働化（2026-09-29・Full Autonomous Build FB-04）：automation-safety-gate・customer-reply-gate・lead-triage。
 * どれも承認・送信・解除を返さない（outcome は閉じていて forbidden_outcome_keys を持てない）。
 * 「止める・上げる」enum 値は force_human_when_outcome_values で tier=human に固定（Jev の confidence が高くても）。
 * Rules First（consent・購読・Secret・有料・外部送信・苦情 等は決定的）→ Jev（fake provider・実ネットワークなし）→ human。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, loadDecisionType } from '../src/schemas/loader.mjs';
import { createDecisionEngine, forcedHumanKey } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, buildJevRequest } from '../src/adapters/jev/jev-adapter.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { SchemaValidationError } from '../src/core/errors.mjs';

const TYPES = ['automation-safety-gate', 'customer-reply-gate', 'lead-triage'];
const SAFETY = readJson('policies/safety/human-only.json');

function fakeProvider(answersByField, seen = []) {
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
      return { model: 'fake-jev', answers, usage: { input_tokens: 400, output_tokens: 8 } };
    },
  };
}

function engineWith(provider = null) {
  const env = { EDL_ALLOW_NETWORK: 'true' };
  const adapters = [createRulesAdapter(), ...(provider ? [createJevAdapter({ env, provider })] : []), createLocalAdapterStub(), createLlmAdapterStub({ env }), createHumanAdapter()];
  return createDecisionEngine({ adapters, meter: createMemoryMeter() });
}

const req = (decision_type, input) => ({ decision_type, application_id: 'claude-code', project_id: 'e-nexus-crm-core', input });

const ASG = (extra = {}) => ({
  automation_kind: 'crm-line-push', environment: 'staging', target_scope: 'single-contact', external_send: true, paid_api: false,
  writes_external_system: true, irreversible: true, touches_secrets: false, personal_data: true, existing_gate: 'human-approval-chain',
  rollback_available: false, rate_or_cap_limited: true, summary: 'One reply to one prospect after a signed human approval', ...extra,
});
const CRG = (extra = {}) => ({
  reply_ref: 'idem-reply-0001', channel: 'line', contact_consent_state: 'granted', subscription_state: 'subscribed', inbound_category: 'inquiry',
  draft_excerpt: 'お問い合わせありがとうございます。資料をお送りします。', draft_author: 'ai-draft-human-edited', language: 'ja', ...extra,
});
const LT = (extra = {}) => ({
  subject_ref: 'ct_0123456789', channel: 'line', consent_context: 'granted', subscription_state: 'subscribed', lifecycle_stage: 'lead',
  inbound_category: 'inquiry', interaction_count: 2, recency: 'today', has_explicit_request: true, product_interest: 'scaffold-saas', business_signal: 'business', ...extra,
});

test('registered with closed input/outcome, final_action human-only, and every outcome field is Jev-askable (boolean/enum)', () => {
  const idx = readJson('schemas/common/decision-types.json');
  for (const id of TYPES) {
    assert.ok(idx.decision_types[id], id);
    assert.ok(!idx.reserved_decision_types[id], id);
    const dt = loadDecisionType(id);
    assert.equal(dt.final_action, 'human-only');
    assert.equal(dt.schema.properties.input.additionalProperties, false);
    assert.equal(dt.schema.properties.outcome.additionalProperties, false);
    for (const k of Object.keys(dt.schema.properties.outcome.properties)) assert.ok(!SAFETY.forbidden_outcome_keys.includes(k), `${id}.${k}`);
    assert.doesNotThrow(() => buildJevRequest({ decisionType: id, outcomeSchema: dt.schema.properties.outcome, input: {}, candidates: [], inputSchema: dt.schema.properties.input }));
  }
});

test('input is closed: PII-like extra fields are rejected before any adapter runs', async () => {
  const engine = engineWith();
  await assert.rejects(() => engine.decide(req('lead-triage', { ...LT(), display_name: '山田太郎' })), SchemaValidationError);
  await assert.rejects(() => engine.decide(req('customer-reply-gate', { ...CRG(), phone: '090-0000-0000' })), SchemaValidationError);
  await assert.rejects(() => engine.decide(req('automation-safety-gate', { ...ASG(), api_key: 'x' })), SchemaValidationError);
});

test('force_human_when_outcome_values: enum stop/escalate values force tier=human (forcedHumanKey)', () => {
  assert.equal(forcedHumanKey({ safety_class: 'escalate' }, SAFETY), 'safety_class=escalate');
  assert.equal(forcedHumanKey({ automation_route: 'do-not-automate' }, SAFETY), 'automation_route=do-not-automate');
  assert.equal(forcedHumanKey({ reply_readiness: 'do-not-send' }, SAFETY), 'reply_readiness=do-not-send');
  assert.equal(forcedHumanKey({ reply_classification: 'do-not-contact' }, SAFETY), 'reply_classification=do-not-contact');
  assert.equal(forcedHumanKey({ safety_class: 'low', automation_route: 'existing-gates' }, SAFETY), null);
  assert.equal(forcedHumanKey({ human_review_required: true }, SAFETY), 'human_review_required', 'boolean keys unchanged');
});

test('automation-safety-gate rules: secrets / paid / bulk send / unsigned external send → escalate + do-not-automate (tier human); G5 executor shape → low', async () => {
  const engine = engineWith();
  const cases = [
    [ASG({ touches_secrets: true }), 'touches-secrets', 'do-not-automate'],
    [ASG({ paid_api: true, existing_gate: 'none' }), 'paid-api-without-signed-approval', 'do-not-automate'],
    [ASG({ target_scope: 'all-contacts' }), 'bulk-external-send', 'do-not-automate'],
    [ASG({ existing_gate: 'none' }), 'external-send-without-signed-approval', 'do-not-automate'],
    [ASG({ automation_kind: 'workflow', external_send: false, existing_gate: 'human-manual', environment: 'production', irreversible: false }), 'production-write-without-rollback', 'human-review'],
  ];
  for (const [input, ruleId, route] of cases) {
    const r = await engine.decide(req('automation-safety-gate', input));
    assert.equal(r.resolved_by, 'rules');
    assert.match(r.rationale, new RegExp(`^rule:${ruleId}`));
    assert.equal(r.outcome.automation_route, route);
    assert.equal(r.tier, 'human', `${ruleId} forces human`);
  }
  const ok = await engine.decide(req('automation-safety-gate', ASG()));
  assert.match(ok.rationale, /^rule:crm-line-push-gated/);
  assert.deepEqual(ok.outcome, { safety_class: 'low', human_review_required: false, automation_route: 'existing-gates' });
  assert.equal(ok.tier, 'auto', 'auto is a classification, not an approval (sending still needs approval_ref)');
  assert.equal(ok.human_gate.preserved, true);
});

test('customer-reply-gate rules: consent / block / withdrawal / complaint / price terms are deterministic; do-not-send and hold force human', async () => {
  const engine = engineWith();
  const cases = [
    [CRG({ contact_consent_state: 'withdrawn' }), 'consent-withdrawn', 'do-not-send'],
    [CRG({ subscription_state: 'blocked' }), 'subscription-blocked', 'do-not-send'],
    [CRG({ inbound_category: 'consent-withdrawal' }), 'consent-withdrawal-message', 'do-not-send'],
    [CRG({ contact_consent_state: 'unknown' }), 'consent-unknown', 'hold'],
    [CRG({ inbound_category: 'complaint' }), 'complaint', 'hold'],
    [CRG({ risk_flags: { price_or_terms: true } }), 'price-or-terms', 'hold'],
    [CRG({ risk_flags: { personal_information: true } }), 'personal-information', 'needs-revision'],
  ];
  for (const [input, ruleId, readiness] of cases) {
    const r = await engine.decide(req('customer-reply-gate', input));
    assert.match(r.rationale, new RegExp(`^rule:${ruleId}`));
    assert.equal(r.outcome.reply_readiness, readiness);
    assert.equal(r.tier, 'human', ruleId);
  }
});

test('customer-reply-gate via Jev: a ready draft can reach auto/review, but a high-confidence do-not-send is still human', async () => {
  const ready = { reply_readiness: { choice: 'human-send-review', confidence: 0.97 }, tone_fit: { choice: 'appropriate', confidence: 0.96 }, risk_level: { choice: 'low', confidence: 0.95 }, human_review_required: 0.02 };
  const r = await engineWith(fakeProvider(ready)).decide(req('customer-reply-gate', CRG()));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.reply_readiness, 'human-send-review');
  assert.notEqual(r.tier, 'human');
  const stop = { ...ready, reply_readiness: { choice: 'do-not-send', confidence: 0.99 } };
  const s = await engineWith(fakeProvider(stop)).decide(req('customer-reply-gate', CRG()));
  assert.equal(s.tier, 'human');
  assert.equal(s.human_gate.reason, 'outcome.reply_readiness=do-not-send');
  // 自己矛盾（high risk なのに send review）→ confidence 0 → human
  const contradict = { ...ready, risk_level: { choice: 'high', confidence: 0.99 }, human_review_required: 0.9 };
  const c = await engineWith(fakeProvider(contradict)).decide(req('customer-reply-gate', CRG()));
  assert.equal(c.tier, 'human');
});

test('lead-triage: consent/block → do-not-contact (human), spam → not-a-lead, others go to Jev with PII-free input only', async () => {
  const engine = engineWith();
  const dnc = await engine.decide(req('lead-triage', LT({ consent_context: 'withdrawn' })));
  assert.equal(dnc.outcome.reply_classification, 'do-not-contact');
  assert.equal(dnc.tier, 'human');
  const spam = await engine.decide(req('lead-triage', LT({ inbound_category: 'spam' })));
  assert.equal(spam.outcome.lead_intent, 'not-a-lead');
  const seen = [];
  const answers = {
    lead_intent: { choice: 'purchase', confidence: 0.93 }, lead_priority: { choice: 'high', confidence: 0.92 }, service_fit: { choice: 'strong', confidence: 0.94 },
    b2b_b2c: { choice: 'b2b', confidence: 0.95 }, reply_classification: { choice: 'needs-human-reply', confidence: 0.93 }, human_review_required: 0.1,
  };
  const r = await engineWith(fakeProvider(answers, seen)).decide(req('lead-triage', LT({ message_summary: '足場の見積もりSaaSのデモを希望' })));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.lead_priority, 'high');
  const sent = JSON.stringify(seen[0].state.input);
  assert.ok(sent.includes('ct_0123456789') && !/U[0-9a-f]{32}/.test(sent), 'only the opaque subject_ref is sent');
});
