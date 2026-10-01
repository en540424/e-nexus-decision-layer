import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, resolveCandidates, resolveProject, checkRegistries, getEntry } from '../src/registries/registry.mjs';
import { RegistryError } from '../src/core/errors.mjs';

test('registries are internally consistent (no duplicate ids, scopes point to projects)', () => {
  assert.deepEqual(checkRegistries(), []);
});

test('resolveCandidates returns global + project scope only', () => {
  const trc = resolveCandidates('skills', { projectId: 'travel-rate-camera' });
  const gh = resolveCandidates('skills', { projectId: 'en-generate-hub' });
  assert.ok(gh.some((s) => s.id === 'en-generate'), 'en-generate-hub sees its own skills');
  assert.ok(!trc.some((s) => s.id === 'en-generate'), 'travel-rate-camera does not see en-generate-hub skills');
  assert.ok(trc.some((s) => s.id === 'common-dev-log'), 'global skills visible everywhere');
});

test('resolveCandidates filters by tags', () => {
  const noteSkills = resolveCandidates('skills', { projectId: 'openmontage', tags: ['note'] });
  assert.ok(noteSkills.length >= 4);
  assert.ok(noteSkills.every((s) => s.tags.includes('note')));
});

test('resolveProject accepts aliases', () => {
  assert.equal(resolveProject('MA-17').id, 'en-generate-hub');
  assert.equal(resolveProject('旅レートカメラ').id, 'travel-rate-camera');
  assert.throws(() => resolveProject('en-volt'), RegistryError);
});

test('models registry: fable is selectable by work center (reading-comparison-audit), not a fixed default', () => {
  // 2026-10-01 整合修正：Vault Advisor正本§0-2（旧「Human 指定時のみ」を廃止）。課金は§0-6
  const fable = getEntry('models', 'fable');
  assert.equal(fable.auto_selectable, true);
  assert.deepEqual(fable.work_center, ['reading-comparison-audit']);
  assert.equal(fable.role, 'executor');
  assert.ok(loadRegistry('models').some((m) => m.id === 'jev' && m.role === 'decision-engine'));
});

test('agents／models の静的能力タグ：宣言済みの語だけ・点数を持たない（Vault 構想正本 MA-32 §4-3・MA-32-2）', async () => {
  const { readJson } = await import('../src/schemas/loader.mjs');
  for (const kind of ['agents', 'models']) {
    const doc = readJson(`registries/${kind}.json`);
    const tags = new Set(doc.capability_tags);
    assert.ok(tags.size > 0, `${kind}: capability_tags`);
    for (const t of tags) assert.match(t, /^[a-z][a-z0-9-]*$/, `${kind}: ${t}`);
    for (const e of doc.entries) {
      assert.ok(Array.isArray(e.capabilities) && e.capabilities.length > 0, `${kind}/${e.id}: capabilities`);
      for (const t of e.capabilities) assert.ok(tags.has(t), `${kind}/${e.id}: 未宣言のタグ ${t}`);
      for (const k of Object.keys(e)) assert.ok(!/score|rating|success_rate|latency|availability/i.test(k), `${kind}/${e.id}: 実測・点数は Knowledge Layer 側（${k}）`);
    }
  }
});

test('unknown registry kind throws', () => {
  assert.throws(() => loadRegistry('widgets'), RegistryError);
});
