/**
 * Mac Runtime の見張り（2026-11-04・MA-22・MA-24）。READ-ONLY・Trading Lab の領域を見ない・作業中の差分を異常にしない・
 * ハッシュやパスを記録と通知に出さない。コマンドとファイルは fixture で差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GUARD_BINS, GUARD_LIMITS, HERMES_FILES, HERMES_SHARE, RELAY_REPO, collectGuard, evaluateGuard, evaluateGuardEvents, nextGuardState, parseGitStatus,
  parseLatestBackup, parseTimeMachineDestination, readRepoNames, summarizeRecords, treeSignature,
} from '../scripts/lib/runtime-guard.mjs';
import { ALLOWED_BINS, TRADING_LAB_PATH, parseArgs, reportOf, runHostHealth, validateArgs } from '../scripts/host-health.mjs';

const CLEAN = '# branch.oid abc\n# branch.head master\n# branch.upstream origin/master\n# branch.ab +0 -0\n';
const NOW = '2026-11-04T09:00:00.000Z';
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

function runner(over = {}) {
  const calls = [];
  const table = {
    git: { code: 0, stdout: CLEAN },
    tmutil: { code: 0, stdout: '' },
    id: { code: 0, stdout: 'staff e-nexus-hermes-read everyone\n' },
    route: { code: 0, stdout: '  interface: en1\n' },
    ...over,
  };
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    return table[path.basename(bin)] ?? { code: 1, stdout: '' };
  };
  return { run, calls };
}

/** root の 644 の固定ファイル・700 の home・750 の共有・vault に 1 ファイル */
function fakeFs(over = {}) {
  const modes = {
    '/Users/hermes': { mode: 0o700, uid: 502 },
    '/Users/op': { mode: 0o700, uid: 501 },
    [HERMES_SHARE]: { mode: 0o750, uid: 501 },
    ...Object.fromEntries(Object.values(HERMES_FILES).map((p) => [p, { mode: 0o644, uid: 0 }])),
    ...over.modes,
  };
  const reads = [];
  return {
    reads,
    existsSync: () => true,
    statSync: (p) => modes[p] ?? { mode: 0o640, uid: 501, size: 10, mtimeMs: 1000 },
    readdirSync: (d, o) => {
      if (d === '/outbox') return over.outbox ?? [];
      return o?.withFileTypes ? [{ name: 'a.md', isDirectory: () => false }] : [];
    },
    readFileSync: (p) => { reads.push(p); return Buffer.from(over.content?.[p] ?? 'x'); },
  };
}
const guardArgs = (fsi, repos = ['r1']) => ({ base: '/base', repos, outbox: '/outbox', operatorHome: '/Users/op', fsi });

test('git status の読み取り：clean・dirty・ahead・upstream なし・失敗', () => {
  assert.deepEqual(parseGitStatus({ code: 0, stdout: CLEAN }), { upstream: true, ahead: 0, dirty: 0 });
  assert.deepEqual(parseGitStatus({ code: 0, stdout: `${CLEAN.replace('+0', '+2')}1 .M N... 100644 100644 100644 a b f\n? new\n` }), { upstream: true, ahead: 2, dirty: 2 });
  assert.equal(parseGitStatus({ code: 0, stdout: '# branch.oid a\n# branch.head x\n' }).upstream, false);
  assert.equal(parseGitStatus({ code: 128, stdout: '' }), null);
  assert.equal(parseGitStatus({ code: 0, stdout: CLEAN, timedOut: true }), null);
});

test('Time Machine の読み取り：保存先なしは exit 0・バックアップの時刻', () => {
  assert.deepEqual(parseTimeMachineDestination({ code: 0, stdout: '' }), { configured: false });
  assert.deepEqual(parseTimeMachineDestination({ code: 0, stdout: '====\nName          : Backup\nKind          : Local\n' }), { configured: true });
  assert.equal(parseTimeMachineDestination({ code: 0, stdout: '', timedOut: true }), null);
  assert.equal(parseLatestBackup('/Volumes/B/2026-11-03-120102.backup\n'), '2026-11-03T12:01:02');
  assert.equal(parseLatestBackup('nothing'), null);
});

