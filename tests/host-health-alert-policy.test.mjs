/**
 * Discord の通知の基準（2026-11-05 Human 決定）の検収。普段は静かに監視し、本当に必要な時だけ知らせる。
 * 判定は decide の連続した呼び出しで、1 回分の動きは runHostHealth を fixture で回す（実際には送らない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALLOWED_BINS, alertText, decide, rollbackUnsent, runHostHealth, safeValue, watchdogItem, webhookBodyOf } from '../scripts/host-health.mjs';
import { COOLDOWN_MS, REMIND_MS, remindInterval, ruleOf } from '../scripts/lib/alert-policy.mjs';

const T0 = Date.parse('2026-11-05T00:20:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(T0 + ms).toISOString();
const state = (id, level, value = 1) => ({ id, level, value, kind: 'state' });
const event = (id, value = null, level = 'warn') => ({ id, level, value, kind: 'event' });

/** runs：[経過 ms, items] の順に decide を回し、通知を [経過 ms, id, change, level] で返す */
function play(runs) {
  let prev = null;
  const out = [];
  for (const [ms, items] of runs) {
    const d = decide(items, prev, { now: iso(ms) });
    prev = { items: d.items, bursts: d.bursts };
    for (const n of d.notify) out.push([ms, n.id, n.change, n.level]);
  }
  return out;
}
const every30 = (hours, items) => Array.from({ length: hours * 2 + 1 }, (_, i) => [i * 30 * MIN, typeof items === 'function' ? items(i) : items]);

test('正常な監視は 1 週間回しても何も知らせない', () => {
  assert.deepEqual(play(every30(168, [state('disk_free_gib', 'ok', 300), state('memory_pressure', 'ok'), state('monitor_pause', 'ok', 'none')])), []);
});

test('一時的な WARN は記録だけ。1 回だけ・短い間だけ・行き来しても乱発しない', () => {
  assert.deepEqual(play(every30(6, (i) => [state('swap_used_gib', i === 3 ? 'warn' : 'ok')])), [], '1 回だけ');
  assert.deepEqual(play(every30(23, [state('load_15m', 'warn')])), [], '24 時間未満');
  assert.deepEqual(play(every30(72, (i) => [state('load_15m', i % 6 < 2 ? 'warn' : 'ok')])), [], '2 回 ok が続けば数え直す');
});

test('WARN が 24 時間続いたら 1 回だけ。再通知も回復の通知もない', () => {
  const runs = every30(100, (i) => [state('disk_free_gib', i < 150 ? 'warn' : 'ok', 40)]);
  assert.deepEqual(play(runs), [[24 * HOUR, 'disk_free_gib', 'new', 'warn']]);
});

test('WARN が CRIT へ悪化したらすぐ知らせる（WARN を知らせた直後でも）', () => {
  const runs = every30(30, (i) => [state('disk_free_gib', i < 50 ? 'warn' : 'crit', 15)]);
  assert.deepEqual(play(runs), [[24 * HOUR, 'disk_free_gib', 'new', 'warn'], [25 * HOUR, 'disk_free_gib', 'new', 'crit']]);
});

test('CRIT はすぐ 1 回。同じ異常を繰り返さず、再通知は 24・48・96 時間…と間隔を広げ 7 日で止まる', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(remindInterval), [24, 48, 96, 168, 168].map((h) => h * HOUR));
  assert.equal(REMIND_MS.max, 168 * HOUR);
  const out = play(every30(24 * 30, [state('network_default_route', 'crit', 'absent')]));
  assert.deepEqual(out.map(([ms, , change]) => [ms / HOUR, change]), [[0, 'new'], [24, 'reminder'], [72, 'reminder'], [168, 'reminder'], [336, 'reminder'], [504, 'reminder'], [672, 'reminder']]);
});

test('回復の通知は CRIT を知らせた項目だけ・2 回続いてから・1 回だけ', () => {
  const out = play(every30(10, (i) => [state('power', i < 4 ? 'crit' : 'ok', 'ac')]));
  assert.deepEqual(out, [[0, 'power', 'new', 'crit'], [2.5 * HOUR, 'power', 'recovered', 'ok']]);
});

test('CRIT から WARN へ下がった間は黙り、ok になれば回復を 1 回。再び CRIT でも発生を重ねない', () => {
  const seq = ['crit', 'warn', 'warn', 'crit', 'warn', 'ok', 'ok', 'ok'];
  const out = play(seq.map((l, i) => [i * 30 * MIN, [state('disk_free_gib', l, 15)]]));
  assert.deepEqual(out.map((x) => x.slice(1, 3)), [['disk_free_gib', 'new'], ['disk_free_gib', 'recovered']]);
});

