/**
 * 前の業務の home（~/.hermes/profiles/work）を、消さず・常駐の gateway を止めずに隔離する（2026-11-18 夜）。
 * hermes profile delete は gateway の停止と全部の削除の警告を出した（Human が中止）＝使わない。
 * 手順（scripts/hermes-work.mjs の isolateLegacyProfile）：空の gateway.parked（Hermes の正規の印）→ 常駐の記録で serve から外れたと読めたら
 * root の e-nexus-legacy/ へ mv -n（中身はそのまま）。
 *
 * 二つに分ける：
 *   模擬：isolateLegacyProfile を今の user と偽の root で動かす（hermes ユーザー・常駐の gateway の記録は模擬）
 *   本物の Hermes の code：v0.22.4（4d04303）の hermes_cli/profiles.py の profiles_to_serve と hermes_constants.py ほか（git の blob の sha で固定）を
 *     本番と同じ Python で動かし、隔離の前・印の後・移した後で「常駐が serve する一覧」「再起動の判定の一覧（include_parked）」を確かめる。
 *     ruamel.yaml と gateway.config._bool_token は空の代わり（この道では呼ばれない：config.yaml の無い profile）。HERMES_SRC を渡した時だけ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isolateLegacyProfile, LEGACY_ARCHIVE_DIR } from '../scripts/hermes-work.mjs';

const localRun = (args) => spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
const fast = { waitSeconds: 0, pollSeconds: 1, sleep: async () => {} };
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;

function world() {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-legacy-')));
  const H = path.join(R, 'hermes');
  const root = path.join(H, '.hermes');
  const legacy = path.join(root, 'profiles/work');
  for (const d of ['cron', 'hooks', 'memories', 'skills', 'cwd', 'sessions']) mkdirSync(path.join(legacy, d), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(legacy, 'SOUL.md'), 'soul\n');
  writeFileSync(path.join(legacy, 'state.db'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(legacy, 'sessions/probe.json'), '{"s":1}');
  writeFileSync(path.join(legacy, 'cron/.tick.lock'), '');
  return { R, H, root, legacy };
}
/** 常駐の記録（root の gateway_state.json）を書く。mtimeOffset 秒だけ印より後（負なら前） */
function gatewayState(x, served, { after = true } = {}) {
  const p = path.join(x.root, 'gateway_state.json');
  writeFileSync(p, JSON.stringify({ served_profiles: served }));
  const m = lstatSync(path.join(x.legacy, 'gateway.parked'), { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
  const t = (m + (after ? 5000 : -5000)) / 1000;
  utimesSync(p, t, t);
}
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).sort().map((n) => {
  const p = path.join(dir, n);
  return [n, lstatSync(p).isDirectory() ? 'dir' : readFileSync(p).toString('base64')];
}));

test('模擬：前の home が無ければ何もしない（absent）', async () => {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-legacy-')));
  try {
    mkdirSync(path.join(R, '.hermes/profiles'), { recursive: true });
    assert.deepEqual(await isolateLegacyProfile(localRun, path.join(R, '.hermes'), fast), { state: 'absent' });
  } finally { rmSync(R, { recursive: true, force: true }); }
});

test('模擬：gateway.parked を置く（空・0600）→ 常駐の記録が古い・まだ work を serve・読めない間は移さない → serve から外れたと読めたら e-nexus-legacy へ移す（中身は 1 byte も変えない）→ 2 回目は absent', async () => {
  const x = world();
  try {
    const before = snapshot(x.legacy);
    // 記録が無い：parked にして待つだけ
    let r = await isolateLegacyProfile(localRun, x.root, fast);
    assert.deepEqual(r, { state: 'parked', reason: 'state_unreadable' });
    const marker = path.join(x.legacy, 'gateway.parked');
    assert.equal(readFileSync(marker, 'utf8'), '');
    assert.equal(lstatSync(marker).mode & 0o777, 0o600);
    // 記録が印より古い（work を serve していた頃の記録）
    gatewayState(x, ['default', 'work'], { after: false });
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).reason, 'state_older_than_marker');
    // 記録は新しいがまだ serve している
    gatewayState(x, ['default', 'work']);
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).reason, 'still_served');
    // 形が違う記録は移す根拠にしない
    gatewayState(x, 'default');
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).reason, 'state_no_served_profiles');
    writeFileSync(path.join(x.root, 'gateway_state.json'), 'not json');
    utimesSync(path.join(x.root, 'gateway_state.json'), Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).reason, 'state_not_json');
    assert.ok(existsSync(x.legacy), 'ここまでは移さない');
    // 常駐が再走査で外した（記録は印より新しく work を含まない）→ 移す
    gatewayState(x, ['default']);
    r = await isolateLegacyProfile(localRun, x.root, { ...fast, stamp: '20261118T120000Z' });
    const dest = path.join(x.root, LEGACY_ARCHIVE_DIR, 'profiles-work-20261118T120000Z');
    assert.deepEqual(r, { state: 'moved', to: dest });
    assert.equal(existsSync(x.legacy), false);
    assert.equal(lstatSync(path.join(x.root, LEGACY_ARCHIVE_DIR)).mode & 0o777, 0o700);
    assert.deepEqual(snapshot(dest), { ...before, 'gateway.parked': '' }, '中身はそのまま（印が増えただけ）');
    assert.deepEqual(await isolateLegacyProfile(localRun, x.root, fast), { state: 'absent' });
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});

