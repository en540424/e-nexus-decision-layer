/**
 * policies/gateway/engine-env.json（consumer が Gateway 子 process へ渡してよい env 名）の検査（2026-09-26）。
 * engine が読む env 名はこのファイルが唯一の一覧で、consumer は Jev 固有の名前を持たない（docs/gateway.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readJson } from '../src/schemas/loader.mjs';
import { JEV_ENV } from '../src/adapters/jev/jev-adapter.mjs';
import { ROOT } from '../src/core/paths.mjs';

const manifest = readJson('policies/gateway/engine-env.json');
const covered = (name) => manifest.forward.prefixes.some((p) => name.startsWith(p)) || manifest.forward.names.includes(name);

function srcFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.mjs') ? [p] : [];
  });
}

test('engine-env manifest: shape is names only (no values), upper-snake names, prefixes end with "_"', () => {
  assert.equal(manifest.contract_version, '1');
  assert.deepEqual(Object.keys(manifest.forward).sort(), ['names', 'prefixes']);
  for (const p of manifest.forward.prefixes) assert.match(p, /^[A-Z][A-Z0-9]*_$/);
  for (const n of manifest.forward.names) assert.match(n, /^[A-Z][A-Z0-9_]*$/);
  assert.equal(new Set(manifest.forward.names).size, manifest.forward.names.length);
});

test('engine-env manifest covers every env name the engine source reads (so consumers never need engine-specific names)', () => {
  const read = new Set(Object.values(JEV_ENV));
  for (const f of srcFiles(path.join(ROOT, 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
  }
  const missing = [...read].filter((n) => !covered(n));
  assert.deepEqual(missing, [], `add to policies/gateway/engine-env.json: ${missing.join(', ')}`);
});

test('engine-env manifest never lists consumer-side generation secrets', () => {
  for (const n of ['FAL_KEY', 'FAL_API_KEY', 'WAVESPEED_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(covered(n), false, n);
});
