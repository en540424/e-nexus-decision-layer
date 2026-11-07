/**
 * Mac mini のホスト監視（2026-10-21・MA-22・Mac Runtime 工程 3）。READ-ONLY・許可したコマンドだけ・Trading Lab の領域を見ない・
 * 状態が変わった時だけ知らせる・PAUSE／DISABLED・Secret とパスを出さない。コマンドは実行せず fixture で差し替える（Windows でも通る）。
 * fixture は 2026-10-21 の Mac mini の実出力（gateway の IP は文書用アドレスへ置換）。UPS・発熱の警告は実機に無い状態なので合成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import {
  ALLOWED_BINS, TRADING_LAB_PATH, makeRunner, collect, evaluate, evaluateEvents, decide, runHostHealth, postAlerts, webhookBodyOf,
  parseDfAvailableBytes, parseSwapUsedBytes, parseLoadavg, parseBoottime, parseThermal, parsePowerSource, parseRoute, parseLaunchctlPrint,
  parseEtimeSeconds, parsePsUsage, parseArgs, validateArgs, DISABLED_REMIND_MS, GAP_MS, PAUSE_MAX_MS, RECOVER_RUNS, alertText, safeValue, isDiscordWebhook, monitorGapEvent, pauseState, recordFailure,
} from '../scripts/host-health.mjs';

const OUT = {
  df: 'Filesystem     1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s1s1   482746452  14092324 337437064     5%  484017 3374370640    0%   /\n',
  pressure: '1\n',
  swap: 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n',
  loadavg: '{ 1.61 1.78 1.71 }\n',
  ncpu: '12\n',
  boottime: '{ sec = 1790751889, usec = 572739 } Wed Sep 30 16:04:49 2026\n',
  therm: 'Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n',
  ps: "Now drawing from 'AC Power'\n",
  route: '   route to: default\ndestination: default\n       mask: default\n    gateway: 192.0.2.1\n  interface: en1\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n',
  launchctlLoaded: 'gui/501/com.e-nexus.usage-digest = {\n\tactive count = 0\n\tpath = /Users/x/Library/LaunchAgents/com.e-nexus.usage-digest.plist\n\tstate = not running\n\truns = 3\n\tlast exit code = 0\n\tspawn type = background (1)\n}\n',
};

/** 呼ばれた argv を記録し、key（bin と引数を空白で結合）で出力を返す */
function fixtureRunner(overrides = {}) {
  const calls = [];
  const table = {
    '/bin/df -k /': { code: 0, stdout: OUT.df },
    '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level': { code: 0, stdout: OUT.pressure },
    '/usr/sbin/sysctl -n vm.swapusage': { code: 0, stdout: OUT.swap },
    '/usr/sbin/sysctl -n vm.loadavg': { code: 0, stdout: OUT.loadavg },
    '/usr/sbin/sysctl -n hw.ncpu': { code: 0, stdout: OUT.ncpu },
    '/usr/sbin/sysctl -n kern.boottime': { code: 0, stdout: OUT.boottime },
    '/usr/bin/pmset -g therm': { code: 0, stdout: OUT.therm },
    '/usr/bin/pmset -g ps': { code: 0, stdout: OUT.ps },
    '/sbin/route -n get default': { code: 0, stdout: OUT.route },
    ...overrides,
  };
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    if (!ALLOWED_BINS.includes(bin)) throw new Error(`not allowed: ${bin}`);
    const key = [bin, ...args].join(' ');
    if (table[key]) return { timedOut: false, ...table[key] };
    if (bin === '/bin/launchctl') return { code: 113, stdout: '', timedOut: false }; // 未登録
    if (bin === '/usr/bin/du') return { code: 0, stdout: `2048\t${args[1]}\n`, timedOut: false };
    return { code: 1, stdout: '', timedOut: false };
  };
  return { run, calls };
}

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'edl-host-health-'));
}
const T0 = new Date('2026-10-21T03:20:00Z');
const later = (ms) => () => new Date(T0.getTime() + ms);

/** 保守窓の印を test の時刻に置く（fixture の時刻は実際の時計より前なので、そのままだと未来の PAUSE になる） */
const pauseAt = (dir, at) => {
  const f = path.join(dir, 'PAUSE');
  writeFileSync(f, '');
  utimesSync(f, at, at);
};

