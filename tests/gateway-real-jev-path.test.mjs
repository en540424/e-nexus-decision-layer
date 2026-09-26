/**
 * Common Decision Gateway × 実 Jev 経路（Vercel transport）の通し検証（2026-09-26・MA-30 実JEV第1段）。
 *
 *   consumer → Gateway → DecisionEngine（production）→ rules → jev(vercel) → local → llm → human
 *
 * 目的：
 *   - 実 Jev 経路が「正常」なら Gateway は Jev の typed Decision をそのまま返し、不必要に human へ倒さない
 *   - 実 Jev 経路が「異常」（network 無効・キー無し・timeout・5xx・429 retry 枯渇・応答不正）なら human へ倒れ、
 *     自動で進まない・承認キーを返さない
 *   - どちらの場合も usage の attempts[] に Jev 経路の証跡（route / networked / reason / tokens）が残る
 *
 * 実ネットワーク・実 'ai' パッケージは使わない（evaluateImpl を注入）。memory meter（usage.jsonl に書かない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine, gatewayAdapters } from '../src/gateway/engine.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { createVercelJevProvider } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';

const USABLE = Object.freeze({ EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'test-key-not-real' });
const APPROVAL_KEYS = ['approved', 'approval', 'approve', 'authorized', 'bypass_human_gate', 'override_budget', 'skip_human_review'];

// rules に一致しない（$5 未満・subtitle 等でない）paid-generation-gate 入力 → Jev まで届く
const INPUT = { asset_kind: 'scene', purpose: 'product hero shot we do not have locally', style: 'photoreal', estimated_paid_cost_usd_micros: 300000 };

/** production と同じ並び（gatewayAdapters）で、Jev の transport だけ注入する */
function gatewayWith({ env = USABLE, evaluateImpl }) {
  let calls = 0;
  const provider = createVercelJevProvider({ evaluateImpl: async (args) => { calls += 1; return evaluateImpl(args); } });
  const adapters = [
    createRulesAdapter(),
    createJevAdapter({ env, provider }),
    createLocalAdapterStub(),
    createLlmAdapterStub({ env }),
    createHumanAdapter(),
  ];
  // 並び・構成は production の gatewayAdapters と一致（mock-jev は入らない）
  assert.deepEqual(adapters.map((a) => a.id), gatewayAdapters({ env: USABLE, mode: 'production' }).map((a) => a.id));
  const meter = createMemoryMeter();
  const gateway = createGateway({ engine: createDecisionLayerEngine({ env, mode: 'production', meter, adapters }), env });
  return { gateway, meter, calls: () => calls };
}

const req = (extra = {}) => ({ decision_type: 'paid-generation-gate', application_id: 'claude-code', project_id: 'en-generate-hub', input: INPUT, ...extra });

/** Vercel evaluate() の形で、全 question に明確に答える */
function clearAnswers({ humanReview = 0.03 } = {}) {
  return async () => ({
    answers: {
      local_sufficient: { type: 'boolean', probability: 0.03 },
      remotion_suitable: { type: 'boolean', probability: 0.03 },
      paid_generation_required: { type: 'boolean', probability: 0.97 },
      human_review_required: { type: 'boolean', probability: humanReview },
      recommended_route: { type: 'choice', choice: 'en-generate-hub', probabilities: { 'en-generate-hub': 0.93 } },
    },
    providerMetadata: { typesafe: { confidence: { recommended_route: 0.93 } } },
    usage: { inputTokens: 420, outputTokens: 12 },
    response: { modelId: 'typesafe-ai/jev' },
  });
}

function jevAttempt(meter) {
  const [row] = meter.readAll();
  return { row, jev: row.attempts.find((a) => a.adapter === 'jev') };
}

function assertFailsTowardHuman(envelope) {
  assert.equal(envelope.ok, true, 'engine resolved via the human adapter (no crash, no auto-proceed)');
  assert.equal(envelope.decision.resolved_by, 'human');
  assert.equal(envelope.decision.tier, 'human');
  assert.equal(envelope.decision.human_gate.required, true);
  for (const k of APPROVAL_KEYS) assert.ok(!(k in envelope.decision.outcome), k);
}

test('real Jev path healthy: Gateway returns the Jev typed Decision (tier auto) instead of forcing human; not an approval', async () => {
  const { gateway, meter, calls } = gatewayWith({ evaluateImpl: clearAnswers() });
  const env = await gateway.decide(req({ correlation_id: 'smoke:healthy' }), { via: 'cli' });
  assert.equal(calls(), 1);
  assert.equal(env.ok, true);
  assert.equal(env.decision.resolved_by, 'jev');
  assert.equal(env.decision.provider, 'typesafe-ai');
  assert.equal(env.decision.tier, 'auto');
  assert.ok(env.decision.confidence >= 0.85);
  assert.equal(env.decision.outcome.recommended_route, 'en-generate-hub');
  assert.equal(env.decision.human_gate.preserved, true, 'Human Gate for spending is preserved even at tier auto');
  for (const k of APPROVAL_KEYS) assert.ok(!(k in env.decision.outcome), k);

  const { row, jev } = jevAttempt(meter);
  assert.equal(row.via, 'cli');
  assert.equal(row.application_id, 'claude-code');
  assert.equal(row.correlation_id, 'smoke:healthy');
  assert.equal(jev.status, 'ok');
  assert.equal(jev.route, 'vercel');
  assert.equal(jev.networked, true);
  assert.equal(jev.input_tokens, 420);
  assert.equal(row.attempts.some((a) => a.adapter === 'mock-jev'), false);
  assert.ok(!JSON.stringify(row).includes(USABLE.AI_GATEWAY_API_KEY), 'secret never reaches usage metering');
  assert.ok(!JSON.stringify(env).includes(USABLE.AI_GATEWAY_API_KEY), 'secret never reaches the envelope');
});

