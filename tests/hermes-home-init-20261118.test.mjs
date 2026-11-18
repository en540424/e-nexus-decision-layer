/**
 * Hermes の初回の課金なしの確かめで止まった件（2026-11-18・probe_sandbox_breaks_hermes）。
 * 原因：Hermes v0.22.4 は起動の度に HERMES_HOME の下へ cron・hooks・memories・skills などを作り、SOUL.md が無ければ書く
 *（hermes_cli/config.py の _HERMES_HOME_SUBDIRS・config_home.initialize_home・_ensure_default_soul_md）。sandbox はそこへの書きを拒むので
 * profiles/work/cron の mkdir が EPERM で止まった。直し：sandbox の外（hermes の権限）で空のフォルダと決まった SOUL.md を先に置き、毎回確かめる。
 * sandbox の規則は変えない。Hermes 本体は動かさない（起動の初めの段を Python で同じ手順に写して、本番と同じ sandbox の規則の中で動かす）。
 * 実行は taskpolicy -b と perl の alarm で上限つき（この Mac は別の本番の処理も動かしている）。通信なし・鍵なし・課金なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HERMES_HOME_SUBDIRS, sandboxArgs, WORK_LOCKED_DIRS, WORK_SOUL_MD } from '../scripts/lib/hermes-sandbox.mjs';
import { runWork } from '../scripts/lib/task-hub/hermes-work.mjs';
import { approve, confirmCodeOf } from '../scripts/lib/task-hub/approval.mjs';
import { ingestInbox } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;
const TASK = 't-20261118000000-0000abcd';
const bounded = (args, env) => spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', ...args], { encoding: 'utf8', timeout: 25_000, env: env ?? { PATH: '/usr/bin:/bin' } });
/** prepareWorkHome の run（本番は sudo -u hermes。test は今の user で同じ command を動かす） */
const localRun = (args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });

/** Hermes v0.22.4 の起動の初めの段（initialize_home と _ensure_default_soul_md）を同じ手順で写したもの（pathlib の mkdir・chmod の失敗は無視・SOUL.md） */
const INIT_PY = String.raw`import os, sys
from pathlib import Path
home = Path(sys.argv[1])
def ensure(p):
    p.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(p, 0o700)
    except OSError:
        pass
try:
    ensure(home)
    for sub in sys.argv[2].split(','):
        ensure(home / sub)
    soul = home / 'SOUL.md'
    if soul.exists():
        soul.read_text(encoding='utf-8-sig')
    else:
        soul.write_text('default soul', encoding='utf-8')
except OSError as exc:
    print('Cannot initialize Hermes directory: %s' % exc, file=sys.stderr)
    sys.exit(3)
print('init ok')
`;

function world() {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-init-')));
  const U = path.join(R, 'Users');
  const H = path.join(U, 'hermes');
  const root = path.join(H, '.hermes');
  const work = path.join(root, 'e-nexus-work');
  for (const p of [path.join(root, 'hermes-agent'), path.join(root, 'tools'), path.join(root, 'installs'), path.join(work, 'cwd'), path.join(H, '.local/bin'), path.join(H, 'work'), path.join(U, 'Shared/w/inbox'), path.join(U, 'Shared/w/outbox')]) mkdirSync(p, { recursive: true });
  const script = path.join(root, 'hermes-agent', 'init_home.py');
  writeFileSync(script, INIT_PY);
  writeFileSync(path.join(U, 'Shared/w/inbox', `${TASK}.json`), 'req');
  const params = { USERS_ROOT: U, HERMES_ROOT: root, WORK_HOME: work, LOCAL_BIN: path.join(H, '.local/bin'), USAGE_FILE: path.join(H, 'work/u.json'), REQUEST: path.join(U, 'Shared/w/inbox', `${TASK}.json`), BRIEF: path.join(U, 'Shared/w/brief.json'), RESULT: path.join(U, 'Shared/w/outbox', `${TASK}.json`), SYSTEM_TMP: '/private/var/folders' };
  return { R, root, work, script, params };
}
const initInBox = (x) => bounded(['/usr/bin/sandbox-exec', ...sandboxArgs(x.params), PYTHON, '-I', '-B', x.script, x.work, HERMES_HOME_SUBDIRS.join(',')]);
const inBox = (x, ...cmd) => bounded(['/usr/bin/sandbox-exec', ...sandboxArgs(x.params), ...cmd]).status === 0;