test('読み取り：Mac mini の実出力から空き・逼迫・swap・load・起動時刻・発熱・電源・経路・launchctl を読む', () => {
  assert.equal(parseDfAvailableBytes(OUT.df), 337437064 * 1024);
  assert.equal(parseSwapUsedBytes(OUT.swap), 0);
  assert.equal(parseSwapUsedBytes('total = 4096.00M  used = 2560.50M  free = 1535.50M  (encrypted)'), 2560.5 * 1024 ** 2);
  assert.deepEqual(parseLoadavg(OUT.loadavg), [1.61, 1.78, 1.71]);
  assert.equal(parseBoottime(OUT.boottime), 1790751889);
  assert.equal(parseThermal(OUT.therm), 'none');
  assert.equal(parseThermal('Thermal warning level set to 2.'), 'warning', '合成');
  assert.equal(parseThermal('CPU_Scheduler_Limit = 100\nCPU_Available_CPUs = 8\nCPU_Speed_Limit = 70'), 'warning', 'Intel 形式（合成）');
  assert.equal(parseThermal(''), null);
  assert.deepEqual(parsePowerSource(OUT.ps), { source: 'ac', percent: null });
  assert.deepEqual(parsePowerSource("Now drawing from 'UPS Power'\n -UPS 1 (id=1)\t85%; discharging"), { source: 'ups', percent: 85 }, '合成');
  assert.deepEqual(parseRoute({ code: 0, stdout: OUT.route }), { default_route: true, interface: 'en1' });
  assert.deepEqual(parseRoute({ code: 1, stdout: '' }), { default_route: false, interface: null }, '既定経路なし');
  assert.equal(parseRoute({ code: -1, stdout: '', timedOut: true }), null, '時間切れは分からない');
  assert.deepEqual(parseLaunchctlPrint({ code: 113, stdout: '' }), { loaded: false });
  assert.deepEqual(parseLaunchctlPrint({ code: 0, stdout: OUT.launchctlLoaded }), { loaded: true, state: 'not running', pid: null, last_exit_code: 0, spawn_type: 'background', runs: 3, last_signal: null });
  assert.equal(parseLaunchctlPrint({ code: 0, stdout: '\tstate = not running\n\tlast terminating signal = Killed: 9\n' }).last_signal, '9');
  assert.equal(parseLaunchctlPrint({ code: 0, stdout: '\tstate = not running\n\tlast exit code = (never exited)\n' }).last_exit_code, null);
  assert.equal(parseLaunchctlPrint({ code: 0, stdout: '\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n' }).last_exit_code, 78);
  assert.equal(parseEtimeSeconds('   05:06\n'), 306);
  assert.equal(parseEtimeSeconds('01:02:03'), 3723);
  assert.equal(parseEtimeSeconds('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.deepEqual(parsePsUsage('  1048576  12.5\n  524288   0.5\n'), { rss_bytes: 1572864 * 1024, cpu_percent: 13, processes: 2 });
  assert.deepEqual(parsePsUsage(''), { rss_bytes: 0, cpu_percent: 0, processes: 0 });
});

test('境界：許可したコマンドだけ・shell なし・最小の env・5 秒で打ち切り。Trading Lab の領域を引数に持たない・process 一覧を取らない', async () => {
  const seen = [];
  const run = makeRunner({ execFileImpl: (bin, args, opts, cb) => { seen.push({ bin, args, opts }); cb(null, '1\n'); } });
  await run('/usr/sbin/sysctl', ['-n', 'hw.ncpu']);
  assert.equal(seen[0].opts.timeout, 5000);
  assert.ok(!('shell' in seen[0].opts) || seen[0].opts.shell === false);
  assert.deepEqual(Object.keys(seen[0].opts.env).sort(), ['LC_ALL', 'PATH'], 'Secret を含み得る env を子 process へ渡さない');
  await assert.rejects(run('/usr/local/bin/prlctl', ['list']), /not allowed/);
  await assert.rejects(run('/bin/sh', ['-c', 'true']), /not allowed/);

  const { run: fx, calls } = fixtureRunner();
  await collect({ run: fx, uid: 501, dataDirs: [tmpdir()], hermesUser: 'hermes' });
  for (const c of calls) {
    assert.ok(ALLOWED_BINS.includes(c[0]), c.join(' '));
    assert.ok(!c.some((x) => TRADING_LAB_PATH.test(x)), `Trading Lab の領域を見ない: ${c.join(' ')}`);
  }
  const psCalls = calls.filter((c) => c[0] === '/bin/ps');
  assert.deepEqual(psCalls, [['/bin/ps', '-U', 'hermes', '-o', 'rss=,pcpu=']], 'ps は Hermes ユーザーだけ（全 process の一覧を取らない）');
  const launchctl = calls.filter((c) => c[0] === '/bin/launchctl').map((c) => c[2]);
  assert.deepEqual(launchctl, ['gui/501/com.e-nexus.usage-digest', 'gui/501/com.e-nexus.rotate-logs', 'gui/501/com.e-nexus.watcher-cycle', 'gui/501/com.e-nexus.knowledge-refresh', 'gui/501/com.e-nexus.host-health-watchdog', 'gui/501/com.e-nexus.runtime-backup'], 'Mac Runtime 自身の定期 job だけ（host-health 自身は含めない）');
});

test('判定：初期値のしきい値（空き 50／20 GiB・逼迫 2／4・swap 2 GiB・load > ncpu・発熱・電源・既定経路）', async () => {
  const { run } = fixtureRunner();
  const ok = evaluate(await collect({ run, uid: 501 }));
  assert.ok(ok.every((x) => x.level === 'ok'), JSON.stringify(ok.filter((x) => x.level !== 'ok')));
  assert.equal(ok.find((x) => x.id === 'disk_free_gib').value, 321.8);
  const lv = (o, id) => evaluate(o).find((x) => x.id === id).level;
  const base = await collect({ run, uid: 501 });
  assert.equal(lv({ ...base, disk_free_bytes: 40 * 1024 ** 3 }, 'disk_free_gib'), 'warn');
  assert.equal(lv({ ...base, disk_free_bytes: 10 * 1024 ** 3 }, 'disk_free_gib'), 'crit');
  assert.equal(lv({ ...base, memory_pressure_level: 2 }, 'memory_pressure'), 'warn');
  assert.equal(lv({ ...base, memory_pressure_level: 4 }, 'memory_pressure'), 'crit');
  assert.equal(lv({ ...base, swap_used_bytes: 3 * 1024 ** 3 }, 'swap_used_gib'), 'warn');
  assert.equal(lv({ ...base, loadavg: [20, 15, 13] }, 'load_15m'), 'warn');
  assert.equal(lv({ ...base, thermal: 'warning' }, 'thermal'), 'warn');
  assert.equal(lv({ ...base, power: { source: 'ups', percent: 90 } }, 'power'), 'crit', 'UPS のバッテリーで動作中＝停電');
  assert.equal(lv({ ...base, route: { default_route: false, interface: null } }, 'network_default_route'), 'crit');
  assert.equal(lv({ ...base, disk_free_bytes: null }, 'disk_free_gib'), 'unknown');
  assert.equal(lv({ ...base, data_bytes: 31 * 1024 ** 3 }, 'data_gib'), 'warn');
  assert.equal(lv({ ...base, hermes: { rss_bytes: 3.5 * 1024 ** 3 } }, 'hermes_rss_gib'), 'warn');
  assert.equal(lv({ ...base, hermes: { rss_bytes: 4.5 * 1024 ** 3 } }, 'hermes_rss_gib'), 'crit');
  assert.ok(!evaluate(base).some((x) => x.id === 'hermes_rss_gib'), 'Hermes を指定しなければ項目を作らない');
});

test('判定：Mac Runtime の job は未登録なら ok・exit ≠ 0 と 30 分を超えた実行中は warn（launchd に時間上限が無いため）', async () => {
  const label = '/bin/launchctl print gui/501/com.e-nexus.watcher-cycle';
  const failed = fixtureRunner({ [label]: { code: 0, stdout: '\tstate = not running\n\tlast exit code = 1\n' } });
  const items = evaluate(await collect({ run: failed.run, uid: 501 }));
  assert.equal(items.find((x) => x.id === 'job:watcher-cycle').level, 'warn');
  assert.equal(items.find((x) => x.id === 'job:usage-digest').value, 'not_loaded');
  const stuck = fixtureRunner({ [label]: { code: 0, stdout: '\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n' }, '/bin/ps -o etime= -p 4242': { code: 0, stdout: '   45:10\n' } });
  const s = evaluate(await collect({ run: stuck.run, uid: 501 })).find((x) => x.id === 'job:watcher-cycle');
  assert.deepEqual([s.level, s.value], ['warn', 'running 45m']);
});

test('通知の判定：WARN は続いた時に 1 回・CRIT はすぐ・回復は CRIT を知らせた項目だけ 2 回続いて 1 回・unknown は前の状態を保つ・PAUSE は知らせず状態も進めない', () => {
  const at = (ms) => new Date(T0.getTime() + ms).toISOString();
  const warn = [{ id: 'disk_free_gib', level: 'warn', value: 40, kind: 'state' }];
  const d1 = decide(warn, null, { now: at(0) });
  assert.equal(d1.notify.length, 0, 'WARN はすぐには知らせない');
  const s1 = { items: d1.items };
  assert.equal(decide(warn, s1, { now: at(30 * 60_000) }).notify.length, 0, '30 分後：続いているだけ');
  assert.deepEqual(decide(warn, s1, { now: at(24 * 3_600_000) }).notify.map((n) => n.change), ['new'], '24 時間続いたら 1 回');
  const crit = [{ id: 'disk_free_gib', level: 'crit', value: 10, kind: 'state' }];
  const d2 = decide(crit, s1, { now: at(60_000) });
  assert.deepEqual(d2.notify.map((n) => n.change), ['new'], '悪化は新しい変化');
  assert.deepEqual(decide(crit, { items: d2.items }, { now: at(60_000 + 24 * 3_600_000) }).notify.map((n) => n.change), ['reminder']);
  const okNow = [{ id: 'disk_free_gib', level: 'ok', value: 80, kind: 'state' }];
  const held = decide(okNow, { items: d2.items }, { now: at(120_000) });
  assert.equal(held.notify.length, 0, `回復は ${RECOVER_RUNS} 回続いてから`);
  assert.equal(held.items.disk_free_gib.level, 'crit');
  assert.equal(decide(crit, { items: held.items }, { now: at(130_000) }).notify.length, 0, '行き来しても「発生」を重ねない');
  const d3 = decide(okNow, { items: held.items }, { now: at(150_000) });
  assert.deepEqual(d3.notify.map((n) => n.change), ['recovered']);
  assert.equal(decide(okNow, { items: d3.items }, { now: at(180_000) }).notify.length, 0, '回復は 1 回だけ');
  const unknown = [{ id: 'disk_free_gib', level: 'unknown', value: null, kind: 'state' }];
  const d4 = decide(unknown, { items: d2.items }, { now: at(120_000) });
  assert.equal(d4.notify.length, 0);
  assert.equal(d4.items.disk_free_gib.level, 'crit', '読めなかった回で回復を作らない');
  const paused = decide(crit, s1, { now: at(60_000), paused: true });
  assert.equal(paused.notify.length, 0);
  assert.equal(paused.items.disk_free_gib.level, 'warn', '保守窓の間は状態を進めない（明けた後に変化として知らせる）');
  assert.deepEqual(decide([{ id: 'rebooted', level: 'warn', value: 'x', kind: 'event' }], s1, { now: at(0) }).notify.map((n) => n.change), ['event']);
});

test('出来事：起動時刻と既定経路の interface が前回と違えば 1 回だけ（初回は比べない）', () => {
  const o = { boottime: 200, route: { default_route: true, interface: 'en0' } };
  assert.deepEqual(evaluateEvents(o, null), []);
  assert.deepEqual(evaluateEvents(o, { boottime: 200, interface: 'en0' }), []);
  assert.deepEqual(evaluateEvents(o, { boottime: 100, interface: 'en1' }).map((e) => e.id), ['rebooted', 'network_interface_changed']);
});

test('1 回分：state.json・月の jsonl を mode 600 で書く・CRIT で DEGRADED を立て回復で消す・webhook が無ければ外に出ない', async () => {
  const dir = tmp();
  try {
    const posted = [];
    const post = async (n) => { posted.push(n); return { sent: true, code: 'SENT' }; };
    const { run } = fixtureRunner();
    const r1 = await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, now: later(0), post });
    assert.equal(r1.code, 0);
    assert.equal(r1.notifyCode, 'NOTHING_TO_SEND');
    const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(st.schema, 'host-health-state/v1');
    assert.equal(st.boottime, 1790751889);
    assert.equal(st.interface, 'en1');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(dir, '2026-10.jsonl')).mode & 0o777, 0o600);
    }
    const low = fixtureRunner({ '/bin/df -k /': { code: 0, stdout: OUT.df.replace('337437064', String(10 * 1024 * 1024)) } });
    const r2 = await runHostHealth({ stateDir: dir, dataDirs: [], run: low.run, uid: 501, now: later(30 * 60_000), post });
    assert.equal(r2.degraded, true);
    assert.ok(existsSync(path.join(dir, 'DEGRADED')));
    assert.equal(r2.notifyCode, 'NO_WEBHOOK', 'webhook を付けていなければ送らない');
    assert.equal(posted.length, 0);
    const r3 = await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, now: later(60 * 60_000), post });
    assert.equal(r3.degraded, false);
    assert.ok(!existsSync(path.join(dir, 'DEGRADED')));
    const lines = readFileSync(path.join(dir, '2026-10.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const all = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.ok(!all.includes('192.0.2.1'), 'gateway の IP を記録しない');
    assert.ok(!all.includes(hostname()), 'ホスト名を記録しない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('通知：webhook を付けた時だけ・送れなかった変化は次の回にもう一度・PAUSE なら送らない・本文にホスト名・ユーザー名・パス・IP を出さない', async () => {
  const dir = tmp();
  try {
    const low = fixtureRunner({ '/bin/df -k /': { code: 0, stdout: OUT.df.replace('337437064', String(10 * 1024 * 1024)) } });
    const results = [{ sent: false, code: 'WEBHOOK_UNREACHABLE' }, { sent: true, code: 'SENT' }];
    const posted = [];
    const post = async (n, o) => { posted.push({ n, o }); return results.shift() ?? { sent: true, code: 'SENT' }; };
    const opts = { stateDir: dir, dataDirs: [], run: low.run, uid: 501, webhook: 'credential:E-NEXUS/edl/host-health-webhook', post };
    const r1 = await runHostHealth({ ...opts, now: later(0) });
    assert.equal(r1.notifyCode, 'WEBHOOK_UNREACHABLE');
    const r2 = await runHostHealth({ ...opts, now: later(30 * 60_000) });
    assert.deepEqual(r2.notify.map((n) => [n.id, n.change]), [['disk_free_gib', 'new']], '前の回に送れなかった変化をもう一度');
    assert.equal(r2.notifyCode, 'SENT');
    const r3 = await runHostHealth({ ...opts, now: later(60 * 60_000) });
    assert.equal(r3.notify.length, 0, '送れた後は再通知まで黙る');
    assert.equal(posted[0].o.spec, 'credential:E-NEXUS/edl/host-health-webhook');
    pauseAt(dir, later(90 * 60_000)());
    const ok = fixtureRunner();
    const r4 = await runHostHealth({ ...opts, run: ok.run, now: later(90 * 60_000) });
    assert.deepEqual([r4.paused, r4.notify.length, posted.length], [true, 0, 2], '保守窓は記録だけ');
    for (const format of ['json', 'discord', 'slack']) {
      const body = JSON.stringify(webhookBodyOf([{ id: 'disk_free_gib', level: 'crit', value: 10, change: 'new' }, { id: 'rebooted', level: 'warn', value: '2026-10-21T03:00:00.000Z', change: 'event' }], format, '2026-10-21T03:20:00.000Z'));
      assert.ok(!body.includes(hostname()) && !body.includes(userInfo().username) && !/\/Users\/|C:\\\\|\d+\.\d+\.\d+\.\d+/.test(body), body);
      if (format !== 'json') assert.match(body, /\[E-NEXUS Mac Runtime host\]/, 'Trading Lab の通知と取り違えない');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('postAlerts：URL は資格情報ストアからだけ・https 必須・名前の形を確かめる（実際の送信はしない）', async () => {
  const notify = [{ id: 'power', level: 'crit', value: 'ups 80%', change: 'new' }];
  const fetched = [];
  const fetchImpl = async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 204 }; };
  assert.equal((await postAlerts(notify, { spec: 'https://hooks.example/x', fetchImpl })).code, 'WEBHOOK_MUST_BE_CREDENTIAL');
  assert.equal((await postAlerts(notify, { spec: 'credential:E-NEXUS/other/x', fetchImpl })).code, 'WEBHOOK_CREDENTIAL_TARGET_INVALID');
  assert.equal((await postAlerts(notify, { spec: 'credential:E-NEXUS/edl/h', readCredentialImpl: async () => null, fetchImpl })).code, 'WEBHOOK_CREDENTIAL_MISSING');
  assert.equal((await postAlerts(notify, { spec: 'credential:E-NEXUS/edl/h', readCredentialImpl: async () => 'http://hooks.example/x', fetchImpl })).code, 'WEBHOOK_URL_INSECURE');
  assert.equal(fetched.length, 0);
  assert.equal((await postAlerts(notify, { spec: 'credential:E-NEXUS/edl/h', format: 'discord', at: 'x', readCredentialImpl: async () => 'https://hooks.example/abc', fetchImpl })).code, 'WEBHOOK_URL_NOT_DISCORD', '資格情報を取り違えても別の宛先へ送らない');
  assert.equal(fetched.length, 0);
  const r = await postAlerts(notify, { spec: 'credential:E-NEXUS/edl/h', format: 'discord', at: 'x', readCredentialImpl: async () => 'https://discord.com/api/webhooks/123/abc-DEF_9', fetchImpl });
  assert.deepEqual(r, { sent: true, code: 'SENT' });
  assert.equal(fetched[0].init.method, 'POST');
  assert.equal(fetched[0].init.redirect, 'error', 'redirect で別の宛先へ本文を送らない');
  assert.ok(!fetched[0].init.body.includes('discord.com') && !fetched[0].init.body.includes('abc-DEF_9'), 'URL を本文に入れない');
});

test('止まる：3 回続けて失敗したら DISABLED を作り、以後は何もしない（exit 3）。Human が消せば戻る', async () => {
  const dir = tmp();
  try {
    const broken = async () => { throw new Error('boom'); };
    const codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await runHostHealth({ stateDir: dir, dataDirs: [], run: broken, uid: 501, now: later(i) })).code);
    assert.deepEqual(codes, [1, 1, 1]);
    assert.ok(existsSync(path.join(dir, 'DISABLED')));
    const { run, calls } = fixtureRunner();
    assert.equal((await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, now: later(10) })).code, 3);
    assert.equal(calls.length, 0, 'DISABLED の間はコマンドを 1 つも起動しない');
    rmSync(path.join(dir, 'DISABLED'));
    const ok = await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, now: later(20) });
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).consecutive_failures, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引数：絶対パスだけ・Trading Lab の領域を拒否・URL の webhook を拒否・知らない引数を拒否', () => {
  assert.deepEqual(validateArgs(parseArgs(['--state-dir', '/Users/x/edl/data/host-health', '--data-dir', '/Users/x/edl/data', '--webhook', 'credential:E-NEXUS/edl/host-health-webhook', '--webhook-format', 'discord'])), []);
  assert.ok(validateArgs(parseArgs(['--data-dir', 'relative'])).some((e) => e.includes('absolute')));
  assert.ok(validateArgs(parseArgs(['--data-dir', '/Users/x/Parallels'])).some((e) => e.includes('Trading Lab')));
  assert.ok(validateArgs(parseArgs(['--data-dir', '/Users/x/AI-Trading-Lab-Migration/state'])).some((e) => e.includes('Trading Lab')));
  assert.ok(validateArgs(parseArgs(['--webhook', 'https://hooks.example/x'])).some((e) => e.includes('--webhook')));
  assert.ok(validateArgs(parseArgs(['--hermes-user', 'Hermes;rm'])).some((e) => e.includes('--hermes-user')));
  assert.throws(() => parseArgs(['--kill', 'parallels']), /unknown argument/);
  assert.throws(() => parseArgs(['--state-dir']), /needs a value/);
  assert.ok(validateArgs(parseArgs(['--webhook-test'])).some((e) => e.includes('--webhook-test')));
  assert.ok(validateArgs(parseArgs(['--github-owner', 'a b'])).some((e) => e.includes('--github-owner')));
  assert.deepEqual(validateArgs(parseArgs(['--github-owner', 'example-org', '--github-credential', 'credential:E-NEXUS/edl/github-monitor-token'])), []);
});

