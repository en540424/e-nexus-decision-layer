/**
 * Hermes の業務の実行の sandbox（2026-11-13・scripts/lib/hermes-sandbox.mjs）。macOS の sandbox-exec で、一時フォルダに作った模擬の
 * /Users・Hermes の root の上で読み・書き・起動の規則を確かめる（Hermes 本体は動かさない・通信なし・鍵なし）。macOS 以外は skip。
 * 実行は taskpolicy -b と perl の alarm で上限つき（この Mac は別の本番の処理も動かしている）。2026-11-13 独立監査 F1・F2 の場合を含む。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOADER, productionParams, sandboxArgs } from '../scripts/lib/hermes-sandbox.mjs';

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const TASK = 't-20261113000000-0000abcd';

function world() {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-sbx-')));
  const U = path.join(R, 'Users');
  const H = path.join(U, 'hermes');
  const root = path.join(H, '.hermes');
  const work = path.join(root, 'profiles/work');
  const d = (p) => { mkdirSync(p, { recursive: true }); return p; };
  for (const p of ['hermes-agent', 'tools', 'installs/k1/environments/g1/.leases', 'sessions', 'memories', 'auth', 'logs', 'backups', 'cron', 'plugins', 'hooks', 'skills', 'profiles/other', 'profiles/work/sessions', 'profiles/work/cwd', 'profiles/work/cache/scratch']) d(path.join(root, p));
  d(path.join(H, '.local/bin')); d(path.join(H, 'work')); d(path.join(U, 'operator/.ssh')); d(path.join(R, 'vf'));
  const shared = d(path.join(U, 'Shared/w'));
  const inbox = d(path.join(shared, 'inbox'));
  const outbox = d(path.join(shared, 'outbox'));
  const w = (p, s = 'x') => writeFileSync(p, s);
  w(path.join(root, '.env'), `ANTHROPIC_API_KEY=${'k'.repeat(40)}\n`);
  for (const p of ['auth.json', 'auth/token', 'state.db', 'sessions/s1', 'memories/m', 'logs/agent.log', 'backups/state.db', 'cron/jobs.json', 'profiles/other/state.db', 'config.yaml', 'hermes-agent/code.py', 'installs/k1/facts.json', 'profiles/work/state.db', 'profiles/work/.env.bak']) w(path.join(root, p));
  w(path.join(U, 'operator/.ssh/id'), 's'); w(path.join(inbox, `${TASK}.json`), 'req'); w(path.join(inbox, 't2.json'), 'other'); w(path.join(shared, 'brief.json'), 'b');
  w(path.join(outbox, 't-20261113000000-0000ffff.json'), '{"summary":"別の business の結果"}');
  const params = { USERS_ROOT: U, HERMES_ROOT: root, WORK_HOME: work, LOCAL_BIN: path.join(H, '.local/bin'), USAGE_FILE: path.join(H, 'work/u.json'), REQUEST: path.join(inbox, `${TASK}.json`), BRIEF: path.join(shared, 'brief.json'), RESULT: path.join(outbox, `${TASK}.json`), SYSTEM_TMP: path.join(R, 'vf') };
  return { R, U, H, root, work, inbox, outbox, shared, params };
}
const bounded = (args, env) => spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', ...args], { encoding: 'utf8', timeout: 25_000, env: env ?? { PATH: '/usr/bin:/bin' } });
const inBox = (params, ...cmd) => bounded(['/usr/bin/sandbox-exec', ...sandboxArgs(params), ...cmd]).status === 0;

test('sandbox の読み：依頼の 1 file・code・依存・profile の state は読める／鍵・auth・他の home・gateway の会話・logs・backups・cron・他の profile・他の依頼・他の結果は読めない', { skip: !isMac }, () => {
  const x = world();
  const rd = (p) => inBox(x.params, '/bin/cat', p);
  const r = (p) => path.join(x.root, p);
  const yes = [x.params.REQUEST, x.params.BRIEF, r('hermes-agent/code.py'), r('installs/k1/facts.json'), r('profiles/work/state.db'), '/etc/hosts'];
  const no = [path.join(x.inbox, 't2.json'), path.join(x.outbox, 't-20261113000000-0000ffff.json'), r('.env'), r('profiles/work/.env.bak'), r('auth.json'), r('auth/token'),
    r('state.db'), r('sessions/s1'), r('memories/m'), r('logs/agent.log'), r('backups/state.db'), r('cron/jobs.json'), r('profiles/other/state.db'), r('config.yaml'),
    path.join(x.U, 'operator/.ssh/id')];
  for (const p of yes) assert.equal(rd(p), true, `読める：${p}`);
  for (const p of no) assert.equal(rd(p), false, `読めない：${p}`);
  for (const dir of [x.inbox, x.outbox, '/private/tmp', x.root]) assert.equal(inBox(x.params, '/bin/ls', dir), false, `一覧は読めない：${dir}`);
  rmSync(x.R, { recursive: true, force: true });
});

test('sandbox の書き：結果の 1 file・usage・profile の state・依存の lock と lease・OS の一時だけ／gateway の plugins・hooks・cron・skills・SOUL・依存の code・profile の設定と hook・他の結果は書けない', { skip: !isMac }, () => {
  const x = world();
  const wr = (p) => inBox(x.params, '/usr/bin/touch', p);
  const r = (p) => path.join(x.root, p);
  const yes = [x.params.RESULT, x.params.USAGE_FILE, r('profiles/work/sessions/s'), r('profiles/work/state.db'), r('profiles/work/cache/scratch/t'), r('installs/k1/.install.lock'), r('installs/k1/environments/g1/.leases/abc'), path.join(x.R, 'vf/t')];
  const no = [path.join(x.outbox, 'other.json'), path.join(x.outbox, `.${TASK}.json.tmp`), r('plugins/p.py'), r('hooks/h.py'), r('cron/jobs.json'), r('skills/SKILL.md'), r('SOUL.md'), r('config.yaml'),
    r('hermes-agent/x.py'), r('tools/py'), r('installs/k1/environments/g1/site.py'), r('installs/k1/facts.json'), r('.env'), r('state.db'), r('sessions/s2'),
    r('profiles/work/config.yaml'), r('profiles/work/.env'), r('profiles/work/cwd/AGENTS.md'), r('profiles/work/SOUL.md'), r('profiles/other/state.db'),
    path.join(x.inbox, 'x'), path.join(x.U, 'operator/x'), `/private/tmp/hermes-sbx-probe-${process.pid}`];
  for (const p of yes) assert.equal(wr(p), true, `書ける：${p}`);
  for (const p of no) assert.equal(wr(p), false, `書けない：${p}`);
  assert.equal(inBox(x.params, '/bin/mkdir', '-p', r('profiles/work/hooks/h')), false, 'profile に hook のフォルダを作れない');
  assert.equal(inBox(x.params, '/bin/ln', r('.env'), r('profiles/work/k')), false, '.env の hardlink を作れない');
  assert.equal(inBox(x.params, '/usr/bin/security', 'list-keychains'), false, 'Keychain の道具は起動できない');
  assert.equal(inBox(x.params, '/usr/bin/curl', '--version'), false, 'curl は起動できない');
  rmSync(x.R, { recursive: true, force: true });
});

test('loader：.env の鍵の 1 行だけを環境変数へ・値は出さない・無い時は exit 65・KEY_PROBE=invalid は .env を読まない', { skip: !isMac }, () => {
  const x = world();
  const envFile = path.join(x.root, '.env');
  const has = (file, extraEnv = {}) => bounded(['/usr/bin/perl', '-e', LOADER, file, '10', x.outbox, '/bin/sh', '-c', 'test "${#ANTHROPIC_API_KEY}" -ge 20 && test -z "${KEY_PROBE:-}" && case "$ANTHROPIC_API_KEY" in sk-ant-api03-invalid-*) echo probe;; *) echo real;; esac && test "$(pwd -P)" = "$OUTBOX_EXPECT" && umask'], { PATH: '/usr/bin:/bin', OUTBOX_EXPECT: x.outbox, ...extraEnv });
  const r = has(envFile);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^real\n0027\n$/, '鍵が入り・作業フォルダへ移り・umask 027');
  assert.doesNotMatch(r.stdout + r.stderr, /kkkk/, '値は出さない');
  const p = has(path.join(x.R, 'no-such.env'), { KEY_PROBE: 'invalid' });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^probe\n/);
  assert.equal(has(path.join(x.R, 'no-such.env')).status, 64);
  writeFileSync(path.join(x.R, 'other.env'), 'OPENAI_API_KEY=abc\nANTHROPIC_API_KEY=short\n');
  assert.equal(has(path.join(x.R, 'other.env')).status, 65);
  rmSync(x.R, { recursive: true, force: true });
});

test('sandboxArgs：安全でない path は拒否・本番の値は /Users/hermes の root と profiles/work', () => {
  const base = productionParams({ request: `/Users/Shared/e-nexus-hermes/work/inbox/${TASK}.json`, brief: '/Users/Shared/e-nexus-hermes/status/runtime-brief.json', result: `/Users/Shared/e-nexus-hermes/work/outbox/${TASK}.json`, usage: '/Users/hermes/work/work-run-usage.json' });
  assert.deepEqual([base.HERMES_ROOT, base.WORK_HOME], ['/Users/hermes/.hermes', '/Users/hermes/.hermes/profiles/work']);
  const [flag, profile] = sandboxArgs(base);
  assert.equal(flag, '-p');
  assert.match(profile, /\(literal "\/Users\/Shared\/e-nexus-hermes\/work\/outbox\/t-20261113000000-0000abcd\.json"\)/);
  assert.match(profile, /\^\/Users\/hermes\/\\\.hermes\/installs\/\[\^\/\]\+\/\\\.install\\\.lock\$/);
  for (const bad of ['relative/path', '/x/../etc', '/x/"quote', '/x y', '', '/x/']) assert.throws(() => sandboxArgs({ ...base, RESULT: bad }), /RESULT/);
  assert.throws(() => sandboxArgs({ ...base, WORK_HOME: '/Users/hermes/elsewhere' }), /WORK_HOME/);
  assert.match(profile, /\(allow network-outbound \(remote tcp "\*:443"\)\)/);
});
