/**
 * Hermes の結果の書き（2026-11-18 夜・初回の実機の実行の no_result）。
 * 記録：exit 0・Haiku 5.5 の API 4 回・Hermes の出力「the outbox write was blocked by the OS ("Operation not permitted")」・
 *   「[write_file] Failed to write file: Operation not permitted: `…/outbox/.hermes-tmp.3a91a61c1a52`」。
 * 原因：Hermes の write_file は結果と同じ dir に一時 file（.hermes-tmp.<16 進 12 桁>）を O_EXCL で作って書き、os.replace で付け替える
 *   （4d04303 tools/file_operations_native.py の atomic_write）。sandbox は結果の 1 file しか書かせなかった（11-13 の「直接書く」は誤り）。
 * 直し：sandbox は結果の dir の .hermes-tmp.<12 hex> だけを足す（付け替え先は結果の 1 file のまま）。課金なしの確かめでも一時 file を作れるかを見る。
 *
 * 本物の Hermes の code：4d04303 の tools/file_operations_native.py（git の blob の sha で固定・標準 library だけ）の atomic_write を、
 *   本番と同じ sandbox の規則（buildProfile）の中で Python で動かす。HERMES_SRC を渡した時だけ。
 * 模擬：sandbox の書きの境（一時 file の名前の形・他の dir・他の結果への付け替え）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildProfile, RESULT_TMP_RE } from '../scripts/lib/hermes-sandbox.mjs';

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;
const TASK = 't-20261118073100-0000abcd';
const NATIVE = 'tools/file_operations_native.py';
const NATIVE_BLOB = '768534ff88aaf8999e16c80703fc5fbfcb782ffa';
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const SRC = process.env.HERMES_SRC ? path.join(process.env.HERMES_SRC, NATIVE) : null;
const realOk = SRC && existsSync(SRC) && blobSha(readFileSync(SRC)) === NATIVE_BLOB;
const bounded = (args) => spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', ...args], { encoding: 'utf8', timeout: 25_000, cwd: '/', env: { PATH: '/usr/bin:/bin' } });

function world() {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-write-')));
  const U = path.join(R, 'Users');
  const H = path.join(U, 'hermes');
  const root = path.join(H, '.hermes');
  const work = path.join(root, 'e-nexus-work');
  for (const p of [path.join(root, 'hermes-agent/tools'), path.join(root, 'tools'), path.join(root, 'installs'), path.join(work, 'cwd'), path.join(H, '.local/bin'), path.join(H, 'work'), path.join(U, 'Shared/w/inbox'), path.join(U, 'Shared/w/outbox'), path.join(U, 'Shared/w/other'), path.join(R, 'vf')]) mkdirSync(p, { recursive: true });
  writeFileSync(path.join(U, 'Shared/w/inbox', `${TASK}.json`), 'req');
  const outbox = path.join(U, 'Shared/w/outbox');
  const params = { USERS_ROOT: U, HERMES_ROOT: root, WORK_HOME: work, LOCAL_BIN: path.join(H, '.local/bin'), USAGE_FILE: path.join(H, 'work/u.json'), REQUEST: path.join(U, 'Shared/w/inbox', `${TASK}.json`), BRIEF: path.join(U, 'Shared/w/brief.json'), RESULT: path.join(outbox, `${TASK}.json`), SYSTEM_TMP: path.join(R, 'vf') };
  return { R, U, root, outbox, params };
}
const box = (profile, ...cmd) => bounded(['/usr/bin/sandbox-exec', '-p', profile, ...cmd]);
/** 11-18 夜の前の profile（一時 file の許しが無い） */
const beforeFix = (p) => buildProfile(p).split('\n').filter((l) => !l.includes('hermes-tmp')).join('\n');

test('模擬：Hermes の一時 file の名前の形（4d04303 の f".hermes-tmp.{secrets.token_hex(6)}"）', () => {
  assert.ok(RESULT_TMP_RE.test('.hermes-tmp.3a91a61c1a52'), '11-18 の実機の記録の名前');
  for (const bad of ['.hermes-tmp.3a91a61c1a5', '.hermes-tmp.3a91a61c1a52f', '.hermes-tmp.3A91A61C1A52', '.hermes-tmp.$$.abcdef', 'hermes-tmp.3a91a61c1a52', '.hermes-tmp.3a91a61c1a52/x']) assert.equal(RESULT_TMP_RE.test(bad), false, bad);
});

