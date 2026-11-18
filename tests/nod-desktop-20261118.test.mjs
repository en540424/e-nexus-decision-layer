/**
 * Nod（試験導入・2026-11-18）の起動・完全終了・見張りの道具（scripts/lib/nod/desktop.mjs・scripts/nod-desktop.mjs・host-health の nod_desktop）。
 * 実の Nod は起動しない：command は全部偽物の run（記録して返すだけ）。fixture の vm_stat は 2026-11-18 の Mac mini の実の出力の形。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, safeValue } from '../scripts/host-health.mjs';
import { alertLine, ruleOf } from '../scripts/lib/alert-policy.mjs';
import { classify } from '../scripts/lib/ops-classify.mjs';
import {
  APP_PATTERN, CLI_BINS, GATE, LAUNCH_ENV, QUIT_SCRIPT, RUNNING_LONG_SECONDS, gateCheck, makeNodRunner, nodDesktopItem, observeNod,
  parseDfAvail, parseEtime, parsePsRows, parseSwapUsed, parseVmStatAvailable, pidsOf, runtimePattern, startNod, stopNod, vmSize,
} from '../scripts/lib/nod/desktop.mjs';
import { main, parse } from '../scripts/nod-desktop.mjs';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    10997.
Pages active:                                 654212.
Pages inactive:                               652214.
Pages speculative:                               948.
Pages throttled:                                   0.
Pages wired down:                             216267.
Pages purgeable:                               10753.
`;
const GiB = 1024 ** 3;
const HOME = '/Users/operator';

/** 偽物の run：bin と args を記録し、表の答えを返す（無ければ exit 1・空） */
function fakeRun(answer) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    const r = answer(bin, args);
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...r };
  };
  return { run, calls };
}
const none = { code: 1, stdout: '' };

test('出力の読み取り：vm_stat・swap・df・etime・pgrep・ps', () => {
  assert.equal(parseVmStatAvailable(VM_STAT), (10997 + 652214 + 948 + 10753) * 16384);
  assert.equal(parseVmStatAvailable('nothing'), null);
  assert.equal(parseVmStatAvailable(VM_STAT.replace(/Pages purgeable.*\n/, '')), null); // 欠けたら読めない（止める側）
  assert.equal(parseSwapUsed('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)'), 0);
  assert.equal(parseSwapUsed('total = 2048.00M  used = 1536.50M  free = 511.50M'), 1536.5 * 1024 ** 2);
  assert.equal(parseSwapUsed('x'), null);
  assert.equal(parseDfAvail('Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 482000000 143000000 297000000 33% /System/Volumes/Data'), 297000000 * 1024);
  assert.equal(parseEtime('05:07'), 307);
  assert.equal(parseEtime('02:05:07'), 7507);
  assert.equal(parseEtime('14-03:38:48'), 14 * 86400 + 3 * 3600 + 38 * 60 + 48);
  assert.equal(parseEtime('bad'), null);
  assert.deepEqual(pidsOf({ code: 1, stdout: '' }), []); // pgrep の「無い」は失敗ではない
  assert.deepEqual(pidsOf({ code: 0, stdout: '12\n34\n' }), [12, 34]);
  assert.equal(pidsOf({ code: 2, stdout: '' }), null);
  assert.equal(pidsOf({ code: 0, stdout: '1', timedOut: true }), null);
  assert.deepEqual(parsePsRows('  05:00  1024\n1-00:00:00 2048\n'), { oldest_seconds: 86400, rss_bytes: 3072 * 1024, count: 2 });
});

test('VM の大きさは v0.8.4 の式（memory は物理の半分を 3〜6 GiB に・cpus は 2〜4）', () => {
  assert.deepEqual(vmSize({ memBytes: 32 * GiB, ncpu: 12 }), { memory_gib: 6, cpus: 4, disk_gib: 24 });
  assert.deepEqual(vmSize({ memBytes: 8 * GiB, ncpu: 8 }), { memory_gib: 4, cpus: 4, disk_gib: 24 });
  assert.deepEqual(vmSize({ memBytes: 4 * GiB, ncpu: 1 }), { memory_gib: 3, cpus: 2, disk_gib: 24 });
});

