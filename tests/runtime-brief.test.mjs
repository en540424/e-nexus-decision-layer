/**
 * Hermes へ渡す整理済みの要約と入力境界（2026-11-05・Batch B）。合成の state だけ。Hermes・API・Keychain に触れない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishStatus } from '../scripts/host-health.mjs';
import { classify, fixedTexts, OPS_CLASSES } from '../scripts/lib/ops-classify.mjs';
import { BRIEF_FILE, BRIEF_SCHEMA, GUIDE_FILE, boundaryViolations, briefInconsistencies, buildBrief, externalView, readBrief, renderReply } from '../scripts/lib/runtime-brief.mjs';
import { buildStatusSummary } from '../scripts/lib/runtime-status-summary.mjs';

const NOW = new Date('2026-11-05T10:20:00.000Z');
const item = (id, level, value = null) => ({ id, level, value, kind: 'state' });
const OK_ITEMS = [item('disk_free_gib', 'ok', 299.5), item('hermes_service', 'ok', 'running'), item('backup_archive', 'ok', '0d restore 0d'), item('backup_history', 'ok', 'history_ok'), item('relay_outbox', 'ok', 0), item('github_api', 'ok', 'ok'), item('github:a', 'ok', 'ok'), item('repo:a', 'ok', 'clean'), item('job:x', 'ok', 'loaded')];
const stateOf = (items, over = {}) => ({ last_success_at: NOW.toISOString(), updated_at: NOW.toISOString(), observed: Object.fromEntries(items.map((x) => [x.id, x.level])), items: Object.fromEntries(items.map((x) => [x.id, { level: x.level, since: '2026-11-01T00:00:00.000Z' }])), heartbeat: { code: 'sent' }, webhook_check: { code: 'ok' }, relay_unacked: 6, ...over });

test('正常：件数と水準だけで、値もパスも repo 名も出ない・境界を通る', () => {
  const b = buildBrief(stateOf(OK_ITEMS), { items: OK_ITEMS, now: NOW, githubTokenExpiresAt: Date.parse('2027-02-03T08:39:03.000Z'), backupTokenExpiresAt: '2027-02-03T00:00:00.000Z' });
  assert.equal(b.schema, BRIEF_SCHEMA);
  assert.equal(b.overall, 'ok');
  assert.deepEqual(b.open_items, []);
  assert.deepEqual(b.sections.relay, { outbox: 0, unacked: 6 });
  assert.equal(b.sections.github.repos, 1);
  assert.equal(b.sections.github.token_days_left, 89);
  assert.deepEqual([b.sections.backup.age_days, b.sections.backup.restore_age_days, b.sections.backup.history], [0, 0, 'history_ok']);
  assert.deepEqual(boundaryViolations(b), []);
  assert.ok(!JSON.stringify(b).includes('299.5'));
});

test('続く異常：群にまとめ、日数・誰が動くか・次の一手を固定の文で。repo 名と job 名を出さない', () => {
  const items = [...OK_ITEMS.filter((x) => !['repo:a', 'github:a', 'disk_free_gib'].includes(x.id)), item('disk_free_gib', 'crit', 10), item('repo:secret-name', 'warn', 'dirty 3'), item('github:secret-name', 'warn', 'ci_failure')];
  const b = buildBrief(stateOf(items), { items, now: NOW });
  assert.deepEqual(b.open_items.map((o) => [o.id, o.level, o.days, o.class]), [['disk_free_gib', 'crit', 4, 'human'], ['group_repos', 'warn', 4, 'ai'], ['group_github', 'warn', 4, 'ai']]);
  assert.deepEqual(b.counts, { open: 3, human: 1, ai: 2, auto: 0 });
  assert.equal(b.sections.github.ci_failing, 1);
  assert.ok(!JSON.stringify(b).includes('secret-name'));
  assert.deepEqual(boundaryViolations(b), []);
});

test('群の外の異常も全体の水準に入る。token の失効は Human の担当で、CI の失敗と混ぜない', () => {
  const items = [...OK_ITEMS.filter((x) => x.id !== 'github_api'), item('credential_backup_token', 'crit', 'expired'), item('backup_history', 'warn', 'history_failed'), item('github_api', 'warn', 'auth_failed')];
  const b = buildBrief(stateOf(items), { items, now: NOW });
  assert.equal(b.overall, 'crit');
  assert.deepEqual([b.sections.backup.level, b.sections.backup.not_ok], ['crit', 2]);
  const gh = b.open_items.find((o) => o.id === 'github_api');
  assert.equal(gh.class, 'human');
  assert.deepEqual(boundaryViolations(b), []);
});

test('送れなかった異常：通知の状態が ok の時のままでも、古い since を日数に使わない', () => {
  const items = [...OK_ITEMS.filter((x) => x.id !== 'disk_free_gib'), item('disk_free_gib', 'crit', 10)];
  const state = stateOf(items);
  state.items.disk_free_gib = { level: 'ok', since: '2026-07-01T00:00:00.000Z' };
  assert.equal(buildBrief(state, { items, now: NOW }).open_items[0].days, 0);
});

test('見張りの項目は渡さない（隔離・固定ファイル・常駐・監視の定義・user 範囲）', () => {
  const items = [...OK_ITEMS, item('hermes_isolation', 'crit', 'admin_group'), item('monitor_args', 'warn', 'monitor_no_webhook'), item('agent_scope', 'warn', 'user_rules')];
  const b = buildBrief(stateOf(items), { items, now: NOW });
  assert.deepEqual(b.open_items, []);
  assert.ok(!/isolation|monitor_args|agent_scope|admin_group/.test(JSON.stringify(b)));
});

test('監視が動いていない時：古い「正常」を出さず、数も出さない', () => {
  const old = stateOf(OK_ITEMS, { last_success_at: '2026-11-05T07:00:00.000Z', updated_at: '2026-11-05T07:00:00.000Z' });
  for (const [state, opts, monitor] of [[old, {}, 'stale'], [stateOf(OK_ITEMS), { paused: true }, 'paused'], [stateOf(OK_ITEMS), { disabled: true }, 'disabled']]) {
    const b = buildBrief(state, { items: OK_ITEMS, now: NOW, ...opts });
    assert.equal(b.monitor, monitor);
    assert.equal(b.overall, 'unknown');
    assert.equal(b.sections.relay.unacked, null);
    assert.equal(b.sections.heartbeat.state, 'unknown');
    assert.deepEqual(boundaryViolations(b), []);
  }
});

test('入力境界：知らない鍵・自由な文字列・パス・IP・Secret・Trading Lab は外れ、外れの一覧に値を載せない', () => {
  const base = buildBrief(stateOf(OK_ITEMS), { items: OK_ITEMS, now: NOW });
  const hostile = [
    { ...base, note: 'x' },
    { ...base, overall: '/Users/someone/.ssh/id_rsa' },
    { ...base, overall: '10.1.2.3' },
    { ...base, monitor: 'github_pat_AAAAAAAAAAAAAAAAAAAAAA' },
    { ...base, monitor: 'https://discord.com/api/webhooks/1/abc' },
    { ...base, monitor: 'trading lab live' },
    { ...base, open_items: [{ id: 'disk_free_gib', level: 'crit', days: 1, class: 'human', cause: '空きが 10 GiB しかない', next: classify('disk_free_gib').next }] },
    { ...base, counts: { ...base.counts, open: 1.5 } },
    { ...base, counts: { ...base.counts, open: 10_000_000 } },
    { ...base, open_items: Array.from({ length: 65 }, () => null) },
  ];
  for (const doc of hostile) {
    const bad = boundaryViolations(doc);
    assert.ok(bad.length > 0, JSON.stringify(doc).slice(0, 80));
    assert.ok(!/Users|github_pat|discord|trading|10\.1/.test(bad.join(' ')), '外れの一覧に値を載せない');
  }
});

test('Webhook の確かめ方を持たない宛先も、そのまま読める', () => {
  const b = buildBrief(stateOf(OK_ITEMS, { webhook_check: { code: 'unsupported' } }), { items: OK_ITEMS, now: NOW });
  assert.equal(b.sections.notify.state, 'unsupported');
  assert.deepEqual(boundaryViolations(b), []);
});

test('v1 の要約も同じ境界を通る', () => {
  const items = [...OK_ITEMS, item('power', 'crit', 'battery 90%')];
  assert.deepEqual(boundaryViolations(buildStatusSummary(stateOf(items), { now: NOW })), []);
});

test('読む側：壊れ・違う schema・境界の外れ・期限切れ・監視の停止は信じない。外部の形は件数だけ', () => {
  const b = buildBrief(stateOf(OK_ITEMS), { items: OK_ITEMS, now: NOW });
  const text = JSON.stringify(b);
  assert.equal(readBrief('{', { now: NOW }).reason, 'unreadable');
  assert.equal(readBrief('{"schema":"x"}', { now: NOW }).reason, 'schema');
  assert.equal(readBrief(JSON.stringify({ ...b, extra: 1 }), { now: NOW }).reason, 'boundary');
  assert.equal(readBrief(text, { now: new Date(NOW.getTime() + 91 * 60_000) }).reason, 'stale');
  assert.equal(readBrief(text, { now: new Date(NOW.getTime() - 6 * 60_000) }).reason, 'future');
  assert.equal(readBrief(text, { now: new Date(NOW.getTime() - 4 * 60_000) }).ok, true, '時計の小さなずれは許す');
  assert.equal(readBrief(JSON.stringify(buildBrief(stateOf(OK_ITEMS), { items: OK_ITEMS, now: NOW, paused: true })), { now: NOW }).reason, 'monitor_paused');
  const r = readBrief(text, { now: NOW });
  assert.equal(r.ok, true);
  assert.match(renderReply(r.brief), /異常はありません/);
  assert.match(renderReply(r.brief), /Vault の受領待ち 6/);
  assert.deepEqual(Object.keys(externalView(r.brief)).sort(), ['counts', 'generated_at', 'monitor', 'overall', 'schema', 'valid_until']);
});

test('host-health の 1 回分：要約 2 つと読み方を 0640 で書く。境界に外れたら 1 つも書かず boundary_blocked', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-brief-'));
  try {
    chmodSync(dir, 0o750);
    const stateDir = mkdtempSync(path.join(tmpdir(), 'edl-brief-state-'));
    const args = { statusDir: dir, stateDir, at: NOW.toISOString(), uid: process.getuid() };
    assert.equal(publishStatus({ ...args, state: stateOf(OK_ITEMS), items: OK_ITEMS }), 'written');
    assert.deepEqual(readdirSync(dir).sort(), [GUIDE_FILE, BRIEF_FILE, 'runtime-status.json'].sort());
    for (const f of readdirSync(dir)) assert.equal(statSync(path.join(dir, f)).mode & 0o777, 0o640);
    assert.equal(readBrief(readFileSync(path.join(dir, BRIEF_FILE), 'utf8'), { now: NOW }).ok, true);
    for (const f of readdirSync(dir)) rmSync(path.join(dir, f));
    const bad = stateOf(OK_ITEMS, { last_success_at: '/Users/x', updated_at: NOW.toISOString() });
    assert.equal(publishStatus({ ...args, state: bad, items: OK_ITEMS }), 'boundary_blocked');
    assert.deepEqual(readdirSync(dir), []);
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('仕分け：全部の文が固定で、class は 3 種類。分からない項目は human へ倒す', () => {
  for (const id of ['disk_free_gib', 'job:x', 'repo:x', 'github:x', 'github_api', 'heartbeat', 'notify_channel', 'backup_archive', 'monitor_gap']) {
    const r = classify(id);
    assert.ok(OPS_CLASSES.includes(r.class));
    assert.ok(fixedTexts().has(r.cause) && fixedTexts().has(r.next));
  }
  assert.equal(classify('something_new').class, 'human');
  assert.equal(classify('hermes_isolation').class, 'human');
  assert.equal(classify('hermes_service').class, 'human', 'AI は Hermes を再起動しない');
});

test('矛盾の検知：数の合わない要約・異常があるのに ok の要約・長すぎる有効期限を信じない。書き手の出す形は通る', () => {
  const ok = buildBrief(stateOf(OK_ITEMS), { items: OK_ITEMS, now: NOW });
  assert.deepEqual(briefInconsistencies(ok), []);
  const row = { id: 'heartbeat', level: 'crit', days: 1, class: 'human', cause: classify('heartbeat').cause, next: classify('heartbeat').next };
  const counts = { open: 1, human: 1, ai: 0, auto: 0 };
  assert.deepEqual(briefInconsistencies({ ...ok, open_items: [row] }), ['counts_open', 'counts_class', 'overall_below_crit']);
  assert.deepEqual(briefInconsistencies({ ...ok, overall: 'crit', open_items: [row] }), ['counts_open', 'counts_class']);
  assert.deepEqual(briefInconsistencies({ ...ok, counts: { ...counts, human: 0, ai: 1 }, overall: 'crit', open_items: [row] }), ['counts_class']);
  assert.deepEqual(briefInconsistencies({ ...ok, counts, overall: 'warn', open_items: [row] }), ['overall_below_crit']);
  assert.deepEqual(briefInconsistencies({ ...ok, counts, overall: 'ok', open_items: [{ ...row, level: 'warn' }] }), ['overall_below_warn']);
  assert.deepEqual(briefInconsistencies({ ...ok, counts, overall: 'crit', open_items: [row] }), []);
  assert.deepEqual(briefInconsistencies({ ...ok, valid_until: new Date(NOW.getTime() + 24 * 3_600_000).toISOString() }), ['valid_until'], '有効期限を延ばした要約');
  assert.deepEqual(briefInconsistencies({ ...ok, valid_until: ok.generated_at }), ['valid_until']);
  assert.equal(readBrief(JSON.stringify({ ...ok, overall: 'ok', counts, open_items: [row] }), { now: NOW }).reason, 'inconsistent');
  // 書き手が作る異常の要約・止まっている時の要約は通る
  const bad = [...OK_ITEMS.filter((x) => x.id !== 'disk_free_gib'), { id: 'disk_free_gib', level: 'crit', value: 1, kind: 'state' }];
  assert.deepEqual(briefInconsistencies(buildBrief(stateOf(bad), { items: bad, now: NOW })), []);
  assert.deepEqual(briefInconsistencies(buildBrief(stateOf(OK_ITEMS), { items: OK_ITEMS, now: NOW, paused: true })), []);
  assert.deepEqual(briefInconsistencies(buildBrief(null, { now: NOW, disabled: true })), []);
});