test('模擬：sandbox の書き：結果の dir の .hermes-tmp.<12 hex> だけ作れて結果の名前へ付け替えられる。他の名前・他の dir・他の依頼の結果への付け替えはできない', { skip: !isMac }, () => {
  const x = world();
  try {
    const prof = buildProfile(x.params);
    const tmp = path.join(x.outbox, '.hermes-tmp.0123456789ab');
    assert.equal(box(prof, '/usr/bin/touch', tmp).status, 0, '一時 file を作れる');
    assert.equal(box(prof, '/bin/mv', tmp, x.params.RESULT).status, 0, '結果の名前へ付け替えられる');
    assert.ok(existsSync(x.params.RESULT));
    rmSync(x.params.RESULT);
    assert.equal(box(prof, '/usr/bin/touch', tmp).status, 0);
    assert.notEqual(box(prof, '/bin/mv', tmp, path.join(x.outbox, 't-20261118000000-ffffffff.json')).status, 0, '他の依頼の結果の名前へは付け替えられない');
    assert.equal(box(prof, '/bin/rm', '-f', tmp).status, 0, '一時 file は消せる');
    for (const bad of [path.join(x.outbox, '.hermes-tmp.0123456789a'), path.join(x.outbox, '.hermes-tmp.zzzzzzzzzzzz'), path.join(x.outbox, '.probe-0123456789ab'), path.join(x.outbox, 'x.json'), path.join(x.U, 'Shared/w/other/.hermes-tmp.0123456789ab'), path.join(x.U, 'Shared/w/inbox/.hermes-tmp.0123456789ab')]) {
      assert.notEqual(box(prof, '/usr/bin/touch', bad).status, 0, `作れない：${bad}`);
    }
    assert.deepEqual(readdirSync(x.outbox), []);
    // 結果の dir の下にフォルダは作れない（「<結果>.json/x」で結果の名前がフォルダになりやり直せなくなるのを防ぐ・監査 11-18 夜）
    for (const d of [x.params.RESULT, path.join(x.outbox, '.hermes-tmp.0123456789ab'), path.join(x.outbox, 'sub')]) assert.notEqual(box(prof, '/bin/mkdir', d).status, 0, `フォルダは作れない：${d}`);
    assert.deepEqual(readdirSync(x.outbox), []);
    assert.equal(box(prof, '/usr/bin/touch', path.join(x.outbox, '.hermes-tmp.0123456789ab')).status, 0, 'file は作れる（require-all で両方の条件）');
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});

const WRITE_PY = String.raw`import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('file_operations_native', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps({'error': m.atomic_write(sys.argv[2], sys.argv[3].encode('utf-8'))}))
`;

test('本物の Hermes の code（tools/file_operations_native.atomic_write）：前の sandbox の規則では一時 file で EPERM（11-18 の実機と同じ）・今の規則では結果を書けて一時 file は残らない', { skip: !isMac || !PYTHON || !realOk ? 'HERMES_SRC に 4d04303 の tools/file_operations_native.py が無い' : false }, () => {
  const x = world();
  try {
    const mod = path.join(x.root, 'hermes-agent', NATIVE); // sandbox の中で読める所に置く（本番の code の置き場所と同じ）
    copyFileSync(SRC, mod);
    const body = JSON.stringify({ v: 1, task_id: TASK, status: 'done', summary: '運用見直し' });
    const run = (profile, target) => {
      const r = box(profile, PYTHON, '-I', '-B', '-c', WRITE_PY, mod, target, body);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').pop()).error;
    };
    const err = run(beforeFix(x.params), x.params.RESULT);
    assert.match(err, /Operation not permitted: .*\/outbox\/\.hermes-tmp\.[0-9a-f]{12}$/, '11-18 の実機の記録と同じ止まり方');
    assert.equal(existsSync(x.params.RESULT), false);
    assert.equal(run(buildProfile(x.params), x.params.RESULT), null, '今の規則では書ける');
    assert.equal(readFileSync(x.params.RESULT, 'utf8'), body);
    assert.deepEqual(readdirSync(x.outbox), [`${TASK}.json`], '一時 file は残らない（os.replace で付け替え）');
    // 2 回目（やり直し）：在る結果の上に書いても同じ（mode を写す道）
    assert.equal(run(buildProfile(x.params), x.params.RESULT), null);
    assert.deepEqual(readdirSync(x.outbox), [`${TASK}.json`]);
    // 他の依頼の結果は書けない（一時 file は作れても付け替えで止まり、Hermes が一時 file を消す）
    const other = run(buildProfile(x.params), path.join(x.outbox, 't-20261118000000-ffffffff.json'));
    assert.match(other, /Operation not permitted/);
    assert.deepEqual(readdirSync(x.outbox), [`${TASK}.json`], '失敗の時も一時 file は残らない');
    // 「<結果>.json/x」（makedirs で結果の名前をフォルダにする道）は止まり、何も残らない
    rmSync(x.params.RESULT);
    assert.match(run(buildProfile(x.params), path.join(x.params.RESULT, 'x')), /Operation not permitted|File exists|Not a directory/);
    assert.deepEqual(readdirSync(x.outbox), [], '結果の名前はフォルダにならない');
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});
