#!/usr/bin/env node
/**
 * GitHub の見張りの token の検収（2026-11-05・H3）。Human が connect-github-monitor.sh から実行する。合格した token だけが Keychain に残る。
 *
 *   node scripts/github-monitor-check.mjs --owner <owner> [--credential E-NEXUS/edl/github-monitor-token]
 *
 * 確かめること：fine-grained PAT か・6 repo を読めるか・書き込みができないか。token は表示しない。結果はコードだけ。
 * exit：0＝合格／1＝不合格／2＝引数
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCredential } from './lib/env-file.mjs';
import { GITHUB_OWNER, verifyMonitorToken } from './lib/github-guard.mjs';
import { defaultGuard } from './lib/runtime-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(argv) {
  const a = { credential: 'E-NEXUS/edl/github-monitor-token' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--owner', '--credential'].includes(argv[i]) || argv[i + 1] === undefined) { console.error(`unknown argument: ${argv[i]}`); return 2; }
    a[argv[i].slice(2)] = argv[i + 1];
  }
  if (!GITHUB_OWNER.test(a.owner ?? '')) { console.error('--owner is required'); return 2; }
  let r;
  try {
    r = await verifyMonitorToken({ token: await readCredential(a.credential), owner: a.owner, repos: defaultGuard(REPO).repos, now: new Date().toISOString() });
  } catch {
    r = { ok: false, code: 'CHECK_FAILED' };
  }
  console.log(JSON.stringify({ component: 'edl-github-monitor-check', ...r, expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null }));
  return r.ok ? 0 : 1;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
