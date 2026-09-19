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

test('models registry: fable is never auto-selectable', () => {
  assert.equal(getEntry('models', 'fable').auto_selectable, false);
  assert.ok(loadRegistry('models').some((m) => m.id === 'jev' && m.role === 'decision-engine'));
});

test('unknown registry kind throws', () => {
  assert.throws(() => loadRegistry('widgets'), RegistryError);
});