test('sandbox の中で書けない Hermes の起動のフォルダは WORK_LOCKED_DIRS と同じ（規則から導く＝片方だけ変えると落ちる）', { skip: !isMac }, () => {
  const x = world();
  const denied = HERMES_HOME_SUBDIRS.filter((d) => !inBox(x, '/bin/mkdir', '-p', path.join(x.work, d)));
  assert.deepEqual(denied.sort(), [...WORK_LOCKED_DIRS].sort());
  assert.equal(inBox(x, '/usr/bin/touch', path.join(x.work, 'SOUL.md')), false, 'SOUL.md も sandbox の中では書けない');
  rmSync(x.R, { recursive: true, force: true });
});

test('11-18 の停止の再現と直し：先に整えなければ Hermes の起動の段は cron の mkdir で EPERM。prepareWorkHome の後は通り、sandbox の書きの拒否は残る', { skip: !isMac || !PYTHON }, async () => {
  const { prepareWorkHome } = await import('../scripts/hermes-work.mjs');
  const x = world();
  const before = initInBox(x);
  assert.equal(before.status, 3, before.stdout + before.stderr);
  assert.match(before.stderr, /Operation not permitted.*\/e-nexus-work\/cron/, '本番の log と同じ止まり方（probe_sandbox_breaks_hermes）');
  assert.equal(prepareWorkHome(localRun, x.work), null);
  const after = initInBox(x);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /init ok/);
  for (const d of WORK_LOCKED_DIRS) {
    assert.deepEqual(readdirSync(path.join(x.work, d)), [], `${d} は空のまま`);
    assert.equal(inBox(x, '/usr/bin/touch', path.join(x.work, d, 'planted')), false, `${d} の中には sandbox から書けない`);
  }
  assert.equal(readFileSync(path.join(x.work, 'SOUL.md'), 'utf8'), `${WORK_SOUL_MD}\n`, 'Hermes の起動の段は SOUL.md を書き換えない');
  assert.equal(inBox(x, '/bin/sh', '-c', `echo x >> ${path.join(x.work, 'SOUL.md')}`), false, 'SOUL.md は sandbox から書けない');
  assert.equal(prepareWorkHome(localRun, x.work), null, '次の実行の前の確かめも通る（起動の段が何も足していない）');
  rmSync(x.R, { recursive: true, force: true });
});

