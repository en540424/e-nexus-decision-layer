#!/usr/bin/env node
/**
 * Gateway の pinned release（2026-09-29・FB-05）。deploy 先の checkout で Human が使う：
 *
 *   node scripts/gateway-release.mjs stamp [--allow-dirty]   HEAD の commit・package version を release.json へ書き、releases.jsonl に追記
 *   node scripts/gateway-release.mjs show                    今の release.json
 *   node scripts/gateway-release.mjs previous                rollback 先（releases.jsonl の、今と違う直前の commit）
 *
 * staging / production の `gateway serve` は release.json の commit が EDL_EXPECTED_RELEASE と一致しないと起動しない（serve-config.mjs）。
 * rollback は「previous の commit を checkout → stamp → env file の EDL_EXPECTED_RELEASE を合わせる → service 再起動」（Human-only。
 * docs/deploy-production-gateway.md）。このscriptは git を読むだけ（checkout・reset はしない）。release.json・releases.jsonl は gitignore。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release.json');
const LOG = path.join(ROOT, 'releases.jsonl');

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** releases.jsonl の行（新しい順ではなく追記順）→ 今の commit と違う直前の commit */
export function previousRelease(lines, currentCommit) {
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r.commit === 'string');
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].commit !== currentCommit) return rows[i];
  return null;
}

export function buildRelease({ commit, version, now = new Date() }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('commit must be a full 40-char sha');
  return { commit, version: version ?? null, stamped_at: now.toISOString() };
}

function main(argv) {
  const [sub] = argv;
  if (sub === 'stamp') {
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty && !argv.includes('--allow-dirty')) {
      console.error('作業ツリーに未commitの変更がある：pinned release にしない（dev の確認だけなら --allow-dirty）');
      return 2;
    }
    const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const release = buildRelease({ commit: git(['rev-parse', 'HEAD']), version });
    writeFileSync(RELEASE, `${JSON.stringify(release, null, 2)}\n`, 'utf8');
    appendFileSync(LOG, `${JSON.stringify(release)}\n`, 'utf8');
    console.log(JSON.stringify({ stamped: release, next: `env file の EDL_EXPECTED_RELEASE=${release.commit} にして service を再起動（Human）` }, null, 2));
    return 0;
  }
  if (sub === 'show') {
    console.log(existsSync(RELEASE) ? readFileSync(RELEASE, 'utf8').trim() : 'null');
    return existsSync(RELEASE) ? 0 : 1;
  }
  if (sub === 'previous') {
    const current = existsSync(RELEASE) ? JSON.parse(readFileSync(RELEASE, 'utf8')).commit : null;
    const prev = previousRelease(existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [], current);
    console.log(JSON.stringify({ current, rollback_to: prev }, null, 2));
    return prev ? 0 : 1;
  }
  console.error('usage: gateway-release.mjs <stamp [--allow-dirty] | show | previous>');
  return 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
