/**
 * Hermes へ渡す状態の要約（2026-11-04・A2 のモック）。allowlist・値を出さない・見張りの項目を渡さない・本番の共有へ書けない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SUMMARY_SCHEMA, assertMockOut, buildStatusSummary } from '../scripts/lib/runtime-status-summary.mjs';
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

test('書き先：一時フォルダの中だけ。Hermes の共有・home・symlink 経由・環境変数では開かない（承認の前に本番へ出さない）', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-summary-'));
  try {
    assert.ok(assertMockOut(path.join(dir, 'out.json')).endsWith('out.json'));
    for (const p of [path.join(HERMES_SHARE, 'status.json'), '/Users/hermes/status.json', '/etc/hermes/status.json', path.join(dir, '..', '..', '..', '..', 'Users', 'Shared', 'x.json')]) {
      assert.throws(() => assertMockOut(p), /A2 is not approved/, p);
    }
    symlinkSync('/Users/Shared', path.join(dir, 'link'));
    assert.throws(() => assertMockOut(path.join(dir, 'link', 'x.json')), /A2 is not approved/);
    writeFileSync(path.join(dir, 'real.json'), '');
    symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'file-link.json'));
    assert.throws(() => assertMockOut(path.join(dir, 'file-link.json')), /A2 is not approved/);
    symlinkSync(path.join(HERMES_SHARE, 'dangling.json'), path.join(dir, 'dangling.json'));
    assert.throws(() => assertMockOut(path.join(dir, 'dangling.json')), /A2 is not approved/, '切れた symlink も拒む');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = HERMES_SHARE;
    try {
      assert.throws(() => assertMockOut(path.join(HERMES_SHARE, 'status.json')), /A2 is not approved/);
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
