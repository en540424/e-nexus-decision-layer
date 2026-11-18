/**
 * 実際に入っている Hermes と、こちらの起動の確かめ（lib/hermes-sandbox.mjs の inProcessCommand）を照らす（2026-11-18 夜・sudo 不要）。
 * 11-18 夜の --check-only は hermes_launcher_unexpected で止まった：本番の launcher が出した python の path
 * （~/.hermes/tools/python-3.14.7+20260901-darwin-arm64/bin/python3）の + を、path の字の許しが拒んだ。bootstrap は 4d04303 の文と全文で同じだった。
 * それまでの試験は偽の名前（tools/py/bin/python3）で、実物の名前を通していなかった。
 *
 * 三つ：
 *   実物の出力：本番の `hermes --print-runtime-command`（Human の --check-only が store の hermes-work-logs に残した 1 行）をそのまま使う
 *   実物の常駐：今動いている常駐の gateway の command line（ps で読める・hermes の home は読まない）の launcher の script が、
 *     4d04303 の hermes_cli/_launchers.py の _launcher_script の出力と全文で同じか（＝入っている launcher の版）。その python の path も確かめを通るか。
 *     常駐が見えない時・HERMES_SRC に 4d04303 の file が無い時は skip（pm.environments は空の代わり：_launcher_script は使わない）
 *   模擬：path の字の許しの境（+ は許し、shell と SBPL で意味の在る字は拒む）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INPROC_ENTRY, inProcessCommand, RUNTIME_ENTRY, runtimeBootstrap } from '../scripts/lib/hermes-sandbox.mjs';

const ROOT = '/Users/hermes/.hermes';
const REAL_PY = `${ROOT}/tools/python-3.14.7+20260901-darwin-arm64/bin/python3`;
/** 2026-11-18 19:46 JST に本番の Hermes が sandbox の中で出した runtime command（store の hermes-work-logs/<task>-launcher.txt の 2 行目そのまま） */
const REAL_PRINTED = `["${REAL_PY}", "-I", "-c", "import os, sys, runpy; os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); os.environ.pop('VIRTUAL_ENV', None); sys.path.insert(0, '/Users/hermes/.hermes/hermes-agent'); sys._hermes_pin_default_home = True; import hermes_bootstrap; os.environ.get('HERMES_HOME') or os.environ.__setitem__('HERMES_HOME', str(__import__('hermes_constants').get_default_hermes_root())); runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"]`;

test('実物の出力：本番の launcher が出した runtime command を受け入れる（python は + の在る store の名前・bootstrap は 4d04303 の文と全文で同じ）', () => {
  const [, , , boot] = JSON.parse(REAL_PRINTED);
  assert.equal(boot, runtimeBootstrap(ROOT), 'bootstrap は 4d04303 の _launchers.runtime_command と同じ');
  const cmd = inProcessCommand(`exit=0 signal=\n${REAL_PRINTED}\n`, ROOT);
  assert.ok(cmd, '11-18 夜はここで null＝hermes_launcher_unexpected だった');
  assert.deepEqual(cmd.slice(0, 3), [REAL_PY, '-I', '-c']);
  assert.equal(cmd[3], `${boot.slice(0, -RUNTIME_ENTRY.length)}exec(${JSON.stringify(INPROC_ENTRY)})`);
});

