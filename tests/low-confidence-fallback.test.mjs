/**
 * 低confidence fallback監査（2026-09-19、Vercel経由Jev実疎通後）。
 *
 * 実疎通で観測した欠陥：実Jevが正常応答（confidence≈0.08、tier=human）したのに、本番既定chainの直後にいる
 * mock-jev のヒューリスティック（0.88）が chosen になり、最終 resolved_by/provider/usage が実呼び出しを表さなかった。
 * 修正は core（fallback/engine）ではなく chain 構成（src/index.mjs defaultAdapters）：実Jev経路が使えるときは
 * mock-jev を chain に入れない。fallback.mjs の「ok だが human 相当なら次へ」という継続設計自体は維持する。
 * 実ネットワークは一切使わない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAdapters, realJevUsable } from '../src/index.mjs';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { createMockJevAdapter } from '../src/adapters/jev/mock-jev-adapter.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

const PHOTOREAL = { asset_kind: 'scene', purpose: 'promo teaser', style: 'photoreal', duration_sec: 8 };
const OUTCOME = { local_sufficient: false, remotion_suitable: false, paid_generation_required: true, human_review_required: false, recommended_route: 'en-generate-hub' };

/** 実Providerを模した Jev：常に ok、confidence は指定値 */
function fakeRealJev(confidence, outcome = OUTCOME) {
  return {
    id: 'jev', kind: 'probabilistic', provider: 'typesafe-ai', model: 'jev',
    supports: () => true,
    async decide() { return { outcome, confidence, rationale: 'fake real jev', usage: { input_tokens: 300, output_tokens: 20, estimated_cost_usd_micros: 12 } }; },
  };
}

// ---- chain 構成（mock の役割） ----

test('realJevUsable: true only when the resolved provider has its key AND the network gate is open', () => {
  assert.equal(realJevUsable({}), false);
  assert.equal(realJevUsable({ JEV_API_KEY: 'k' }), false, 'key without network gate');
  assert.equal(realJevUsable({ EDL_ALLOW_NETWORK: 'true' }), false, 'network gate without key');
  assert.equal(realJevUsable({ JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }), true, 'direct');
  assert.equal(realJevUsable({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }), true, 'vercel');
  assert.equal(realJevUsable({ JEV_PROVIDER: 'vercel', JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }), false, 'vercel needs AI_GATEWAY_API_KEY, not JEV_API_KEY');
  assert.equal(realJevUsable({ JEV_PROVIDER: 'cloudflare', EDL_ALLOW_NETWORK: 'true' }), false, 'reserved route');
  assert.equal(realJevUsable({ JEV_PROVIDER: 'nope', EDL_ALLOW_NETWORK: 'true' }), false, 'unknown route never throws');
});

