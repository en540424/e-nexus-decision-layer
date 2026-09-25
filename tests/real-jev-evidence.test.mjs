/**
 * scripts/real-jev-evidence.mjs — 「実 Jev を使った」の判定（attempts[] ベース）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRealJevAttempt, collectEvidence } from '../scripts/real-jev-evidence.mjs';

const realJev = { adapter: 'jev', status: 'ok', route: 'vercel', networked: true, input_tokens: 420, output_tokens: 12, confidence: 0.3, latency_ms: 900 };

test('isRealJevAttempt: networked ok jev on a real route with tokens; never mock / pre-send gates / zero-token', () => {
  assert.equal(isRealJevAttempt(realJev), true);
  assert.equal(isRealJevAttempt({ ...realJev, adapter: 'mock-jev' }), false);
  assert.equal(isRealJevAttempt({ ...realJev, route: 'mock' }), false);
  assert.equal(isRealJevAttempt({ ...realJev, route: null }), false);
  assert.equal(isRealJevAttempt({ ...realJev, networked: false }), false);
  assert.equal(isRealJevAttempt({ ...realJev, status: 'unavailable', reason: 'JEV_OVERLOADED' }), false);
  assert.equal(isRealJevAttempt({ ...realJev, input_tokens: 0 }), false);
});

test('collectEvidence: a real Jev call that still ends in human tier counts as evidence (resolved_by is not the criterion)', () => {
  const rows = [
    { timestamp: '2026-09-26T01:00:00Z', application_id: 'claude-code', via: 'cli', decision_type: 'channel-selection', resolved_by: 'human', tier: 'human', attempts: [{ adapter: 'rules', status: 'unavailable' }, realJev, { adapter: 'human', status: 'ok' }] },
    { timestamp: '2026-09-26T01:01:00Z', application_id: 'en-generate-hub', via: 'cli', decision_type: 'paid-generation-gate', resolved_by: 'human', tier: 'human', attempts: [{ adapter: 'jev', status: 'unavailable', reason: 'NETWORK_DISABLED', networked: false }] },
    { timestamp: '2026-09-25T01:00:00Z', application_id: 'claude-code', via: 'cli', decision_type: 'channel-selection', attempts: [realJev] },
  ];
  const groups = collectEvidence(rows, { since: '2026-09-26T00:00:00Z' });
  const cc = groups.find((g) => g.application_id === 'claude-code');
  assert.equal(cc.requests, 1, 'rows before --since are excluded');
  assert.equal(cc.real_jev, 1);
  assert.equal(cc.samples[0].jev_route, 'vercel');
  const eg = groups.find((g) => g.application_id === 'en-generate-hub');
  assert.equal(eg.real_jev, 0);
  assert.equal(eg.samples[0].jev_unavailable_reason, 'NETWORK_DISABLED');
});
