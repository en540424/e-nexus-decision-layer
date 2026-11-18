/**
 * Hermes の --check-only が preflight_probe_no_auth_error で止まった件（2026-11-18 夜）。
 * 記録：exit=1・stderr「Error: Gateway inaccessible: authorization」。これは Anthropic の 401 ではない。
 * 原因：v0.22.4 の `hermes -z` は gateway の client（hermes_cli/main.py の _run_oneshot_from_args → gateway_chat.launch_from_args →
 * gateway_client.connect_gateway）で、named profile の会話は root の multiplexer＝常駐の gateway（sandbox の外・本物の鍵）が処理する。
 * sandbox は root の config と socket を拒むので gateway_runtime._refused の「authorization」で止まった＝安全の側。
 * 直し：sandbox の規則は変えず（gateway へはつながせない）、Hermes の in-process の -z（_run_and_exit_oneshot → hermes_cli.oneshot.run_oneshot）を
 * sandbox の中の同じ process で動かす（lib/hermes-sandbox.mjs の inProcessCommand）。
 * Hermes 本体は動かさない：launcher の runtime command と hermes_cli.main の形を写した小さな偽物で、差し替えの仕組みを本番と同じ sandbox の規則の中で確かめる。
 * 実行は taskpolicy -b と perl の alarm で上限つき。通信なし・鍵なし・課金なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildProfile, INPROC_ENTRY, INPROC_SIGNATURE, inProcessCommand, productionParams, RUNTIME_ENTRY, runtimeBootstrap, sandboxArgs } from '../scripts/lib/hermes-sandbox.mjs';
import { classifyProbe, macSys } from '../scripts/hermes-work.mjs';

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;
const TASK = 't-20261118000000-0000abcd';
const bounded = (args, env) => spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', ...args], { encoding: 'utf8', timeout: 25_000, env: env ?? { PATH: '/usr/bin:/bin' } });

/** hermes_cli/_launchers.runtime_command（home=None）が出す bootstrap の写し（v0.22.4・4d04303） */
const bootstrapOf = (root) => "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); "
  + `os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, '${root}/hermes-agent'); sys._hermes_pin_default_home = True; import hermes_bootstrap; `
  + "os.environ.get('HERMES_HOME') or os.environ.__setitem__('HERMES_HOME', str(__import__('hermes_constants').get_default_hermes_root())); "
  + RUNTIME_ENTRY;
const printed = (py, root) => `${JSON.stringify([py, '-I', '-c', bootstrapOf(root)])}\n`;

/** hermes_cli.main の形の偽物：-z は gateway へ渡す（本番の止まりと同じ文）。_run_and_exit_oneshot は in-process で受けた引数を出す */
const FAKE_MAIN = String.raw`import os, sys, json
def _run_and_exit_oneshot(prompt, *, model=None, provider=None, toolsets=None, skills=None, usage_file=None, resume=None, reasoning=None):
    sys.stdout.write(json.dumps({'inproc': prompt, 'toolsets': toolsets, 'usage_file': usage_file, 'resume': resume, 'home': os.environ.get('HERMES_HOME'), 'pid': os.getpid(), 'ppid': os.getppid()}) + '\n')
    sys.stdout.flush()
    os._exit(2)
def _run_oneshot_from_args(args):
    sys.stderr.write('Error: Gateway inaccessible: authorization\n')
    sys.exit(1)
def main():
    import argparse
    p = argparse.ArgumentParser(prog='hermes')
    p.add_argument('-z', '--oneshot')
    p.add_argument('-t', '--toolsets')
    p.add_argument('--usage-file')
    p.add_argument('-r', '--resume')
    args = p.parse_args(sys.argv[1:])
    if args.oneshot is not None:
        _run_oneshot_from_args(args)
    return 0
if __name__ == '__main__':
    sys.exit(main())
`;

