import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { ROOT } from '../core/paths.mjs';

const cache = new Map();

export function readJson(relPath) {
  const abs = isAbsolute(relPath) ? relPath : join(ROOT, relPath);
  if (!cache.has(abs)) {
    if (!existsSync(abs)) throw new Error(`file not found: ${relPath}`);
    cache.set(abs, JSON.parse(readFileSync(abs, 'utf8')));
  }
  return cache.get(abs);
}

export function clearCache() {
  cache.clear();
}

/** decision_type → schemas/<domain>/<name>.schema.json の対応は schemas/common/decision-types.json が持つ */
export function loadDecisionType(decisionType) {
  const index = readJson('schemas/common/decision-types.json');
  const entry = index.decision_types[decisionType];
  if (!entry) return null;
  return { id: decisionType, ...entry, schema: readJson(entry.schema) };
}

export function listDecisionTypes() {
  return readJson('schemas/common/decision-types.json').decision_types;
}
