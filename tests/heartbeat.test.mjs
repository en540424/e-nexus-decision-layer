/**
 * 外部の死活監視（2026-11-05・H6）。受け側は loopback の実 server と差し替えた時計で回す（VPS・Discord には接続しない）。送る側は fetch を差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FLAP, LIMIT_MS, OUTAGE_MS, RETRY_MS, SKEW_MS, TEXT, discordSender, flush, initialState, onBeat, onTick, settle, startReceiver, verifyBeat } from '../deploy/vps-heartbeat/receiver.mjs';
import { HEARTBEAT_LIMITS, HEARTBEAT_TOKEN, HEARTBEAT_URL, heartbeatItem, nextHeartbeat, sendHeartbeat } from '../scripts/lib/heartbeat.mjs';
import { parseArgs, runHostHealth, safeValue, validateArgs } from '../scripts/host-health.mjs';
import { renderJob, validateJobArgs } from '../scripts/scheduled-job-service.mjs';

const TOKEN = 'a'.repeat(64);
const T0 = Date.parse('2026-11-05T00:00:00.000Z');
const MIN = 60_000;
const sign = (ts, token = TOKEN) => createHmac('sha256', token).update(String(ts)).digest('hex');

/** 30 分ごとの信号を alive(分) の間だけ送り、毎分判定して、送った本文を [分, 種類] で返す */
async function simulate(minutes, alive, sendOk = () => true) {
  let s = onBeat(initialState(T0), { now: T0, ts: T0 });
  const out = [];
  for (let m = 1; m <= minutes; m += 1) {
    const now = T0 + m * MIN;
    if (m % 30 === 0 && alive(m)) s = onBeat(s, { now, ts: now });
    s = onTick(s, { now });
    s = await flush(s, { now, send: async (text) => { const ok = sendOk(m); if (ok) out.push([m, Object.keys(TEXT).find((k) => TEXT[k] === text)]); return ok; } });
  }
  return out;
}

test('署名：合う時だけ受ける。時刻のずれ・再送・形の違い・別の token は拒む', () => {
  const v = (over) => verifyBeat({ token: TOKEN, ts: String(T0), sig: sign(T0), now: T0, lastTs: 0, ...over });
  assert.equal(v({}), T0);
  assert.equal(v({ lastTs: T0 }), null, '再送');
  assert.equal(v({ now: T0 + SKEW_MS + 1 }), null, '時刻のずれ');
  assert.equal(v({ sig: sign(T0, 'b'.repeat(64)) }), null);
  assert.equal(v({ sig: 'xyz' }), null);
  assert.equal(v({ sig: undefined }), null);
  assert.equal(v({ ts: 'abc' }), null);
});

test('正常：30 分ごとの信号なら 1 週間通知しない', async () => {
  assert.deepEqual(await simulate(7 * 24 * 60, () => true), []);
});

test('途絶：60 分以上で 1 回だけ・続いても重ねない・戻れば 1 回', async () => {
  const out = await simulate(24 * 60, (m) => m < 60 || m > 600);
  assert.deepEqual(out, [[30 + 70, 'down'], [630, 'up']], '最後の信号（30 分）から 70 分');
  assert.ok(LIMIT_MS >= 60 * MIN);
});

test('1 回の抜けと実行時間の揺れでは鳴らない（信号は実行の最後に送るので間隔が揺れる）', async () => {
  let s = onBeat(initialState(T0), { now: T0 + 20_000, ts: T0 + 20_000 });
  s = onTick(s, { now: T0 + 60 * MIN + 45_000 });
  assert.equal(s.pending, null);
});

test('一時的な欠け：1 回抜けただけでは知らせない', async () => {
  assert.deepEqual(await simulate(600, (m) => m !== 120), []);
});

test('反復：行き来しても 1 日 3 通を超えない・落ち着けば通知は止まる', async () => {
  const out = await simulate(7 * 24 * 60, (m) => Math.floor(m / 150) % 2 === 0);
  const perDay = {};
  for (const [m] of out) perDay[Math.floor(m / 1440)] = (perDay[Math.floor(m / 1440)] ?? 0) + 1;
  assert.ok(Math.max(...Object.values(perDay)) <= 3, JSON.stringify(perDay));
  assert.ok(out.some(([, k]) => k === 'repeat'));
  assert.deepEqual(out.slice(0, 3).map(([, k]) => k), ['down', 'up', 'repeat']);
});

