/**
 * deploy/macos/rea.sh（2026-10-22・MA-22 S5）。版の固定・Trading Lab の領域の拒否・rea.sh が入れたもの以外は消さない・
 * agent の user 範囲の登録を WARN・登録は案内だけ（実行しない）。ネットワークに出る install の本体は test しない（引数の拒否まで）。
 * HOME は一時フォルダに差し替える（本物の ~/.claude.json を読まない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
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
  // rea.sh は POSIX の絶対パスだけを受け付ける。Windows（Git Bash）では一時フォルダの C:\… を /c/… に直して渡す（2026-10-22）
  const shHome = process.platform === 'win32' ? home.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : home;
  const tl = rea(home, 'install', '--version', '6.7.0', '--prefix', `${shHome}/Parallels/rea`);
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
  // register-hint の形（env -i・sandbox-exec・WORKSPACE=<フォルダ>/work）と、そのフォルダの拒否リスト（2026-10-26）
  const lab = path.join(home, 'rea-lab');
  mkdirSync(path.join(lab, '.claude'), { recursive: true });
  writeFileSync(path.join(lab, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['mcp__rea__start_frida_session'] } }));
  const sandboxed = { command: '/usr/bin/env', args: ['-i', 'PATH=/usr/bin', '/usr/sbin/taskpolicy', '-b', '/usr/bin/sandbox-exec', '-f', '/x/rea-mcp.sb', '-D', `WORKSPACE=${lab}/work`, '/x/rea', 'mcp'] };
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { rea: { command: 'npx', env: { SECRET_TOKEN: 'do-not-print' } } }, projects: { [lab]: { mcpServers: { rea: sandboxed } } } }));
  const r = rea(home, 'status');
  assert.match(r.out, /WARN claude-code: user 範囲/);
  assert.match(r.out, /INFO claude-code: local 範囲の登録（1 project・sandbox あり）/);
  assert.ok(!/WARN claude-code: (local|登録した)/.test(r.out), r.out);
  assert.ok(!r.out.includes('do-not-print'));
  // 入っている版の REA から作った拒否リストと違えば WARN（REA を更新して作り直していない）
  const eff = path.join(home, 'e-nexus-runtime', 'tools', 'rea', 'current', 'node_modules', 'rea-agents', 'dist', 'contracts');
  mkdirSync(eff, { recursive: true });
  writeFileSync(path.join(eff, 'toolEffects.js'), 'export const TOOL_EFFECTS = { start_frida_session: { launchesProcess: true }, run_new_tool: { launchesProcess: true } };\n');
  assert.match(rea(home, 'status').out, /WARN claude-code: 登録したフォルダの拒否リストが、入っている版の REA から作った物と違う/);
  rmSync(path.join(home, 'e-nexus-runtime'), { recursive: true, force: true });
  // 形が違う（WORKSPACE がフォルダそのもの＝.claude に書ける）
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [lab]: { mcpServers: { rea: { ...sandboxed, args: sandboxed.args.map((a) => a.startsWith('WORKSPACE=') ? `WORKSPACE=${lab}` : a) } } } } }));
  assert.match(rea(home, 'status').out, /WARN claude-code: local 範囲の登録の形が register-hint と違う/);
  // local 範囲でも sandbox-exec を通らない登録は WARN（2026-10-26）
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/x/rea-lab': { mcpServers: { rea: { command: '/x/rea', args: ['mcp'] } } } } }));
  assert.match(rea(home, 'status').out, /WARN claude-code: local 範囲の登録が sandbox-exec を通っていない/);
  writeFileSync(path.join(home, '.claude.json'), '{}');
  mkdirSync(path.join(home, '.claude', 'skills', 'reverse-engineer-anything'), { recursive: true });
  assert.match(rea(home, 'status').out, /WARN claude-code: user 範囲の skill/);
}));

test('deny-settings：入れた版の効果の宣言から、外部コードの実行・ネットワーク・Frida 等を拒否する設定を出す', { skip: !hasSh }, () => withHome((home) => {
  const dir = path.join(home, 'e-nexus-runtime', 'tools', 'rea', 'current', 'node_modules', 'rea-agents', 'dist', 'contracts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'toolEffects.js'), `const e = (o = {}) => ({ executesForeignCode: false, mutatesTarget: false, mutatesDevice: false, changesUiState: false, mayDiscardData: false, accessesNetwork: false, launchesProcess: false, ...o });
export const TOOL_EFFECTS = { open_binary: e({ launchesProcess: true }), analyze_javascript_application: e({ launchesProcess: true }), inspect_macho: e(), extract_artifact: e({ launchesProcess: true, accessesNetwork: true }), run_target: e({ launchesProcess: true }), start_frida_session: e(), observe_web_execution: e({ accessesNetwork: true }), gdb_console: e({ executesForeignCode: true }) };\n`);
  const r = rea(home, 'deny-settings');
  assert.equal(r.code, 0, r.out);
  const deny = JSON.parse(r.out).permissions.deny;
  // run_target：名前に手がかりが無くても、process を起動すると宣言していれば拒否（新しい道具は既定で拒否）
  // open_binary・analyze_javascript_application：解析の補助の process だけを起動する静的な道具（STATIC_HELPERS）は通す。ほかの効果があれば拒否（extract_artifact）
  assert.deepEqual(deny, ['mcp__rea__extract_artifact', 'mcp__rea__gdb_console', 'mcp__rea__observe_web_execution', 'mcp__rea__run_target', 'mcp__rea__start_frida_session']);
  rmSync(path.join(dir, 'toolEffects.js'));
  assert.equal(rea(home, 'deny-settings').code, 2, '効果の宣言が無ければ空の設定を出さない');
}));

test('register-hint：local 範囲の手順を表示するだけで、setup・user 範囲を使わない', { skip: !hasSh }, () => withHome((home) => {
  const r = rea(home, 'register-hint', '--project', '/Users/x/rea-lab');
  assert.equal(r.code, 0);
  // REA は空の env・専用の TMPDIR・background の優先度・sandbox の中（profile は prefix へ写した物・WORKSPACE は専用フォルダの work）（2026-10-26）
  assert.match(r.out, /claude mcp add --scope local rea -- \/usr\/bin\/env -i PATH="[^"]+" HOME="[^"]+" TMPDIR="\/Users\/x\/rea-lab\/tmp" \/usr\/sbin\/taskpolicy -b \/usr\/bin\/sandbox-exec -f "[^"]*\/tools\/rea\/rea-mcp\.sb" -D LAB="\/Users\/x\/rea-lab" .*-D WORKSPACE="\/Users\/x\/rea-lab\/work" .*-D TMP="\/Users\/x\/rea-lab\/tmp" -D DARWIN_CACHE="[^"]+" "[^"]*\/current\/node_modules\/\.bin\/rea" mcp$/m);
  assert.ok(!/--scope (user|project)\b/.test(r.out));
  assert.ok(!existsSync(path.join(home, '.claude.json')), '設定に書かない');
}));

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

test('lab-prepare：専用フォルダ（700）・拒否リスト・sandbox の profile を用意し、登録はしない。Vault・git の作業ツリー・既存の設定は避ける（2026-10-26）', { skip: !hasSh || !isMac }, () => withHome((home) => {
  const prefix = path.join(home, 'e-nexus-runtime', 'tools', 'rea');
  const dir = path.join(prefix, 'current', 'node_modules', 'rea-agents', 'dist', 'contracts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'toolEffects.js'), 'export const TOOL_EFFECTS = { inspect_macho: { launchesProcess: false }, start_frida_session: { launchesProcess: true } };\n');
  const lab = path.join(home, 'e-nexus-runtime', 'rea-lab');
  const r = rea(home, 'lab-prepare', '--project', lab);
  assert.equal(r.code, 0, r.out);
  for (const d of [lab, path.join(lab, 'work'), path.join(lab, 'tmp')]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  assert.deepEqual(JSON.parse(readFileSync(path.join(lab, '.claude', 'settings.json'), 'utf8')).permissions.deny, ['mcp__rea__start_frida_session']);
  assert.match(readFileSync(path.join(prefix, 'rea-mcp.sb'), 'utf8'), /\(deny network\*\)/);
  assert.ok(!existsSync(path.join(home, '.claude.json')), '登録しない');
  // 既にある設定は上書きしない
  writeFileSync(path.join(lab, '.claude', 'settings.json'), '{"keep":true}');
  assert.equal(rea(home, 'lab-prepare', '--project', lab).code, 0);
  assert.equal(readFileSync(path.join(lab, '.claude', 'settings.json'), 'utf8'), '{"keep":true}');
  // Vault・git の作業ツリーの中は拒否
  assert.equal(rea(home, 'lab-prepare', '--project', path.join(home, 'Obsidian', 'EN-Knowledge-Vault', 'rea')).code, 2);
  const repo = path.join(home, 'repo');
  mkdirSync(repo);
  if (spawnSync('git', ['init', '-q', repo], { timeout: 10_000 }).status === 0) {
    const g = rea(home, 'lab-prepare', '--project', path.join(repo, 'rea-lab'));
    assert.equal(g.code, 2);
    assert.match(g.out, /git の作業ツリー/);
  }
}));

test('rea-mcp.sb：sandbox の中では利用者のデータ（ホーム・一時フォルダ）と外向きの通信を拒否し、work・tmp だけ読み書きできる（2026-10-26・独立監査 B1・S1・S4）', { skip: !isMac }, () => withHome((home) => {
  // home は /private/var/folders の下（os.tmpdir）＝ profile が既定で読ませない場所。work・tmp だけを param で戻す
  const real = realpathSync(home);
  const lab = path.join(real, 'rea-lab'); const work = path.join(lab, 'work'); const tmp = path.join(lab, 'tmp'); const other = path.join(real, 'other-project');
  for (const d of [work, tmp, path.join(lab, '.claude'), other]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(work, 'a.txt'), 'ok'); writeFileSync(path.join(other, 'b.txt'), 'no');
  writeFileSync(path.join(work, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const profile = path.join(path.dirname(SCRIPT), 'rea-mcp.sb');
  const sb = (...cmd) => spawnSync('/usr/bin/sandbox-exec', ['-f', profile, '-D', `LAB=${lab}`, '-D', `REA_PREFIX=${path.join(real, 'prefix')}`, '-D', `WORKSPACE=${work}`,
    '-D', `REA_STATE=${path.join(real, 'state')}`, '-D', `TMP=${tmp}`, '-D', `DARWIN_CACHE=${path.join(real, 'cache')}`, ...cmd], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(sb('/bin/cat', path.join(work, 'a.txt')).stdout, 'ok');
  assert.notEqual(sb('/bin/cat', path.join(other, 'b.txt')).status, 0, '一時フォルダの下の別の project は読めない');
  assert.notEqual(sb('/bin/ls', '/Users').status, 0, '全ユーザーのホームは中身を読めない');
  assert.equal(sb('/bin/ls', lab).status, 0, '専用フォルダそのものは一覧できる（Claude Code は MCP の server をそこを cwd にして起動する）');
  writeFileSync(path.join(lab, '.claude', 'settings.json'), '{}');
  assert.notEqual(sb('/bin/cat', path.join(lab, '.claude', 'settings.json')).status, 0, '専用フォルダの .claude の中身は読めない');
  assert.equal(sb('/usr/bin/touch', path.join(work, 'w')).status, 0);
  assert.equal(sb('/usr/bin/touch', path.join(tmp, 'w')).status, 0);
  assert.notEqual(sb('/usr/bin/touch', path.join(lab, '.claude', 'settings.local.json')).status, 0, '拒否リスト・hook の場所へは書けない');
  assert.notEqual(sb('/usr/bin/touch', path.join(real, 'w')).status, 0, 'work・tmp の外へは書けない');
  const net = sb(process.execPath, '-e', 'require("net").createServer().listen(0,"127.0.0.1",()=>process.exit(0)).on("error",()=>process.exit(7))');
  assert.equal(net.status, 7, 'bind も拒否');
  for (const bin of ['/usr/bin/osascript', '/usr/bin/hdiutil', '/usr/bin/security', '/bin/launchctl', '/usr/bin/java', path.join(work, 'run.sh')]) {
    assert.match(sb(bin, 'help').stderr, /execvp\(\) of .* failed: Operation not permitted/, `${bin} は起動しない`);
  }
  assert.equal(sb('/bin/ps', '-o', 'pid=', '-p', String(process.pid)).status, 0, 'REA の後片付けの確認に要る ps は動く');
}));