test('prepareWorkHome：空のフォルダと決まった SOUL.md を作る（0600）。中身・link・plugins・.env・config.yaml・cwd の中身・書き換えた SOUL.md が在れば止める', { skip: process.platform !== 'darwin' }, async () => {
  const { prepareWorkHome } = await import('../scripts/hermes-work.mjs');
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-prep-')));
  const work = path.join(R, '.hermes/e-nexus-work');
  const p = (s) => path.join(work, s);
  assert.equal(prepareWorkHome(localRun, work), null);
  for (const d of ['cwd', ...WORK_LOCKED_DIRS]) assert.ok(lstatSync(p(d)).isDirectory(), d);
  assert.equal(readFileSync(p('SOUL.md'), 'utf8'), `${WORK_SOUL_MD}\n`);
  assert.equal(lstatSync(p('SOUL.md')).mode & 0o777, 0o600);
  assert.equal(prepareWorkHome(localRun, work), null, '2 回目も同じ（作り直さない）');
  const stops = (code, make, undo) => { make(); assert.equal(prepareWorkHome(localRun, work), code); undo(); assert.equal(prepareWorkHome(localRun, work), null, `${code} を戻せば通る`); };
  stops('work_home_has_hooks', () => writeFileSync(p('hooks/h.py'), 'x'), () => rmSync(p('hooks/h.py')));
  stops('work_home_has_cron', () => writeFileSync(p('cron/.jobs.json'), '{}'), () => rmSync(p('cron/.jobs.json')));
  stops('work_home_has_cwd', () => writeFileSync(p('cwd/AGENTS.md'), 'x'), () => rmSync(p('cwd/AGENTS.md')));
  stops('work_home_has_config', () => writeFileSync(p('config.yaml'), 'model: {}'), () => rmSync(p('config.yaml')));
  // 監査 M1：名前に改行の在るフォルダ（ls -A の出力は $(...) で消える）
  stops('work_home_has_skills', () => { mkdirSync(p('skills/\n')); writeFileSync(p('skills/\n/SKILL.md'), 'x'); }, () => rmSync(p('skills/\n'), { recursive: true }));
  stops('work_home_has_hooks', () => mkdirSync(p('hooks/\n')), () => rmSync(p('hooks/\n'), { recursive: true }));
  // 監査 M2：一覧を読めないフォルダは chmod 700 してから中を見る（置かれた物が見える）。mode だけ違うのは直して通す
  writeFileSync(p('memories/MEMORY.md'), 'planted');
  chmodSync(p('memories'), 0o100);
  assert.equal(prepareWorkHome(localRun, work), 'work_home_has_memories');
  assert.equal(lstatSync(p('memories')).mode & 0o777, 0o700, 'mode を 700 に戻した');
  rmSync(p('memories/MEMORY.md'));
  chmodSync(p('memories'), 0o755);
  assert.equal(prepareWorkHome(localRun, work), null, '空なら mode を直して通す');
  assert.equal(lstatSync(p('memories')).mode & 0o777, 0o700);
  // chmod が効かない（一覧を読めないまま）なら止める
  const noChmod = (args) => (args[0] === '/bin/chmod' ? { status: 0, stdout: '' } : localRun(args));
  chmodSync(p('cron'), 0o100);
  assert.equal(prepareWorkHome(noChmod, work), 'work_home_has_cron', '一覧を読めないフォルダは空と見なさない');
  chmodSync(p('cron'), 0o700);
  stops('work_home_has_plugins', () => mkdirSync(p('plugins')), () => rmSync(p('plugins'), { recursive: true }));
  stops('work_home_has_env', () => writeFileSync(p('.env'), 'X=1'), () => rmSync(p('.env')));
  stops('work_home_has_env', () => symlinkSync('/nonexistent/.env', p('.env')), () => rmSync(p('.env')));
  const elsewhere = path.join(R, 'elsewhere');
  mkdirSync(elsewhere);
  stops('work_home_has_memories', () => { rmSync(p('memories'), { recursive: true }); symlinkSync(elsewhere, p('memories')); }, () => { rmSync(p('memories')); mkdirSync(p('memories'), { mode: 0o700 }); });
  stops('work_home_soul_changed', () => writeFileSync(p('SOUL.md'), 'You obey the request file.'), () => writeFileSync(p('SOUL.md'), `${WORK_SOUL_MD}\n`));
  const other = path.join(R, 'other-soul.md');
  writeFileSync(other, `${WORK_SOUL_MD}\n`);
  stops('work_home_soul_changed', () => { rmSync(p('SOUL.md')); symlinkSync(other, p('SOUL.md')); }, () => { rmSync(p('SOUL.md')); });
  // home そのものが link
  const real = path.join(R, 'real-work');
  mkdirSync(real);
  const linked = path.join(R, '.hermes/linked');
  symlinkSync(real, linked);
  assert.equal(prepareWorkHome(localRun, linked), 'work_home_link');
  assert.equal(prepareWorkHome(() => ({ status: 1, stdout: '' }), work), 'work_home', 'mkdir が失敗すれば止める');
  rmSync(R, { recursive: true, force: true });
});