function world(main = FAKE_MAIN) {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-inproc-')));
  const U = path.join(R, 'Users');
  const H = path.join(U, 'hermes');
  const root = path.join(H, '.hermes');
  const work = path.join(root, 'profiles/work');
  const code = path.join(root, 'hermes-agent');
  for (const p of [path.join(code, 'hermes_cli'), path.join(root, 'tools/py/bin'), path.join(root, 'installs'), path.join(work, 'cwd'), path.join(H, '.local/bin'), path.join(H, 'work'), path.join(U, 'Shared/w/inbox'), path.join(U, 'Shared/w/outbox')]) mkdirSync(p, { recursive: true });
  writeFileSync(path.join(code, 'hermes_bootstrap.py'), '');
  writeFileSync(path.join(code, 'hermes_cli/__init__.py'), '');
  writeFileSync(path.join(code, 'hermes_cli/main.py'), main);
  const py = path.join(root, 'tools/py/bin/python3');
  if (PYTHON) symlinkSync(PYTHON, py);
  writeFileSync(path.join(U, 'Shared/w/inbox', `${TASK}.json`), 'req');
  const params = { USERS_ROOT: U, HERMES_ROOT: root, WORK_HOME: work, LOCAL_BIN: path.join(H, '.local/bin'), USAGE_FILE: path.join(H, 'work/u.json'), REQUEST: path.join(U, 'Shared/w/inbox', `${TASK}.json`), BRIEF: path.join(U, 'Shared/w/brief.json'), RESULT: path.join(U, 'Shared/w/outbox', `${TASK}.json`), SYSTEM_TMP: '/private/var/folders' };
  return { R, root, work, py, params };
}
const boxed = (x, cmd) => bounded(['/usr/bin/sandbox-exec', ...sandboxArgs(x.params), ...cmd], { PATH: '/usr/bin:/bin', HOME: path.dirname(x.root), HERMES_HOME: x.work });

test('inProcessCommand：Hermes の runtime command の末尾の entry だけを in-process の code に替える', () => {
  const root = '/Users/hermes/.hermes';
  const py = `${root}/tools/cpython-3.12/bin/python3`;
  const cmd = inProcessCommand(`⚠ warning on stdout\n${printed(py, root)}`, root);
  assert.ok(cmd);
  assert.deepEqual(cmd.slice(0, 3), [py, '-I', '-c']);
  const boot = bootstrapOf(root);
  assert.equal(cmd[3], `${boot.slice(0, -RUNTIME_ENTRY.length)}exec(${JSON.stringify(INPROC_ENTRY)})`);
  assert.ok(!cmd[3].includes('run_module'), 'gateway の client の main を module として走らせない');
  assert.match(INPROC_ENTRY, /_m\._run_oneshot_from_args = _enexus_inproc/);
  assert.match(INPROC_ENTRY, /resume=None/);
  assert.ok(/^[\x20-\x7e\n]*$/.test(INPROC_ENTRY), 'ASCII だけ（JSON の文字列＝Python の文字列として同じ）');
});

test('inProcessCommand：形が違えば null（止める）', () => {
  const root = '/Users/hermes/.hermes';
  const py = `${root}/tools/p/bin/python3`;
  const boot = bootstrapOf(root);
  const bad = [
    '', 'not json', '{"a":1}', JSON.stringify([py, '-I', '-c']), JSON.stringify([py, '-c', boot, 'x']),
    JSON.stringify([py, '-I', '-c', boot, '--extra']),
    JSON.stringify([`${root}/profiles/work/bin/python3`, '-I', '-c', boot]), // sandbox の中で書ける所の python
    JSON.stringify([`${root}/tools/../profiles/work/python3`, '-I', '-c', boot]),
    JSON.stringify(['/usr/bin/python3', '-I', '-c', boot]),
    JSON.stringify([`${root}/tools/p y/python3`, '-I', '-c', boot]),
    JSON.stringify([`${root}/installs/k/.leases/python3`, '-I', '-c', boot]), // sandbox の中で書ける（監査 3）
    JSON.stringify([`${root}/installs/.install.lock`, '-I', '-c', boot]),
    JSON.stringify([`${root}/tools/bin/sh`, '-I', '-c', boot]),
    JSON.stringify([`${root}/python3`, '-I', '-c', boot]),
    JSON.stringify([py, '-I', '-c', `import os; os.system('x'); ${boot}`]), // 前に code を足した bootstrap（監査 4）
    JSON.stringify([py, '-I', '-c', boot.replace('sys._hermes_pin_default_home = True; ', '')]),
    JSON.stringify([py, '-I', '-c', boot.replace("'hermes_cli.main'", "'hermes_cli.other'")]),
    JSON.stringify([py, '-I', '-c', `${boot}; print(1)`]),
    JSON.stringify([py, '-I', '-c', boot.replace(`${root}/hermes-agent`, '/tmp/x')]),
    JSON.stringify([py, '-I', '-c', `exec('x'); ${boot}`]),
    JSON.stringify([py, '-I', '-c', `${RUNTIME_ENTRY}; ${boot}`]),
  ];
  for (const b of bad) assert.equal(inProcessCommand(b, root), null, b.slice(0, 80));
});