test('見る repo は repos.conf と relay だけで、Trading Lab は入らない', () => {
  const names = readRepoNames(readFileSync(new URL('../deploy/macos/repos.conf', import.meta.url), 'utf8'));
  assert.ok(names.includes('e-nexus-decision-layer') && names.includes(RELAY_REPO));
  for (const n of names) assert.doesNotMatch(n, TRADING_LAB_PATH);
  assert.ok(!GUARD_BINS.some((b) => /prl/.test(b)));
  for (const b of GUARD_BINS) assert.ok(ALLOWED_BINS.includes(b));
});

test('collectGuard：index を書かない git だけを呼び、Hermes の home の中を読まない', async () => {
  const fsi = fakeFs();
  const { run, calls } = runner();
  const g = await collectGuard({ run, hermesUser: 'hermes', ...guardArgs(fsi) });
  const git = calls.find((c) => c[0] === '/usr/bin/git');
  assert.deepEqual(git.slice(1, 3), ['--no-optional-locks', '-C']);
  assert.ok(!calls.flat().some((a) => /fetch|pull|push|ls-remote/.test(a)));
  assert.deepEqual(g.isolation, []);
  assert.deepEqual(fsi.reads.sort(), Object.values(HERMES_FILES).sort());
  assert.equal(g.backup.configured, false);
});

test('collectGuard：隔離が崩れたらコードで分かる', async () => {
  const fsi = fakeFs({ modes: { '/Users/op': { mode: 0o750, uid: 501 }, '/Users/hermes': { mode: 0o755, uid: 502 }, [HERMES_SHARE]: { mode: 0o755, uid: 501 }, [HERMES_FILES.config]: { mode: 0o664, uid: 0 }, [HERMES_FILES.wrapper]: { mode: 0o755, uid: 502 } } });
  const { run } = runner({ id: { code: 0, stdout: 'staff admin\n' } });
  const g = await collectGuard({ run, hermesUser: 'hermes', ...guardArgs(fsi) });
  assert.deepEqual(g.isolation.sort(), ['admin_group', 'config_not_root_only', 'hermes_home_open', 'operator_home_open', 'share_open', 'wrapper_not_root_only']);
  const it = evaluateGuard({ repos: {}, outbox: { count: 0, oldest_ms: null }, backup: { configured: false }, isolation: g.isolation }, null, NOW).find((x) => x.id === 'hermes_isolation');
  assert.equal(it.level, 'crit');
});

test('読めない時は unknown にして、悪化も回復も作らない', async () => {
  const { run } = runner({ id: { code: 1, stdout: '' }, git: { code: 128, stdout: '' }, tmutil: { code: -1, stdout: '', timedOut: true } });
  const g = await collectGuard({ run, hermesUser: 'hermes', ...guardArgs(fakeFs()) });
  g.service = null;
  const by = Object.fromEntries(evaluateGuard(g, null, NOW).map((x) => [x.id, x.level]));
  assert.deepEqual(by, { 'repo:r1': 'unknown', relay_outbox: 'ok', backup_time_machine: 'unknown', hermes_service: 'unknown', hermes_isolation: 'unknown' });
});

test('repo の差分は続いた時だけ warn（作業中は異常にしない）', () => {
  const g = { repos: { r: { upstream: true, ahead: 1, dirty: 2 } }, outbox: null, backup: null };
  const level = (since) => evaluateGuard(g, since ? { repo_since: { r: since } } : null, NOW).find((x) => x.id === 'repo:r');
  assert.equal(level(null).level, 'ok');
  assert.equal(level(hoursAgo(GUARD_LIMITS.repo_hours - 1)).level, 'ok');
  assert.equal(level(hoursAgo(GUARD_LIMITS.repo_hours)).level, 'warn');
  assert.equal(level(hoursAgo(30)).value, 'dirty 2 ahead 1');
  const s = nextGuardState(g, { repo_since: { r: hoursAgo(5) } }, NOW);
  assert.equal(s.repo_since.r, hoursAgo(5));
  assert.deepEqual(nextGuardState({ repos: { r: { upstream: true, ahead: 0, dirty: 0 } } }, { repo_since: { r: hoursAgo(5) } }, NOW).repo_since, {});
  assert.equal(nextGuardState({ repos: { r: null } }, { repo_since: { r: hoursAgo(5) } }, NOW).repo_since.r, hoursAgo(5));
});

