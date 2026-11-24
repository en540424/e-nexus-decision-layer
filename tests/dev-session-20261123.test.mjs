import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeSessions, devSessionsItem, forgetSession, listSessions, recoverPlan, SCREEN, screenEnv, screenName, startSession, stopSession, stripAnsi } from '../scripts/lib/dev-session.mjs';
import { parse } from '../scripts/dev-session.mjs';
import { safeValue } from '../scripts/host-health.mjs';
import { alertLine } from '../scripts/lib/alert-policy.mjs';

const hasScreen = process.platform === 'darwin' && existsSync(SCREEN);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function until(fn, ms = 10_000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; }
// 短い名前の保存先（screen の socket の path の長さの上限）
const freshRoot = () => realpathSync(mkdtempSync(path.join('/tmp', 'edl-ds-')));
const quitAll = (root) => { for (const n of ['a', 'b', 'dup', 'gone', 'term', 'stop']) spawnSync(SCREEN, ['-S', screenName(root, n), '-X', 'quit'], { env: screenEnv(root), timeout: 5000 }); };

test('parse：名前の形・-- の後の command・知らない引数', () => {
  assert.deepEqual(parse(['start', 'job-1', '--cwd', '/tmp', '--', 'npm', 'test']).cmd, ['npm', 'test']);
  assert.throws(() => parse(['start', 'Bad_Name', '--', 'x']), /name/);
  assert.throws(() => parse(['start', 'ok']), /needs --/);
  assert.throws(() => parse(['status', '--force']), /unknown/);
  assert.throws(() => parse(['rm', 'x']), /command/);
});

test('screenEnv：入れ子の Claude Code・Cursor の変数を子に渡さない・SCREENDIR を保存先に固定する', () => {
  const env = screenEnv('/r', { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', VSCODE_PID: '1', CURSOR_TRACE_ID: 'x', TERM_PROGRAM: 'vscode', STY: 'old', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', SCREENDIR: '/r/.screen' });
});

test('screenName：保存先ごとに別の名前（試験と本番がぶつからない）', () => {
  assert.notEqual(screenName('/a', 'x'), screenName('/b', 'x'));
  assert.match(screenName('/a', 'x'), /^edl[0-9a-f]{6}-x$/);
});

test('stripAnsi：色・カーソル移動・OSC・CR の上書きを除く', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07ok\x1b[2K\rdone\n'), 'red\ndone\n');
});

test('claudeSessions：--bg の session のうち許した場所の下だけ（対話の session・Trading Lab の場所は出さない）', () => {
  const rows = [
    { id: 'aaaa1111', kind: 'background', cwd: '/home/u/e-nexus-runtime/x', status: 'working', startedAt: 0 },
    { id: 'bbbb2222', kind: 'background', cwd: '/home/u/ai-trading-lab-runtime', status: 'working' },
    { id: 'cccc3333', kind: 'interactive', cwd: '/home/u/e-nexus-runtime/x', status: 'busy' },
    { id: 'dddd4444', kind: 'background', cwd: '/home/u/e-nexus-runtime-evil', status: 'idle' },
  ];
  const r = claudeSessions({ allowRoots: ['/home/u/e-nexus-runtime'], exec: () => JSON.stringify(rows) });
  assert.deepEqual(r.sessions.map((s) => s.id), ['aaaa1111']);
  assert.equal(claudeSessions({ exec: () => { throw new Error('no claude'); } }).ok, false);
  assert.equal(claudeSessions({ exec: () => '{}' }).ok, false);
});

test('host-health の値の形と通知の文（件数もコードも決まった形だけ）', () => {
  for (const v of ['ok', 'vanished', 'check_failed']) assert.equal(safeValue('dev_sessions', v), v);
  assert.equal(safeValue('dev_sessions', 'vanished /Users/x'), '[redacted]');
  assert.match(alertLine({ id: 'dev_sessions', level: 'warn', value: 'vanished', change: 'new' }), /recover/);
});

test('保存先が無ければ見張りの項目は出さない', () => {
  assert.equal(devSessionsItem('/nonexistent-edl-ds'), null);
});