test('classifyProbe：gateway の「authorization」は鍵の 401 と読まない（11-18 夜の本番の記録）', () => {
  const real = { status: 1, signal: null, stdout: '', stderr: '⚠ install out of sync (venv: could not enumerate profiles: /Users/hermes/.hermes/profiles) — run `hermes pm install`\nError: Gateway inaccessible: authorization\n' };
  assert.equal(classifyProbe(real), 'probe_gateway_transport');
  assert.equal(classifyProbe({ status: 1, stderr: 'Gateway connection failed; no local fallback' }), 'probe_gateway_transport');
  assert.equal(classifyProbe({ status: 1, stderr: 'Gateway could not start: boom' }), 'probe_gateway_transport');
  assert.equal(classifyProbe({ status: 1, stderr: 'Gateway inaccessible: authorization\nError code: 401 authentication_error' }), 'probe_gateway_transport', 'gateway の止まりが先');
  assert.equal(classifyProbe({ status: 2, stdout: 'Provider returned 401.', stderr: '' }), null, 'in-process の 401＝通った');
  assert.equal(classifyProbe({ status: 1, stdout: '', stderr: 'hermes -z: no final response' }, '{"completed": false, "failure": "Error code: 401 - invalid x-api-key"}'), null, 'usage の file の failure の 401 も見る');
  assert.equal(classifyProbe({ status: 1, stdout: '', stderr: '' }, '{"session_id": "20261118_140155_ab", "input_tokens": 4012, "failure": "Connection error: name resolution failed"}'), 'probe_no_auth_error', 'session_id・数の中の 401 を通ったと読まない（監査 1）');
  assert.equal(classifyProbe({ status: 1, stdout: '', stderr: 'x' }, 'not json 401'), 'probe_no_auth_error', '読めない usage は見ない');
  assert.equal(classifyProbe({ status: 2, stdout: "Anthropic rejected your API key, so the model can't be reached. Update it in Settings → Providers, or run `hermes setup` in a terminal.\n", stderr: '' }), null, 'in-process の 401 の文（turn_failure_copy._AUTH_COPY・監査 2）');
  assert.equal(classifyProbe({ status: 1, stderr: 'e-nexus: hermes oneshot signature changed' }), 'probe_inproc_unexpected');
  assert.equal(classifyProbe({ status: 1, stderr: 'e-nexus: in-process oneshot returned' }), 'probe_inproc_unexpected');
  assert.equal(classifyProbe({ status: 0, stdout: 'OK' }), 'probe_unexpected_success');
  assert.equal(classifyProbe({ status: 1, stderr: "PermissionError: [Errno 1] Operation not permitted: '/x/cron'" }), 'probe_sandbox_breaks_hermes');
  assert.equal(classifyProbe({ status: null, signal: 'SIGKILL', stderr: '' }), 'probe_timeout');
  assert.equal(classifyProbe({ status: 1, stderr: 'something else' }), 'probe_no_auth_error');
});

