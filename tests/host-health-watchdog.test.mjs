/**
 * host-health の見張りの見張り（2026-11-04・MA-22）。本体が自分では知らせられない停止を別の job から知らせる。
 * 重複させない・回復を 1 回・PAUSE・host-health の state を書かない。launchctl は fixture で差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorState, runWatchdog } from '../scripts/host-health-watchdog.mjs';

const T0 = Date.parse('2026-11-04T09:00:00.000Z');
const iso = (m) => new Date(T0 + m * 60_000).toISOString();
const LOADED = { code: 0, stdout: '\tstate = not running\n\tlast exit code = 0\n', timedOut: false };
const NOT_LOADED = { code: 113, stdout: '', timedOut: false };

test('判定：解除・記録の途絶は CRIT。launchctl が読めない・DISABLED（本体が知らせる）は unknown', () => {
  const job = { loaded: true };
  const state = { updated_at: iso(0) };
  assert.deepEqual(monitorState({ state, disabled: false, job, now: iso(60) }), { level: 'ok', value: 'ok' });
  assert.deepEqual(monitorState({ state, disabled: false, job, now: iso(120) }), { level: 'crit', value: 'stale 120m' });
  assert.equal(monitorState({ state, disabled: true, job, now: iso(500) }).level, 'unknown', '本体の通知に重ねない');
  assert.equal(monitorState({ state, disabled: true, job: { loaded: false }, now: iso(1) }).value, 'not_loaded', '解除されていれば本体は知らせられない');
  assert.deepEqual(monitorState({ state, disabled: false, job: { loaded: false }, now: iso(1) }), { level: 'crit', value: 'not_loaded' });
  assert.equal(monitorState({ state, disabled: false, job: null, now: iso(1) }).level, 'unknown');
  assert.deepEqual(monitorState({ state: null, disabled: false, job, now: iso(1) }), { level: 'crit', value: 'no_state' }, '登録されているのに記録が無いのは黙らない');
  assert.equal(monitorState({ state: { updated_at: 'broken' }, disabled: false, job, now: iso(1) }).value, 'no_state');
});

test('通知：止まった時に 1 回・続けば 24 時間後に再通知・送れなければ次の回・回復は 1 回・host-health の state は書かない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-watchdog-'));
  try {
    const state = path.join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ updated_at: iso(0) }));
    const before = readFileSync(state, 'utf8');
    const results = [{ sent: false, code: 'WEBHOOK_UNREACHABLE' }];
    const posted = [];
    const post = async (n) => { posted.push(n[0]); return results.shift() ?? { sent: true, code: 'SENT' }; };
    const tick = (m, res = LOADED) => runWatchdog({ stateDir: dir, webhook: 'credential:E-NEXUS/edl/h', webhookFormat: 'discord', run: async () => res, uid: 501, now: () => new Date(iso(m)), post });

    assert.equal((await tick(60)).notify.length, 0, '正常は知らせない');
    const down = await tick(120);
    assert.deepEqual([down.notifyCode, down.notify[0].id, down.notify[0].level], ['WEBHOOK_UNREACHABLE', 'monitor_alive', 'crit']);
    assert.equal((await tick(180)).notifyCode, 'SENT', '送れなかった分をもう一度');
    assert.equal((await tick(240)).notify.length, 0, '重ねない');
    assert.equal((await tick(180 + 1439)).notify.length, 0, '24 時間は重ねない');
    assert.equal((await tick(180 + 1440)).notify[0].change, 'reminder');
    writeFileSync(state, JSON.stringify({ updated_at: iso(1700) }));
    assert.equal((await tick(1701)).notify.length, 0, '回復は 2 回続いてから');
    const up = await tick(1730);
    assert.deepEqual([up.notify[0].change, up.notify[0].level], ['recovered', 'ok']);
    assert.ok(posted.every((n) => n.id === 'monitor_alive'));
    writeFileSync(state, before);
    assert.equal(readFileSync(state, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('解除された job を知らせる・PAUSE の間は知らせない・webhook が無ければ外へ出ない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-watchdog-'));
  try {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ updated_at: iso(0) }));
    const posted = [];
    const post = async (n) => { posted.push(n); return { sent: true, code: 'SENT' }; };
    const base = { stateDir: dir, run: async () => NOT_LOADED, uid: 501, now: () => new Date(iso(1)), post };
    assert.equal((await runWatchdog(base)).notifyCode, 'NO_WEBHOOK');
    assert.equal(posted.length, 0);
    rmSync(path.join(dir, 'watchdog.json'));
    writeFileSync(path.join(dir, 'PAUSE'), '');
    const r = await runWatchdog({ ...base, webhook: 'credential:E-NEXUS/edl/h' });
    assert.deepEqual([r.paused, r.notify.length, posted.length], [true, 0, 0]);
    rmSync(path.join(dir, 'PAUSE'));
    const r2 = await runWatchdog({ ...base, webhook: 'credential:E-NEXUS/edl/h' });
    assert.equal(r2.value, 'not_loaded');
    assert.equal(posted.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接続の道具（Human が実行）：端末でなければ何もしない・URL を引数で受けない・値を出さない', () => {
  const file = new URL('../deploy/macos/connect-discord-alerts.sh', import.meta.url);
  const body = readFileSync(file, 'utf8');
  assert.ok(!/\$1|\$@|https:\/\/discord/.test(body), 'URL を引数やファイルに置かない');
  assert.match(body, /keychain-edl\.sh set "\$NAME"/);
  assert.match(body, /--webhook-format discord --webhook-test/);
  assert.equal(spawnSync('bash', ['-n', file.pathname], { timeout: 10_000 }).status, 0);
  const r = spawnSync('bash', [file.pathname], { input: '', timeout: 10_000, encoding: 'utf8' });
  assert.equal(r.status, 2, '端末でなければ Keychain に触れない');
});