test('process の照合は行の頭に固定：その path を引数に書いただけの shell・du・grep は数えない', () => {
  const rt = new RegExp(runtimePattern(HOME));
  const app = new RegExp(APP_PATTERN);
  assert.ok(rt.test(`${HOME}/Library/Application Support/nod/runtime/09d5/lima/bin/limactl hostagent --pidfile x nod`));
  assert.ok(rt.test(`${HOME}/Library/Application Support/nod/profiles/local/desktop-runtime/limactl-stop stop nod`));
  assert.ok(rt.test(`${HOME}/.nod-desktop/abc/_lima/bin/x`));
  assert.ok(!rt.test(`/usr/bin/du -sk ${HOME}/.nod-desktop/`));
  assert.ok(!rt.test(`/bin/zsh -c ls '${HOME}/Library/Application Support/nod/runtime/'`));
  assert.ok(!rt.test(`/Users/other/Library/Application Support/nod/runtime/x`)); // 別の user の Nod は数えない
  assert.ok(app.test('/Applications/Nod.app/Contents/MacOS/nod'));
  assert.ok(app.test('/Applications/Nod.app/Contents/MacOS/nod --onboarding'));
  // 本体だけ：helper・更新の ShipIt が残っただけで「動いている」と読まない（監査 M1：止まった app へ quit を送らない・VM の残りを見落とさない）
  assert.ok(!app.test('/Applications/Nod.app/Contents/Frameworks/Nod Helper (Renderer).app/Contents/MacOS/Nod Helper (Renderer) --type=renderer'));
  assert.ok(!app.test('/Applications/Nod.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt dev.nod.desktop.ShipIt /x'));
  assert.ok(!app.test('/Applications/Nod.app/Contents/MacOS/nodx'));
  assert.ok(!app.test('/Applications/NodXapp/x'));
  assert.ok(!app.test('/usr/bin/codesign -dv /Applications/Nod.app/'));
});

/** 観測の偽物：app と runtime の pid と etime を表で返す */
function nodWorld({ app = [], runtime = [], pgrepTimeout = false }) {
  return fakeRun((bin, args) => {
    if (bin === '/usr/bin/pgrep') {
      if (pgrepTimeout) return { code: -1, timedOut: true };
      const rows = args[1] === APP_PATTERN ? app : runtime;
      return rows.length ? { stdout: `${rows.map((r) => r.pid).join('\n')}\n` } : none;
    }
    if (bin === '/bin/ps') {
      const pids = args.at(-1).split(',').map(Number);
      return { stdout: [...app, ...runtime].filter((r) => pids.includes(r.pid)).map((r) => `${r.etime} ${r.kb}`).join('\n') };
    }
    return none;
  });
}

test('見張りの項目：入っていなければ無し・動いていない・動いている・4 時間以上・VM だけ残った・確かめられない', async () => {
  const item = async (w, installed = true) => nodDesktopItem(await observeNod({ run: w.run, home: HOME, installed }));
  assert.equal(await item(nodWorld({}), false), null);
  assert.deepEqual(await item(nodWorld({})), { id: 'nod_desktop', level: 'ok', value: 'not_running', kind: 'state' });
  assert.equal((await item(nodWorld({ app: [{ pid: 10, etime: '10:00', kb: 400000 }], runtime: [{ pid: 11, etime: '09:00', kb: 90000 }] }))).value, 'running');
  const long = await item(nodWorld({ app: [{ pid: 10, etime: '04:00:01', kb: 1 }] }));
  assert.deepEqual([long.level, long.value], ['warn', 'running_long']);
  assert.equal(RUNNING_LONG_SECONDS, 4 * 3600);
  const left = await item(nodWorld({ runtime: [{ pid: 11, etime: '01:00', kb: 1 }] }));
  assert.deepEqual([left.level, left.value], ['warn', 'vm_left']);
  const bad = await item(nodWorld({ pgrepTimeout: true }));
  assert.deepEqual([bad.level, bad.value], ['warn', 'check_failed']);
  // ps が読めない＝check_failed（長さの見張りを黙って外さない）・pgrep と ps の間に終わった＝無い（監査 L4）
  const psDown = fakeRun((bin) => (bin === '/usr/bin/pgrep' ? { stdout: '10\n' } : { code: -1, timedOut: true }));
  assert.equal((await item(psDown)).value, 'check_failed');
  const gone = fakeRun((bin) => (bin === '/usr/bin/pgrep' ? { stdout: '10\n' } : { code: 1, stdout: '' }));
  assert.equal((await item(gone)).value, 'not_running');
  // 他の process の一覧を取らない：pgrep は固定の 2 つの形だけ・ps は見つけた pid だけ
  const w = nodWorld({ app: [{ pid: 10, etime: '10:00', kb: 1 }] });
  await observeNod({ run: w.run, home: HOME, installed: true });
  for (const c of w.calls) {
    if (c[0] === '/usr/bin/pgrep') assert.ok([APP_PATTERN, runtimePattern(HOME)].includes(c[2]));
    else { assert.equal(c[0], '/bin/ps'); assert.equal(c.at(-1), '10'); }
  }
});

