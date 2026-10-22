/**
 * deploy/macos/rea.sh（2026-10-22・MA-22 S5）。版の固定・Trading Lab の領域の拒否・rea.sh が入れたもの以外は消さない・
 * agent の user 範囲の登録を WARN・登録は案内だけ（実行しない）。ネットワークに出る install の本体は test しない（引数の拒否まで）。
 * HOME は一時フォルダに差し替える（本物の ~/.claude.json を読まない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'macos', 'rea.sh');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

function rea(home, ...args) {
  // timeout：以前、値の無い引数で無限に回る不具合があった。test が止まらなくならないように打ち切る
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, timedOut: r.error?.code === 'ETIMEDOUT' };
}
function withHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'edl-rea-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test('install：版は x.y.z だけ・Trading Lab の領域と相対パスを拒否（ネットワークに出る前に止まる）', { skip: !hasSh }, () => withHome((home) => {
  assert.equal(rea(home, 'install', '--version', 'latest').code, 2);
  assert.equal(rea(home, 'install', '--version', '^6.7.0').code, 2);
  const tl = rea(home, 'install', '--version', '6.7.0', '--prefix', `${home}/Parallels/rea`);
  assert.equal(tl.code, 2);
  assert.match(tl.out, /Trading Lab/);
  assert.equal(rea(home, 'install', '--version', '6.7.0', '--prefix', 'rel/rea').code, 2);
  assert.ok(!existsSync(path.join(home, 'e-nexus-runtime')), '拒否した時は何も作らない');
}));

test('引数：値の無い引数はすぐ exit 2（無限に回らない）', { skip: !hasSh }, () => withHome((home) => {
  for (const args of [['install', '--version'], ['status', '--prefix'], ['register-hint', '--project'], ['uninstall', '--version']]) {
    const r = rea(home, ...args);
    assert.equal(r.timedOut, false, `${args.join(' ')} が止まらない`);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out, /needs a value/);
  }
}));

test('uninstall：rea.sh の印の無いフォルダは消さない', { skip: !hasSh }, () => withHome((home) => {
  const dir = path.join(home, 'e-nexus-runtime', 'tools', 'rea', '6.7.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'keep.txt'), 'x');
  const r = rea(home, 'uninstall', '--version', '6.7.0');
  assert.equal(r.code, 2);
  assert.ok(existsSync(path.join(dir, 'keep.txt')));
  writeFileSync(path.join(dir, '.edl-rea'), 'rea-agents@6.7.0');
  assert.equal(rea(home, 'uninstall', '--version', '6.7.0').code, 0);
  assert.ok(!existsSync(dir));
}));

test('status：Claude Code の user 範囲・user 範囲の skill の登録は WARN、local 範囲は INFO、値は表示しない', { skip: !hasSh }, () => withHome((home) => {
  assert.match(rea(home, 'status').out, /REA の登録なし/);
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { rea: { command: 'npx', env: { SECRET_TOKEN: 'do-not-print' } } }, projects: { '/x/rea-lab': { mcpServers: { rea: {} } } } }));
  const r = rea(home, 'status');
  assert.match(r.out, /WARN claude-code: user 範囲/);
  assert.match(r.out, /INFO claude-code: local 範囲/);
  assert.ok(!r.out.includes('do-not-print'));
  writeFileSync(path.join(home, '.claude.json'), '{}');
  mkdirSync(path.join(home, '.claude', 'skills', 'reverse-engineer-anything'), { recursive: true });
  assert.match(rea(home, 'status').out, /WARN claude-code: user 範囲の skill/);
}));

test('deny-settings：入れた版の効果の宣言から、外部コードの実行・ネットワーク・Frida 等を拒否する設定を出す', { skip: !hasSh }, () => withHome((home) => {
  const dir = path.join(home, 'e-nexus-runtime', 'tools', 'rea', 'current', 'node_modules', 'rea-agents', 'dist', 'contracts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'toolEffects.js'), `const e = (o = {}) => ({ executesForeignCode: false, mutatesTarget: false, mutatesDevice: false, changesUiState: false, mayDiscardData: false, accessesNetwork: false, launchesProcess: false, ...o });
export const TOOL_EFFECTS = { analyze_javascript_application: e({ launchesProcess: true }), inspect_macho: e(), extract_artifact: e({ launchesProcess: true, accessesNetwork: true }), run_target: e({ launchesProcess: true }), start_frida_session: e(), observe_web_execution: e({ accessesNetwork: true }), gdb_console: e({ executesForeignCode: true }) };\n`);
  const r = rea(home, 'deny-settings');
  assert.equal(r.code, 0, r.out);
  const deny = JSON.parse(r.out).permissions.deny;
  // run_target：名前に手がかりが無くても、process を起動すると宣言していれば拒否（新しい道具は既定で拒否）
  // analyze_javascript_application：解析の補助の process だけを起動する静的な道具（STATIC_HELPERS）は通す。ほかの効果があれば拒否（extract_artifact）
  assert.deepEqual(deny, ['mcp__rea__extract_artifact', 'mcp__rea__gdb_console', 'mcp__rea__observe_web_execution', 'mcp__rea__run_target', 'mcp__rea__start_frida_session']);
  rmSync(path.join(dir, 'toolEffects.js'));
  assert.equal(rea(home, 'deny-settings').code, 2, '効果の宣言が無ければ空の設定を出さない');
}));

test('register-hint：local 範囲の手順を表示するだけで、setup・user 範囲を使わない', { skip: !hasSh }, () => withHome((home) => {
  const r = rea(home, 'register-hint', '--project', '/Users/x/rea-lab');
  assert.equal(r.code, 0);
  assert.match(r.out, /claude mcp add --scope local rea -- /);
  assert.ok(!/--scope (user|project)\b/.test(r.out));
  assert.ok(!existsSync(path.join(home, '.claude.json')), '設定に書かない');
}));