test('静かな間に始まった本当の停止：明けた時に続いていれば知らせる（電源が不安定なまま最後に落ちる場面で黙らない）', async () => {
  const out = await simulate(14 * 24 * 60, (m) => m < 240 ? m < 120 || m >= 210 : m < 300 ? false : m < 330);
  assert.deepEqual(out.map(([, k]) => k).slice(0, 3), ['down', 'up', 'repeat']);
  assert.ok(out.length >= 4 && ['down', 'repeat'].includes(out[3][1]), JSON.stringify(out));
  assert.ok(out.length <= 5);
});

test('反復の後に安定すれば復旧を 1 回（「控える」の 1 通で終わらない）', async () => {
  const out = await simulate(5 * 24 * 60, (m) => !((m >= 60 && m < 180) || (m >= 240 && m < 360)));
  assert.deepEqual(out.map(([, k]) => k), ['down', 'up', 'repeat', 'up']);
  assert.ok(out[3][0] >= out[2][0] + 24 * 60, '静かな間が明けてから');
});

test('送信の間の受信を失わない：途絶を送っている間に戻れば復旧も届く・失敗しても途絶へ戻さない', () => {
  const now = T0;
  const sending = { ...initialState(T0), pending: 'up', down: false };
  assert.equal(settle(sending, { attempted: 'down', ok: true, now }).pending, 'up', '送っている間に復旧へ変わった');
  assert.equal(settle(sending, { attempted: 'down', ok: false, now }).pending, 'up');
  assert.equal(settle({ ...sending, pending: 'down' }, { attempted: 'down', ok: true, now }).pending, null);
});

test('送れない時：RETRY_MS ごとにもう一度・送れるまで消えない・途絶を送れないうちに戻れば復旧へ置き換える', async () => {
  let s = onBeat(initialState(T0), { now: T0, ts: T0 });
  const now = T0 + LIMIT_MS + 1;
  s = onTick(s, { now });
  assert.equal(s.pending, 'down');
  const tries = [];
  const fail = async (text) => { tries.push(text); return false; };
  s = await flush(s, { now, send: fail });
  s = await flush(s, { now: now + MIN, send: fail });
  assert.equal(tries.length, 1, '間をあける');
  s = await flush(s, { now: now + RETRY_MS, send: async () => { throw new Error('down'); } });
  assert.equal(s.pending, 'down');
  const back = onBeat(s, { now: now + 2 * RETRY_MS, ts: now + 2 * RETRY_MS });
  assert.equal(back.pending, 'up', '途絶を知らせようとした回の後は復旧を送る');
});