test('real Jev path healthy but uncertain (low confidence, like the 2026-09-19 first run) → human tier; Jev attempt still recorded as networked ok', async () => {
  const { gateway, meter } = gatewayWith({ evaluateImpl: clearAnswers({ humanReview: 0.54 }) });
  const env = await gateway.decide(req());
  assert.equal(env.decision.tier, 'human');
  assert.equal(env.decision.human_gate.required, true);
  const { jev } = jevAttempt(meter);
  assert.equal(jev.status, 'ok');
  assert.equal(jev.networked, true);
});

const FAILURES = [
  ['network disabled (no EDL_ALLOW_NETWORK)', { env: { JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'test-key-not-real' } }, 'NETWORK_DISABLED', false, 0],
  ['key missing', { env: { EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'vercel' } }, 'JEV_VERCEL_API_KEY_MISSING', false, 0],
  ['provider timeout / abort', { evaluateImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }, 'JEV_NETWORK_ERROR', true, 1],
  ['provider 503', { evaluateImpl: async () => { throw Object.assign(new Error('upstream'), { statusCode: 503, isRetryable: true }); } }, 'JEV_OVERLOADED', true, 1],
  ['429 retries exhausted (RetryError)', {
    evaluateImpl: async () => {
      const inner = Object.assign(new Error('rate'), { statusCode: 429, isRetryable: true });
      throw Object.assign(new Error('Failed after 3 attempts'), { name: 'RetryError', reason: 'maxRetriesExceeded', errors: [inner, inner, inner], lastError: inner });
    },
  }, 'JEV_RATE_LIMITED', true, 1],
  ['malformed provider response (answers missing)', { evaluateImpl: async () => ({ usage: { inputTokens: 1, outputTokens: 0 } }) }, 'JEV_MALFORMED_RESPONSE', true, 1],
];

for (const [name, opts, reason, networked, expectedCalls] of FAILURES) {
  test(`real Jev path failure → human, never auto-proceeds: ${name}`, async () => {
    const { gateway, meter, calls } = gatewayWith({ evaluateImpl: clearAnswers(), ...opts });
    const env = await gateway.decide(req());
    assertFailsTowardHuman(env);
    assert.equal(calls(), expectedCalls, 'pre-send gates never invoke the transport');
    const { row, jev } = jevAttempt(meter);
    assert.equal(jev.status, 'unavailable');
    assert.equal(jev.reason, reason);
    assert.equal(jev.networked, networked);
    assert.equal(row.fallback_occurred, true);
    assert.ok(!JSON.stringify(row).includes('test-key-not-real'));
  });
}

test('Gateway does not degrade what Jev receives (2026-09-26 Calibration §28): state.input equals the consumer input exactly (types kept, nothing dropped or renamed), input_notes / narrowed options / derived route reach the provider', async () => {
  const seen = [];
  const { gateway } = gatewayWith({
    evaluateImpl: async (args) => {
      seen.push(args);
      return {
        answers: {
          channel_status: { type: 'choice', choice: 'primary', probabilities: { primary: 0.95 } },
          content_channel_fit: { type: 'choice', choice: 'high', probabilities: { high: 0.95 } },
          human_review_required: { type: 'boolean', probability: 0.1 },
        },
        usage: { inputTokens: 1300, outputTokens: 90 },
        response: { modelId: 'typesafe-ai/jev' },
        providerMetadata: { typesafe: { confidence: { channel_status: 0.95, content_channel_fit: 0.93 } } },
      };
    },
  });
  const input = {
    content_id: 'cal-gw-1', source_type: 'dev-log', content_type: 'article', media_type: 'text', channel: 'note',
    channel_registered: true, channel_publication_state: 'not-published', title: 't', summary: 's', language: 'ja',
    paid_listing: false, human_channel_preference: 'none',
  };
  const env = await gateway.decide({ decision_type: 'channel-selection', application_id: 'claude-code', project_id: 'e-nexus-decision-layer', input }, { via: 'cli' });
  assert.equal(env.ok, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].state.input, input, 'consumer input reaches Jev unchanged');
  assert.equal(seen[0].state.input.channel_registered, true, 'boolean stays boolean');
  assert.match(seen[0].state.input_notes.channel, /note\.com/);
  assert.deepEqual(Object.keys(seen[0].questions).sort(), ['channel_status', 'content_channel_fit', 'human_review_required']);
  assert.deepEqual(Object.keys(seen[0].questions.channel_status.criteria), ['primary', 'secondary', 'not_recommended']);
  assert.equal(env.decision.outcome.recommended_route, 'channel-candidate-review', 'route derived from status');
  assert.equal(env.decision.resolved_by, 'jev');
  assert.equal(env.decision.tier, 'auto', 'human_review_required=false is escalation-only; other fields ≥ 0.85');
});
