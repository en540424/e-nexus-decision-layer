#!/usr/bin/env node
/**
 * バックアップの棚卸し（2026-11-04・Mac Runtime）。READ-ONLY・ネットワークなし・macOS のみ。ファイルの中身は読まず、大きさと git の状態だけを見る。
 * Trading Lab の領域・Keychain・Hermes の home は対象にしない（repo に場所を書かず、結果は標準出力だけ。公開 repo へ貼らない）。
 *
 *   node scripts/backup-inventory.mjs
 *
 * protection：git＝GitHub に全部ある／git_unpushed＝差分あり／none＝保全先なし／regenerable＝作り直せる（backup しない）／secret＝backup しない（再発行）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRADING_LAB_PATH, makeRunner, parseDuBytes } from './host-health.mjs';
import { HERMES_SHARE, defaultGuard, parseGitStatus } from './lib/runtime-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** repo の外の資産。class：notes＝手で書いた記録／state＝実測と基準／config＝設定／memory＝AI の記憶 */
export function catalog({ base, home, repoRoot }) {
  const memoryDir = path.join(home, '.claude', 'projects', `${base.replaceAll('/', '-')}-e-nexus-decision-layer`, 'memory');
  return [
    { id: 'runtime_notes', class: 'notes', dir: base, topLevelOnly: true, protection: 'none' },
    { id: 'runtime_rules', class: 'config', dir: path.join(base, '.claude'), protection: 'none' },
    { id: 'mac_runtime_state', class: 'state', dir: path.join(base, 'mac-runtime-state'), protection: 'none' },
    { id: 'claude_memory', class: 'memory', dir: memoryDir, protection: 'none' },
    { id: 'relay_local', class: 'config', dir: path.join(home, '.enexus'), protection: 'none' },
    { id: 'host_health_records', class: 'state', dir: path.join(repoRoot, 'data', 'host-health'), protection: 'none' },
    { id: 'rea_install', class: 'tool', dir: path.join(base, 'tools'), protection: 'regenerable' },
    { id: 'hermes_vault_copy', class: 'copy', dir: HERMES_SHARE, protection: 'regenerable' },
  ].filter((t) => !TRADING_LAB_PATH.test(t.dir));
}

export async function inventory({ run, base, home, repoRoot, repos, exists = existsSync }) {
  const size = async (dir) => {
    const r = await run('/usr/bin/du', ['-sk', dir]);
    return r.code === 0 ? parseDuBytes(r.stdout) : null;
  };
  const rows = [];
  for (const name of repos) {
    const dir = path.join(base, name);
    if (!exists(path.join(dir, '.git'))) continue;
    const g = parseGitStatus(await run('/usr/bin/git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v2', '--branch']));
    rows.push({ id: `repo:${name}`, class: 'repo', bytes: await size(path.join(dir, '.git')), protection: g && !g.dirty && !g.ahead && g.upstream ? 'git' : 'git_unpushed' });
  }
  for (const t of catalog({ base, home, repoRoot })) {
    if (!exists(t.dir)) { rows.push({ id: t.id, class: t.class, bytes: null, protection: 'absent' }); continue; }
    rows.push({ id: t.id, class: t.class, bytes: t.topLevelOnly ? null : await size(t.dir), protection: t.protection });
  }
  rows.push({ id: 'keychain_secrets', class: 'secret', bytes: null, protection: 'secret' });
  return rows;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const g = defaultGuard(REPO);
  const run = makeRunner({ allowed: ['/usr/bin/du', '/usr/bin/git'], timeoutMs: 30_000 });
  inventory({ run, base: g.base, home: homedir(), repoRoot: REPO, repos: g.repos }).then((rows) => {
    console.log(JSON.stringify({ component: 'edl-backup-inventory', rows }, null, 2));
  });
}
