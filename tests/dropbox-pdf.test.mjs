import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUSINESS_HANDLERS } from '../scripts/lib/task-hub/business-handlers.mjs';
import { loadCatalog } from '../scripts/lib/task-hub/policy.mjs';

test('PDF search scopes candidates and stages only the locally approved revision', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dropbox-pdf-'));
  try {
    const root = '/documents';
    const selected = `${root}/example.pdf`;
    const bytes = Buffer.from('%PDF-1.7\nfixture');
    let downloads = 0;
    const reader = {
      search: async (query, options) => {
        assert.equal(query, 'example');
        assert.equal(options.path, root);
        assert.equal(options.filenameOnly, true);
        return [
          { path: selected, rev: 'rev1', size: bytes.length },
          { path: `${root}/restricted/secret.pdf` },
          { path: '/outside/example.pdf' },
          { path: `${root}/example.xlsx` },
        ];
      },
      metadata: async (file) => ({ path: file, tag: 'file' }),
      download: async (file) => {
        assert.equal(file, selected);
        downloads++;
        return { bytes, meta: { path: selected, rev: 'rev1' } };
      },
    };
    const config = {
      dropbox: { businesses: { 'biz-a': { read_only: true, pdf_roots: [root], deny_roots: [`${root}/restricted`], output_root: '/output' } } },
      services: { backupDir: dir, dropbox: (role) => {
        assert.equal(role, 'read');
        return reader;
      } },
    };
    const local = { source: 'human-cli', business: 'biz-a', task_id: 'test-task-0001' };
    const run = (intent, params, task = local) => BUSINESS_HANDLERS[intent].run({ config, task: { ...task, params } });
    const found = await run('dropbox.pdf.search', { path: root, query: 'example' });
    assert.deepEqual(found.result.candidates.map((item) => item.path), [selected]);
    assert.equal(found.result.selection_required, true);
    assert.equal(loadCatalog().intents['dropbox.pdf.fetch'].class, 'human_required');
    await assert.rejects(run('dropbox.pdf.fetch', { path: selected, rev: 'rev1' }, { ...local, source: 'bot-front' }), { code: 'dropbox_pdf_local_only' });
    await assert.rejects(run('dropbox.pdf.fetch', { path: `${root}/restricted/secret.pdf`, rev: 'rev1' }), { code: 'dropbox_path_not_allowed' });
    assert.equal(downloads, 0);
    await assert.rejects(run('dropbox.pdf.fetch', { path: selected, rev: 'previous' }), { code: 'dropbox_pdf_revision_changed' });
    const params = { path: selected, rev: 'rev1' };
    const fetched = await run('dropbox.pdf.fetch', params);
    assert.deepEqual(await run('dropbox.pdf.fetch', params), fetched);
    assert.deepEqual(readFileSync(path.join(dir, 'biz-a', 'pdf-staging', fetched.result.local_ref)), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