test('回復の直後に CRIT へ戻っても 6 時間は重ねない。続いていれば明けた回に知らせる。隔離の崩れは待たない', () => {
  const cycle = (id) => [...every30(2, (i) => [state(id, i === 0 ? 'crit' : 'ok')]), ...Array.from({ length: 16 }, (_, i) => [(2.5 + i / 2) * HOUR, [state(id, 'crit')]])];
  const out = play(cycle('memory_pressure'));
  assert.deepEqual(out.map(([ms, , change]) => [ms / HOUR, change]), [[0, 'new'], [1, 'recovered'], [7, 'new']]);
  assert.equal(COOLDOWN_MS, 6 * HOUR);
  assert.deepEqual(play(cycle('hermes_isolation')).map(([ms, , change]) => [ms / HOUR, change]), [[0, 'new'], [1, 'recovered'], [2.5, 'new']]);
});

test('行き来する CRIT：1 日に何度繰り返しても通知は間引かれる', () => {
  const out = play(every30(48, (i) => [state('memory_pressure', i % 4 === 0 ? 'crit' : 'ok')]));
  assert.ok(out.length <= 16, String(out.length));
});

test('送れなかった重大：回復の後も「知らせられなかった」を 1 回だけ。送れれば印は消える', () => {
  const at = (ms) => iso(ms);
  const crit = [state('memory_pressure', 'crit', 4)];
  const ok = [state('memory_pressure', 'ok', 1)];
  const d1 = decide(crit, null, { now: at(0) });
  const items = rollbackUnsent(d1.notify, {}, d1.items, at(0));
  assert.deepEqual([items.memory_pressure.level, items.memory_pressure.missed_at], ['ok', at(0)]);
  const d2 = decide(ok, { items }, { now: at(30 * MIN) });
  assert.deepEqual(d2.notify.map((n) => n.change), ['recovered_missed']);
  assert.deepEqual(decide(ok, { items: rollbackUnsent(d2.notify, items, d2.items, at(30 * MIN)) }, { now: at(60 * MIN) }).notify.map((n) => n.change), ['recovered_missed'], '送れなければ次の回');
  assert.equal(decide(ok, { items: d2.items }, { now: at(60 * MIN) }).notify.length, 0, '1 回だけ');
  const d3 = decide(crit, { items }, { now: at(30 * MIN) });
  assert.deepEqual(d3.notify.map((n) => n.change), ['new']);
  assert.equal(d3.items.memory_pressure.missed_at, null);
});

test('「知らせられなかった」の直後に重大へ戻れば待たせない・WARN の通知で重大だった事実を消さない', () => {
  const crit = [state('memory_pressure', 'crit', 4)];
  const ok = [state('memory_pressure', 'ok', 1)];
  const warn = [state('memory_pressure', 'warn', 2)];
  const d1 = decide(crit, null, { now: iso(0) });
  const items = rollbackUnsent(d1.notify, {}, d1.items, iso(0));
  const d2 = decide(ok, { items }, { now: iso(30 * MIN) });
  assert.deepEqual(decide(crit, { items: d2.items }, { now: iso(60 * MIN) }).notify.map((n) => n.change), ['new']);
  let prev = { items };
  const changes = [];
  for (let i = 1; i <= 52; i += 1) {
    const d = decide(i <= 50 ? warn : ok, prev, { now: iso(i * 30 * MIN) });
    prev = { items: d.items };
    changes.push(...d.notify.map((n) => n.change));
  }
  assert.deepEqual(changes, ['new', 'recovered_missed']);
});

test('CRIT と WARN の境で行き来するだけなら、再通知の間隔は広げたまま', () => {
  const out = play(every30(24 * 60, (i) => [state('disk_free_gib', i % 2 ? 'warn' : 'crit', 20)]));
  assert.ok(out.length <= 12, String(out.length));
});

test('同じ項目でも新しいコードが増えれば知らせ直す（隔離・user 範囲）。増えなければ重ねない', () => {
  const iso1 = (v) => [state('hermes_isolation', 'crit', v)];
  assert.deepEqual(play([[0, iso1('share_open')], [HOUR, iso1('share_open')], [2 * HOUR, iso1('share_open,admin_group')], [3 * HOUR, iso1('share_open,admin_group')], [4 * HOUR, iso1('admin_group')]]).map(([ms, , change]) => [ms / HOUR, change]), [[0, 'new'], [2, 'new']]);
  const scope = (v) => [state('agent_scope', 'warn', v)];
  assert.deepEqual(play([[0, scope('user_rules')], [HOUR, scope('user_rules,user_claude_md')]]).map(([ms]) => ms / HOUR), [0, 1]);
});