test('模擬：python の path の字の許しの境（+ は許す・空白・引用符・$・`・;・改行・.. は拒む・置き場所は hermes-agent・tools・installs だけ）', () => {
  const boot = runtimeBootstrap(ROOT);
  const ok = (py) => inProcessCommand(JSON.stringify([py, '-I', '-c', boot]), ROOT) !== null;
  for (const py of [REAL_PY, `${ROOT}/tools/python-3.13.9+20250101-darwin-arm64/bin/python3.13`, `${ROOT}/installs/k/env/bin/python3`]) assert.equal(ok(py), true, py);
  for (const py of [`${ROOT}/tools/py thon/bin/python3`, `${ROOT}/tools/py"x/bin/python3`, `${ROOT}/tools/py$x/bin/python3`, `${ROOT}/tools/py\`x/bin/python3`,
    `${ROOT}/tools/py;x/bin/python3`, `${ROOT}/tools/py\nx/bin/python3`, `${ROOT}/tools/../e-nexus-work/bin/python3`, `${ROOT}/tools/+x/bin/python3`,
    `${ROOT}/e-nexus-work/bin/python3`, `${ROOT}/tools/python-3.14.7+20260901-darwin-arm64/bin/sh`, `${ROOT}/installs/k/.leases/python3`]) assert.equal(ok(py), false, py);
});

// ── 実物の常駐（sudo 不要・読むだけ） ──────────────────────────────────────────────────────────────
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;
const REAL = { 'hermes_cli/_launchers.py': '1e6eb47bc27dd07f37a416cf8b3e62f47b8ab9ad', 'hermes_cli/_early_recovery.py': '8630b0fc6993cf9bafc4b0dc2f799e78a3f213ec', 'hermes_cli/__init__.py': '9ccc4b297d6db08b773cc48eab4dea1af4ce5683' };
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const SRC = process.env.HERMES_SRC ?? null;
const srcOk = SRC && Object.entries(REAL).every(([p, sha]) => existsSync(path.join(SRC, p)) && blobSha(readFileSync(path.join(SRC, p))) === sha);
const GATEWAY = 'gateway run --external-supervisor';
function residentCmdline() {
  if (process.platform !== 'darwin') return null;
  const pg = spawnSync('/usr/bin/pgrep', ['-U', 'hermes', '-f', GATEWAY], { encoding: 'utf8', timeout: 10_000 });
  const pid = String(pg.stdout ?? '').trim().split('\n').find((l) => /^\d+$/.test(l));
  if (!pid) return null;
  const ps = spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 10_000 });
  const line = String(ps.stdout ?? '').replace(/\n$/, '');
  return line.includes(' -I -c ') && line.endsWith(` ${GATEWAY}`) ? line : null;
}
const resident = residentCmdline();

test('実物の常駐：今動いている常駐の gateway の launcher は 4d04303 の _launcher_script と全文で同じ・その python の path を確かめが受け入れる', { skip: !resident ? '常駐の gateway が見えない' : !srcOk || !PYTHON ? 'HERMES_SRC に 4d04303 の _launchers.py が無い' : false }, () => {
  const i = resident.indexOf(' -I -c ');
  const py = resident.slice(0, i);
  // ps は script の改行を \012 で出す
  const code = resident.slice(i + ' -I -c '.length, -(` ${GATEWAY}`.length)).replace(/\\012/g, '\n');
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-launcher-')));
  try {
    mkdirSync(path.join(R, 'pm'), { recursive: true });
    writeFileSync(path.join(R, 'pm/__init__.py'), '');
    writeFileSync(path.join(R, 'pm/environments.py'), 'def owning_home_root(*a, **k):\n    raise RuntimeError("stub")\ndef store_root(*a, **k):\n    raise RuntimeError("stub")\n');
    const gen = String.raw`import sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from hermes_cli._launchers import _launcher_script
sys.stdout.write(_launcher_script('hermes', Path(sys.argv[3]), None))
`;
    const r = spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', PYTHON, '-I', '-B', '-c', gen, SRC, R, `${ROOT}/hermes-agent`],
      { encoding: 'utf8', timeout: 25_000, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(code, r.stdout, '入っている launcher は 4d04303 の物（版の食い違いなし）');
  } finally { rmSync(R, { recursive: true, force: true }); }
  assert.ok(py.startsWith(`${ROOT}/tools/`), py);
  assert.ok(inProcessCommand(JSON.stringify([py, '-I', '-c', runtimeBootstrap(ROOT)]), ROOT), `常駐の python（${py}）を確かめが受け入れる`);
});