test('実物の screen：始める → 終了コードと履歴 → 同じ名前は二重に始めない → 次の回で前の回を archive へ', { skip: !hasScreen, timeout: 60_000 }, async () => {
  const root = freshRoot();
  try {
    const r = startSession(root, 'a', ['/bin/sh', '-c', 'echo hello-テスト; sleep 1; exit 4']);
    assert.equal(r.ok, true, JSON.stringify(r));
    const dup = startSession(root, 'a', ['/bin/true']);
    assert.equal(dup.code, 'already_running');
    assert.ok(await until(() => existsSync(path.join(root, 'sessions', 'a', 'exit.json')) && !listSessions(root).some((s) => s.state === 'finishing')));
    const [s] = listSessions(root);
    assert.equal(s.state, 'exited');
    assert.equal(s.code, 4);
    assert.match(readFileSync(path.join(root, 'sessions', 'a', 'screen.log'), 'utf8'), /hello-テスト/);
    const again = startSession(root, 'a', ['/bin/sh', '-c', 'exit 0']);
    assert.equal(again.ok, true);
    assert.ok(existsSync(path.join(root, 'archive', `a-${s.run}`, 'exit.json')), 'previous run archived, not deleted');
    assert.ok(await until(() => listSessions(root)[0]?.state === 'exited'));
    const events = readFileSync(path.join(root, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ['start', 'exit', 'archive', 'start', 'exit']);
  } finally { quitAll(root); rmSync(root, { recursive: true, force: true }); }
});

test('実物の screen：始めた terminal（pty）を SIGHUP→SIGKILL で殺しても job は続き、launchd の子になっている（Cursor を閉じたのと同じ形）', { skip: !hasScreen, timeout: 60_000 }, async () => {
  const root = freshRoot();
  const cli = new URL('../scripts/dev-session.mjs', import.meta.url).pathname;
  try {
    const job = 'i=0; while [ $i -lt 6 ]; do echo tick $i; i=$((i+1)); sleep 1; done';
    const term = spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/sh', '-c', `node ${cli} start term -- /bin/sh -c '${job}'; sleep 60`], { env: { ...process.env, EDL_DEV_SESSION_DIR: root }, detached: true, stdio: 'ignore' });
    assert.ok(await until(() => existsSync(path.join(root, 'sessions', 'term', 'run.json'))));
    process.kill(-term.pid, 'SIGHUP');
    process.kill(-term.pid, 'SIGKILL');
    assert.ok(await until(() => term.exitCode !== null || term.signalCode !== null));
    const ls = spawnSync(SCREEN, ['-ls'], { env: screenEnv(root), encoding: 'utf8', timeout: 5000 }).stdout;
    const pid = ls.match(/^\s+(\d+)\.edl[0-9a-f]{6}-term\s/m)?.[1];
    assert.ok(pid, `screen still listed: ${ls}`);
    assert.equal(spawnSync('/bin/ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf8' }).stdout.trim(), '1');
    assert.ok(await until(() => listSessions(root)[0]?.state === 'exited', 20_000));
    assert.equal(listSessions(root)[0].code, 0);
    assert.match(readFileSync(path.join(root, 'sessions', 'term', 'screen.log'), 'utf8'), /tick 5/);
  } finally { quitAll(root); rmSync(root, { recursive: true, force: true }); }
});

test('実物の screen：強制終了は vanished（見張りが warn）・recover はやり直しの command を出すだけ・forget で片づく。stop は stopped', { skip: !hasScreen, timeout: 60_000 }, async () => {
  const root = freshRoot();
  try {
    assert.equal(startSession(root, 'gone', ['/bin/sh', '-c', 'sleep 30']).ok, true);
    assert.ok(await until(() => existsSync(path.join(root, 'sessions', 'gone', 'run.json'))));
    const ls = spawnSync(SCREEN, ['-ls'], { env: screenEnv(root), encoding: 'utf8', timeout: 5000 }).stdout;
    const pid = Number(ls.match(/^\s+(\d+)\.edl[0-9a-f]{6}-gone\s/m)?.[1]);
    const runner = Number(JSON.parse(readFileSync(path.join(root, 'sessions', 'gone', 'run.json'), 'utf8')).pid);
    process.kill(pid, 'SIGKILL');
    try { process.kill(-runner, 'SIGKILL'); } catch { /* 既に無い */ }
    spawnSync(SCREEN, ['-wipe'], { env: screenEnv(root), timeout: 5000 });
    assert.ok(await until(() => listSessions(root)[0]?.state === 'vanished'));
    assert.deepEqual(devSessionsItem(root), { id: 'dev_sessions', level: 'warn', value: 'vanished', kind: 'state' });
    const [plan] = recoverPlan(listSessions(root));
    assert.deepEqual(plan.restart.slice(-3), ['/bin/sh', '-c', 'sleep 30']);
    assert.equal(forgetSession(root, 'gone').ok, true);
    assert.equal(devSessionsItem(root).value, 'ok');

    assert.equal(startSession(root, 'stop', ['/bin/sh', '-c', 'sleep 30']).ok, true);
    assert.ok(await until(() => existsSync(path.join(root, 'sessions', 'stop', 'run.json'))));
    assert.equal(forgetSession(root, 'stop').code, 'still_running');
    assert.equal(stopSession(root, 'stop').ok, true);
    assert.ok(await until(() => listSessions(root).find((s) => s.name === 'stop')?.state === 'stopped'));
    assert.equal(devSessionsItem(root).value, 'ok', 'a stop on request is not a vanished job');
    assert.equal(stopSession(root, 'stop').code, 'not_running');
  } finally { quitAll(root); rmSync(root, { recursive: true, force: true }); }
});

test('壊れた跡：meta の無い dir は作り直す・古い lock は 1 分で取り直す', { skip: !hasScreen, timeout: 30_000 }, async () => {
  const root = freshRoot();
  try {
    mkdirSync(path.join(root, 'sessions', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'sessions', 'b', 'junk'), 'x');
    mkdirSync(path.join(root, 'sessions', '.b.lock'));
    assert.equal(startSession(root, 'b', ['/bin/true']).code, 'already_starting');
    assert.equal(startSession(root, 'b', ['/bin/true'], { now: Date.now() + 120_000 }).ok, true);
    assert.ok(await until(() => listSessions(root)[0]?.state === 'exited'));
    assert.equal(existsSync(path.join(root, 'sessions', 'b', 'junk')), false);
  } finally { quitAll(root); rmSync(root, { recursive: true, force: true }); }
});
