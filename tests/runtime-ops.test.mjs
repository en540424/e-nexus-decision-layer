/**
 * 運用の道具（2026-11-05・Batch C）と、job の欠落・設定改変・Webhook の生存・relay の未反映の見張り。合成のデータだけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BLIND_MS, JOB_PERIOD_HOURS, THRESHOLDS, WATCHDOG_LABEL, blindCheck, checkWebhook, evaluate, evaluateEvents, jobRunsCheck, notifyChannelItem, safeValue } from '../scripts/host-health.mjs';
import { monitorWebhookItem } from '../scripts/host-health-watchdog.mjs';
import { collectGithub } from '../scripts/lib/github-guard.mjs';
import { ruleOf } from '../scripts/lib/alert-policy.mjs';
import { collectGuard, evaluateGuard, evaluateGuardEvents, plistArgs } from '../scripts/lib/runtime-guard.mjs';
import { DONE_WHEN, OBSERVE_WINDOW_DAYS, acceptanceOf, humanRequired, parse, readRecords, renderOverview, renderTimeline, timelineOf, validate, whyOf } from '../scripts/runtime-ops.mjs';

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

test('観察：窓が 7 日ちょうどでも届くように別に読む。--days が短くても観察の幅は変わらない', () => {
  const week = Array.from({ length: 7 * 48 + 2 }, (_, i) => row((7 * 48 + 1 - i) / 2, [{ id: 'hermes_service', level: 'ok', value: 'running' }, { id: 'hermes_rss_gib', level: 'ok', value: 0.3 }, { id: 'memory_pressure', level: 'ok', value: 1 }, { id: 'swap_used_gib', level: 'ok', value: 0 }]));
  const h8 = (b) => acceptanceOf(b).find((r) => r.id === 'H8');
  assert.ok(OBSERVE_WINDOW_DAYS > 7);
  assert.equal(h8({ ...base(), observation: week }).verdict, 'pass');
  assert.equal(h8({ ...base(), observation: week.slice(-48 * 3) }).verdict, 'pending', '3 日分だけなら合格にしない');
  assert.equal(h8({ ...base(), records: week.slice(-10), observation: week }).verdict, 'pass', '--days 3 でも観察の結果は同じ');
});

test('観察：合格の目安を全部見る（常駐・再起動・固定ファイル・RSS・メモリ・空白。Mac の再起動の空白は除く）', () => {
  const ok = (h, extra = []) => row(h, [{ id: 'hermes_service', level: 'ok', value: 'running' }, { id: 'hermes_rss_gib', level: 'ok', value: 0.3 }, { id: 'memory_pressure', level: 'ok', value: 1 }, ...extra]);
  const svc = (id = 'hermes_service', level = 'ok') => ({ id, level, value: null });
  const full = (level = 'ok') => [svc('hermes_service', level), svc('hermes_rss_gib'), svc('memory_pressure'), svc('swap_used_gib')];
  const obs = (extra) => [ok(3), ok(2.5, extra), ok(2)];
  const h8 = (observation) => acceptanceOf({ ...base(), observation }).find((r) => r.id === 'H8');
  assert.equal(h8(obs()).verdict, 'pending');
  for (const [item, key] of [[{ id: 'hermes_restarted', level: 'warn' }, 'hermes_restarted'], [{ id: 'hermes_files_changed', level: 'warn' }, 'hermes_files_changed']]) {
    const r = h8(obs([item]));
    assert.deepEqual([r.verdict, r.facts[key]], ['fail', 1]);
  }
  assert.equal(h8([ok(3), row(2.5, [{ id: 'hermes_service', level: 'warn', value: 'stopped' }])]).verdict, 'fail');
  assert.equal(h8([ok(3), row(2.5, [svc(), { id: 'hermes_rss_gib', level: 'ok', value: 3.1 }])]).verdict, 'fail');
  assert.equal(h8([ok(3), row(2.5, [svc(), { id: 'memory_pressure', level: 'warn', value: 2 }])]).verdict, 'fail');
  assert.equal(h8([ok(3), row(2.5, [svc(), { id: 'swap_used_gib', level: 'crit', value: 9 }])]).verdict, 'fail');
  const gap = h8([ok(5), ok(2)]);
  assert.deepEqual([gap.verdict, gap.facts.gaps], ['fail', 1]);
  assert.equal(h8([ok(5), ok(2, [{ id: 'rebooted', level: 'warn' }])]).facts.gaps, 0, 'Mac の再起動の分は除く');
  // 幅は Hermes を ok と見た最初の回から。記録だけ古くても、見えていない間は合格にしない
  const days = (n, items) => Array.from({ length: n * 48 + 1 }, (_, i) => row((n * 48 - i) / 2, items));
  const older = [...days(8, [{ id: 'disk_free_gib', level: 'ok', value: 1 }]).slice(0, 5 * 48), ...days(3, full())];
  assert.deepEqual([h8(older).verdict, h8(older).facts.days_observed], ['pending', 3]);
  assert.equal(h8(days(8, [{ id: 'disk_free_gib', level: 'ok', value: 1 }])).verdict, 'pending', '項目が無い');
  assert.equal(h8(days(8, [svc('hermes_service', 'unknown')])).verdict, 'pending', 'ずっと見えていない');
  const blind = days(8, full());
  blind[50] = row((8 * 48 - 50) / 2, full('unknown'));
  assert.deepEqual([h8(blind).verdict, h8(blind).facts.hermes_service_unseen], ['pass', 1], '1 回の読み損ねで何日も止めない');
  for (let i = 50; i < 70; i += 1) blind[i] = row((8 * 48 - i) / 2, full('unknown'));
  assert.deepEqual([h8(blind).verdict, h8(blind).facts.hermes_service_unseen], ['pending', 20], '見えない回が多ければ異常なしに数えない');
  const down = h8(days(8, [svc('hermes_service', 'warn')]));
  assert.deepEqual([down.verdict, down.facts.hermes_service_not_ok, down.facts.days_observed], ['fail', 385, 0], '窓の全部で止まっている時も fail');
  assert.equal(h8(days(8, full())).verdict, 'pass');
  assert.equal(h8(days(8, [svc()])).verdict, 'pending', 'メモリの項目が見えていない窓を合格にしない');
  assert.equal(h8(days(8, full()).slice(0, -10)).verdict, 'pending', '記録が止まった後の幅で合格にしない');
});

test('時系列：変わり目と出来事と通知だけ。最初の ok は出さない・連続する同じ出来事は 1 行に・値は関所を通す', () => {
  const rows = timelineOf([
    row(5, [{ id: 'disk_free_gib', level: 'ok', value: 300 }, { id: 'monitor_config_changed', level: 'warn', value: 'monitor_plist' }]),
    row(4.5, [{ id: 'disk_free_gib', level: 'ok', value: 299 }, { id: 'monitor_config_changed', level: 'warn', value: 'monitor_plist' }]),
    row(4, [{ id: 'disk_free_gib', level: 'warn', value: 20 }], { notify: [{ id: 'disk_free_gib', change: 'warn' }], notify_code: 'SENT' }),
    row(3.5, [{ id: 'disk_free_gib', level: 'warn', value: 19 }]),
    row(3, [{ id: 'disk_free_gib', level: 'ok', value: 200 }, { id: 'github:private-name', level: 'warn', value: '/Users/someone/secret' }], { notify: [{ id: 'disk_free_gib', change: 'recovered' }], notify_code: 'WEBHOOK_CREDENTIAL_MISSING' }),
  ]);
  assert.deepEqual(rows.map((x) => [x.kind, x.id, x.level, x.count ?? null, x.sent ?? null]), [
    ['event', 'monitor_config_changed', 'warn', 2, null],
    ['level', 'disk_free_gib', 'warn', null, 'warn'],
    ['level', 'disk_free_gib', 'ok', null, null],
    ['level', 'github:private-name', 'warn', null, null],
  ]);
  const text = renderTimeline(rows);
  assert.match(text, /monitor_config_changed ×2/);
  assert.match(text, /disk_free_gib ok→warn .*［通知：warn］/);
  assert.doesNotMatch(text, /someone/, '値は関所を通す');
  assert.equal(renderTimeline([]), '変わり目はありません');
  const first = timelineOf([row(2, [{ id: 'disk_free_gib', level: 'warn', value: 20 }]), { at: at(1), items: 'x', notify: 'y' }, { at: at(0.5), items: [null, {}] }]);
  assert.deepEqual(first.map((x) => [x.id, x.from]), [['disk_free_gib', null]], '窓の前から続く異常を変わり目と言わない・壊れた行で落ちない');
  assert.match(renderTimeline(first), /（窓の前から）→warn/);
});

test('1 画面：検収・状態・Human・読み取りの検証を並べる。判定を足さない', () => {
  const rows = acceptanceOf(base());
  const text = renderOverview({ rows, reply: '異常はありません', human: [{ priority: 1, title: 'X', due: '2026-11-12', overdue: false }], readCheck: { state: 'not_run' } });
  for (const s of ['【検収】', 'PASS    H2', '異常はありません', '[高] 〜2026-11-12 X', '未実施']) assert.ok(text.includes(s), s);
  assert.match(renderOverview({ rows, reply: 'x', human: [], readCheck: { state: 'fail', failed: ['no_invention'], api_calls: 2, total_tokens: 9000 } }), /fail（no_invention）・API 2 回・9000 token/);
  assert.match(renderOverview({ rows, reply: 'x', human: [], readCheck: { state: 'not_run' } }), /【Human が要ること】\nありません/);
});

test('検収：正常の項目を送っていれば H2 は fail（異常・出来事・回復は送ってよい）', () => {
  const b = base();
  b.records = [healthy(1), { ...healthy(0.5), notify_code: 'SENT', notify: [{ id: 'x', level: 'crit', change: 'new' }, { id: 'y', level: 'ok', change: 'recovered' }] }];
  assert.equal(byId(acceptanceOf(b)).H2, 'pass');
  b.records = [healthy(1), { ...healthy(0.5), notify_code: 'SENT', notify: [{ id: 'y', level: 'ok', change: 'new' }] }];
  assert.equal(byId(acceptanceOf(b)).H2, 'fail');
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
  assert.deepEqual(humanRequired({ ledger: { not: 'array' }, now: NOW }), [], '壊れた台帳で止まらない');
  const overdue = humanRequired({ ledger: [{ id: 'c', title: 'x', due: '2026-11-01' }], now: NOW });
  assert.equal(overdue[0].overdue, true);
});

test('plist の引数：ProgramArguments の中だけ数える（注釈と他の鍵の値は数えない）', () => {
  const plist = '<plist><dict><key>Label</key><string>--webhook</string><!-- <string>--no-guard</string> --><key>ProgramArguments</key><array><string>node</string></array></dict></plist>';
  assert.deepEqual(plistArgs(plist), ['node']);
  assert.equal(plistArgs('<plist><dict></dict></plist>'), null);
});

test('Human Required：監視が止まっている・記録が無い時は「対応なし」と言わない', () => {
  assert.deepEqual(humanRequired({ now: NOW }), []);
  assert.deepEqual(humanRequired({ monitor: { disabled: true, stale: true }, now: NOW }).map((r) => [r.id, r.priority]), [['monitor:disabled', 1]]);
  assert.deepEqual(humanRequired({ monitor: { stale: true }, now: NOW }).map((r) => r.id), ['monitor:stale']);
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
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => ({ status: 403 }) }), 'unreachable', '403 は途中の遮断の時がある');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => { throw new Error('keychain'); }, fetchImpl }), 'unreachable', 'Keychain の一時の失敗で鳴らさない');
  for (const status of [401, 404]) assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => ({ status }) }), 'gone');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => ({ status: 503 }) }), 'unreachable');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => URL_OK, fetchImpl: async () => { throw new Error('x'); } }), 'unreachable');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => 'https://evil.example/hook', fetchImpl }), 'unsupported');
  assert.equal(await checkWebhook({ spec: 'credential:x', readCredentialImpl: async () => null, fetchImpl }), 'config_invalid');
  assert.equal(notifyChannelItem(null), null);
  assert.equal(notifyChannelItem({ code: 'ok' }).level, 'ok');
  assert.equal(notifyChannelItem({ code: 'unreachable' }).level, 'ok', '一時の失敗では鳴らさない');
  assert.equal(notifyChannelItem({ code: 'gone' }).level, 'warn');
  assert.equal(safeValue('notify_channel', 'gone'), 'gone');
});

// ─── relay の未反映 ───

test('relay：acks branch のファイル名だけ読む。自分の machine だけ数える・読めなければ null', async () => {
  const ID = '20260101T000000Z-test-box-abc123';
  const reply = (status, json) => ({ status, json: async () => json, headers: { get: () => null } });
  const seen = [];
  const fetchImpl = async (u) => {
    const p = new URL(u).pathname;
    seen.push(p);
    if (p.endsWith('/git/trees/acks')) return reply(200, { tree: [{ path: `acks/test-box/2026-11/${ID}.json` }, { path: 'acks/other/2026-11/20261105T064601Z-other-aaaaaa.json' }, { path: 'acks/test-box/2026-11/bad name.json' }] });
    if (p.endsWith('/git/ref/heads/master')) return reply(200, { object: { sha: 'abc' } });
    if (p.endsWith('/status')) return reply(200, { total_count: 0, state: 'pending' });
    if (p.endsWith('/actions/runs')) return reply(200, { workflow_runs: [] });
    return reply(200, { default_branch: 'master', visibility: 'private' });
  };
  const args = { credential: 'E-NEXUS/edl/x', owner: 'o', repos: ['e-nexus-devlog-relay'], now: at(0), read: async () => 'github_pat_x', fetchImpl };
  const r = await collectGithub({ ...args, relay: { repo: 'e-nexus-devlog-relay', prefix: 'acks/test-box/' } });
  assert.deepEqual(r.relay_acked, [ID]);
  assert.ok(!seen.some((p) => /contents|blobs/.test(p)), '中身は読まない');
  assert.equal((await collectGithub(args)).relay_acked, undefined);
  const broken = await collectGithub({ ...args, relay: { repo: 'e-nexus-devlog-relay', prefix: 'acks/test-box/' }, fetchImpl: async (u) => (new URL(u).pathname.endsWith('/git/trees/acks') ? reply(404, {}) : fetchImpl(u)) });
  assert.equal(broken.status, 'ok');
  assert.equal(broken.relay_acked, null);
});

test('Webhook の確かめ：判定の前に確かめて今回の結果で知らせる。ok の間は 1 日 1 回・それ以外は毎回・止めれば state に残さない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ops-wh-'));
  try {
    const { runHostHealth } = await import('../scripts/host-health.mjs');
    const run = async (bin) => ({ code: 1, stdout: '', timedOut: bin === 'never' });
    let code = 'gone';
    let checks = 0;
    const once = (at, webhookCheck = async () => { checks += 1; return code; }) => runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, webhookCheck, now: () => new Date(at) });
    const a = await once('2026-11-05T00:00:00.000Z');
    assert.equal(a.items.find((x) => x.id === 'notify_channel').level, 'warn');
    code = 'ok';
    const b = await once('2026-11-05T00:30:00.000Z');
    assert.equal(b.items.find((x) => x.id === 'notify_channel').level, 'ok', '作り直した後の回に古い「使えない」を出さない');
    assert.equal(checks, 2);
    await once('2026-11-05T01:00:00.000Z');
    assert.equal(checks, 2, 'ok の間は 1 日 1 回');
    await once('2026-11-06T00:31:00.000Z');
    assert.equal(checks, 3);
    const off = await once('2026-11-06T01:00:00.000Z', null);
    assert.equal(off.items.find((x) => x.id === 'notify_channel'), undefined);
    const { readFileSync } = await import('node:fs');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).webhook_check, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('読めない状態が続く：24 時間で件数だけ数える。戻れば数え直す。GitHub は別の項目が受け持つ', () => {
  const u = { id: 'disk_free_gib', level: 'unknown', value: null, kind: 'state' };
  const first = blindCheck([u, { id: 'github_api', level: 'unknown', kind: 'state' }, { id: 'rebooted', level: 'unknown', kind: 'event' }], null, at(30));
  assert.deepEqual(Object.keys(first.next), ['disk_free_gib']);
  assert.equal(first.stale, 0);
  assert.equal(blindCheck([u], first.next, at(7)).stale, 0);
  assert.equal(blindCheck([u], first.next, new Date(Date.parse(at(30)) + BLIND_MS).toISOString()).stale, 1);
  assert.deepEqual(blindCheck([{ ...u, level: 'ok' }], first.next, at(1)), { stale: 0, next: {} });
  assert.equal(ruleOf('monitor_blind').hold, 0);
});

test('再起動の判定：時計の補正の分は再起動と言わない', () => {
  assert.deepEqual(evaluateEvents({ boottime: 1000 + 5 }, { boottime: 1000 }), []);
  assert.equal(evaluateEvents({ boottime: 2000 }, { boottime: 1000 })[0].id, 'rebooted');
});

test('隔離：id が読めない回も権限の崩れは捨てない', async () => {
  const hermes = '/Users/hermes';
  const fsi = { ...fakeFsi(FULL), statSync: () => ({ mode: 0o777, uid: 501 }) };
  const g = await collectGuard({ run: async (bin) => ({ code: bin === '/usr/bin/id' ? 1 : 0, stdout: '', timedOut: false }), hermesUser: 'hermes', base: '/b', repos: [], outbox: '/o', operatorHome: '/Users/op', fsi });
  assert.ok(g.isolation.includes('hermes_home_open') && g.isolation.includes('config_not_root_only'), hermes);
  assert.ok(!g.isolation.includes('admin_group'));
});

test('Human の一覧：台帳の done_when が記録で満たされた行は出さない（pass だけ。inconclusive・fail・未実施・知らない条件は残す）', () => {
  const ledger = [{ id: 'rc', priority: 1, title: 'read check', done_when: 'read_check_pass' }, { id: 'console', priority: 1, title: 'console' }, { id: 'odd', title: 'odd', done_when: 'no_such_rule' }];
  const ids = (readCheck) => humanRequired({ ledger, readCheck, now: NOW }).map((r) => r.id);
  assert.deepEqual(ids({ state: 'pass' }), ['console', 'odd']);
  for (const state of ['inconclusive', 'fail', 'not_run']) assert.deepEqual(ids({ state }), ['rc', 'console', 'odd'], state);
  assert.deepEqual(ids(null), ['rc', 'console', 'odd'], '読めなければ残す');
  assert.deepEqual(humanRequired({ ledger: [null, { id: 'x', title: 'x', done_when: 'toString' }], readCheck: { state: 'pass' }, now: NOW }).map((r) => r.id), ['x'], 'prototype の名前で消さない・壊れた行で止まらない');
  assert.deepEqual(Object.keys(DONE_WHEN), ['read_check_pass']);
});