test('VPS の再起動：起動から 60 分は知らせない。一度も受信していない間も知らせない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-hb-'));
  try {
    const stateFile = path.join(root, 'state.json');
    let clock = T0;
    const sent = [];
    const opts = { token: TOKEN, port: 0, stateFile, send: async (t) => { sent.push(t); return true; }, clock: () => clock };
    const a = await startReceiver(opts);
    clock += 3 * LIMIT_MS;
    await a.tick();
    assert.deepEqual(sent, [], '一度も受信していない');
    const res = await fetch(`http://127.0.0.1:${a.port}/hb`, { method: 'POST', headers: { 'x-edl-ts': String(clock), 'x-edl-sig': sign(clock) } });
    assert.equal(res.status, 204);
    await new Promise((r) => { a.server.close(r); });
    clock += 5 * LIMIT_MS; // VPS が止まっていた（OUTAGE_MS より長い）
    const b = await startReceiver(opts);
    await b.tick();
    assert.deepEqual(sent, [], '起動の直後は待つ');
    clock += LIMIT_MS;
    await b.tick();
    assert.deepEqual(sent, [TEXT.down], '起動から 60 分たっても来なければ知らせる');
    await new Promise((r) => { b.server.close(r); });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('再起動が続くだけなら待ち直さない（crash loop の間に黙らない）・壊れた state でも止まらない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-hb-'));
  try {
    const stateFile = path.join(root, 'state.json');
    let clock = T0;
    const sent = [];
    const opts = { token: TOKEN, port: 0, stateFile, send: async (t) => { sent.push(t); return true; }, clock: () => clock };
    let r = await startReceiver(opts);
    await fetch(`http://127.0.0.1:${r.port}/hb`, { method: 'POST', headers: { 'x-edl-ts': String(clock), 'x-edl-sig': sign(clock) } });
    for (let i = 0; i < 80 && !sent.length; i += 1) {
      await new Promise((res) => { r.server.close(res); });
      clock += OUTAGE_MS - MIN; // 落ちてはすぐ戻る
      r = await startReceiver(opts);
      await r.tick();
    }
    assert.deepEqual(sent, [TEXT.down]);
    await new Promise((res) => { r.server.close(res); });
    writeFileSync(stateFile, JSON.stringify({ hits: null, last_ts: Number.MAX_SAFE_INTEGER, pending: 'evil', last_seen: 'x' }));
    const b = await startReceiver(opts);
    await b.tick();
    const res = await fetch(`http://127.0.0.1:${b.port}/hb`, { method: 'POST', headers: { 'x-edl-ts': String(clock), 'x-edl-sig': sign(clock) } });
    assert.equal(res.status, 404, '未来の last_ts は now＋ずれまでに切る');
    clock += SKEW_MS + 1000;
    const again = await fetch(`http://127.0.0.1:${b.port}/hb`, { method: 'POST', headers: { 'x-edl-ts': String(clock + SKEW_MS - 500), 'x-edl-sig': sign(clock + SKEW_MS - 500) } });
    assert.equal(again.status, 204, '時間がたてば受ける');
    await new Promise((res2) => { b.server.close(res2); });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state の未来の値と null で黙らない・落ちない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-hb-'));
  try {
    const stateFile = path.join(root, 'state.json');
    let clock = T0;
    const sent = [];
    const opts = { token: TOKEN, port: 0, stateFile, send: async (t) => { sent.push(t); return true; }, clock: () => clock };
    writeFileSync(stateFile, 'null');
    const a = await startReceiver(opts);
    await new Promise((r) => { a.server.close(r); });
    const far = T0 + 365 * 86_400_000;
    writeFileSync(stateFile, JSON.stringify({ last_seen: far, started_at: far, quiet_until: far, alive_at: far, last_ts: 0, hits: [] }));
    const b = await startReceiver(opts);
    for (let i = 0; i < 26 * 60; i += 1) { clock += MIN; await b.tick(); }
    assert.ok(sent.length >= 1, '未来の quiet_until で永久に黙らない');
    await new Promise((r) => { b.server.close(r); });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('認証の前に接続を溜めさせない：上限と時間切れを持つ・拒否は接続を閉じる', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-hb-'));
  try {
    const r = await startReceiver({ token: TOKEN, port: 0, stateFile: path.join(root, 's.json'), send: async () => true });
    assert.deepEqual([r.server.maxConnections <= 64, r.server.requestTimeout <= 10_000, r.server.headersTimeout <= 10_000], [true, true, true]);
    const res = await fetch(`http://127.0.0.1:${r.port}/x`, { method: 'POST', body: 'x'.repeat(1024) });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('connection'), 'close');
    await new Promise((res2) => { r.server.close(res2); });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('受け側の server：loopback で待つ・/hb の POST で署名が合う時だけ 204・他は全部 404・state に送信元を残さない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-hb-'));
  try {
    const stateFile = path.join(root, 'state.json');
    let clock = T0;
    const r = await startReceiver({ token: TOKEN, port: 0, stateFile, send: async () => true, clock: () => clock });
    assert.equal(r.server.address().address, '127.0.0.1');
    const url = `http://127.0.0.1:${r.port}`;
    const hb = (over = {}) => fetch(`${url}/hb`, { method: 'POST', headers: { 'x-edl-ts': String(clock), 'x-edl-sig': sign(clock), ...over } });
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(`${url}/hb`)).status, 404, 'GET');
    assert.equal((await fetch(`${url}/other`, { method: 'POST' })).status, 404);
    assert.equal((await hb({ 'x-edl-sig': sign(clock, 'b'.repeat(64)) })).status, 404);
    assert.equal((await hb()).status, 204);
    assert.equal((await hb()).status, 404, '同じ時刻の再送');
    clock += 1000;
    assert.equal((await hb()).status, 204);
    const saved = readFileSync(stateFile, 'utf8');
    assert.ok(!saved.includes('127.0.0.1') && !saved.includes(TOKEN));
    await new Promise((res) => { r.server.close(res); });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Discord：mention を無効・redirect に従わない・本文は固定の文だけ', async () => {
  const seen = [];
  const send = discordSender({ url: 'https://discord.com/api/webhooks/1/x', fetchImpl: async (u, o) => { seen.push(o); return { ok: true }; } });
  assert.equal(await send(TEXT.down), true);
  assert.deepEqual(JSON.parse(seen[0].body).allowed_mentions, { parse: [] });
  assert.equal(seen[0].redirect, 'error');
  for (const t of Object.values(TEXT)) assert.ok(!/\d+\.\d+\.\d+\.\d+|https?:|\/Users/.test(t));
  assert.match(TEXT.down, /不明/, '原因を断定しない');
});