test('relay の未送信・Time Machine・Hermes の常駐の判定', () => {
  const base = { repos: {}, outbox: { count: 0, oldest_ms: null }, backup: { configured: false } };
  const item = (g, id) => evaluateGuard({ ...base, ...g }, null, NOW).find((x) => x.id === id);
  assert.equal(item({ outbox: { count: 1, oldest_ms: Date.parse(hoursAgo(2)) } }, 'relay_outbox').level, 'ok');
  assert.deepEqual([item({ outbox: { count: 2, oldest_ms: Date.parse(hoursAgo(25)) } }, 'relay_outbox')].map((x) => [x.level, x.value]), [['warn', 2]]);
  assert.deepEqual([item({}, 'backup_time_machine')].map((x) => [x.level, x.value]), [['ok', 'not_configured']]);
  assert.equal(item({ backup: { configured: true, latest: hoursAgo(24) } }, 'backup_time_machine').level, 'ok');
  assert.equal(item({ backup: { configured: true, latest: hoursAgo(24 * 3) } }, 'backup_time_machine').level, 'warn');
  assert.equal(item({ backup: { configured: true, latest: hoursAgo(24 * 7) } }, 'backup_time_machine').level, 'crit');
  assert.equal(item({ backup: { configured: true, latest: null } }, 'backup_time_machine').level, 'unknown');
  assert.equal(item({ service: { loaded: true, state: 'running', pid: 5 } }, 'hermes_service').level, 'ok');
  assert.deepEqual([item({ service: { loaded: true, state: 'not running', pid: null, last_exit_code: 0 } }, 'hermes_service')].map((x) => [x.level, x.value]), [['warn', 'stopped exit 0']]);
  assert.equal(item({ service: { loaded: false } }, 'hermes_service').value, 'not_loaded');
  assert.equal(item({}, 'hermes_service'), undefined);
});

test('出来事：最初は基準を取るだけ・再起動と変化は名前だけ', () => {
  const g = { repos: {}, service: { pid: 9 }, drift: { config: 'b'.repeat(64), plist: 'c', wrapper: null } };
  assert.deepEqual(evaluateGuardEvents(g, null), []);
  const ev = evaluateGuardEvents(g, { hermes_pid: 8, drift: { config: 'a'.repeat(64), plist: 'c', wrapper: 'd' } });
  assert.deepEqual(ev.map((e) => [e.id, e.value]), [['hermes_restarted', null], ['hermes_files_changed', 'config']]);
  assert.deepEqual(evaluateGuardEvents({ repos: {}, service: { pid: null } }, { hermes_pid: 8 }), []);
});

