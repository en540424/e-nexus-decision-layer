#!/usr/bin/env node
/**
 * Hermes の実読み取りの検証の手元の道具（2026-11-07・H4）。deploy/macos/hermes-read-check.sh から呼ばれる。API・Keychain・通信なし。
 *
 *   node scripts/hermes-read-check.mjs prepare --evidence <abs> --share <abs> [--brief <abs>] [--skip-guards]   写しと合成データと問いを作る
 *   node scripts/hermes-read-check.mjs grade --evidence <abs> --exit <n>                                       答えを採点して result.json を書く
 *
 * 証跡（--evidence・700）：brief.snapshot.json・fixture.json・prompt.txt・answer.txt・stderr.txt・usage.json・result.json。公開 repo に置かない。
 * exit：0＝合格（prepare は準備できた）／1＝不合格／2＝引数／3＝始められない（2 回目・書き換えの時間・要約を信じられない）
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRADING_LAB_PATH } from './host-health.mjs';
import { DEFAULT_MODEL } from './hermes-service.mjs';
import { READ_CHECK_SCHEMA, buildFixture, gradeReadCheck, inRewriteWindow, promptOf } from './lib/hermes-read-check.mjs';
import { BRIEF_FILE, readBriefFile } from './lib/runtime-brief.mjs';
import { STATUS_DIR } from './lib/runtime-status-summary.mjs';

export const STARTED_MARK = 'started';

export function parse(argv) {
  const a = { command: argv[0], skipGuards: false };
  const map = { '--evidence': 'evidence', '--share': 'share', '--brief': 'brief', '--exit': 'exit' };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--skip-guards') a.skipGuards = true;
    else if (map[k] && argv[i + 1] !== undefined) {
      a[map[k]] = argv[i + 1];
      i += 1;
    } else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}
export function validate(a) {
  const errors = [];
  if (!['prepare', 'grade'].includes(a.command)) errors.push('command must be prepare|grade');
  for (const [k, v] of [['--evidence', a.evidence], ['--share', a.share], ['--brief', a.brief]]) {
    if (v === undefined) continue;
    if (!path.isAbsolute(v) || v.split('/').includes('..')) errors.push(`${k} must be an absolute path without ..`);
    else if (TRADING_LAB_PATH.test(v)) errors.push(`${k}: Trading Lab の領域は使わない`);
  }
  if (!a.evidence) errors.push('--evidence is required');
  if (a.command === 'prepare' && !a.share) errors.push('--share is required');
  if (a.command === 'grade' && !/^\d{1,3}$/.test(a.exit ?? '')) errors.push('--exit must be a number');
  return errors;
}

/** 始めてよいかを確かめて、読む物を置く。問いの文は証跡に、合成データは Hermes が読める共有へ */
export function prepare({ evidence, share, briefFile = path.join(STATUS_DIR, BRIEF_FILE), skipGuards = false, now = new Date() }) {
  if (existsSync(path.join(evidence, STARTED_MARK))) return { code: 3, reason: 'already_ran' };
  if (!skipGuards && inRewriteWindow(now)) return { code: 3, reason: 'rewrite_window' };
  const r = readBriefFile(briefFile, { now });
  if (!r.ok) return { code: 3, reason: `brief_${r.reason}` };
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  chmodSync(evidence, 0o700);
  mkdirSync(share, { recursive: true, mode: 0o750 });
  chmodSync(share, 0o750);
  const fixture = buildFixture(now);
  const fixtureFile = path.join(share, 'fixture.json');
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(fixtureFile, json, { mode: 0o640 });
  writeFileSync(path.join(evidence, 'fixture.json'), json, { mode: 0o600 });
  writeFileSync(path.join(evidence, 'brief.snapshot.json'), `${JSON.stringify(r.brief, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(evidence, 'prompt.txt'), promptOf({ statusDir: path.dirname(briefFile), fixtureFile }), { mode: 0o600 });
  return { code: 0, reason: 'ready' };
}

const readOr = (file, fallback) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};
const jsonOr = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function grade({ evidence, exitCode, now = new Date() }) {
  const brief = jsonOr(path.join(evidence, 'brief.snapshot.json'));
  const fixture = jsonOr(path.join(evidence, 'fixture.json'));
  if (!brief || !fixture) return { schema: READ_CHECK_SCHEMA, verdict: 'fail', failed: ['evidence_missing'], checks: [], usage: null };
  const result = gradeReadCheck({ answer: readOr(path.join(evidence, 'answer.txt'), ''), stderr: readOr(path.join(evidence, 'stderr.txt'), ''), brief, fixture, usage: jsonOr(path.join(evidence, 'usage.json')), exitCode, expectedModel: DEFAULT_MODEL });
  const body = { ...result, graded_at: now.toISOString(), started_at: readOr(path.join(evidence, STARTED_MARK), '').trim() || null, finished_at: readOr(path.join(evidence, 'finished'), '').trim() || null };
  writeFileSync(path.join(evidence, 'result.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return body;
}

function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validate(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  if (a.command === 'prepare') {
    const r = prepare({ evidence: a.evidence, share: a.share, briefFile: a.brief, skipGuards: a.skipGuards });
    console.log(JSON.stringify({ component: 'edl-hermes-read-check', ...r }));
    return r.code;
  }
  const r = grade({ evidence: a.evidence, exitCode: Number(a.exit) });
  console.log(JSON.stringify({ component: 'edl-hermes-read-check', verdict: r.verdict, failed: r.failed, usage: r.usage }, null, 2));
  return r.verdict === 'pass' ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