test('長く WARN へ下がった後に重大へ戻れば、広がった間隔を待たない', () => {
  const seq = every30(24 * 20, (i) => [state('disk_free_gib', i < 48 * 14 || i >= 48 * 19 ? 'crit' : 'warn', 10)]);
  const out = play(seq).map(([ms, , change]) => [ms / HOUR / 24, change]);
  assert.deepEqual(out.at(-1), [19, 'reminder']);
});

test('電源・回線・監視の停止は回復の直後の戻りも待たない', () => {
  for (const id of ['power', 'network_default_route', 'monitor_alive', 'monitor_watchdog']) {
    const seq = ['crit', 'ok', 'ok', 'crit'];
    assert.deepEqual(play(seq.map((l, i) => [i * 30 * MIN, [state(id, l)]])).map((x) => x[2]), ['new', 'recovered', 'new'], id);
  }
});

test('Hermes の停止：1 回だけなら記録だけ・続けば重大・回復を 1 回', () => {
  assert.deepEqual(play(every30(5, (i) => [state('hermes_service', i === 2 ? 'warn' : 'ok', 'running')])), [], '再起動の瞬間は黙る');
  const out = play(every30(5, (i) => [state('hermes_service', i >= 1 && i < 5 ? 'warn' : 'ok', 'stopped exit 1')]));
  assert.deepEqual(out, [[1.5 * HOUR, 'hermes_service', 'new', 'crit'], [3 * HOUR, 'hermes_service', 'recovered', 'ok']]);
  const long = play(every30(30, [state('hermes_service', 'warn', 'not_loaded')]));
  assert.deepEqual(long.map(([ms, , change]) => [ms / HOUR, change]), [[1, 'new'], [25, 'reminder']], '続けば重大と同じ間隔で再通知');
});

test('重大な出来事は 1 回ずつすぐ。セキュリティの異常は続いた時間を待たない', () => {
  for (const id of ['rebooted', 'monitor_gap', 'hermes_files_changed', 'monitor_config_changed', 'residents_changed', 'github_visibility_changed', 'github_default_branch_changed']) {
    assert.deepEqual(play([[0, [event(id)]], [30 * MIN, []]]), [[0, id, 'event', 'warn']], id);
  }
  assert.deepEqual(play([[0, [state('agent_scope', 'warn', 'user_rules')]], [30 * MIN, [state('agent_scope', 'warn', 'user_rules')]]]).map((x) => x.slice(1, 3)), [['agent_scope', 'new']]);
});

test('軽微な出来事は記録だけ。24 時間に 3 回繰り返したら 1 回知らせ、重ねない', () => {
  const at = (h) => [h * HOUR, [event('hermes_restarted')]];
  assert.deepEqual(play([at(0), at(30), at(60)]), [], '散発は黙る');
  assert.deepEqual(play([at(0), at(1), at(2), at(3), at(4), at(5)]).map(([ms, id]) => [ms / HOUR, id]), [[2, 'hermes_restarted']]);
  assert.deepEqual(play([at(0), at(1), at(2), at(26), at(27), at(28)]).map(([ms]) => ms / HOUR), [2, 28], '翌日も続けば 1 回');
});

test('本文は「対象：何が起きたか → 対応」の 1 行。項目名・内部コードの羅列にしない', () => {
  const text = alertText([
    { id: 'disk_free_gib', level: 'crit', value: 18.2, change: 'new' },
    { id: 'power', level: 'crit', value: 'ups 80%', change: 'reminder' },
    { id: 'disk_free_gib', level: 'ok', value: 80, change: 'recovered' },
    { id: 'repo:en-sns-hub', level: 'warn', value: 'dirty 3', change: 'new' },
  ]);
  assert.deepEqual(text.split('\n'), [
    '[E-NEXUS Mac Runtime host]',
    '【重大】起動ディスク：空きが少ない（18.2） → 要対応',
    '【重大・継続】電源：AC 以外で動いている（ups 80%） → 要対応',
    '【警告】repo en-sns-hub：未 commit か未 push が続いている（dirty 3） → 確認',
    '【復旧】起動ディスク：正常に戻った → 対応不要',
  ]);
  assert.equal(alertText([{ id: 'delivery_test', level: 'ok', value: '配送試験 異常ではありません', change: 'event' }]).split('\n')[1], '【通知】配送試験：異常ではありません → 対応不要');
});