test('defaultAdapters: mock-jev is present only when the real Jev route is NOT usable (dev/test/no-key fallback role)', () => {
  const ids = (env) => defaultAdapters({ env }).map((a) => a.id);
  assert.deepEqual(ids({}), ['rules', 'jev', 'mock-jev', 'local', 'llm', 'human'], 'no key → mock stays (documented "works without API key")');
  assert.deepEqual(ids({ JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }), ['rules', 'jev', 'local', 'llm', 'human'], 'direct usable → no mock');
  assert.deepEqual(ids({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' }), ['rules', 'jev', 'local', 'llm', 'human'], 'vercel usable → no mock');
  assert.deepEqual(ids({ JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'false' }), ['rules', 'jev', 'mock-jev', 'local', 'llm', 'human'], 'network gate closed → mock stays');
});

test('defaultAdapters() with no argument reads process.env (the CLI never loads .env — keys must be exported in the shell)', () => {
  // realJevUsable() と jev adapter 本体は同じ env（既定 process.env）を見るので、
  // 「jev が実際に呼べる」ときだけ mock が外れ、キーがシェルに無ければ jev unavailable → mock が残る（整合）。
  const ids = defaultAdapters().map((a) => a.id);
  assert.ok(ids.includes('jev') && ids.includes('human'));
  assert.equal(ids.includes('mock-jev'), !realJevUsable(process.env));
});

// ---- 正常応答 + confidence（unavailable と混同しない） ----

test('real provider ok + high confidence → auto, resolved by the real provider', async () => {
  const { engine } = makeEngine({ adapters: [createRulesAdapter(), fakeRealJev(0.95), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.provider, 'typesafe-ai');
  assert.equal(r.tier, 'auto');
  assert.equal(r.fallback.trace.find((t) => t.adapter === 'jev').status, 'ok');
});

test('real provider ok + review confidence → review tier, chain stops at the real provider', async () => {
  const { engine } = makeEngine({ adapters: [createRulesAdapter(), fakeRealJev(0.7), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.tier, 'review');
  assert.equal(r.human_gate.required, false);
});

test('real provider ok + human confidence is recorded as status:ok (never "unavailable") and ends at human escalation, not at a mock', async () => {
  const { engine } = makeEngine({ adapters: [createRulesAdapter(), fakeRealJev(0.08), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  const jevTrace = r.fallback.trace.find((t) => t.adapter === 'jev');
  assert.equal(jevTrace.status, 'ok', 'a low-confidence answer is not a provider failure');
  assert.equal(jevTrace.tier, 'human');
  assert.equal(jevTrace.confidence, 0.08);
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.tier, 'human');
  assert.equal(r.human_gate.required, true);
  assert.equal(r.outcome.escalated, true);
});

test('regression: with the production default chain, a real low-confidence Jev answer is NOT superseded by mock-jev', async () => {
  // 実疎通で観測した状況を再現：photoreal 入力（mock ヒューリスティックなら 0.88）、実 Jev は 0.08
  const env = { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'true' };
  const adapters = defaultAdapters({ env }).map((a) => (a.id === 'jev' ? fakeRealJev(0.08) : a));
  const { engine } = makeEngine({ adapters });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.ok(!r.fallback.trace.some((t) => t.adapter === 'mock-jev'), 'mock-jev never runs when the real route is usable');
  assert.notEqual(r.provider, 'mock');
  assert.equal(r.tier, 'human');
});

test('mock role: when the real Jev route is unavailable (no key), mock-jev still answers (unchanged fallback behaviour)', async () => {
  const { engine } = makeEngine({ adapters: defaultAdapters({ env: {} }) });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.fallback.trace.find((t) => t.adapter === 'jev').status, 'unavailable');
  assert.equal(r.resolved_by, 'mock-jev');
});

test('auth / network / malformed failures from the real provider are "unavailable" and fall through to the next adapter', async () => {
  const cases = [
    { env: { JEV_API_KEY: 'k', EDL_ALLOW_NETWORK: 'false' }, reason: 'NETWORK_DISABLED' },
    { env: { EDL_ALLOW_NETWORK: 'true' }, reason: 'JEV_API_KEY_MISSING' },
  ];
  for (const c of cases) {
    const { engine } = makeEngine({ adapters: [createRulesAdapter(), createJevAdapter({ env: c.env }), createMockJevAdapter(), createHumanAdapter()] });
    const r = await engine.decide(gateRequest(PHOTOREAL));
    const t = r.fallback.trace.find((x) => x.adapter === 'jev');
    assert.equal(t.status, 'unavailable');
    assert.equal(t.reason, c.reason);
    assert.equal(r.resolved_by, 'mock-jev');
  }
  const malformed = { id: 'jev', kind: 'probabilistic', provider: 'typesafe-ai', model: 'jev', supports: () => true, async decide() { return { outcome: {}, confidence: 5 }; } };
  const { engine } = makeEngine({ adapters: [createRulesAdapter(), malformed, createMockJevAdapter(), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.fallback.trace.find((x) => x.adapter === 'jev').status, 'unavailable');
  assert.equal(r.resolved_by, 'mock-jev');
});

// ---- Human Gate は変わらない ----

test('human gate: real provider ok + high confidence + human_review_required=true is still human, never auto', async () => {
  const { engine } = makeEngine({ adapters: [createRulesAdapter(), fakeRealJev(0.99, { ...OUTCOME, human_review_required: true }), createHumanAdapter()] });
  const r = await engine.decide(gateRequest(PHOTOREAL));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.tier, 'human');
  assert.equal(r.human_gate.reason, 'outcome.human_review_required=true');
});