test('写しの署名は一覧の変化で変わり、ファイルの中身を読まない', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-'));
  try {
    writeFileSync(path.join(dir, 'a.md'), 'x');
    const a = treeSignature(dir);
    assert.equal(treeSignature(dir), a);
    writeFileSync(path.join(dir, 'b.md'), 'y');
    assert.notEqual(treeSignature(dir), a);
    assert.equal(treeSignature(path.join(dir, 'none')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function hostRun(over = {}) {
  const { run, calls } = runner(over);
  const wrapped = async (bin, args) => {
    if (bin === '/bin/launchctl' && args[1]?.startsWith('system/')) return over.launchctl ?? { code: 0, stdout: `system/x = {\n\tstate = running\n\tpid = ${over.pid ?? 700}\n}\n` };
    return run(bin, args);
  };
  return { run: wrapped, calls };
}

test('host-health の 1 回分に入り、記録と通知にハッシュ・パスが出ず、送れなかった変化は次の回に残る', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-hh-'));
  try {
    const opts = { stateDir: dir, dataDirs: [], hermesUser: 'hermes', uid: 501 };
    const first = await runHostHealth({ ...opts, guard: guardArgs(fakeFs({ content: { [HERMES_FILES.config]: 'one' } })), run: hostRun().run });
    assert.equal(first.code, 0, first.error);
    assert.equal(first.notify.length, 0);
    const failing = async () => ({ sent: false, code: 'WEBHOOK_TIMEOUT' });
    const changed = guardArgs(fakeFs({ content: { [HERMES_FILES.config]: 'two' } }));
    const second = await runHostHealth({ ...opts, guard: changed, run: hostRun({ pid: 701 }).run, webhook: 'credential:E-NEXUS/edl/x', post: failing });
    assert.deepEqual(second.notify.map((n) => n.id).sort(), ['hermes_files_changed', 'hermes_restarted']);
    const sent = [];
    const third = await runHostHealth({ ...opts, guard: changed, run: hostRun({ pid: 701 }).run, webhook: 'credential:E-NEXUS/edl/x', post: async (n) => { sent.push(...n); return { sent: true, code: 'SENT' }; } });
    assert.deepEqual(third.notify.map((n) => n.id).sort(), ['hermes_files_changed', 'hermes_restarted']);
    const fourth = await runHostHealth({ ...opts, guard: changed, run: hostRun({ pid: 701 }).run });
    assert.equal(fourth.notify.length, 0);
    const log = readFileSync(path.join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8');
    assert.doesNotMatch(log, /[0-9a-f]{64}|\/Users\/|\/etc\/|\/Library\//);
    assert.doesNotMatch(JSON.stringify(sent), /[0-9a-f]{64}|\//);
    assert.deepEqual(reportOf(dir, { days: 1 }).events.map((e) => e.id).sort(), ['hermes_files_changed', 'hermes_files_changed', 'hermes_restarted', 'hermes_restarted']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-guard なら見張りを呼ばない・引数の検査', async () => {
  assert.equal(parseArgs(['--no-guard']).guard, false);
  assert.equal(parseArgs([]).guard, true);
  assert.equal(parseArgs(['--report', '--days', '3']).report, true);
  assert.deepEqual(validateArgs(parseArgs(['--report', '--days', '7'])), []);
  assert.equal(validateArgs(parseArgs(['--days', '0'])).length, 1);
});

test('観察の要約：期間・欠け・ピーク・悪かった項目・出来事', () => {
  const rec = (at, items) => JSON.stringify({ at, items });
  const s = summarizeRecords([
    rec('2026-11-01T00:00:00.000Z', [{ id: 'hermes_rss_gib', level: 'ok', value: 9 }]),
    rec('2026-11-04T00:20:00.000Z', [{ id: 'hermes_rss_gib', level: 'ok', value: 0.2 }, { id: 'load_15m', level: 'ok', value: 2 }]),
    rec('2026-11-04T00:50:00.000Z', [{ id: 'hermes_rss_gib', level: 'ok', value: 0.4 }, { id: 'hermes_service', level: 'warn', value: 'stopped exit 0' }]),
    'broken',
    rec('2026-11-04T02:20:00.000Z', [{ id: 'hermes_restarted', level: 'warn', value: null }, { id: 'disk_free_gib', level: 'unknown', value: null }]),
  ], { since: '2026-11-02T00:00:00.000Z' });
  assert.equal(s.records, 3);
  assert.equal(s.gaps, 1);
  assert.deepEqual(s.peak, { hermes_rss_gib: 0.4, load_15m: 2 });
  assert.deepEqual(s.not_ok, { hermes_service: { warn: 1, crit: 0, unknown: 0 }, disk_free_gib: { warn: 0, crit: 0, unknown: 1 } });
  assert.deepEqual(s.events, [{ at: '2026-11-04T02:20:00.000Z', id: 'hermes_restarted', value: null }]);
});
