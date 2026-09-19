import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USAGE_FIELDS, createFileMeter, summarize } from '../src/usage/metering.mjs';
import { makeEngine, gateRequest } from './helpers.mjs';

test('every decision writes one usage record with all required fields', async () => {
  const { engine, meter } = makeEngine();
  await engine.decide(gateRequest({ asset_kind: 'subtitle', purpose: 'x' }, { tenant: 'user-A' }));
  await engine.decide(gateRequest({ asset_kind: 'scene', purpose: 'x', style: 'photoreal' }, { tenant: 'user-A' }));
  const rows = meter.readAll();
  assert.equal(rows.length, 2);
  for (const r of rows) for (const f of USAGE_FIELDS) assert.ok(f in r, `field ${f}`);
  assert.equal(rows[0].resolved_by, 'rules');
  assert.equal(rows[0].fallback_occurred, false);
  assert.equal(rows[1].resolved_by, 'mock-jev');
  assert.equal(rows[1].fallback_occurred, true);
  assert.equal(rows[1].human_escalation, true);
  assert.ok(rows[1].input_tokens > 0);
});

test('summarize groups by tenant / provider for pricing analysis', async () => {
  const { engine, meter } = makeEngine();
  await engine.decide(gateRequest({ asset_kind: 'subtitle', purpose: 'x' }, { tenant: 'user-A' }));
  await engine.decide(gateRequest({ asset_kind: 'scene', purpose: 'x', style: 'photoreal' }, { tenant: 'user-B' }));
  const byTenant = summarize(meter.readAll(), 'tenant');
  assert.equal(byTenant['user-A'].requests, 1);
  assert.equal(byTenant['user-B'].by_provider.mock, 1);
  assert.equal(byTenant['user-B'].human_escalations, 1);
  const byProvider = summarize(meter.readAll(), 'provider');
  assert.ok('(none)' in byProvider && 'mock' in byProvider);
});

test('file meter appends JSONL and reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edl-'));
  const meter = createFileMeter({ path: join(dir, 'u.jsonl') });
  meter.record({ a: 1 });
  meter.record({ a: 2 });
  assert.deepEqual(meter.readAll(), [{ a: 1 }, { a: 2 }]);
  rmSync(dir, { recursive: true, force: true });
});