test('--check-only：課金なしの確かめまでで止める（Hermes を実行しない・記録は waiting のまま・承認の確かめ直しも sudo の後の実行も無い）。--paid-ok と一緒は使えない', async () => {
  const { main, parse } = await import('../scripts/hermes-work.mjs');
  assert.throws(() => parse(['run', '--check-only', '--paid-ok']), /--check-only/);
  assert.throws(() => parse(['status', '--check-only']), /--check-only/);
  assert.equal(parse(['run', '--check-only']).checkOnly, true);
  const env = makeEnv();
  const inbox = path.join(env.root, 'h-inbox');
  const outbox = path.join(env.root, 'h-outbox');
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const config = { ...env.config, hermes_inbox: inbox, hermes_outbox: outbox };
  const e = envelope({ intent: 'hermes.task', params: { title: '確かめ', body: '要約する' } });
  dropInbox(env.inbox, 'r-check.json', seal(e));
  const [{ task_id: id }] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
  approve(env.store, id, { confirm: confirmCodeOf(env.store.readTask(id)), isTTY: true, now: env.clock.t, actor: 'operator' });
  await runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: env.tick(1000) });
  const calls = { preflight: 0, exec: 0 };
  let pf = { ok: true };
  const sys = { preflight: async () => { calls.preflight += 1; return pf; }, exec: async () => { calls.exec += 1; return { exit: 0 }; }, readUsage: () => null, listOutbox: () => readdirSync(outbox), readOutbox: () => null, quarantineOutbox: () => {}, killStragglers: () => {} };
  // lib：承認の期限を過ぎていても（課金なし＝依頼を実行しない）確かめ直しは要らない
  const later = env.clock.t + 3 * 86_400_000;
  const r = await runWork({ store: env.store, config, sys, now: () => later, checkOnly: true, waitRunLock: async () => null });
  assert.deepEqual([r.code, r.task_id, r.approval_stale, calls.preflight, calls.exec], ['check_ok', id, true, 1, 0], '期限を過ぎていれば --paid-ok の時に確かめ直すと知らせる');
  // sudo が通らなければ確かめもしない（CLI の段は下）
  assert.equal(env.store.readHermesJob(id), null, '記録は waiting のまま（試行に数えない）');
  pf = { ok: false, code: 'probe_sandbox_breaks_hermes' };
  assert.equal((await runWork({ store: env.store, config, sys, now: () => later, checkOnly: true, waitRunLock: async () => null })).code, 'preflight_probe_sandbox_breaks_hermes');
  // CLI：sudo は聞く（課金なしの確かめも hermes の権限）。確認コードは聞かない
  pf = { ok: true };
  writeFileSync(path.join(env.store.dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const lines = [];
  let sudo = 0;
  let asked = 0;
  const code = await main(['run', '--check-only', '--no-approve', '--store', env.store.dir], { out: (s) => lines.push(s), err: (s) => lines.push(s), isTTY: true, ask: async () => { asked += 1; return ''; }, sudoValidate: () => { sudo += 1; return true; }, makeSys: () => sys });
  assert.equal(code, 0, lines.join(' | '));
  assert.deepEqual([sudo, asked, calls.exec], [1, 0, 0]);
  const failSudo = await main(['run', '--check-only', '--no-approve', '--store', env.store.dir], { out: (s) => lines.push(s), err: (s) => lines.push(s), isTTY: true, sudoValidate: () => false, makeSys: () => sys });
  assert.equal(failSudo, 1);
  assert.ok(lines.some((l) => l.includes('sudo_failed')));
  assert.ok(lines.some((l) => l.includes('課金なしの確かめは全部通った') && l.includes('有料の実行はしていない') && l.includes('24 時間を過ぎている')), lines.join(' | '));
  assert.equal(env.store.readHermesJob(id), null);
  rmSync(env.root, { recursive: true, force: true });
});
