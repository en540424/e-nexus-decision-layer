/**
 * Jev Adapter が到達経路（Provider）に固定されていないことを確認する。
 * 実ネットワーク送信は一切行わない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { assertJevProviderShape, resolveJevProvider, createCloudflareJevProvider, JEV_PROVIDER_IDS } from '../src/adapters/jev/jev-provider-interface.mjs';
import { AdapterUnavailableError } from '../src/core/errors.mjs';
import { loadDecisionType, readJson } from '../src/schemas/loader.mjs';
import { makeEngine } from './helpers.mjs';

test('provider interface: shape is enforced; three routes are named (direct/vercel implemented, cloudflare reserved)', () => {
  assert.deepEqual([...JEV_PROVIDER_IDS], ['direct', 'vercel', 'cloudflare']);
  assert.throws(() => assertJevProviderShape({ id: 'x' }), /available\(\) missing/);
  assert.equal(resolveJevProvider({}).id, 'direct', 'default route is direct');
  assert.equal(resolveJevProvider({ JEV_PROVIDER: 'vercel' }).id, 'vercel');
  assert.throws(() => resolveJevProvider({ JEV_PROVIDER: 'nope' }), (e) => e instanceof AdapterUnavailableError && e.details.route === 'nope');
});

test('reserved route (cloudflare) is unavailable, never sent', async () => {
  const p = createCloudflareJevProvider();
  assert.equal(p.available({ JEV_API_KEY: 'dummy' }).ok, false);
  await assert.rejects(() => p.send({ request: {} }), (e) => e.details.reason === 'JEV_ROUTE_NOT_IMPLEMENTED');
  const viaEnv = createJevAdapter({ env: { JEV_API_KEY: 'dummy', EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'cloudflare' } });
  assert.equal(viaEnv.route, 'cloudflare');
  await assert.rejects(() => viaEnv.decide({ decisionType: 'x' }), (e) => e.details.reason === 'JEV_ROUTE_NOT_IMPLEMENTED' && e.details.route === 'cloudflare');
});

test('a custom provider can be injected without touching the adapter or the engine', async () => {
  const calls = [];
  const fake = {
    id: 'fake-gateway',
    available: () => ({ ok: true }),
    // 応答は公式Jev形式（{model, answers, usage}）。2026-09-19確認済み仕様に合わせる（MA-30開発ログ参照）
    async send({ request }) {
      calls.push(request);
      return {
        model: 'jev-1.13.0',
        answers: {
          local_sufficient: { type: 'noul', noul: 0.05 },
          remotion_suitable: { type: 'noul', noul: 0.05 },
          paid_generation_required: { type: 'noul', noul: 0.95 },
          human_review_required: { type: 'noul', noul: 0.95 },
          recommended_route: {
            type: 'choice',
            choice: 'en-generate-hub',
            probabilities: { local: 0.01, remotion: 0.01, 'en-generate-hub': 0.9, 'human-review': 0.08 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 120, output_tokens: 20 },
      };
    },
  };
  const jev = createJevAdapter({ env: { EDL_ALLOW_NETWORK: 'true' }, provider: fake });
  assert.equal(jev.route, 'fake-gateway');
  const { engine } = makeEngine({ adapters: [jev, ...makeEngine().engine.adapters.filter((a) => a.id === 'human')], routingPolicy: { default_chain: ['jev', 'human'], overrides: {} } });
  const r = await engine.decide({ decision_type: 'paid-generation-gate', application_id: 'test', project_id: 'openmontage', input: { asset_kind: 'scene', purpose: 'x', style: 'photoreal' } });
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.provider, 'typesafe-ai');
  assert.equal(r.tier, 'human', 'human_review_required still forces human even via a real-looking provider');
  assert.equal(calls.length, 1);
  // request は公式Jev形式（{model, state, questions}）。task/candidates は state 配下（jev-adapter.mjs の変換結果）
  assert.equal(calls[0].model, 'jev-latest');
  assert.equal(calls[0].state.task, 'paid-generation-gate');
  assert.ok(Array.isArray(calls[0].state.candidates));
  assert.deepEqual(r.outcome, {
    local_sufficient: false, remotion_suitable: false, paid_generation_required: true,
    human_review_required: true, recommended_route: 'en-generate-hub',
  }, 'outcome carries only the typed business fields, no jev-specific shape (noul/choice/probabilities)');
});

test('reserved decision types exist by name only and cannot be decided', async () => {
  const idx = readJson('schemas/common/decision-types.json');
  // content-publish-gate は 2026-09-23 MA-31 G3 で実装済みへ移動（tests/content-publish-gate.test.mjs）
  for (const id of ['agent-action-micro', 'context-relevance', 'io-guard-assist', 'post-execution-verify', 'channel-selection', 'lead-triage', 'next-best-action', 'customer-reply-gate', 'automation-safety-gate']) {
    assert.ok(idx.reserved_decision_types[id], `${id} reserved`);
    assert.equal(loadDecisionType(id), null, `${id} has no schema yet`);
  }
  assert.ok(!idx.reserved_decision_types['content-publish-gate'], 'content-publish-gate is no longer reserved');
  assert.ok(idx.decision_types['content-publish-gate'], 'content-publish-gate is implemented');
  const { engine } = makeEngine();
  await assert.rejects(() => engine.decide({ decision_type: 'io-guard-assist', application_id: 'a', project_id: 'openmontage', input: {} }), (e) => e.code === 'UNKNOWN_DECISION_TYPE');
});

test('guard-assist release keys are forbidden outcome keys', () => {
  const safety = readJson('policies/safety/human-only.json');
  for (const k of ['safety_cleared', 'guard_released', 'unblock', 'release_block', 'allow_execution']) assert.ok(safety.forbidden_outcome_keys.includes(k), k);
});
