/**
 * 届く範囲の表（scripts/task-hub-exposure.mjs・2026-11-24）。作り物の config だけ・通信なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exposure, main } from '../scripts/task-hub-exposure.mjs';
import { validateConfig } from '../scripts/lib/task-hub/policy.mjs';

const FIVE = ['status.query', 'task.status', 'report.morning', 'note.record', 'hermes.task'];
const READS = ['dropbox.list', 'dropbox.search', 'schedule.read'];
const cfg = (over = {}) => validateConfig({
  businesses: ['biz-a', 'biz-b'],
  sources: { 'bot-x': { channels: ['chan-x'], businesses: ['biz-a', 'biz-b'], intents: [...FIVE, ...READS], business_intents: { 'biz-a': FIVE, 'biz-b': ['task.status', ...READS] }, ...over } },
  dropbox: { businesses: { 'biz-b': { read_only: true, read_roots: ['/業務/秘密の名前'], deny_names: ['安全書類'], output_root: '/biz-b' } } },
});
const row = (r, b) => r.rows.find((x) => x.business === b);

test('business ごとに無人で動きうる intent が分かれる・承認の要る物・Dropbox は件数だけ', () => {
  const r = exposure(cfg());
  assert.deepEqual(row(r, 'biz-a').classes.auto, ['report.morning', 'status.query', 'task.status']);
  assert.deepEqual(row(r, 'biz-a').classes.ai_check, ['note.record']);
  assert.ok(row(r, 'biz-a').classes.human_required.includes('hermes.task') && row(r, 'biz-a').classes.human_required.includes('dropbox.list'));
  assert.deepEqual(row(r, 'biz-b').classes.auto, ['dropbox.list', 'dropbox.search', 'schedule.read', 'task.status']);
  assert.ok(row(r, 'biz-b').classes.human_required.includes('note.record'), 'biz-b のメモは承認');
  assert.equal(row(r, 'biz-a').dropbox, null);
  assert.deepEqual(row(r, 'biz-b').dropbox, { read_only: true, read_roots: 1, schedule_files: 0, estimate_roots: 0, pdf_roots: 0, deny_roots: 0, deny_names: 1 });
  assert.ok(!JSON.stringify(r).includes('秘密の名前'), 'フォルダの名前は出さない');
});

test('business_intents が無ければ intents と businesses の掛け算（今の本番の形）', () => {
  const r = exposure(cfg({ business_intents: undefined }));
  assert.deepEqual(row(r, 'biz-a').classes.auto, row(r, 'biz-b').classes.auto);
  assert.ok(row(r, 'biz-a').classes.auto.includes('dropbox.list'));
});

test('CLI：--config・--source・--json と、読めない config は exit 2', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'exposure-'));
  try {
    const f = path.join(dir, 'c.json');
    writeFileSync(f, JSON.stringify(cfg()));
    const lines = [];
    assert.equal(main(['--config', f, '--source', 'bot-x', '--json'], { out: (x) => lines.push(x), err: () => {} }), 0);
    assert.equal(JSON.parse(lines[0]).rows.length, 2);
    writeFileSync(f, '{"sources":{}}');
    assert.equal(main(['--config', f], { out: () => {}, err: () => {} }), 2);
    assert.equal(main(['--nope'], { out: () => {}, err: () => {} }), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