test('起動の前の関所：VM の分＋余裕・swap・圧迫・ディスク。読めない値は止める側', async () => {
  const world = ({ vm = VM_STAT, swap = 'total = 0.00M  used = 0.00M  free = 0.00M', pressure = '1\n', df = 'F\n/dev/x 1 1 297000000 1% /System/Volumes/Data' } = {}) => fakeRun((bin, args) => {
    if (bin === '/usr/bin/vm_stat') return vm === null ? { code: 1 } : { stdout: vm };
    if (bin === '/usr/sbin/sysctl') { const v = args[1] === 'vm.swapusage' ? swap : pressure; return v === null ? { code: 1 } : { stdout: v }; }
    if (bin === '/bin/df') return df === null ? { code: 1 } : { stdout: df };
    return none;
  }).run;
  const ok = await gateCheck({ run: world(), memBytes: 32 * GiB, ncpu: 12 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.facts.need_gib, 6 + GATE.margin_gib);
  const low = await gateCheck({ run: world({ vm: VM_STAT.replace('652214', '100000') }), memBytes: 32 * GiB, ncpu: 12 });
  assert.deepEqual(low.codes, ['memory_low']);
  assert.deepEqual((await gateCheck({ run: world({ swap: 'total = 4096.00M  used = 2048.00M  free = 2048.00M' }), memBytes: 32 * GiB, ncpu: 12 })).codes, ['swap_in_use']);
  assert.deepEqual((await gateCheck({ run: world({ pressure: '2\n' }), memBytes: 32 * GiB, ncpu: 12 })).codes, ['memory_pressure']);
  assert.deepEqual((await gateCheck({ run: world({ df: 'F\n/dev/x 1 1 1000000 1% /' }), memBytes: 32 * GiB, ncpu: 12 })).codes, ['disk_low']);
  assert.deepEqual((await gateCheck({ run: world({ vm: null, swap: null, pressure: null, df: null }), memBytes: 32 * GiB, ncpu: 12 })).codes, ['unknown_memory', 'unknown_swap', 'unknown_pressure', 'unknown_disk']);
});

test('起動：動いている・VM が残っている時は open しない。open には解析を切る環境変数を渡す', async () => {
  const obs = (o) => async () => ({ installed: true, ok: true, app: null, runtime: null, ...o });
  for (const [o, code] of [[{ app: { pids: [1] } }, 'already_running'], [{ runtime: { pids: [2] } }, 'vm_left'], [{ ok: false }, 'check_failed'], [{ installed: false }, 'not_installed']]) {
    const w = fakeRun(() => ({}));
    assert.equal((await startNod({ run: w.run, observe: obs(o) })).code, code);
    assert.equal(w.calls.length, 0);
  }
  const w = fakeRun(() => ({}));
  assert.equal((await startNod({ run: w.run, observe: obs({}) })).code, 'started');
  assert.equal(w.calls.length, 1);
  const [bin, ...args] = w.calls[0];
  assert.equal(bin, '/usr/bin/open');
  assert.deepEqual(args.slice(0, 3), ['-g', '-a', '/Applications/Nod.app']);
  for (const e of LAUNCH_ENV) assert.ok(args.includes(e) && args[args.indexOf(e) - 1] === '--env');
  for (const e of ['NOD_ANALYTICS_ENABLED=false', 'NOD_FEEDBACK_URL=', 'NOD_ONBOARDING_EMAIL_URL=']) assert.ok(LAUNCH_ENV.includes(e));
});

test('完全終了：止まっている時は quit を送らない（AppleScript が起動しうる）・消えるまで待つ・残れば残った物のコード・強制の停止はしない', async () => {
  const seq = (states) => { let i = 0; return async () => ({ installed: true, ok: true, app: null, runtime: null, ...states[Math.min(i++, states.length - 1)] }); };
  const opts = { waitMs: 10_000, pollMs: 1000, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })() };
  const cases = [
    [[{}], 'already_stopped', 0],
    [[{ runtime: { pids: [2] } }], 'vm_left', 0],
    [[{ app: { pids: [1] }, runtime: { pids: [2] } }, { app: { pids: [1] }, runtime: { pids: [2] } }, {}], 'stopped', 1],
    [[{ app: { pids: [1] } }], 'app_still_running', 1],
    [[{ app: { pids: [1] }, runtime: { pids: [2] } }, { runtime: { pids: [2] } }], 'vm_left', 1],
  ];
  for (const [states, code, quits] of cases) {
    const w = fakeRun(() => ({}));
    const r = await stopNod({ run: w.run, observe: seq(states), ...opts, now: (() => { let t = 0; return () => (t += 1000); })() });
    assert.equal(r.code, code, JSON.stringify(states));
    assert.equal(w.calls.length, quits);
    for (const c of w.calls) assert.deepEqual(c, ['/usr/bin/osascript', '-e', QUIT_SCRIPT]);
  }
  // quit の文は app が動いている時だけ quit する（is running は起動しない）
  assert.match(QUIT_SCRIPT, /^if application id "dev\.nod\.desktop" is running then tell application id "dev\.nod\.desktop" to quit$/);
  // 返事が失敗・時間切れでも待つ窓の間は見続ける（監査 L1）
  const fail = fakeRun(() => ({ code: 1 }));
  const clock = () => { let t = 0; return () => (t += 1000); };
  assert.equal((await stopNod({ run: fail.run, observe: seq([{ app: { pids: [1] } }]), ...opts, now: clock() })).code, 'quit_unconfirmed');
  const slow = fakeRun(() => ({ code: -1, timedOut: true }));
  assert.equal((await stopNod({ run: slow.run, observe: seq([{ app: { pids: [1] } }, {}]), ...opts, now: clock() })).code, 'stopped');
});