test('本文に秘密・パス・ホスト識別を出さない（項目の全種類に悪い値を入れても落ちる）', () => {
  const bad = ['https://discord.com/api/webhooks/1/token', '/Users/op/.ssh/id', '192.0.2.10', 'mac-mini.local', 'sk-ant-api03-abc', 'op@example.com', 'en0 aa:bb:cc:dd:ee:ff'];
  const ids = ['disk_free_gib', 'memory_pressure', 'swap_used_gib', 'load_15m', 'thermal', 'power', 'network_default_route', 'job:watcher-cycle', 'data_gib', 'hermes_rss_gib', 'hermes_service', 'hermes_isolation', 'hermes_restarted', 'hermes_files_changed', 'monitor_config_changed', 'residents_changed', 'agent_scope', 'rebooted', 'network_interface_changed', 'repo:r', 'relay_outbox', 'backup_archive', 'github_api', 'github_visibility_changed', 'github_default_branch_changed', 'github:r', 'monitor_gap', 'monitor_pause', 'monitor_alive', 'monitor_watchdog', 'host_health', 'future_item'];
  for (const format of ['discord', 'slack', 'json']) {
    const body = JSON.stringify(webhookBodyOf(ids.flatMap((id) => bad.map((value) => ({ id, level: 'crit', value, change: 'new' }))), format, 'x'));
    for (const v of bad) assert.ok(!body.includes(v), `${format} ${v}`);
  }
});

test('基準の無い項目は WARN なら 24 時間待ち、固定の文で出す（値の文字列は落ちる）', () => {
  assert.equal(ruleOf('future_item').hold, 24 * HOUR);
  assert.equal(alertText([{ id: 'future_item', level: 'warn', value: 'x', change: 'new' }]).split('\n')[1], '【警告】future_item：異常を検知した（[redacted]） → 確認');
});

test('watchdog の停止：host-health が見る。未登録は異常にしない・解除と途絶は CRIT・記録が無いだけなら WARN', () => {
  const now = iso(0);
  const ok = { loaded: true };
  const at = (installed, job, updatedAt) => { const { level, value } = watchdogItem({ installed, job, updatedAt, now }); return [level, value]; };
  assert.deepEqual(at(false, { loaded: false }, null), ['ok', 'not_installed']);
  assert.deepEqual(at(true, { loaded: false }, iso(0)), ['crit', 'not_loaded'], 'plist を残した解除も見える');
  assert.deepEqual(at(true, ok, iso(-2 * HOUR)), ['ok', 'ok']);
  assert.deepEqual(at(true, ok, iso(-4 * HOUR)), ['crit', 'stale 240m']);
  assert.deepEqual(at(true, ok, null), ['warn', 'no_state']);
  assert.deepEqual(at(true, null, null), ['unknown', null]);
  assert.deepEqual(at(undefined, ok, iso(0)), ['unknown', null]);
  assert.equal(watchdogItem({ installed: true, job: ok, updatedAt: iso(-5 * HOUR), now, gap: true }).level, 'unknown', 'Mac の停止の直後に偽の CRIT を出さない');
});

test('GitHub の値の関所：公開範囲は enum だけ・branch は先頭の / と // を通さない', () => {
  assert.equal(safeValue('github_visibility_changed', 'r:PRIVATE->PUBLIC'), 'r:PRIVATE->PUBLIC');
  assert.equal(safeValue('github_default_branch_changed', 'r:main->release/2.0'), 'r:main->release/2.0');
  for (const v of ['https://discord.com/api/webhooks/1234/tok_en->x', 'r:/Users/op/.ssh/id->b']) {
    assert.equal(safeValue('github_visibility_changed', v), '[redacted]');
    assert.equal(safeValue('github_default_branch_changed', v), '[redacted]');
  }
});