test('sandbox の通信の規則は変えていない：unix socket は名前解決だけ・TCP は 443 だけ（常駐の gateway の socket・loopback の API へはつながせない）', () => {
  const p = buildProfile(productionParams({ request: '/Users/Shared/w/inbox/t.json', brief: '/Users/Shared/w/brief.json', result: '/Users/Shared/w/outbox/t.json', usage: '/Users/hermes/work/u.json' }));
  const allows = p.split('\n').filter((l) => l.startsWith('(allow network'));
  assert.deepEqual(allows, ['(allow network-outbound (remote tcp "*:443"))', '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))']);
  assert.match(p, /\(deny network-outbound\)/);
  assert.ok(!/localhost|127\.0\.0\.1|gateway\.sock|control\.sock/.test(p));
});

test('再現と直し：sandbox の中で、launcher の runtime command のままなら gateway へ渡して止まり、inProcessCommand なら同じ process で -z を受ける', { skip: !isMac || !PYTHON }, () => {
  const x = world();
  try {
    const args = ['-z', `Reply with the single word OK. (probe abc)`, '-t', 'file', '--usage-file', x.params.USAGE_FILE];
    const asPrinted = JSON.parse(printed(x.py, x.root));
    const before = boxed(x, [...asPrinted, ...args]);
    assert.equal(before.status, 1, before.stdout + before.stderr);
    assert.equal(classifyProbe(before), 'probe_gateway_transport', '本番の --check-only と同じ止まり方');

    const cmd = inProcessCommand(printed(x.py, x.root), x.root);
    assert.ok(cmd);
    const after = boxed(x, [...cmd, ...args]);
    assert.equal(after.status, 2, after.stderr);
    const got = JSON.parse(after.stdout.trim().split('\n').pop());
    assert.equal(got.inproc, 'Reply with the single word OK. (probe abc)');
    assert.equal(got.toolsets, 'file');
    assert.equal(got.usage_file, x.params.USAGE_FILE);
    assert.equal(got.resume, null);
    assert.equal(got.home, x.work, 'HERMES_HOME は業務の profile のまま');
    assert.ok(!/Gateway/.test(after.stderr));

    const resumed = boxed(x, [...cmd, ...args, '-r', 'old-session']);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /resume is not allowed/, '前の会話を続けさせない');
    assert.equal(classifyProbe(resumed), 'probe_inproc_unexpected');
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});

test('in-process の entry は _run_and_exit_oneshot の引数が v0.22.4 と違えば起動しない（監査 6）', { skip: !isMac || !PYTHON }, () => {
  assert.equal(INPROC_SIGNATURE, 'prompt,model,provider,toolsets,skills,usage_file,resume,reasoning');
  const x = world(FAKE_MAIN.replace('skills=None, usage_file=None', 'skills=None, usage=None'));
  try {
    const cmd = inProcessCommand(printed(x.py, x.root), x.root);
    const r = boxed(x, [...cmd, '-z', 'hi', '-t', 'file']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hermes oneshot signature changed/);
    assert.equal(classifyProbe(r), 'probe_inproc_unexpected');
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});

test('runtimeBootstrap は試験の写し（v0.22.4 の _launchers.runtime_command）と同じ文', () => {
  assert.equal(runtimeBootstrap('/Users/hermes/.hermes'), bootstrapOf('/Users/hermes/.hermes'));
});

test('macSys.exec：課金なしの確かめを通っていなければ Hermes を起動しない（exit 70・何も動かさない・監査 5）', async () => {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-exec-')));
  try {
    const store = { path: (n) => path.join(R, n) };
    const sys = macSys({ store, log: () => {}, outbox: R });
    const r = await sys.exec({ task_id: TASK }, { seconds: 1, prompt: 'x', runToken: 'abc' });
    assert.deepEqual(r, { exit: 70, signal: null, timedOut: false });
    assert.match(readFileSync(path.join(R, 'hermes-work-logs', `${TASK}.txt`), 'utf8'), /no launch command/);
  } finally { rmSync(R, { recursive: true, force: true }); }
});

