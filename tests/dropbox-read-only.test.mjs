import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { businessCycle } from '../scripts/business-cycle.mjs';
import { loadScopes } from '../scripts/lib/dropbox/scope.mjs';
import { BUSINESS_HANDLERS } from '../scripts/lib/task-hub/business-handlers.mjs';

const dropbox = { businesses: { 'e-step': {
  read_only: true,
  read_roots: ['/sites'],
  schedule_files: ['/calendar.xlsx'],
  deny_roots: ['/sites/estimates'],
  deny_names: ['元請'],
  output_root: '/e-step',
} } };

test('read-only Dropbox allows scoped reads and blocks every other business handler before opening credentials', async () => {
  const config = {
    dropbox,
    services: {
      dropbox(role) {
        assert.equal(role, 'read');
        return { list: async (p) => {
          assert.equal(p, '/sites');
          return { entries: [
            { path: '/sites/active', name: 'active', tag: 'folder' },
            { path: '/sites/元　請', name: '元　請', tag: 'folder' },
            { path: '/sites/estimates', name: 'estimates', tag: 'folder' },
          ] };
        } };
      },
    },
  };
  const context = { config, task: { business: 'e-step', params: { path: '/sites' } } };
  const read = await BUSINESS_HANDLERS['dropbox.list'].run(context);
  assert.deepEqual(read.result.entries.map((item) => item.name), ['active']);
  for (const [intent, handler] of Object.entries(BUSINESS_HANDLERS)) {
    if (['dropbox.list', 'dropbox.search', 'schedule.read'].includes(intent)) continue;
    await assert.rejects(async () => handler.run(context), { code: 'dropbox_read_only' }, intent);
  }
  const invalid = structuredClone(dropbox);
  invalid.businesses['e-step'].read_only = 'true';
  assert.throws(() => loadScopes(invalid), { code: 'dropbox_config_invalid' });
});

test('read-only Dropbox schedules cannot trigger the weekly backup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dropbox-read-only-'));
  try {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ businesses: ['e-step'], sources: {}, dropbox }), { mode: 0o600 });
    const result = await businessCycle({ store: dir, services: () => assert.fail('backup touched services') });
    assert.equal(result.code, 'not_configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