const creds = (over = {}) => async (t) => ({ [HEARTBEAT_URL]: 'https://example.invalid/hb', [HEARTBEAT_TOKEN]: TOKEN, ...over })[t] ?? null;

test('送る側：時刻と署名だけ（本文なし）・https だけ・Keychain に無ければ通信しない', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push([u, o]); return { status: 204 }; };
  assert.equal(await sendHeartbeat({ read: creds(), fetchImpl, clock: () => T0 }), 'sent');
  const [, o] = seen[0];
  assert.equal(o.body, undefined);
  assert.equal(o.redirect, 'error');
  assert.deepEqual(Object.keys(o.headers).sort(), ['x-edl-sig', 'x-edl-ts']);
  assert.equal(verifyBeat({ token: TOKEN, ts: o.headers['x-edl-ts'], sig: o.headers['x-edl-sig'], now: T0, lastTs: 0 }), T0, '受け側と同じ署名');
  seen.length = 0;
  assert.equal(await sendHeartbeat({ read: creds({ [HEARTBEAT_URL]: null }), fetchImpl }), 'off');
  assert.equal(await sendHeartbeat({ read: creds({ [HEARTBEAT_TOKEN]: null }), fetchImpl }), 'off');
  assert.equal(await sendHeartbeat({ read: creds({ [HEARTBEAT_URL]: 'http://example.invalid/hb' }), fetchImpl }), 'config_invalid');
  assert.equal(await sendHeartbeat({ read: creds({ [HEARTBEAT_URL]: 'not a url' }), fetchImpl }), 'config_invalid');
  assert.equal(await sendHeartbeat({ read: creds({ [HEARTBEAT_TOKEN]: 'short' }), fetchImpl }), 'config_invalid');
  assert.equal(seen.length, 0);
  assert.equal(await sendHeartbeat({ read: creds(), fetchImpl: async () => ({ status: 404 }) }), 'rejected');
  assert.equal(await sendHeartbeat({ read: creds(), fetchImpl: async () => ({ status: 502 }) }), 'failed');
  assert.equal(await sendHeartbeat({ read: creds(), fetchImpl: async () => { throw new Error('x'); } }), 'failed');
  assert.equal(await sendHeartbeat({ read: async () => { throw new Error('locked'); }, fetchImpl }), 'failed');
});

test('送る側の見張り：off は項目なし・失敗は続いた時だけ WARN・形の違いはすぐ WARN・値は関所を通る', () => {
  const now = new Date(T0).toISOString();
  const later = new Date(T0 + HEARTBEAT_LIMITS.fail_hours * 3_600_000).toISOString();
  assert.equal(heartbeatItem(null, now), null);
  assert.equal(heartbeatItem({ code: 'off' }, now), null);
  const f = nextHeartbeat('failed', null, now);
  assert.equal(f.fail_since, now);
  assert.equal(nextHeartbeat('failed', f, later).fail_since, now);
  assert.equal(heartbeatItem(f, now).level, 'ok');
  assert.equal(heartbeatItem(f, later).level, 'warn');
  assert.equal(heartbeatItem({ code: 'config_invalid', fail_since: now }, now).level, 'warn');
  assert.equal(nextHeartbeat('sent', f, later).fail_since, null);
  assert.equal(safeValue('heartbeat', 'failed'), 'failed');
  assert.equal(safeValue('heartbeat', 'https://secret.invalid/hb'), '[redacted]');
});