test('Discord：mention を全部無効・長くても途中で切らず件数を出す・CRIT を先頭に・宛先の形を確かめる', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `repo:r${i}`, level: 'warn', value: 'dirty 3', change: 'new' }));
  const body = webhookBodyOf([...many, { id: 'power', level: 'crit', value: 'ups 80%', change: 'new' }], 'discord', 'x');
  assert.deepEqual(body.allowed_mentions, { parse: [] }, '@everyone を鳴らさない');
  assert.ok(body.content.length <= 1900, String(body.content.length));
  assert.equal(body.content.split('\n')[1], '【重大】電源：AC 以外で動いている（ups 80%） → 要対応');
  assert.match(body.content, /…ほか \d+ 件/);
  assert.ok(isDiscordWebhook(new URL('https://discord.com/api/webhooks/123/abc')));
  assert.ok(isDiscordWebhook(new URL('https://discordapp.com/api/webhooks/123/abc')));
  assert.ok(isDiscordWebhook(new URL('https://ptb.discord.com/api/v10/webhooks/123/abc')));
  for (const u of ['https://discord.com.example/api/webhooks/1/a', 'https://discord.com/api/v9/channels/1', 'https://hooks.example/api/webhooks/1/a']) assert.ok(!isDiscordWebhook(new URL(u)), u);
});