const OUT = {
  '/bin/df -k /': 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1s1 482746452 14092324 337437064 5% 484017 3374370640 0% /\n',
  '/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level': '1\n',
  '/usr/sbin/sysctl -n vm.swapusage': 'total = 0.00M  used = 0.00M  free = 0.00M\n',
  '/usr/sbin/sysctl -n vm.loadavg': '{ 1.61 1.78 1.71 }\n',
  '/usr/sbin/sysctl -n hw.ncpu': '12\n',
  '/usr/sbin/sysctl -n kern.boottime': '{ sec = 1790751889, usec = 1 } x\n',
  '/usr/bin/pmset -g therm': 'Note: No thermal warning level has been recorded\n',
  '/usr/bin/pmset -g ps': "Now drawing from 'AC Power'\n",
};
function runner(overrides = {}) {
  const table = { ...OUT, '/sbin/route -n get default': '  interface: en1\n', ...overrides };
  return async (bin, args) => {
    assert.ok(ALLOWED_BINS.includes(bin));
    const key = [bin, ...args].join(' ');
    if (key in table) return { code: 0, stdout: table[key], timedOut: false };
    return bin === '/bin/launchctl' ? { code: 113, stdout: '', timedOut: false } : { code: 1, stdout: '', timedOut: false };
  };
}
const withDir = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-alert-policy-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('1 回分：正常な 30 分の監視を 48 回回しても 1 通も送らない', () => withDir(async (dir) => {
  const posted = [];
  const post = async (n) => { posted.push(n); return { sent: true, code: 'SENT' }; };
  for (let i = 0; i < 48; i += 1) {
    const r = await runHostHealth({ stateDir: dir, dataDirs: [], run: runner(), uid: 501, webhook: 'credential:E-NEXUS/edl/h', webhookFormat: 'discord', now: () => new Date(T0 + i * 30 * MIN), post });
    assert.deepEqual([r.code, r.notifyCode], [0, 'NOTHING_TO_SEND']);
  }
  assert.equal(posted.length, 0);
  assert.equal(readFileSync(path.join(dir, '2026-11.jsonl'), 'utf8').trim().split('\n').length, 48, '記録は残す');
}));

test('1 回分：送れない間は 30 分に 1 回だけ試し、軽微な出来事の回数を足さない', () => withDir(async (dir) => {
  let tries = 0;
  const post = async () => { tries += 1; return { sent: false, code: 'WEBHOOK_UNREACHABLE' }; };
  const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
  await runHostHealth({ ...opts, run: runner(), now: () => new Date(T0) });
  const changed = runner({ '/sbin/route -n get default': '  interface: en7\n', '/usr/sbin/sysctl -n kern.boottime': '{ sec = 1790760000, usec = 1 } x\n' });
  for (let i = 1; i <= 6; i += 1) await runHostHealth({ ...opts, run: changed, now: () => new Date(T0 + i * 30 * MIN) });
  assert.equal(tries, 6);
  const s = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(s.bursts.network_interface_changed, undefined, '同じ切替を何度も数えない');
}));

test('1 回分：CRIT の項目だけ送れなくても、軽微な出来事の回数は数える（基準が進む回）', () => withDir(async (dir) => {
  const post = async () => ({ sent: false, code: 'WEBHOOK_UNREACHABLE' });
  const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
  await runHostHealth({ ...opts, run: runner(), now: () => new Date(T0) });
  await runHostHealth({ ...opts, run: runner({ '/sbin/route -n get default': '  interface: en7\n', '/usr/bin/pmset -g ps': "Now drawing from 'UPS Power'\n" }), now: () => new Date(T0 + 30 * MIN) });
  const s = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(s.bursts.network_interface_changed.hits.length, 1);
  assert.equal(s.interface, 'en7');
}));

test('送れない間に解消した CRIT：次に送れる時に 1 回だけ知らせる（回線断は送信も必ず失敗する）', () => withDir(async (dir) => {
  const posted = [];
  let up = false;
  const post = async (n) => { if (!up) return { sent: false, code: 'WEBHOOK_UNREACHABLE' }; posted.push(...n); return { sent: true, code: 'SENT' }; };
  const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
  const tick = (i, run) => runHostHealth({ ...opts, run, now: () => new Date(T0 + i * 30 * MIN) });
  await tick(0, runner());
  const lost = runner({ '/sbin/route -n get default': null });
  for (let i = 1; i <= 24; i += 1) await tick(i, async (bin, args) => (bin === '/sbin/route' ? { code: 1, stdout: '', timedOut: false } : lost(bin, args)));
  up = true;
  for (let i = 25; i <= 30; i += 1) await tick(i, runner());
  assert.deepEqual(posted.map((n) => [n.id, n.change]), [['network_default_route', 'recovered_missed']]);
  assert.match(alertText(posted), /【復旧】ネットワーク：重大な異常があったが通知できなかった。今は正常 → 確認/);
}));