test('模擬：待つ間に常駐が外せば同じ実行の中で移す（再走査の 30 秒を待つ）', async () => {
  const x = world();
  try {
    let polls = 0;
    const sleep = async () => { polls += 1; if (polls === 2) gatewayState(x, ['default']); };
    const r = await isolateLegacyProfile(localRun, x.root, { waitSeconds: 70, pollSeconds: 5, sleep, stamp: 's' });
    assert.equal(r.state, 'moved');
    assert.equal(polls, 2);
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});

test('模擬（監査 M1）：記録から work が外れても、フォルダの中の file を開いた process が残る間は移さない（still_open）。閉じれば移す。前の回の印なら待たない', async () => {
  const x = world();
  let holder;
  try {
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).state, 'parked');
    gatewayState(x, ['default']);
    // 止めきれない turn の代わり：state.db を開いたままの process
    holder = spawn('/usr/bin/tail', ['-f', path.join(x.legacy, 'state.db')], { stdio: 'ignore' });
    await new Promise((r) => { setTimeout(r, 300); });
    let polls = 0;
    const r = await isolateLegacyProfile(localRun, x.root, { waitSeconds: 70, pollSeconds: 5, sleep: async () => { polls += 1; } });
    assert.equal(r.state, 'parked');
    assert.match(r.reason, /^still_open\(tail:\d+:\d+\)$/, '開いている process の名前・pid・数を記録に残す');
    assert.equal(polls, 0, '印は前の回の物＝待たずに 1 回だけ見る');
    assert.ok(existsSync(x.legacy));
    holder.kill('SIGKILL');
    await new Promise((res) => { holder.on('exit', res); });
    holder = null;
    const m = await isolateLegacyProfile(localRun, x.root, { ...fast, stamp: 'closed' });
    assert.equal(m.state, 'moved');
    assert.ok(existsSync(path.join(m.to, 'gateway.parked')) && !existsSync(path.join(m.to, 'work')), '移した物は dest 自身');
  } finally { holder?.kill('SIGKILL'); rmSync(x.R, { recursive: true, force: true }); }
});

