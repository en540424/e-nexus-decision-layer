/**
 * 運用の道具（2026-11-05・Batch C）と、job の欠落・設定改変・Webhook の生存・relay の未反映の見張り。合成のデータだけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JOB_PERIOD_HOURS, THRESHOLDS, WATCHDOG_LABEL, checkWebhook, evaluate, jobRunsCheck, notifyChannelItem, safeValue } from '../scripts/host-health.mjs';
import { monitorWebhookItem } from '../scripts/host-health-watchdog.mjs';
import { collectGithub } from '../scripts/lib/github-guard.mjs';
import { ruleOf } from '../scripts/lib/alert-policy.mjs';
import { collectGuard, evaluateGuard, evaluateGuardEvents, plistArgs } from '../scripts/lib/runtime-guard.mjs';
import { acceptanceOf, humanRequired, parse, readRecords, validate, whyOf } from '../scripts/runtime-ops.mjs';

const NOW = Date.parse('2026-11-08T10:20:00.000Z');
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const BACKUP = 'com.e-nexus.runtime-backup';
const row = (h, items, extra = {}) => ({ at: at(h), items, notify: [], notify_code: 'NOTHING_TO_SEND', ...extra });
const healthy = (h) => row(h, [{ id: 'monitor_watchdog', level: 'ok', value: 'ok' }, { id: 'github_api', level: 'ok', value: 'ok' }, { id: 'github:a', level: 'ok', value: 'ok' }, { id: 'heartbeat', level: 'ok', value: 'sent' }, { id: 'hermes_service', level: 'ok', value: 'running' }, { id: 'hermes_rss_gib', level: 'ok', value: 0.2 }]);
const base = () => ({
  state: { status_summary: 'written', heartbeat: { code: 'sent', fail_since: null }, github_token_expires_at: '2027-02-03T08:39:03.000Z' },
  watchdog: { updated_at: at(0.5), items: { monitor_alive: { level: 'ok' } } },
  receipt: { finished_at: at(5), consecutive_failures: 0, history_verified_at: at(20), history_failure: null },
  records: [healthy(1), healthy(0.5)],
  jobs: { [WATCHDOG_LABEL]: { loaded: true }, [BACKUP]: { loaded: true, runs: 1, last_exit_code: 0 } },
  briefAge: 0.3,
  now: NOW,
});
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.verdict]));

test('検収：記録で揃えば pass。観察は 7 日たつまで pending', () => {
  const v = byId(acceptanceOf(base()));
  assert.deepEqual(v, { H2: 'pass', H3: 'pass', H4: 'pass', H5: 'pass', H6: 'pass', H8: 'pending' });
});

test('検収：定期の回がまだなら pending（手で送った初回だけでは pass にしない）', () => {
  const b = base();
  b.jobs[BACKUP] = { loaded: true, runs: 0, last_exit_code: null };
  b.state.heartbeat = { code: 'off', fail_since: null };
  b.records = [row(1, []), row(0.5, [])];
  const v = byId(acceptanceOf(b));
  assert.equal(v.H5, 'pending');
  assert.equal(v.H6, 'pending');
  assert.equal(v.H3, 'pending');
});

test('検収：異常は fail（watchdog の途絶・token の失効・バックアップの失敗・信号の失敗の継続）', () => {
  const b = base();
  b.watchdog.updated_at = at(4);
  b.records = [row(0.5, [{ id: 'github_api', level: 'warn', value: 'auth_failed' }, { id: 'monitor_watchdog', level: 'crit', value: 'stale 240m' }])];
  b.receipt.consecutive_failures = 2;
  b.state.heartbeat = { code: 'failed', fail_since: at(2) };
  const v = byId(acceptanceOf(b));
  assert.deepEqual([v.H2, v.H3, v.H5, v.H6], ['fail', 'fail', 'fail', 'fail']);
});

test('原因調査：変わった回だけ並べ、通知の有無と誰が動くか。値は関所を通す', () => {
  const rows = [
    row(3, [{ id: 'disk_free_gib', level: 'ok', value: 60 }]),
    row(2, [{ id: 'disk_free_gib', level: 'ok', value: 60 }]),
    row(1, [{ id: 'disk_free_gib', level: 'crit', value: 10 }], { notify: [{ id: 'disk_free_gib', level: 'crit', change: 'new' }], notify_code: 'SENT' }),
    row(0.5, [{ id: 'job:x', level: 'warn', value: '/Users/someone/path' }]),
  ];
  const w = whyOf('disk_free_gib', rows);
  assert.equal(w.class, 'human');
  assert.deepEqual(w.timeline.map((t) => [t.level, t.value, t.notified ?? null]), [['ok', 60, null], ['crit', 10, 'new']]);
  assert.equal(whyOf('job:x', rows).timeline[0].value, '[redacted]');
});

test('Human Required：台帳＋今の異常（human だけ）＋期限の近い token を優先度の順に。済んだものと ai の項目は出ない', () => {
  const rows = humanRequired({
    ledger: [{ id: 'console', priority: 1, title: 'Console の計上先', due: '2026-11-12' }, { id: 'old', priority: 1, title: 'x', done: true }, { id: 'vps', priority: 3, title: 'VPS の更新' }],
    last: row(0, [{ id: 'power', level: 'crit', value: 'battery' }, { id: 'repo:a', level: 'warn', value: 'dirty 1' }]),
    state: { github_token_expires_at: at(-24 * 20) },
    receipt: { token_expires_at: at(-24 * 5) },
    now: NOW,
  });
  assert.deepEqual(rows.map((r) => r.id), ['console', 'token:バックアップの token', 'item:power', 'token:GitHub の見張りの token', 'vps']);
  const overdue = humanRequired({ ledger: [{ id: 'c', title: 'x', due: '2026-11-01' }], now: NOW });
  assert.equal(overdue[0].overdue, true);
});

test('記録の読み取り：壊れた行を飛ばす・引数は絶対パスだけ・Trading Lab の領域は見ない', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ops-'));
  try {
    writeFileSync(path.join(dir, '2026-11.jsonl'), `${JSON.stringify(row(1, []))}\nbroken\n${JSON.stringify(row(0.5, []))}\n`);
    assert.equal(readRecords(dir).length, 2);
    assert.equal(readRecords(dir, { since: at(0.7) }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(validate(parse(['acceptance'])), []);
  assert.ok(validate(parse(['why'])).length);
  assert.ok(validate(parse(['human', '--ledger', 'rel.json'])).length);
  assert.ok(validate(parse(['brief', '--file', '/x/Parallels/a.json'])).length);
  assert.throws(() => parse(['why', '--nope']));
});

// ─── job の失敗・欠落 ───

const JOB = { loaded: true, state: 'not running', pid: null, last_exit_code: 0, runs: 3, last_signal: null };
const jobItem = (o, opts) => evaluate({ jobs: { [BACKUP]: { ...JOB, ...o } }, guard: { residents: [BACKUP] } }, THRESHOLDS, opts).find((x) => x.id === 'job:runtime-backup');

test('job：定期の時刻を過ぎても runs が増えなければ missed。増えれば数え直す。読めない回は基準を進めない', () => {
  const limit = JOB_PERIOD_HOURS[BACKUP] * 1.25;
  const first = jobRunsCheck({ [BACKUP]: JOB }, null, at(40));
  assert.deepEqual(first.missed, {});
  assert.equal(jobRunsCheck({ [BACKUP]: JOB }, first.next, at(40 - limit + 1)).missed[BACKUP], undefined);
  const late = jobRunsCheck({ [BACKUP]: JOB }, first.next, at(5));
  assert.equal(late.missed[BACKUP], 35);
  assert.deepEqual(jobRunsCheck({ [BACKUP]: { ...JOB, runs: 4 } }, first.next, at(5)).missed, {});
  assert.equal(jobRunsCheck({ [BACKUP]: null }, first.next, at(5)).next[BACKUP].at, first.next[BACKUP].at);
  assert.deepEqual(jobRunsCheck({ [BACKUP]: { loaded: false } }, first.next, at(5)).missed, {}, '解除は別の項目で見る');
  assert.equal(jobItem({}, { missed: { [BACKUP]: 35 } }).value, 'missed 35h');
  assert.equal(jobItem({}, { missed: { [BACKUP]: 35 } }).level, 'warn');
  assert.equal(safeValue('job:runtime-backup', 'missed 35h'), 'missed 35h');
});

test('job：定義があるのに読み込まれていない・signal で落ちたのは WARN。未登録は異常にしない', () => {
  assert.deepEqual([jobItem({ loaded: false }).level, jobItem({ loaded: false }).value], ['warn', 'registered_not_loaded']);
  const unregistered = evaluate({ jobs: { [BACKUP]: { loaded: false } }, guard: { residents: [] } }).find((x) => x.id === 'job:runtime-backup');
  assert.deepEqual([unregistered.level, unregistered.value], ['ok', 'not_loaded']);
  const watchdog = evaluate({ jobs: { [WATCHDOG_LABEL]: { loaded: false } }, guard: { residents: [WATCHDOG_LABEL] } }).find((x) => x.id === 'job:host-health-watchdog');
  assert.equal(watchdog.level, 'ok', '解除は monitor_watchdog が CRIT で見る');
  assert.deepEqual([jobItem({ last_signal: '9' }).level, jobItem({ last_signal: '9' }).value], ['warn', 'signal 9']);
  assert.equal(safeValue('job:x', 'signal 9'), 'signal 9');
  assert.equal(safeValue('job:x', 'registered_not_loaded'), 'registered_not_loaded');
});

// ─── 設定の改変 ───

const plist = (...args) => `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array></dict></plist>`;
const fakeFsi = (files) => ({ existsSync: (p) => Object.hasOwn(files, p), readFileSync: (p) => { if (!Object.hasOwn(files, p)) throw new Error('none'); return files[p]; }, readdirSync: () => [], statSync: () => ({ mode: 0o700, uid: 0, mtimeMs: 0 }) });
const AGENTS = '/Users/op/Library/LaunchAgents';
const guardOf = (files) => collectGuard({ run: async () => ({ code: 0, stdout: '', timedOut: false }), base: '/b', repos: [], outbox: '/o', operatorHome: '/Users/op', fsi: fakeFsi(files) });
const FULL = { [`${AGENTS}/com.e-nexus.host-health.plist`]: plist('--webhook', 'credential:x', '--heartbeat', '--github-owner', 'o'), [`${AGENTS}/com.e-nexus.host-health-watchdog.plist`]: plist('--webhook', 'credential:x') };

test('設定：バックアップの job と除外の条件の変化も出来事になる（初回は基準だけ）', async () => {
  const files = { ...FULL, [`${AGENTS}/${BACKUP}.plist`]: plist('--deny-file', '/d/deny.txt'), '/d/deny.txt': 'a\nb\n' };
  const first = await guardOf(files);
  assert.ok(first.config.backup_plist && first.config.backup_deny);
  const changed = await guardOf({ ...files, '/d/deny.txt': 'a\n' });
  const ev = evaluateGuardEvents(changed, { config: first.config });
  assert.deepEqual(ev.map((e) => [e.id, e.value]), [['monitor_config_changed', 'backup_deny']]);
  assert.deepEqual(evaluateGuardEvents(changed, { config: {} }), [], '基準が無い項目は知らせない（導入の回に鳴らさない）');
  assert.equal(safeValue('monitor_config_changed', 'backup_deny,backup_plist'), 'backup_deny,backup_plist');
  assert.equal(safeValue('monitor_config_changed', 'repos_conf'), 'repos_conf');
});

test('設定：job の引数の欠け。host-health は watchdog の分を、watchdog は host-health の分を知らせる', async () => {
  assert.deepEqual((await guardOf(FULL)).monitor_args, []);
  const g = await guardOf({ ...FULL, [`${AGENTS}/com.e-nexus.host-health.plist`]: plist('--heartbeat'), [`${AGENTS}/com.e-nexus.host-health-watchdog.plist`]: plist('x') });
  assert.deepEqual(g.monitor_args, ['monitor_no_webhook', 'monitor_no_github', 'watchdog_no_webhook']);
  const it = evaluateGuard({ repos: {}, outbox: null, backup: null, monitor_args: g.monitor_args }, null, at(0)).find((x) => x.id === 'monitor_args');
  assert.equal(it.level, 'warn');
  assert.equal(ruleOf('monitor_args').hold, 0, '待たずに知らせる');
  assert.equal((await guardOf({})).monitor_args, undefined, '登録の前は項目にしない');
  assert.equal((await guardOf({ [`${AGENTS}/com.e-nexus.host-health.plist`]: 'bplist00binary' })).monitor_args, null);
  assert.equal(monitorWebhookItem(plist('--webhook', 'x')).level, 'ok');
  assert.deepEqual([monitorWebhookItem(plist('x')).level, monitorWebhookItem(plist('x')).value], ['warn', 'no_webhook']);
  assert.equal(monitorWebhookItem(null).level, 'unknown');
  assert.equal(plistArgs('not xml'), null);
});

// ─── Webhook の生存 ───

test('Webhook の生存：何も送らず GET だけ。本文を読まない・Discord の形だけ', async () => {
  const URL_OK = 'https://discord.com/api/webhooks/1/abc';
  const calls = [];
  const fetchImpl = async (u, o) => { calls.push([u, o.method, o.body]); return { status: 200, json: () => { throw new Error('本文を読まない'); } }; };
  assert.equal(await checkWebhook({ spec: 'credential:E-NEXUS/edl/x', readCredentialImpl: async () => URL_OK, fetchImpl }), 'ok');
  assert.deepEqual(calls[0], [URL_OK, 'GET', undefined]);
  for (const status of [401, 403, 404]) assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => ({ status }) }), 'gone');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => ({ status: 503 }) }), 'unreachable');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => { throw new Error('x'); } }), 'unreachable');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => 'https://evil.example/hook', fetchImpl }), 'config_invalid');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => null, fetchImpl }), 'config_invalid');
  assert.equal(notifyChannelItem(null), null);
  assert.equal(notifyChannelItem({ code: 'ok' }).level, 'ok');
  assert.equal(notifyChannelItem({ code: 'unreachable' }).level, 'ok', '一時の失敗では鳴らさない');
  assert.equal(notifyChannelItem({ code: 'gone' }).level, 'warn');
  assert.equal(safeValue('notify_channel', 'gone'), 'gone');
});

// ─── relay の未反映 ───

test('relay：acks branch のファイル名だけ読む。自分の machine だけ数える・読めなければ null', async () => {
  const ID = '20261105T064601Z-mac-mini-e98bca';
  const reply = (status, json) => ({ status, json: async () => json, headers: { get: () => null } });
  const seen = [];
  const fetchImpl = async (u) => {
    const p = new URL(u).pathname;
    seen.push(p);
    if (p.endsWith('/git/trees/acks')) return reply(200, { tree: [{ path: `acks/mac-mini/2026-11/${ID}.json` }, { path: 'acks/other/2026-11/20261105T064601Z-other-aaaaaa.json' }, { path: 'acks/mac-mini/2026-11/bad name.json' }] });
    if (p.endsWith('/git/ref/heads/master')) return reply(200, { object: { sha: 'abc' } });
    if (p.endsWith('/status')) return reply(200, { total_count: 0, state: 'pending' });
    if (p.endsWith('/actions/runs')) return reply(200, { workflow_runs: [] });
    return reply(200, { default_branch: 'master', visibility: 'private' });
  };
  const args = { credential: 'E-NEXUS/edl/x', owner: 'o', repos: ['e-nexus-devlog-relay'], now: at(0), read: async () => 'github_pat_x', fetchImpl };
  const r = await collectGithub({ ...args, relay: { repo: 'e-nexus-devlog-relay', prefix: 'acks/mac-mini/' } });
  assert.deepEqual(r.relay_acked, [ID]);
  assert.ok(!seen.some((p) => /contents|blobs/.test(p)), '中身は読まない');
  assert.equal((await collectGithub(args)).relay_acked, undefined);
  const broken = await collectGithub({ ...args, relay: { repo: 'e-nexus-devlog-relay', prefix: 'acks/mac-mini/' }, fetchImpl: async (u) => (new URL(u).pathname.endsWith('/git/trees/acks') ? reply(404, {}) : fetchImpl(u)) });
  assert.equal(broken.status, 'ok');
  assert.equal(broken.relay_acked, null);
});