test('state を書けない間は同じ CRIT を毎回送らない（送れた印を残せないので送らず、書けないことだけ枠で知らせる）', () => withDir(async (dir) => {
  const posted = [];
  const post = async (n) => { posted.push(...n); return { sent: true, code: 'SENT' }; };
  const opts = { stateDir: dir, dataDirs: [], uid: 501, webhook: 'credential:E-NEXUS/edl/h', post };
  await runHostHealth({ ...opts, run: runner(), now: () => new Date(T0) });
  mkdirSync(path.join(dir, 'state.json.tmp'));
  const ups = runner({ '/usr/bin/pmset -g ps': "Now drawing from 'UPS Power'\n" });
  for (let i = 1; i <= 12; i += 1) await runHostHealth({ ...opts, run: ups, now: () => new Date(T0 + i * 30 * MIN) });
  assert.ok(!posted.some((n) => n.id === 'power'));
  assert.deepEqual([...new Set(posted.map((n) => `${n.id}:${n.value}`))], ['host_health:state_unwritable']);
  assert.ok(posted.length <= 2, String(posted.length));
}));

/** 送れない回を混ぜて回す。sendable(ms) が false の回は rollbackUnsent で戻す（回線断は送信も失敗する） */
function playSending(runs, sendable = () => true) {
  let prev = null;
  const out = [];
  for (const [ms, items] of runs) {
    const d = decide(items, prev, { now: iso(ms) });
    const ok = !d.notify.length || sendable(ms);
    if (ok) for (const n of d.notify) out.push([ms, n.id, n.change, n.repeat ?? null]);
    const itemsNext = ok ? d.items : rollbackUnsent(d.notify, prev?.items, d.items, iso(ms));
    prev = { items: itemsNext, bursts: ok ? d.bursts : (prev?.bursts ?? {}) };
  }
  return out;
}
const perDay = (out) => out.reduce((m, [ms]) => { const k = Math.floor(ms / (24 * HOUR)); m[k] = (m[k] ?? 0) + 1; return m; }, {});

test('電源の行き来：1 回目はふつうに、2 回目で「反復」を 1 通。明けるまで静かで、落ち着けば回復を 1 回', () => {
  const flapping = (i) => (i < 48 ? i % 3 === 0 : false); // 1.5 時間ごとに 24 時間行き来して、その後は安定
  const out = playSending(every30(72, (i) => [state('power', flapping(i) ? 'crit' : 'ok', 'ups 90%')]));
  assert.deepEqual(out.slice(0, 3), [[0, 'power', 'new', null], [HOUR, 'power', 'recovered', null], [1.5 * HOUR, 'power', 'new', 2]]);
  assert.deepEqual(out.at(-1).slice(1, 3), ['power', 'recovered']);
  assert.ok(out.length <= 5, `3 日で ${out.length} 通`);
});

test('電源と回線が 3 週間行き来し続けても、1 日に 3 通を超えない', () => {
  for (const id of ['power', 'network_default_route']) {
    for (const period of [3, 4, 5, 7, 13]) {
      const out = playSending(every30(24 * 21, (i) => [state(id, i % period === 0 ? 'crit' : 'ok', 'absent')]));
      assert.ok(Math.max(...Object.values(perDay(out))) <= 3, `${id} 周期 ${period}：${JSON.stringify(perDay(out))}`);
      assert.ok(out.some(([, , , r]) => r), '反復は知らせる');
    }
  }
});

test('回線の行き来で送信も失敗する：「知らせられなかった」も数えて、毎回の通知にしない', () => {
  const lost = (ms) => Math.round(ms / (30 * MIN)) % 3 === 0; // 既定経路が無い回は送れない
  const out = playSending(every30(24 * 7, (i) => [state('network_default_route', i % 3 === 0 ? 'crit' : 'ok', 'absent')]), (ms) => !lost(ms));
  assert.deepEqual(out.slice(0, 2).map(([, , change, repeat]) => [change, repeat]), [['recovered_missed', null], ['recovered_missed', 2]]);
  assert.ok(Math.max(...Object.values(perDay(out))) <= 2, JSON.stringify(perDay(out)));
});

test('行き来が 1 回だけの停電は今までどおり：すぐ 1 回・回復 1 回。24 時間あけば別の異常として知らせる', () => {
  const out = playSending(every30(60, (i) => [state('power', i < 4 || (i >= 60 && i < 64) ? 'crit' : 'ok', 'ups 80%')]));
  assert.deepEqual(out.map(([ms, , change, repeat]) => [ms / HOUR, change, repeat]), [[0, 'new', null], [2.5 * HOUR / HOUR, 'recovered', null], [30, 'new', null], [32.5, 'recovered', null]]);
});