test('command の許可：kill・pkill・limactl・rm は実行しない', async () => {
  const run = makeNodRunner({ execFileImpl: () => assert.fail('must not exec') });
  for (const bin of ['/bin/kill', '/usr/bin/pkill', '/usr/bin/killall', '/bin/rm', 'limactl', '/bin/sh']) await assert.rejects(run(bin, []), /command not allowed/);
  for (const bin of ['/bin/kill', '/usr/bin/pkill', '/usr/bin/killall', '/bin/rm', '/bin/sh']) assert.ok(!CLI_BINS.includes(bin));
});

test('CLI：引数の検査・start と session は Terminal の Human だけ（tty でなければ何も実行しない）', async () => {
  assert.throws(() => parse(['launch']), /command must be/);
  assert.throws(() => parse(['stop', '--wait', '5']), /--wait/);
  assert.throws(() => parse(['measure', '--label', 'A B']), /unknown argument/);
  assert.deepEqual(parse(['stop', '--wait', '60']), { command: 'stop', wait: 60, label: 'snapshot' });
  const w = fakeRun(() => ({}));
  const write = process.stdout.write;
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  try {
    for (const cmd of ['start', 'session']) assert.equal(await main([cmd], w.run), 1);
  } finally { process.stdout.write = write; }
  assert.match(printed, /needs_terminal/);
  assert.equal(w.calls.length, 0);
});

test('host-health：値はコードだけ通す・知らせの文と仕分けが在る', () => {
  for (const v of ['not_running', 'running', 'running_long', 'vm_left', 'check_failed']) assert.equal(safeValue('nod_desktop', v), v);
  assert.equal(safeValue('nod_desktop', '/Users/operator/.nod-desktop'), '[redacted]');
  const rule = ruleOf('nod_desktop');
  assert.equal(rule.target, 'Nod（試験導入）');
  assert.match(alertLine({ id: 'nod_desktop', level: 'warn', value: 'vm_left' }), /VM が残っている/);
  assert.equal(classify('nod_desktop').class, 'human'); // Human の作業中の Nod を AI が止めない（監査 M4）
  assert.equal(rule.codes, true);
});

test('host-health の知らせ：4 時間の知らせの後に VM が残れば、もう一度知らせる（値が変わった＝codes・監査 H1）。1 回の確かめの失敗では知らせない', () => {
  const T = Date.parse('2026-11-20T00:00:00Z');
  const at = (i) => new Date(T + i * 30 * 60_000).toISOString();
  const play = (values) => { let prev = null; const sent = []; values.forEach((v, i) => { const level = ['not_running', 'running'].includes(v) ? 'ok' : 'warn'; const d = decide([{ id: 'nod_desktop', level, value: v, kind: 'state' }], prev, { now: at(i) }); for (const n of d.notify) sent.push([i, n.value]); prev = { items: d.items, bursts: d.bursts }; }); return sent; };
  const sent = play(['running', 'running_long', 'running_long', 'running_long', 'vm_left', 'vm_left', 'vm_left', 'vm_left']);
  assert.deepEqual(sent.map(([, v]) => v), ['running_long', 'vm_left']);
  assert.deepEqual(play(['not_running', 'check_failed', 'not_running', 'not_running']), [], '1 回の pgrep の時間切れで Discord へ送らない');
});