test('模擬：link・持ち主の違う形・移す先が在る時は触らない（skipped・parked のまま）', async () => {
  const x = world();
  try {
    // 前の home が link
    const real = path.join(x.R, 'elsewhere');
    mkdirSync(real);
    rmSync(x.legacy, { recursive: true });
    symlinkSync(real, x.legacy);
    assert.deepEqual(await isolateLegacyProfile(localRun, x.root, fast), { state: 'skipped', reason: 'legacy_not_plain_dir' });
    assert.deepEqual(readdirSync(real), [], 'link の先に印を置かない');
    rmSync(x.legacy);
    // 印の位置に link
    mkdirSync(x.legacy);
    symlinkSync(path.join(x.R, 'target'), path.join(x.legacy, 'gateway.parked'));
    assert.deepEqual(await isolateLegacyProfile(localRun, x.root, fast), { state: 'skipped', reason: 'marker_not_plain_file' });
    assert.equal(existsSync(path.join(x.R, 'target')), false, 'link の先を作らない');
    rmSync(path.join(x.legacy, 'gateway.parked'));
    // 移す先が在る（上書きしない）
    mkdirSync(path.join(x.root, LEGACY_ARCHIVE_DIR, 'profiles-work-same'), { recursive: true });
    writeFileSync(path.join(x.legacy, 'gateway.parked'), '');
    gatewayState(x, ['default']);
    assert.deepEqual(await isolateLegacyProfile(localRun, x.root, { ...fast, stamp: 'same' }), { state: 'parked', reason: 'dest_exists' });
    assert.ok(existsSync(x.legacy));
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});

// ── 本物の Hermes の code ─────────────────────────────────────────────────────────────────────────
/** v0.22.4（4d04303818b61bf3aa09278af48356315515965b）の file の git の blob の sha */
const REAL = {
  'hermes_constants.py': 'f9897c96cc49c6e8b19f1a501715e064c99d182d',
  'utils.py': '095cbff16e231dd062714168312b951a31d8a2b8',
  'hermes_yaml.py': '4cd43d3cbda1f22974c29fc59dbabef50455f892',
  'agent/__init__.py': '9555e8210179a1b4e6245bf69bf71039f7bb29ae',
  'agent/jiter_preload.py': '61b90820b83b1411496e5e38da09e25b34a17da8',
  'agent/file_safety.py': '31bd2c8f0f944d101da2ac62adfd6888d2d5a878',
  'hermes_cli/__init__.py': '9ccc4b297d6db08b773cc48eab4dea1af4ce5683',
  'hermes_cli/profiles.py': 'f81e091e64d11359caf850656e8b4611b21c820e',
  'hermes_cli/archive_safe.py': 'adc0f01b62de8b81035d88fbfa9810611b731767',
  'hermes_cli/home_data_layout.py': '72be9bb82ee907210cbf07accf2137661ea0d06d',
  'hermes_cli/profiles_remove.py': '9c2f75280ad8f1c5f17ad6d45a0af8698975b50c',
};
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const SRC = process.env.HERMES_SRC ?? null;
const realOk = SRC && Object.entries(REAL).every(([p, sha]) => existsSync(path.join(SRC, p)) && blobSha(readFileSync(path.join(SRC, p))) === sha);
const JUDGE = String.raw`import json, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from hermes_cli import profiles as p
print(json.dumps({'serve': [n for n, _ in p.profiles_to_serve(True)], 'boot': [n for n, _ in p.profiles_to_serve(True, include_parked=True)]}))
`;

test('本物の Hermes の code（profiles.profiles_to_serve）：前の home は serve されている → gateway.parked で serve から外れるが再起動の判定には残る → e-nexus-legacy へ移すと両方から消える。新しい業務の home はどれにも出ない', { skip: !realOk || !PYTHON ? 'HERMES_SRC に 4d04303 の file が無い' : false }, async () => {
  const x = world();
  const stub = path.join(x.R, 'stub');
  try {
    mkdirSync(path.join(stub, 'ruamel/yaml'), { recursive: true });
    mkdirSync(path.join(stub, 'gateway'), { recursive: true });
    writeFileSync(path.join(stub, 'ruamel/__init__.py'), '');
    writeFileSync(path.join(stub, 'ruamel/yaml/__init__.py'), 'class YAML:\n    def __init__(self, *a, **k):\n        raise RuntimeError("stub: YAML is not parsed on this path")\n');
    writeFileSync(path.join(stub, 'ruamel/yaml/error.py'), 'class YAMLError(Exception):\n    pass\n');
    writeFileSync(path.join(stub, 'ruamel/yaml/resolver.py'), 'class VersionedResolver:\n    pass\n');
    writeFileSync(path.join(stub, 'gateway/__init__.py'), '');
    writeFileSync(path.join(stub, 'gateway/config.py'), 'def _bool_token(v):\n    raise RuntimeError("stub: not on this path")\n');
    mkdirSync(path.join(x.root, 'e-nexus-work/sessions'), { recursive: true });
    writeFileSync(path.join(x.root, 'e-nexus-work/SOUL.md'), 'x');
    writeFileSync(path.join(x.root, 'e-nexus-work/state.db'), '');
    const judge = () => {
      const r = spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', PYTHON, '-I', '-B', '-c', JUDGE, SRC, stub],
        { encoding: 'utf8', timeout: 25_000, cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: x.H } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    assert.deepEqual(judge(), { serve: ['default', 'work'], boot: ['default', 'work'] }, '今：常駐が work を serve している');
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).state, 'parked');
    assert.deepEqual(judge(), { serve: ['default'], boot: ['default', 'work'] }, '印の後：serve と cron からは外れるが、再起動の判定には残る');
    gatewayState(x, ['default']);
    assert.equal((await isolateLegacyProfile(localRun, x.root, fast)).state, 'moved');
    assert.deepEqual(judge(), { serve: ['default'], boot: ['default'] }, '移した後：常駐は 1 つの profile の形に戻れる（次の再起動から）');
  } finally { rmSync(x.R, { recursive: true, force: true }); }
});