test('反復の後も重大が続くなら、明けた回に再通知する（行き来の後の長い停電を黙らせない）', () => {
  const out = playSending(every30(60, (i) => [state('power', i === 0 || i >= 3 ? 'crit' : 'ok', 'ups 50%')]));
  assert.deepEqual(out.map(([ms, , change, repeat]) => [ms / HOUR, change, repeat]), [[0, 'new', null], [1, 'recovered', null], [1.5, 'new', 2], [25.5, 'reminder', null]]);
});

test('再起動・監視の空白の繰り返し：1 回目は 1 通、2 回目で「反復」、24 時間は静か。繰り返す間も 1 日 1 通まで', () => {
  for (const id of ['rebooted', 'monitor_gap']) {
    const runs = Array.from({ length: 24 * 7 }, (_, i) => [i * HOUR, [event(id, '1h0m')]]);
    const out = playSending(runs);
    assert.deepEqual(out.slice(0, 2).map(([ms, , change, repeat]) => [ms / HOUR, change, repeat]), [[0, 'event', null], [1, 'event', 2]]);
    assert.ok(Math.max(...Object.values(perDay(out))) <= 2, JSON.stringify(perDay(out)));
    assert.ok(Object.keys(perDay(out)).length >= 6, '止まり続けるなら毎日知らせる');
  }
  assert.deepEqual(playSending([[0, [event('rebooted')]], [25 * HOUR, [event('rebooted')]]]).map(([, , change, repeat]) => [change, repeat]), [['event', null], ['event', null]], '別の日の 1 回は反復ではない');
});

test('反復の本文：固定の文と回数だけ・値は出さない・回数が数でなければ付けない', () => {
  const text = alertText([{ id: 'power', level: 'crit', value: 'ups 80%', change: 'new', repeat: 3 }, { id: 'rebooted', level: 'warn', value: '2026-11-05T00:00:00.000Z', change: 'event', repeat: 2 }]);
  assert.match(text, /【反復】電源：AC との行き来を繰り返している（24 時間に 3 回）→ 要対応。落ち着くまで通知を控える/);
  assert.match(text, /【反復】Mac：再起動を繰り返している（24 時間に 2 回）→ 心当たりがなければ確認/);
  assert.ok(!text.includes('ups 80%'));
  assert.doesNotMatch(alertText([{ id: 'power', level: 'crit', value: 'ups', change: 'new', repeat: 'x' }]), /反復/);
});

test('行き来を数えない項目の state は変わらない（WARN だけの項目に flap の欄を足さない）', () => {
  const d = decide([state('data_gib', 'crit', 10)], null, { now: iso(0) });
  assert.ok(!('flap_hits' in d.items.data_gib));
  assert.equal(d.notify[0].repeat, undefined);
});

test('監査の列：反復の明けに再通知・回復・新規が続いても、どの 24 時間でも 3 通まで（行き来の項目すべて）', () => {
  const rolling = (out) => Math.max(...out.map(([ms]) => out.filter(([x]) => x >= ms && x < ms + 24 * HOUR).length));
  const seq = ['crit', 'ok', 'ok', ...Array(49).fill('crit'), 'ok', 'ok', 'crit', 'ok', 'ok', 'crit', 'crit', ...Array(100).fill('ok')];
  const out = playSending(seq.map((level, i) => [i * 30 * MIN, [state('power', level, 'ups 90%')]]));
  assert.ok(rolling(out) <= 3, JSON.stringify(out));
  for (const id of ['memory_pressure', 'hermes_isolation', 'monitor_alive', 'monitor_watchdog', 'disk_free_gib', 'hermes_rss_gib', 'hermes_service']) {
    for (const period of [3, 6, 7, 14, 15]) {
      const o = playSending(every30(24 * 14, (i) => [state(id, i % period === 0 ? 'crit' : 'ok', 'ok')]));
      assert.ok(rolling(o) <= 3, `${id} ${period} ${JSON.stringify(o.slice(0, 8))}`);
    }
  }
});

