/**
 * 3 か月ごとの運用要約（2026-11-05 Human 決定）。暦四半期に 1 通だけ・送信の失敗で再送を積み上げない・本文は集計の数だけ。実際には送らない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { runQuarterly, webhookBodyOf } from '../scripts/host-health.mjs';
import { QUARTERLY_RETRY, duePeriod, periodBounds, periodOf, previousPeriod, quarterlyText, summarizeQuarter } from '../scripts/lib/quarterly-report.mjs';

const HOUR = 3_600_000;
const SLOT = HOUR / 2;
const jst = (s) => Date.parse(`${s}+09:00`);
const iso = (ms) => new Date(ms).toISOString();

test('四半期の区切りは日本時間', () => {
  assert.equal(periodOf(jst('2026-12-31T23:59:00')), '2026Q4');
  assert.equal(periodOf(jst('2027-01-01T00:00:00')), '2027Q1');
  assert.equal(periodOf(jst('2027-04-01T00:00:00')), '2027Q2');
  assert.equal(periodOf(jst('2027-07-01T00:00:00')), '2027Q3');
  assert.equal(periodOf(jst('2027-10-01T00:00:00')), '2027Q4');
  assert.equal(previousPeriod('2027Q1'), '2026Q4');
  assert.equal(previousPeriod('2027Q3'), '2027Q2');
  assert.deepEqual(periodBounds('2026Q4'), { from: jst('2026-10-01T00:00:00'), to: jst('2027-01-01T00:00:00') });
});

test('送る時：1・4・7・10 月の最初の日の 9 時より後。それ以外の日は送らない', () => {
  const s = { last_period: '2026Q3' };
  assert.equal(duePeriod(s, iso(jst('2026-12-31T23:50:00'))), null);
  assert.equal(duePeriod(s, iso(jst('2027-01-01T08:50:00'))), null, '朝まで待つ');
  assert.equal(duePeriod(s, iso(jst('2027-01-01T09:20:00'))), '2026Q4');
  assert.equal(duePeriod(s, iso(jst('2027-02-14T12:00:00'))), '2026Q4', 'Mac が止まっていれば動いた時に');
  assert.equal(duePeriod({ last_period: '2026Q4' }, iso(jst('2027-03-31T12:00:00'))), null);
  assert.equal(duePeriod(null, iso(jst('2027-01-01T09:20:00'))), null, 'state を失っても同じ四半期を二度送らない');
  assert.equal(duePeriod({ last_period: '2026Q1' }, iso(jst('2027-01-01T09:20:00'))), '2026Q4', '飛ばした四半期を積み上げず最後の 1 通だけ');
});

const row = (t, items, extra = {}) => JSON.stringify({ at: iso(t), items, notify: [], notify_code: 'NOTHING_TO_SEND', ...extra });
const ok = (id) => ({ id, level: 'ok', value: 1 });

test('集計：稼働率・重大の件数・対応済み・未解決・軽微・出来事・欠落', () => {
  const from = jst('2027-01-01T00:00:00');
  const to = jst('2027-04-01T00:00:00');
  const lines = [];
  for (let t = from, i = 0; t < to; t += SLOT, i += 1) {
    if (i >= 200 && i < 210) continue; // 欠落
    const items = [{ id: 'disk_free_gib', level: i >= 10 && i < 14 ? 'crit' : 'ok', value: 1 }, { id: 'swap_used_gib', level: i >= 20 && i < 22 ? 'warn' : 'ok', value: 1 }, { id: 'power', level: t > to - 3 * SLOT ? 'crit' : 'ok', value: 1 }];
    if (i === 100) items.push({ id: 'rebooted', level: 'warn', value: 'x' });
    if (i >= 110 && i < 113) items.push({ id: 'monitor_config_changed', level: 'warn', value: 'monitor_plist' }); // 送れない間は続きの行に残る
    if (i === 120) items.push({ id: 'network_interface_changed', level: 'warn', value: 'x' }); // 軽微は数えない
    lines.push(row(t, items, i === 10 ? { notify_code: 'SENT' } : {}));
  }
  lines.push('broken line', row(to, [{ id: 'disk_free_gib', level: 'crit', value: 1 }]), row(from - 1, [{ id: 'disk_free_gib', level: 'crit', value: 1 }]));
  const s = summarizeQuarter(lines, '2027Q1');
  assert.deepEqual({ ...s, availability: undefined }, { records: 4310, availability: undefined, crit: 2, resolved: 1, unresolved: 1, warn: 1, events: 2, gaps: 1, notified: 1 });
  assert.equal(s.availability, 99.8);
});

test('集計：1 回だけの ok で閉じない・外した項目は未解決にしない・途中から始まった四半期は最初の記録から', () => {
  const t0 = jst('2026-11-04T17:20:00');
  const lines = [
    row(t0, [{ id: 'memory_pressure', level: 'crit', value: 4 }, { id: 'repo:x', level: 'crit', value: 1 }]),
    row(t0 + SLOT, [ok('memory_pressure'), { id: 'repo:x', level: 'crit', value: 1 }]),
    row(t0 + 2 * SLOT, [{ id: 'memory_pressure', level: 'crit', value: 4 }]),
    row(t0 + 3 * SLOT, [ok('memory_pressure')]),
    row(t0 + 4 * SLOT, [ok('memory_pressure')]),
  ];
  const s = summarizeQuarter(lines, '2026Q4', { now: t0 + 5 * SLOT });
  assert.deepEqual([s.crit, s.resolved, s.unresolved, s.availability], [2, 2, 0, 100]);
});

test('集計：Hermes の停止（記録は warn・通知は重大）を重大に数える・四半期の前半の欠落を隠さない', () => {
  const t0 = jst('2027-03-31T20:00:00');
  const svc = { id: 'hermes_service', level: 'warn', value: 'not_loaded' };
  const s = summarizeQuarter([row(t0, [svc]), row(t0 + SLOT, [svc], { notify: [{ id: 'hermes_service', level: 'crit', change: 'new' }] }), row(t0 + 2 * SLOT, [svc])], '2027Q1');
  assert.deepEqual([s.crit, s.unresolved, s.warn], [1, 1, 0]);
  assert.match(quarterlyText('2027Q1', s), /未解決の確認が必要/);
  const lines = [row(jst('2026-12-31T23:50:00'), [ok('disk_free_gib')])];
  for (let t = jst('2027-03-21T00:00:00'); t < jst('2027-04-01T00:00:00'); t += SLOT) lines.push(row(t, [ok('disk_free_gib')]));
  assert.ok(summarizeQuarter(lines, '2027Q1').availability < 15, '前の四半期に記録があれば期間の頭から数える');
});

test('本文：短く・集計の数だけ。項目名・パス・ホスト名を載せない', () => {
  const s = { records: 4310, availability: 99.8, crit: 2, resolved: 1, unresolved: 1, warn: 1, events: 2, gaps: 1, notified: 3 };
  const text = quarterlyText('2026Q4', s);
  assert.deepEqual(text.split('\n'), ['[E-NEXUS Mac Runtime host] 運用要約 2026年10〜12月', '監視の稼働率：99.8%（欠落 1 回）', '重大：2 件（対応済み 1・未解決 1）', '軽微な警告：1 件', '出来事：2 件', 'host-health の通知：3 回', '対応：未解決の確認が必要']);
  assert.match(quarterlyText('2026Q4', { ...s, unresolved: 0 }), /対応：不要$/);
  assert.match(quarterlyText('2026Q1', { records: 0 }), /記録なし/);
  assert.ok(text.length < 200);
  assert.ok(!text.includes(hostname()) && !text.includes(userInfo().username) && !/\/Users\/|\d+\.\d+\.\d+\.\d+|https?:/.test(text));
  for (const format of ['discord', 'slack', 'json']) assert.ok(JSON.stringify(webhookBodyOf([], format, 'x', text)).includes('運用要約'));
  assert.deepEqual(webhookBodyOf([], 'discord', 'x', text).allowed_mentions, { parse: [] });
});

const withDir = async (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-quarterly-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const DUE = jst('2027-01-01T09:20:00');
const args = (dir, prev, ms, post, extra = {}) => ({ stateDir: dir, prev, at: iso(ms), paused: false, webhook: 'credential:E-NEXUS/edl/h', webhookFormat: 'discord', post, ...extra });

test('指定の時に 1 通だけ。次の回からは送らない', () => withDir(async (dir) => {
  writeFileSync(path.join(dir, '2026-12.jsonl'), `${row(jst('2026-12-01T09:20:00'), [ok('disk_free_gib')])}\n`);
  const sent = [];
  const post = async (n, o) => { sent.push(o.text); return { sent: true, code: 'SENT' }; };
  const prev = { schema: 'host-health-state/v1', items: {}, quarterly: { last_period: '2026Q3', attempts: 0, last_attempt_at: null } };
  const r1 = await runQuarterly(args(dir, prev, DUE, post));
  assert.deepEqual([r1.period, r1.code, r1.state.last_period], ['2026Q4', 'SENT', '2026Q4']);
  assert.match(sent[0], /運用要約 2026年10〜12月/);
  for (let i = 1; i <= 3000; i += 100) await runQuarterly(args(dir, { ...prev, quarterly: r1.state }, DUE + i * SLOT, post));
  assert.equal(sent.length, 1);
}));

test('初めての回（今の版へ更新した時）は送らず、今の四半期の分を次の区切りで送れるようにする', () => withDir(async (dir) => {
  const post = async () => assert.fail('送らない');
  const r = await runQuarterly(args(dir, { items: {} }, jst('2026-11-05T13:50:00'), post));
  assert.deepEqual([r.code, r.state.last_period], [null, '2026Q3']);
  assert.equal(duePeriod(r.state, iso(DUE)), '2026Q4');
}));

test('送れない時は 6 時間あけて 8 回まで。諦めたら次の四半期まで送らない', () => withDir(async (dir) => {
  let tries = 0;
  const post = async () => { tries += 1; return { sent: false, code: 'WEBHOOK_HTTP_500' }; };
  let prev = { items: {}, quarterly: { last_period: '2026Q3', attempts: 0, last_attempt_at: null } };
  const codes = [];
  for (let i = 0; i < 400; i += 1) {
    const r = await runQuarterly(args(dir, prev, DUE + i * SLOT, post));
    prev = { ...prev, quarterly: r.state };
    if (r.code) codes.push(r.code);
  }
  assert.equal(tries, QUARTERLY_RETRY.max_attempts);
  assert.equal(codes.at(-1), 'QUARTERLY_GAVE_UP');
  assert.equal(prev.quarterly.last_period, '2026Q4');
}));

test('送る前に試みを残す：送れた後の書き込みに失敗しても次の回に重ねない', () => withDir(async (dir) => {
  const post = async () => ({ sent: true, code: 'SENT' });
  const prev = { schema: 'host-health-state/v1', items: {}, quarterly: { last_period: '2026Q3', attempts: 0, last_attempt_at: null } };
  await runQuarterly(args(dir, prev, DUE, post));
  const saved = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.quarterly.last_attempt_at, iso(DUE), '最後の state を書けなくてもここまでは残っている');
  const again = await runQuarterly(args(dir, saved, DUE + SLOT, post));
  assert.equal(again.code, null, '6 時間は重ねない');
}));

test('PAUSE の間・webhook が無い時は試みに数えない。要約の失敗で落ちない', () => withDir(async (dir) => {
  const post = async () => assert.fail('送らない');
  const prev = { items: {}, quarterly: { last_period: '2026Q3', attempts: 0, last_attempt_at: null } };
  for (const extra of [{ paused: true }, { webhook: null }]) {
    const r = await runQuarterly(args(dir, prev, DUE, post, extra));
    assert.deepEqual([r.code, r.state.attempts], [null, 0]);
  }
  const r = await runQuarterly(args(dir, { ...prev, schema: 'host-health-state/v1' }, DUE, async () => { throw new Error('/Users/op/x'); }));
  assert.deepEqual([r.code, r.state.attempts], ['QUARTERLY_FAILED', 1]);
}));
