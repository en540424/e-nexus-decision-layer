/**
 * Hermes へ渡す状態の要約（2026-11-04・A2。2026-11-05 H4 で本番の共有を開始）。allowlist・値を出さない・見張りの項目を渡さない・--out は一時フォルダだけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STATUS_DIR, STATUS_FILE, SUMMARY_SCHEMA, assertMockOut, buildStatusSummary, writeStatusSummary } from '../scripts/lib/runtime-status-summary.mjs';
import { runHostHealth } from '../scripts/host-health.mjs';
import { main } from '../scripts/runtime-status-summary.mjs';
import { HERMES_SHARE } from '../scripts/lib/runtime-guard.mjs';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const item = (level) => ({ level, since: '2026-11-04T08:00:00.000Z', last_notified_at: null });
const STATE = {
  updated_at: '2026-11-04T08:50:00.000Z',
  boottime: 1790751889,
  interface: 'en9',
  guard: { drift: { config: 'deadbeef' }, hermes_pid: 4242, residents: ['com.e-nexus.hermes'] },
  items: {
    disk_free_gib: item('warn'),
    memory_pressure: item('ok'),
    hermes_rss_gib: item('ok'),
    hermes_isolation: item('crit'),
    hermes_service: item('ok'),
    agent_scope: item('warn'),
    'repo:secret-repo-name': item('warn'),
    'job:usage-digest': item('ok'),
    'github:private-repo': item('crit'),
    unknown_future_item: item('crit'),
  },
};

test('allowlist：水準と件数だけ。値・hash・pid・回線名・repo 名・未知の項目を出さない', () => {
  const s = buildStatusSummary(STATE, { now: NOW });
  const text = JSON.stringify(s);
  assert.equal(s.schema, SUMMARY_SCHEMA);
  for (const secret of ['en9', 'deadbeef', '4242', 'secret-repo-name', 'private-repo', 'unknown_future_item', 'boottime', 'since', 'Users']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(s.attention, [{ group: 'host', id: 'disk_free_gib', level: 'warn' }]);
  assert.deepEqual(s.groups.backup, { level: 'unknown', not_ok: 0 }, '項目の無い群を ok と言わない');
  assert.deepEqual(s.groups.repos, { level: 'warn', not_ok: 1 });
  assert.deepEqual(s.groups.github, { level: 'crit', not_ok: 1 });
  assert.equal(s.overall, 'crit');
});

test('見張られる側に検知の中身を渡さない：隔離・user 範囲・常駐・固定ファイルの項目は要約に入らない', () => {
  const s = buildStatusSummary(STATE, { now: NOW });
  assert.equal(s.groups.hermes.level, 'ok', 'hermes_isolation の crit を反映しない');
  assert.ok(!JSON.stringify(s).includes('isolation') && !JSON.stringify(s).includes('agent_scope'));
});

test('監視が動いていない時は「正常」と言わない：古い・無い・PAUSE・DISABLED は overall unknown', () => {
  assert.equal(buildStatusSummary(STATE, { now: new Date('2026-11-04T11:00:00.000Z') }).monitor, 'stale');
  assert.equal(buildStatusSummary(null, { now: NOW }).overall, 'unknown');
  assert.equal(buildStatusSummary(STATE, { now: NOW, paused: true }).monitor, 'paused');
  const off = buildStatusSummary(STATE, { now: NOW, disabled: true });
  assert.deepEqual([off.monitor, off.overall, off.groups.host.level, off.attention], ['disabled', 'unknown', 'unknown', []]);
  assert.equal(buildStatusSummary({ updated_at: STATE.updated_at, items: {} }, { now: NOW }).overall, 'unknown', '何も見ていなければ正常と言わない');
  assert.equal(buildStatusSummary({ updated_at: 'broken', items: {} }, { now: NOW }).monitor, 'stale');
  assert.doesNotThrow(() => buildStatusSummary({ updated_at: STATE.updated_at, items: { disk_free_gib: null } }, { now: NOW }));
});

test('送れていない異常を ok と言わない：今の水準（observed）を通知の状態（items）より優先する', () => {
  const s = buildStatusSummary({ updated_at: STATE.updated_at, items: { disk_free_gib: item('ok') }, observed: { disk_free_gib: 'crit' } }, { now: NOW });
  assert.equal(s.overall, 'crit');
  assert.deepEqual(s.attention, [{ group: 'host', id: 'disk_free_gib', level: 'crit' }]);
});

test('書き先：一時フォルダの中だけ。Hermes の共有・home・symlink 経由・環境変数では開かない（手で試す口から本番へ出さない）', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-summary-'));
  try {
    assert.ok(assertMockOut(path.join(dir, 'out.json')).endsWith('out.json'));
    for (const p of [path.join(HERMES_SHARE, 'status.json'), '/Users/hermes/status.json', '/etc/hermes/status.json', path.join(dir, '..', '..', '..', '..', 'Users', 'Shared', 'x.json')]) {
      assert.throws(() => assertMockOut(p), /--out writes only under the temp folder/, p);
    }
    symlinkSync('/Users/Shared', path.join(dir, 'link'));
    assert.throws(() => assertMockOut(path.join(dir, 'link', 'x.json')), /--out writes only under the temp folder/);
    writeFileSync(path.join(dir, 'real.json'), '');
    symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'file-link.json'));
    assert.throws(() => assertMockOut(path.join(dir, 'file-link.json')), /--out writes only under the temp folder/);
    symlinkSync(path.join(HERMES_SHARE, 'dangling.json'), path.join(dir, 'dangling.json'));
    assert.throws(() => assertMockOut(path.join(dir, 'dangling.json')), /--out writes only under the temp folder/, '切れた symlink も拒む');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = HERMES_SHARE;
    try {
      assert.throws(() => assertMockOut(path.join(HERMES_SHARE, 'status.json')), /--out writes only under the temp folder/);
    } finally {
      process.env.TMPDIR = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：--out は mode 600・知らない引数と許可の外は exit 2・state が無くても動く', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-summary-'));
  try {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE));
    const out = path.join(dir, 'o.json');
    assert.equal(main(['--state-dir', dir, '--out', out], { now: NOW }), 0);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).overall, 'crit');
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(main(['--state-dir', dir, '--out', out], { now: NOW }), 2, '既にあるファイルへ書かない（wx）');
    assert.equal(main(['--share', '/x']), 2);
    const pause = path.join(dir, 'PAUSE');
    writeFileSync(pause, '');
    utimesSync(pause, new Date(NOW.getTime() - 100 * 3_600_000), new Date(NOW.getTime() - 100 * 3_600_000));
    let shown = '';
    main(['--state-dir', dir], { log: (t) => { shown = t; }, now: NOW });
    assert.equal(JSON.parse(shown).monitor, 'running', '期限切れの PAUSE で paused のままにしない');
    rmSync(pause);
    assert.equal(main(['--state-dir', '/Users/x/Parallels/x']), 2, 'Trading Lab の領域を読まない');
    assert.equal(main(['--state-dir', 'relative']), 2);
    assert.equal(main(['--state-dir', dir, '--out', `${HERMES_SHARE}/s.json`]), 2);
    let printed = '';
    assert.equal(main(['--state-dir', path.join(dir, 'none')], { log: (t) => { printed = t; }, now: NOW }), 0);
    assert.equal(JSON.parse(printed).monitor, 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本番の書き込み：0640・置き換え・tmp を残さない。フォルダが無ければ何もしない・危ないフォルダへは書かない', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-status-'));
  try {
    const dir = path.join(root, 'status');
    const uid = process.getuid();
    assert.equal(writeStatusSummary({ a: 1 }, { dir, uid }), 'not_configured', 'フォルダを作らない');
    assert.ok(!existsSync(dir));
    mkdirSync(dir, { mode: 0o750 });
    chmodSync(dir, 0o750);
    assert.equal(writeStatusSummary({ a: 1 }, { dir, uid }), 'written');
    assert.equal(writeStatusSummary({ a: 2 }, { dir, uid }), 'written', '2 回目は置き換え');
    const file = path.join(dir, STATUS_FILE);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(dir), [STATUS_FILE]);
    assert.equal(writeStatusSummary({ a: 3 }, { dir, uid: uid + 1 }), 'dir_unsafe', '他人のフォルダ');
    chmodSync(dir, 0o770);
    assert.equal(writeStatusSummary({ a: 3 }, { dir, uid }), 'dir_unsafe', 'group が書ける');
    chmodSync(dir, 0o750);
    const link = path.join(root, 'link');
    symlinkSync(dir, link);
    assert.equal(writeStatusSummary({ a: 3 }, { dir: link, uid }), 'dir_unsafe', 'symlink');
    mkdirSync(path.join(root, 'ro'), { mode: 0o550 });
    assert.equal(writeStatusSummary({ a: 3 }, { dir: path.join(root, 'ro'), uid }), 'write_failed');
    chmodSync(path.join(root, 'ro'), 0o750);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本番の置き場は Hermes の共有の下の固定 1 か所', () => {
  assert.equal(STATUS_DIR, '/Users/Shared/e-nexus-hermes/status');
});

test('host-health の 1 回分：要約だけを書く・値やパスを出さない・書けなければ監視は止めず WARN が 1 回・DISABLED の間も disabled と書く', { skip: process.platform !== 'darwin' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-status-'));
  try {
    const stateDir = path.join(root, 'state');
    const statusDir = path.join(root, 'status');
    mkdirSync(statusDir, { mode: 0o750 });
    chmodSync(statusDir, 0o750);
    const T = Date.parse('2026-11-05T00:20:00.000Z');
    const base = { stateDir, statusDir, dataDirs: [], uid: process.getuid(), webhook: 'credential:E-NEXUS/edl/h', post: async () => ({ sent: true, code: 'SENT' }) };
    const run = async (bin) => (bin === '/bin/df' ? { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s1 1000 900 12000000 90% /\n', timedOut: false } : { code: 1, stdout: '', timedOut: false });
    const tick = (m, extra = {}) => runHostHealth({ ...base, run, now: () => new Date(T + m * 60_000), ...extra });
    const first = await tick(0);
    assert.equal(first.code, 0);
    const text = readFileSync(path.join(statusDir, STATUS_FILE), 'utf8');
    const s = JSON.parse(text);
    assert.deepEqual([s.schema, s.monitor], ['runtime-status-summary/v1', 'running']);
    assert.ok(s.attention.some((a) => a.id === 'disk_free_gib'));
    assert.ok(s.attention.every((a) => Object.keys(a).join() === 'group,id,level'), '項目は群・id・水準だけ');
    assert.ok(!/11\.4|12000000|\/dev|\/Users|disk3/.test(text), '値・パスを出さない');
    chmodSync(statusDir, 0o770);
    const unsafe = await tick(30);
    assert.equal(unsafe.code, 0, '要約が書けなくても監視は止めない');
    const later = await tick(60);
    assert.deepEqual(later.items.find((x) => x.id === 'status_summary').level, 'warn');
    const held = await tick(60 + 24 * 60);
    assert.ok(held.notify.some((n) => n.id === 'status_summary'), '続いた時だけ 1 回');
    chmodSync(statusDir, 0o750);
    writeFileSync(path.join(stateDir, 'DISABLED'), 'x');
    await tick(60 + 24 * 60 + 30);
    assert.equal(JSON.parse(readFileSync(path.join(statusDir, STATUS_FILE), 'utf8')).monitor, 'disabled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