test('host-health の 1 回分：記録の後に 1 回送る・失敗しても 1 回分は成功・DISABLED の間は送らない・既定は送らない', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-hb-'));
  try {
    const run = async () => ({ code: 1, stdout: '', timedOut: false });
    const base = { stateDir: root, dataDirs: [], run, uid: 501 };
    let calls = 0;
    const heartbeat = async () => { calls += 1; assert.ok(readFileSync(path.join(root, 'state.json'), 'utf8').includes('last_success_at')); return 'failed'; };
    const at = (m) => () => new Date(T0 + m * MIN);
    const r = await runHostHealth({ ...base, heartbeat, now: at(0) });
    assert.deepEqual([r.code, calls], [0, 1]);
    const state = JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'));
    assert.deepEqual(state.heartbeat, { code: 'failed', fail_since: new Date(T0).toISOString() });
    const next = await runHostHealth({ ...base, heartbeat: async () => { throw new Error('x'); }, now: at(30) });
    assert.equal(next.code, 0);
    assert.equal(next.items.find((x) => x.id === 'heartbeat').value, 'failed');
    await runHostHealth({ ...base, now: at(60) });
    assert.equal(calls, 1, '--heartbeat が無ければ送らない');
    writeFileSync(path.join(root, 'DISABLED'), 'x');
    await runHostHealth({ ...base, heartbeat, now: at(90) });
    assert.equal(calls, 1, 'DISABLED の間は送らない＝途絶として届く');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('引数と job の定義：--heartbeat は host-health だけ。plist に URL や token を書かない', () => {
  assert.equal(parseArgs(['--heartbeat']).heartbeat, true);
  assert.deepEqual(validateArgs(parseArgs(['--heartbeat'])), []);
  const a = { job: 'host-health', target: 'launchd', dir: '/d', node: '/n', hour: 7, minute: 30, heartbeat: 'true' };
  assert.deepEqual(validateJobArgs(a), []);
  assert.match(renderJob(a).content, /<string>--heartbeat<\/string>/);
  assert.ok(validateJobArgs({ ...a, job: 'host-health-watchdog' }).some((e) => e.includes('--heartbeat')));
});

test('導入の道具：受け側は他の service を触らない・Human が実行・端末でなければ Keychain に触れない', () => {
  const install = new URL('../deploy/vps-heartbeat/install.sh', import.meta.url);
  const body = readFileSync(install, 'utf8');
  assert.equal(spawnSync('bash', ['-n', install.pathname], { timeout: 10_000 }).status, 0);
  const stateChanging = body.split('\n').filter((l) => /systemctl\s+(?:enable|disable|start|stop|restart|reload)/.test(l));
  assert.ok(stateChanging.length && stateChanging.every((l) => l.includes('$UNIT')), '状態を変える systemctl は自分の unit だけ');
  assert.ok(!/ufw|iptables|tailscale (?:serve|funnel)|apt(?:-get)? |docker /.test(body.replace(/^#.*$/gm, '')));
  assert.match(body, /\[ -t 0 \]/, 'URL の入力は端末でだけ');
  assert.match(body, /--delivery-test/, '導入の時に Discord へ届くことを確かめる');
  assert.ok(!/8791/.test(body), 'VPS staging の候補の port を使わない');
  const unit = readFileSync(new URL('../deploy/vps-heartbeat/e-nexus-heartbeat.service', import.meta.url), 'utf8');
  for (const k of ['User=edl-heartbeat', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'MemoryMax=128M', 'CPUQuota=10%']) assert.ok(unit.includes(k), k);
  const connect = new URL('../deploy/macos/connect-heartbeat.sh', import.meta.url);
  assert.equal(spawnSync('bash', ['-n', connect.pathname], { timeout: 10_000 }).status, 0);
  assert.equal(spawnSync('bash', [connect.pathname], { input: '', timeout: 10_000, encoding: 'utf8' }).status, 2);
  assert.match(readFileSync(connect, 'utf8'), /--heartbeat/, '登録済みの job が送らないなら始めない');
  assert.ok(FLAP.count >= 2);
});