test('通数の上限で持ち越した重大は、上限が明けた回に知らせる（永久に黙らない）・隔離の新しいコードは上限を待たない', () => {
  const seq = [...Array(4).fill(null).flatMap(() => ['crit', 'ok', 'ok']), ...Array(200).fill('crit')];
  const out = playSending(seq.map((level, i) => [i * 30 * MIN, [state('power', level, 'ups 50%')]]));
  assert.ok(out.at(-1)[0] > 24 * HOUR, '続いていれば明けた後にも知らせる');
  const iso1 = playSending([[0, [state('hermes_isolation', 'crit', 'admin_group')]], [30 * MIN, [state('hermes_isolation', 'ok', 'ok')]], [60 * MIN, [state('hermes_isolation', 'ok', 'ok')]], [90 * MIN, [state('hermes_isolation', 'crit', 'admin_group')]], [120 * MIN, [state('hermes_isolation', 'crit', 'admin_group,share_open')]]]);
  assert.deepEqual(iso1.map(([, , change, repeat]) => [change, repeat]), [['new', null], ['recovered', null], ['new', 2], ['new', null]], '反復で静かな間も新しいコードは知らせる');
});

test('再開の後の 2 回目でも watchdog の古い記録で偽の CRIT を出さない（ログインが起動より遅い時）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-resume-'));
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schema: 'host-health-state/v1', items: {}, updated_at: iso(0), last_success_at: iso(0) }));
    writeFileSync(path.join(dir, 'watchdog.json'), JSON.stringify({ updated_at: iso(0) }));
    const label = 'com.e-nexus.host-health-watchdog';
    const run = async (bin, args) => {
      if (bin === '/bin/launchctl' && args[1].includes('watchdog')) return { code: 0, stdout: 'state = not running\n', timedOut: false };
      if (bin === '/usr/sbin/sysctl' && args[1] === 'kern.boottime') return { code: 0, stdout: `{ sec = ${Math.floor((T0 + 5 * HOUR) / 1000) - 7200}, usec = 0 }`, timedOut: false };
      return { code: 1, stdout: '', timedOut: false };
    };
    const base = { stateDir: dir, dataDirs: [], run, uid: 501, guard: { base: dir, repos: [], outbox: path.join(dir, 'none'), operatorHome: dir } };
    mkdirSync(path.join(dir, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(path.join(dir, 'Library', 'LaunchAgents', `${label}.plist`), 'x');
    mkdirSync(path.join(dir, 'x'), { recursive: true });
    const tick = (ms) => runHostHealth({ ...base, now: () => new Date(T0 + ms) });
    const first = await tick(5 * HOUR);
    const second = await tick(5.5 * HOUR);
    const level = (r) => r.items.find((x) => x.id === 'monitor_watchdog')?.level;
    assert.equal(first.status, 'ok');
    assert.equal(level(first), 'unknown');
    assert.equal(level(second), 'unknown', '再開の 2 回目も watchdog の次の回を待つ');
    assert.equal(level(await tick(7 * HOUR)), 'crit', '待った後も watchdog が動かなければ知らせる');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('隔離：回復の後でも 24 時間に知らせていないコードは上限を待たない。2 つのコードの交互は重ねない', () => {
  const lvl = (v) => (v ? 'crit' : 'ok');
  const run = (vals) => playSending(vals.map((v, i) => [i * 30 * MIN, [state('hermes_isolation', lvl(v), v || 'ok')]]));
  const out = run(['share_open', 'share_open,hermes_home_open', '', '', 'admin_group']);
  assert.equal(out.at(-1)[0], 2 * HOUR, '新しいコードはすぐ');
  const alt = run(Array.from({ length: 48 }, (_, i) => (i % 2 ? 'share_open' : 'hermes_home_open')));
  assert.ok(alt.length <= 3, `${alt.length} 通`);
});

test('WARN の行き来は反復に数えない：最初の本物の CRIT は値つきのふつうの通知', () => {
  const seq = ['warn', 'ok', 'ok', 'warn', 'ok', 'ok', 'warn', 'ok', 'ok', 'crit'];
  const out = playSending(seq.map((level, i) => [i * 30 * MIN, [state('memory_pressure', level, 4)]]));
  assert.deepEqual(out.map(([, , change, repeat]) => [change, repeat]), [['new', null]]);
});

test('時計が未来へ飛んだ回の記録で、戻った後の重大を黙らせない', () => {
  const later = 16 * 365 * 24 * HOUR;
  const seq = [[later, 'crit'], [later + HOUR, 'ok'], [later + 2 * HOUR, 'ok'], [later + 3 * HOUR, 'crit'], [later + 4 * HOUR, 'ok'], [later + 5 * HOUR, 'ok'], [0, 'ok'], [HOUR, 'crit']];
  const out = playSending(seq.map(([ms, level]) => [ms, [state('power', level, 'ups 90%')]]));
  assert.ok(out.some(([ms]) => ms === HOUR), JSON.stringify(out));
});
