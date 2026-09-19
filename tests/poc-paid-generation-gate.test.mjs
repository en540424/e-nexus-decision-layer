/**
 * PoC: 有料生成API直前の Decision Gate。
 * 期待される役割 = 「en-generate-hub の Human-only 承認フローへ持ち込む前の事前トリアージ」。
 * en-generate-hub 側のコード・承認・予算・台帳には一切触れない（このrepo内で完結）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, gateRequest } from './helpers.mjs';

const ROUTES = ['local', 'remotion', 'en-generate-hub', 'human-review'];

test('text-only assets (subtitle / kinetic typography / slideshow) resolve to Remotion by rule, auto tier', async () => {
  const { engine } = makeEngine();
  for (const asset_kind of ['subtitle', 'kinetic-typography', 'slideshow']) {
    const r = await engine.decide(gateRequest({ asset_kind, purpose: 'jp explainer', language: 'ja' }));
    assert.equal(r.resolved_by, 'rules', asset_kind);
    assert.equal(r.outcome.paid_generation_required, false);
    assert.equal(r.outcome.recommended_route, 'remotion');
    assert.equal(r.tier, 'auto');
  }
});

test('photoreal scene → paid_generation_required=true AND human_review_required=true → tier human', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'scene', purpose: 'product hero', style: 'photoreal', duration_sec: 6 }));
  assert.equal(r.resolved_by, 'mock-jev');
  assert.equal(r.outcome.paid_generation_required, true);
  assert.equal(r.outcome.human_review_required, true);
  assert.equal(r.outcome.recommended_route, 'en-generate-hub');
  assert.equal(r.tier, 'human', 'paid generation can never be auto-tier');
});

test('estimated cost >= $5 is always human by deterministic rule regardless of asset kind', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'b-roll', purpose: 'x', estimated_paid_cost_usd_micros: 5_000_000 }));
  assert.equal(r.resolved_by, 'rules');
  assert.equal(r.tier, 'human');
  assert.equal(r.outcome.recommended_route, 'en-generate-hub');
});

test('ambiguous request (no style, no assets) → low confidence → escalates to human review', async () => {
  const { engine } = makeEngine();
  const r = await engine.decide(gateRequest({ asset_kind: 'b-roll', purpose: 'filler' }));
  assert.equal(r.tier, 'human');
  assert.ok(['mock-jev', 'human'].includes(r.resolved_by));
});

test('outcome never contains an approval; paid route always implies human gate required', async () => {
  const { engine } = makeEngine();
  const inputs = [
    { asset_kind: 'scene', purpose: 'a', style: 'cinematic', has_reference_media: true, duration_sec: 30 },
    { asset_kind: 'product-shot', purpose: 'b', style: 'photoreal' },
    { asset_kind: 'image', purpose: 'c', style: 'anime' },
    { asset_kind: 'talking-head', purpose: 'd', has_local_assets: true, style: 'flat' },
  ];
  for (const input of inputs) {
    const r = await engine.decide(gateRequest(input));
    assert.ok(ROUTES.includes(r.outcome.recommended_route ?? 'human-review') || r.outcome.escalated);
    assert.ok(!('approved' in r.outcome));
    if (r.outcome.paid_generation_required) assert.equal(r.human_gate.required, true);
  }
});