test('通知の関所（allowlist）：項目ごとの形に合う値だけ通す。知らない項目の文字列は全部落とす', () => {
  const bad = ['/Users/op/secret', 'C:\\Users\\op', '192.0.2.10', 'fe80::1', '2001:db8::1', 'aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'https://discord.com/api/webhooks/1/token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-api03-abc', 'a'.repeat(40), 'mac-mini.local', 'op@example.com', 'x'.repeat(200)];
  for (const id of ['power', 'repo:r', 'job:usage-digest', 'github:r', 'monitor_gap', 'network_interface_changed', 'hermes_isolation', 'unknown_future_item']) {
    for (const v of bad) assert.equal(safeValue(id, v), '[redacted]', `${id} ${v}`);
  }
  for (const [id, v] of [['power', 'ups 80%'], ['network_interface_changed', 'en0->en1'], ['repo:r', 'dirty 3 ahead 1'], ['repo:r', 'ahead 2 no_upstream'], ['repo:r', 'clean'], ['rebooted', '2026-10-21T03:00:00.000Z'], ['hermes_isolation', 'admin_group,share_open'], ['hermes_service', 'stopped exit 1'], ['github_visibility_changed', 'e-nexus-crm-core:PRIVATE->PUBLIC'], ['monitor_gap', '3h10m'], ['residents_changed', '+host-health-watchdog,-x'], ['backup_archive', '3d restore never'], ['job:watcher-cycle', 'running 45m'], ['delivery_test', '配送試験 異常ではありません']]) {
    assert.equal(safeValue(id, v), v);
  }
  assert.equal(safeValue('disk_free_gib', 12.5), 12.5);
  assert.equal(safeValue('disk_free_gib', null), null);
  const text = alertText([{ id: 'x', level: 'warn', value: '/Users/op/.ssh/id_ed25519', change: 'new' }, { id: '/Users/op', level: 'warn', value: 1, change: 'new' }]);
  assert.ok(!text.includes('/Users'), text);
  const json = JSON.stringify(webhookBodyOf([{ id: 'x', level: 'warn', value: '192.0.2.10', change: 'new', extra: 'secret' }], 'json', 'x'));
  assert.ok(!json.includes('192.0.2.10') && !json.includes('secret'), json);
});

test('監視の空白：前の回から 90 分を超えたら 1 回だけ知らせる。送れない間は値を持ち越し、送れたら消える', async () => {
  const iso = (ms) => new Date(T0.getTime() + ms).toISOString();
  assert.deepEqual(monitorGapEvent(null, iso(0)), []);
  assert.deepEqual(monitorGapEvent({ updated_at: iso(0) }, iso(GAP_MS)), [], '90 分ちょうどは空白にしない');
  assert.equal(monitorGapEvent({ updated_at: iso(0) }, iso(190 * 60_000))[0].value, '3h10m');
  const dir = tmp();
  try {
    const results = [{ sent: false, code: 'WEBHOOK_CREDENTIAL_MISSING' }, { sent: true, code: 'SENT' }];
    const post = async () => results.shift();
    const { run } = fixtureRunner();
    const opts = { stateDir: dir, dataDirs: [], run, uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
    await runHostHealth({ ...opts, now: later(0) });
    const r1 = await runHostHealth({ ...opts, now: later(190 * 60_000) });
    assert.deepEqual(r1.notify.map((n) => [n.id, n.value]), [['monitor_gap', '3h10m']]);
    assert.equal(r1.notifyCode, 'WEBHOOK_CREDENTIAL_MISSING');
    const r2 = await runHostHealth({ ...opts, now: later(220 * 60_000) });
    assert.deepEqual(r2.notify.map((n) => [n.id, n.value]), [['monitor_gap', '3h10m']], '送れなかった時間を足さない');
    assert.equal(r2.notifyCode, 'SENT');
    const r3 = await runHostHealth({ ...opts, now: later(250 * 60_000) });
    assert.equal(r3.notify.length, 0, '正常の定期通知はしない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('監視の停止：DISABLED になったら CRIT で知らせ、止まっている間は 24 時間ごとに知らせ続ける。時間切れも失敗に数える', async () => {
  const dir = tmp();
  try {
    const posted = [];
    const post = async (n) => { posted.push(n[0]); return { sent: true, code: 'SENT' }; };
    const webhook = 'credential:E-NEXUS/edl/h';
    const at = (ms) => new Date(T0.getTime() + ms).toISOString();
    for (let i = 0; i < 3; i += 1) await recordFailure({ stateDir: dir, at: at(i), webhook, webhookFormat: 'discord', post });
    assert.ok(existsSync(path.join(dir, 'DISABLED')), '時間切れの 3 回でも止まる（黙って走り続けない）');
    assert.deepEqual([posted.length, posted[0].level, posted[0].value, posted[0].change], [1, 'crit', 'disabled', 'event']);
    const { run, calls } = fixtureRunner();
    const opts = { stateDir: dir, dataDirs: [], run, uid: 501, webhook, webhookFormat: 'discord', post };
    assert.equal((await runHostHealth({ ...opts, now: later(30 * 60_000) })).code, 3);
    assert.equal(posted.length, 1, '24 時間は重ねない');
    assert.equal((await runHostHealth({ ...opts, now: later(DISABLED_REMIND_MS + 60_000) })).code, 3);
    assert.deepEqual([posted.length, posted[1].change], [2, 'reminder']);
    assert.equal(calls.length, 0, 'DISABLED の間はコマンドを起動しない');
    pauseAt(dir, later(3 * DISABLED_REMIND_MS)());
    await runHostHealth({ ...opts, now: later(3 * DISABLED_REMIND_MS) });
    assert.equal(posted.length, 2, '保守窓は知らせない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('宛先が Discord なら --webhook-format を付け忘れても Discord の形で送る（json は拒否され、黙って送れ続けない）', async () => {
  const fetched = [];
  const r = await postAlerts([{ id: 'power', level: 'crit', value: 'ups 80%', change: 'new' }], { spec: 'credential:E-NEXUS/edl/h', at: 'x', readCredentialImpl: async () => 'https://discord.com/api/webhooks/1/a', fetchImpl: async (u, i) => { fetched.push(JSON.parse(i.body)); return { ok: true, status: 204 }; } });
  assert.equal(r.code, 'SENT');
  assert.match(fetched[0].content, /^\[E-NEXUS Mac Runtime host\]/);
});

test('PAUSE：明けた後に出来事を知らせる（再起動・回線・空白を飲み込まない）', async () => {
  const dir = tmp();
  try {
    const posted = [];
    const post = async (n) => { posted.push(...n); return { sent: true, code: 'SENT' }; };
    const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
    await runHostHealth({ ...opts, run: fixtureRunner().run, now: later(0) });
    pauseAt(dir, later(300 * 60_000)());
    const rebooted = fixtureRunner({ '/usr/sbin/sysctl -n kern.boottime': { code: 0, stdout: OUT.boottime.replace('1790751889', '1790760000') }, '/sbin/route -n get default': { code: 0, stdout: OUT.route.replace('en1', 'en7') } });
    const r1 = await runHostHealth({ ...opts, run: rebooted.run, now: later(300 * 60_000) });
    assert.deepEqual([r1.paused, posted.length], [true, 0]);
    rmSync(path.join(dir, 'PAUSE'));
    const r2 = await runHostHealth({ ...opts, run: rebooted.run, now: later(330 * 60_000) });
    assert.deepEqual(r2.notify.map((n) => n.id).sort(), ['monitor_gap', 'rebooted'], '回線の切替は記録だけ');
    assert.ok(r2.items.some((x) => x.id === 'network_interface_changed'), '基準を進めない間に飲み込まない');
    const r3 = await runHostHealth({ ...opts, run: rebooted.run, now: later(360 * 60_000) });
    assert.equal(r3.notify.length, 0, '送れた後はもう出さない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PAUSE：未来の mtime は期限の幅を超えたら効かせない（時計の小さな戻りでは保守窓のまま）', () => {
  const dir = tmp();
  try {
    pauseAt(dir, new Date(T0.getTime() + 60_000));
    assert.deepEqual(pauseState(dir, T0.toISOString()), { paused: true, expired: false });
    pauseAt(dir, new Date(T0.getTime() + PAUSE_MAX_MS + 60_000));
    assert.deepEqual(pauseState(dir, T0.toISOString()), { paused: false, expired: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('監視の記録：jsonl を書けない回は成功に数えず積み上がる。state が消えたら 1 回知らせる', async () => {
  const dir = tmp();
  try {
    const posted = [];
    const post = async (n) => { posted.push(...n); return { sent: true, code: 'SENT' }; };
    const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
    const r0 = await runHostHealth({ ...opts, run: fixtureRunner().run, now: later(0) });
    assert.equal(r0.code, 0);
    assert.equal(posted.some((n) => n.id === 'monitor_state_reset'), false, '最初の回は知らせない');
    rmSync(path.join(dir, 'state.json'));
    const r1 = await runHostHealth({ ...opts, run: fixtureRunner().run, now: later(30 * 60_000) });
    assert.deepEqual(r1.notify.filter((n) => n.id === 'monitor_state_reset').map((n) => n.change), ['event']);
    const r2 = await runHostHealth({ ...opts, run: fixtureRunner().run, now: later(60 * 60_000) });
    assert.equal(r2.notify.some((n) => n.id === 'monitor_state_reset'), false, '1 回だけ');
    const month = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    rmSync(path.join(dir, month));
    mkdirSync(path.join(dir, month));
    for (const [i, want] of [[3, 1], [4, 2]]) {
      const r = await runHostHealth({ ...opts, run: fixtureRunner().run, now: later(i * 30 * 60_000) });
      assert.deepEqual([r.code, r.failures], [1, want], '毎回 0 へ戻らない');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('出来事：同じ出来事は 24 時間に 3 通まで。超えた分は bursts の数が増えない。窓が明ければ戻る', () => {
  const ev = [{ id: 'monitor_config_changed', level: 'warn', value: 'monitor_plist', kind: 'event' }];
  let prev = null;
  let sent = 0;
  for (let i = 0; i < 48; i += 1) {
    const d = decide(ev, prev, { now: new Date(T0.getTime() + i * 30 * 60_000).toISOString() });
    sent += d.notify.length;
    prev = { items: d.items, bursts: d.bursts };
  }
  assert.equal(sent, 3);
  assert.equal(decide(ev, prev, { now: new Date(T0.getTime() + 25 * 3_600_000).toISOString() }).notify.length, 1);
});

test('反復の上限：監視の引数のコードの交互・user 範囲の行き来も 24 時間に 3 通まで', () => {
  for (const [id, values] of [['monitor_args', ['monitor_no_webhook', 'monitor_no_heartbeat']], ['agent_scope', ['user_rules', 'ok']]]) {
    let prev = null;
    let sent = 0;
    for (let i = 0; i < 48; i += 1) {
      const v = values[i % 2];
      const d = decide([{ id, level: v === 'ok' ? 'ok' : 'warn', value: v, kind: 'state' }], prev, { now: new Date(T0.getTime() + i * 30 * 60_000).toISOString() });
      sent += d.notify.length;
      prev = { items: d.items, bursts: d.bursts };
    }
    assert.ok(sent <= 3, `${id}: ${sent}`);
  }
});

test('PAUSE の消し忘れ：72 時間を過ぎたら効かない・monitor_pause=expired の WARN', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'PAUSE');
    writeFileSync(f, '');
    const old = new Date(T0.getTime() - PAUSE_MAX_MS - 60_000);
    utimesSync(f, old, old);
    assert.deepEqual(pauseState(dir, T0.toISOString()), { paused: false, expired: true });
    const posted = [];
    const post = async (n) => { posted.push(...n); return { sent: true, code: 'SENT' }; };
    const opts = { stateDir: dir, dataDirs: [], run: fixtureRunner().run, uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
    const r = await runHostHealth({ ...opts, now: later(0) });
    assert.equal(r.paused, false);
    assert.ok(r.items.some((x) => x.id === 'monitor_pause' && x.level === 'warn'), 'WARN はまず記録だけ');
    await runHostHealth({ ...opts, now: later(24 * 3_600_000) });
    assert.deepEqual(posted.filter((n) => n.id === 'monitor_pause').map((n) => [n.level, n.value]), [['warn', 'expired']], '残り続ければ知らせる');
    const fresh = new Date(T0.getTime() - PAUSE_MAX_MS + 60_000);
    utimesSync(f, fresh, fresh);
    assert.deepEqual(pauseState(dir, T0.toISOString()), { paused: true, expired: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空白の後の最初の回が失敗しても monitor_gap を失わない', async () => {
  const dir = tmp();
  try {
    const { run } = fixtureRunner();
    const posted = [];
    const post = async (n) => { posted.push(...n); return { sent: true, code: 'SENT' }; };
    const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
    await runHostHealth({ ...opts, run, now: later(0) });
    await runHostHealth({ ...opts, run: async () => { throw new Error('boom'); }, now: later(300 * 60_000) });
    const r = await runHostHealth({ ...opts, run, now: later(330 * 60_000) });
    assert.deepEqual(r.notify.map((n) => [n.id, n.value]), [['monitor_gap', '5h0m']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Human が DISABLED を消したら数え直す（1 回の失敗で黙って止まり直さない）', async () => {
  const dir = tmp();
  try {
    const broken = async () => { throw new Error('boom'); };
    const posted = [];
    const post = async (n) => { posted.push(n[0]); return { sent: true, code: 'SENT' }; };
    const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
    for (let i = 0; i < 3; i += 1) await runHostHealth({ ...opts, run: broken, now: later(i) });
    assert.equal(posted.length, 1);
    rmSync(path.join(dir, 'DISABLED'));
    const r = await runHostHealth({ ...opts, run: broken, now: later(10) });
    assert.equal(r.failures, 1);
    assert.ok(!existsSync(path.join(dir, 'DISABLED')));
    for (const i of [11, 12]) await runHostHealth({ ...opts, run: broken, now: later(i) });
    assert.ok(existsSync(path.join(dir, 'DISABLED')));
    assert.equal(posted.length, 2, '止まり直したらもう一度知らせる');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('記録を書けない：回数を残せなくても知らせる・例外で落ちない・message（パス）を返さない', async () => {
  const base = tmp();
  try {
    const stateDir = path.join(base, 'file-not-dir');
    writeFileSync(stateDir, '');
    const posted = [];
    const post = async (n) => { posted.push(n[0]); return { sent: true, code: 'SENT' }; };
    const r = await runHostHealth({ stateDir, dataDirs: [], run: fixtureRunner().run, uid: 501, webhook: 'credential:E-NEXUS/edl/h', now: () => new Date('2026-10-21T06:20:00Z'), post });
    assert.equal(r.code, 1);
    assert.ok(!String(r.error).includes(base), r.error);
    assert.deepEqual(posted.map((n) => [n.id, n.level]), [['host_health', 'crit']]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('今回見なかった項目は state から消える（外した repo の水準が残り続けない）。今の水準は observed に残る', async () => {
  const dir = tmp();
  try {
    const stateFile = path.join(dir, 'state.json');
    const { run } = fixtureRunner();
    const guard = { base: dir, repos: [], outbox: path.join(dir, 'outbox'), operatorHome: dir };
    await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, guard, now: later(0) });
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    s.items['repo:removed'] = { level: 'warn', since: 'x', last_notified_at: 'x' };
    writeFileSync(stateFile, JSON.stringify(s));
    await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, guard, now: later(60_000) });
    const after = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok(!('repo:removed' in after.items));
    const low = fixtureRunner({ '/bin/df -k /': { code: 0, stdout: OUT.df.replace('337437064', String(10 * 1024 * 1024)) } });
    await runHostHealth({ stateDir: dir, dataDirs: [], run: low.run, uid: 501, guard, webhook: 'credential:E-NEXUS/edl/h', now: later(120_000), post: async () => ({ sent: false, code: 'WEBHOOK_UNREACHABLE' }) });
    const unsent = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(unsent.observed.disk_free_gib, 'crit', '送れていない異常も今の水準には残る');
    assert.equal(unsent.items.disk_free_gib.level, 'ok', '通知の状態は戻して次の回にもう一度');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('実際に出る項目の id は通知で全部読める（関所で項目名を落とさない）', async () => {
  const { run } = fixtureRunner();
  const o = await collect({ run, uid: 501, dataDirs: [], hermesUser: 'hermes' });
  const ids = [...evaluate(o).map((x) => x.id), ...['monitor_gap', 'monitor_pause', 'monitor_alive', 'monitor_watchdog', 'host_health', 'rebooted', 'residents_changed', 'github_api', 'github:e-nexus-crm-core', 'repo:en-sns-hub', 'hermes_isolation', 'backup_archive', 'agent_scope']];
  assert.ok(ids.includes('load_15m'));
  const text = alertText(ids.map((id) => ({ id, level: 'warn', value: 1, change: 'new' })));
  assert.ok(!text.includes('[redacted]'), text);
  assert.equal(text.split('\n').length, ids.length + 1);
  assert.ok(!text.includes('異常を検知した'), `固定の文が無い項目がある：${text}`);
});

test('state を一度書けなかっただけでは止まらない：CRIT を知らせるが DISABLED にしない・6 時間ごとの枠でだけ・直れば続く', async () => {
  const dir = tmp();
  try {
    const posted = [];
    const post = async (n) => { posted.push(n[0]); return { sent: true, code: 'SENT' }; };
    mkdirSync(path.join(dir, 'state.json.tmp')); // state の書き込みだけが失敗する
    const webhook = 'credential:E-NEXUS/edl/h';
    const failures = await recordFailure({ stateDir: dir, at: '2026-10-21T06:20:00.000Z', webhook, post });
    assert.equal(failures, 1);
    assert.deepEqual(posted.map((n) => [n.id, n.value]), [['host_health', 'state_unwritable']]);
    for (const at of ['2026-10-21T07:20:00.000Z', '2026-10-21T07:50:00.000Z', '2026-10-21T11:50:00.000Z']) await recordFailure({ stateDir: dir, at, webhook, post });
    assert.equal(posted.length, 1, '30 分ごとに重ねない');
    await recordFailure({ stateDir: dir, at: '2026-10-21T12:20:00.000Z', webhook, post });
    assert.equal(posted.length, 2, '次の枠でまた知らせる');
    assert.ok(!existsSync(path.join(dir, 'DISABLED')));
    rmSync(path.join(dir, 'state.json.tmp'), { recursive: true });
    const r = await runHostHealth({ stateDir: dir, dataDirs: [], run: fixtureRunner().run, uid: 501, now: later(60_000), post });
    assert.equal(r.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('前の版が作った DISABLED を Human が消しても数え直す（disabled_at が無い state）', async () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schema: 'host-health-state/v1', updated_at: T0.toISOString(), consecutive_failures: 3, items: {} }));
    const r = await runHostHealth({ stateDir: dir, dataDirs: [], run: async () => { throw new Error('boom'); }, uid: 501, now: later(60_000) });
    assert.equal(r.failures, 1);
    assert.ok(!existsSync(path.join(dir, 'DISABLED')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
