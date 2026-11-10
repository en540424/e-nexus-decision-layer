/**
 * Task Hub の VPS 受け口と Mac 側の運び手（2026-11-09・MA-24）。loopback の実 server（port 0）と差し替えた時計で回す。VPS・Keychain・外部には接続しない。
 * id・鍵は試験用の作り物（bot-front・biz-a 等）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS, SUPPORTED_PROTOCOL_VERSIONS, addSource, authenticate, buildTaskBody, intentAllowed, normalizeSources, removeSource, startIntake } from '../deploy/vps-task-intake/intake.mjs';
import { newNonce, openRecord, sealRecord, sealStatus } from '../scripts/lib/task-hub/wire.mjs';
import { ack, keyFromHex, normalizeBase, pull, pushStatuses, writeInbox } from '../scripts/lib/task-hub/vps-client.mjs';
import { KEYCHAIN_URL, keychainKeyTarget, parseArgs, runSync } from '../scripts/task-intake-sync.mjs';

const T0 = Date.parse('2026-11-09T00:00:00.000Z');
const DAY = 86_400_000;
const CHANNEL = 'vps-intake';
const KEY_HEX = 'ab'.repeat(32);
const KEY = Buffer.from(KEY_HEX, 'hex');
const OTHER_KEY = Buffer.from('cd'.repeat(32), 'hex');
const BOT_A = `etk_${'1'.repeat(64)}`;
const BOT_B = `etk_${'2'.repeat(64)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const SOURCES = () => ({ 'bot-front': { key_sha256: sha(BOT_A) }, 'bot-back': { key_sha256: sha(BOT_B) } });

/** 試験用の環境。clock は手で進める。log は集めて「コードだけ」を確かめる */
async function boot({ sources = SOURCES(), limits, dir, clock = { t: T0 } } = {}) {
  const root = dir ?? mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  const stateDir = path.join(root, 'state');
  const logs = [];
  const r = await startIntake({ channelKey: KEY, channel: CHANNEL, sources, stateDir, port: 0, clock: () => clock.t, log: (code, extra) => logs.push({ code, ...extra }), limits });
  const url = `http://127.0.0.1:${r.port}`;
  return { ...r, url, root, stateDir, clock, logs, close: () => new Promise((res) => { r.server.close(res); }) };
}
const cleanup = async (...envs) => { for (const e of envs) { await e.close(); rmSync(e.root, { recursive: true, force: true }); } };

const post = (env, bearer, msg, extra = {}) => fetch(`${env.url}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra }, body: typeof msg === 'string' ? msg : JSON.stringify(msg) });
let rpcId = 0;
const rpc = async (env, bearer, method, params) => {
  const res = await post(env, bearer, { jsonrpc: '2.0', id: ++rpcId, method, params });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
};
/** tool を呼んで { isError, data } にする */
const tool = async (env, bearer, name, args) => {
  const { status, json } = await rpc(env, bearer, 'tools/call', { name, arguments: args });
  assert.equal(status, 200);
  assert.ok(json.result, JSON.stringify(json));
  return { isError: json.result.isError === true, data: JSON.parse(json.result.content[0].text) };
};
const submitArgs = (n, over = {}) => ({ idempotency_key: `task-${String(n).padStart(4, '0')}-abcd`, business: 'biz-a', intent: 'report.summarize', params: { n }, summary: 'test', ...over });

const macHeaders = (env, label, tail, { key = KEY, ts } = {}) => {
  const t = ts ?? (env.clock.t += 1);
  return { 'x-edl-ts': String(t), 'x-edl-sig': createHmac('sha256', key).update(`${label}\n${t}\n${tail}`).digest('hex') };
};
/** pull の署名の対象は offset と max（サーバーが読んだ値）。query の文字列からサーバーと同じ規則で作る */
const pullTail = (query) => {
  const q = new URLSearchParams(query);
  const n = Number(q.get('max'));
  const max = Number.isInteger(n) && n >= 1 ? Math.min(n, LIMITS.pull_max) : LIMITS.pull_max;
  return `GET /pull?offset=${Number(q.get('offset') ?? '0')}&max=${max}`;
};
const macPull = (env, over = {}, query = '') => fetch(`${env.url}/pull${query}`, { signal: AbortSignal.timeout(10_000), headers: macHeaders(env, 'edl-pull-v1', pullTail(query), over) });
const macPost = (env, route, label, body, over = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${env.url}${route}`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', ...macHeaders(env, label, sha(text), over) }, body: text });
};
const macAck = (env, nonces, over) => macPost(env, '/ack', 'edl-ack-v1', { nonces }, over);
const macStatus = (env, statuses, over) => macPost(env, '/status', 'edl-status-v1', { statuses }, over);
const status = (task_ref, source, state, updated_at, result = { summary: 'ok' }, over = {}) => sealStatus(over.key ?? KEY, { channel: over.channel ?? CHANNEL, task_ref, source, state, updated_at, body: JSON.stringify(result) });

test('MCP：initialize・notifications/initialized・ping・tools/list・tools/call の基本', async () => {
  const env = await boot();
  try {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const r = await rpc(env, BOT_A, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(r.json.result.protocolVersion, v);
      assert.deepEqual(r.json.result.capabilities, { tools: {} });
      assert.ok(r.json.result.serverInfo.name);
    }
    assert.equal((await rpc(env, BOT_A, 'initialize', { protocolVersion: '1999-01-01' })).json.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0], '知らない版は対応版の先頭');
    const note = await post(env, BOT_A, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
    assert.deepEqual((await rpc(env, BOT_A, 'ping')).json.result, {});
    const list = (await rpc(env, BOT_A, 'tools/list')).json.result.tools;
    assert.deepEqual(list.map((t) => t.name).sort(), ['get_task_status', 'list_capabilities', 'submit_task']);
    for (const t of list) assert.equal(t.inputSchema.type, 'object');
    const cap = (await rpc(env, BOT_A, 'tools/call', { name: 'list_capabilities', arguments: {} })).json.result;
    assert.match(cap.content[0].text, /proposal/i);
    assert.match(cap.content[0].text, /never executed automatically/i);
    assert.match(cap.content[0].text, /approved on that machine by the human/i);
    assert.equal((await rpc(env, BOT_A, 'nope')).json.error.code, -32601);
    assert.equal((await rpc(env, BOT_A, 'tools/call', { name: 'delete_everything' })).json.error.code, -32602);
    const bad = await post(env, BOT_A, '{not json');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);
    const batch = await post(env, BOT_A, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    assert.equal((await batch.json()).length, 2, 'batch：notification には返さない');
    assert.equal((await post(env, BOT_A, [])).status, 400);
  } finally { await cleanup(env); }
});

test('認証：Bearer が無い・違う・形が違うは 401（WWW-Authenticate・接続を閉じる・本文に何も入れない）', async () => {
  const env = await boot();
  try {
    const cases = [undefined, 'x'.repeat(64), `etk_${'3'.repeat(64)}`, ''];
    for (const k of cases) {
      const res = await post(env, k, { jsonrpc: '2.0', id: 1, method: 'ping' });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      assert.equal(res.headers.get('connection'), 'close');
      assert.equal(await res.text(), 'unauthorized');
    }
    const basic = await post(env, undefined, { jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Basic ${BOT_A}` });
    assert.equal(basic.status, 401);
    const long = await post(env, 'z'.repeat(5000), { jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(long.status, 401);
    assert.equal((await post(env, BOT_A, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
    // 関数としても：全 source と比べ、合えばその id だけ
    const { sources } = normalizeSources(SOURCES());
    assert.equal(authenticate(`Bearer ${BOT_B}`, sources), 'bot-back');
    assert.equal(authenticate(`bearer ${BOT_A}`, sources), 'bot-front', '語の大文字小文字は問わない');
    assert.equal(authenticate(`Bearer ${BOT_A} extra`, sources), null);
    assert.equal(authenticate(undefined, sources), null);
    assert.equal(authenticate('Bearer ', new Map()), null);
  } finally { await cleanup(env); }
});

test('経路：GET /mcp は 405・知らない path や method は 404 で接続を閉じる・認証の無い /pull /ack /status も 404', async () => {
  const env = await boot();
  try {
    const get = await fetch(`${env.url}/mcp`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await fetch(`${env.url}/mcp`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) })).status, 405);
    for (const [method, p] of [['GET', '/'], ['GET', '/other'], ['POST', '/pull'], ['GET', '/pull'], ['POST', '/ack'], ['POST', '/status'], ['GET', '/status'], ['GET', '/ack'], ['PUT', '/mcp/x'], ['POST', '/mcp/']]) {
      const res = await fetch(`${env.url}${p}`, { method, signal: AbortSignal.timeout(10_000), body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 404, `${method} ${p}`);
      assert.equal(res.headers.get('connection'), 'close');
    }
    assert.equal(env.server.address().address, '127.0.0.1');
    assert.deepEqual([env.server.maxConnections <= 64, env.server.requestTimeout <= 15_000, env.server.headersTimeout <= 10_000], [true, true, true]);
  } finally { await cleanup(env); }
});

test('大きすぎる本文：/mcp と /ack は 64KiB を超えると 413 で閉じる', async () => {
  const env = await boot();
  try {
    const big = await post(env, BOT_A, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } }));
    assert.equal(big.status, 413);
    assert.equal(big.headers.get('connection'), 'close');
    const ackBig = await macPost(env, '/ack', 'edl-ack-v1', 'x'.repeat(70 * 1024));
    assert.equal(ackBig.status, 413);
    assert.equal((await post(env, BOT_A, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200, '続けて使える');
  } finally { await cleanup(env); }
});

test('submit_task：受け付けて封にする・同じ idempotency_key は同じ ref を返す（重ねて積まない）', async () => {
  const env = await boot();
  try {
    const a = submitArgs(1);
    const first = await tool(env, BOT_A, 'submit_task', a);
    assert.deepEqual(first.data, { accepted: true, task_ref: a.idempotency_key, state: 'received' });
    assert.equal(first.isError, false);
    const again = await tool(env, BOT_A, 'submit_task', { ...a, params: { changed: true } });
    assert.equal(again.data.task_ref, a.idempotency_key);
    assert.equal(again.data.duplicate, true);
    assert.equal(env.stats().queue, 1);
    const other = await tool(env, BOT_B, 'submit_task', a);
    assert.equal(other.data.duplicate, undefined, '別の source は別の依頼（同じ key でも）');
    assert.equal(env.stats().queue, 2);
    const st = await tool(env, BOT_A, 'get_task_status', { task_ref: a.idempotency_key });
    assert.equal(st.data.state, 'received', '取り出される前は received');
  } finally { await cleanup(env); }
});

test('submit_task の検査：型・長さ・形・本文の大きさは code だけで isError', async () => {
  const env = await boot();
  try {
    const ok = submitArgs(1);
    const cases = [
      [{ ...ok, idempotency_key: 'short' }, 'invalid_idempotency_key'],
      [{ ...ok, idempotency_key: 'has space in it' }, 'invalid_idempotency_key'],
      [{ ...ok, idempotency_key: 'x'.repeat(129) }, 'invalid_idempotency_key'],
      [{ ...ok, idempotency_key: 12345678 }, 'invalid_idempotency_key'],
      [{ ...ok, business: 'Biz_A' }, 'invalid_business'],
      [{ ...ok, business: 'a' }, 'invalid_business'],
      [{ ...ok, intent: 'noDots' }, 'invalid_intent'],
      [{ ...ok, intent: 'Report.Summarize' }, 'invalid_intent'],
      [{ ...ok, intent: 'a.b.c.d.e' }, 'invalid_intent'],
      [{ ...ok, params: [1] }, 'invalid_params'],
      [{ ...ok, params: 'text' }, 'invalid_params'],
      [{ ...ok, params: null }, 'invalid_params'],
      [{ ...ok, summary: 'x'.repeat(201) }, 'invalid_summary'],
      [{ ...ok, summary: 'bell\u0007' }, 'invalid_summary'],
      [{ ...ok, summary: 5 }, 'invalid_summary'],
      [{ ...ok, params: { blob: 'x'.repeat(17 * 1024) } }, 'too_large'],
    ];
    for (const [args, code] of cases) {
      const r = await tool(env, BOT_A, 'submit_task', args);
      assert.equal(r.isError, true);
      assert.deepEqual(r.data, { error: code });
    }
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', 'text')).data, { error: 'invalid_arguments' });
    assert.equal((await tool(env, BOT_A, 'submit_task', { ...ok, summary: 'あ'.repeat(200) })).isError, false, '200 文字ちょうどは可');
    assert.deepEqual((await tool(env, BOT_A, 'get_task_status', { task_ref: 'x' })).data, { error: 'invalid_task_ref' });
    assert.equal(buildTaskBody({ ...ok, extra: 'dropped' }).error, undefined);
    assert.ok(!buildTaskBody({ ...ok, source: 'bot-back' }).body.includes('bot-back'));
  } finally { await cleanup(env); }
});

test('封：openRecord で検証でき、source は認証した鍵の source（引数で source を名乗っても無視）・本文は固定の形', async () => {
  const env = await boot();
  try {
    const args = submitArgs(7, { source: 'bot-back', channel: 'evil', received_at: 1, nonce: 'f'.repeat(32), sig: 'x', params: { source: 'bot-back', note: 'n' } });
    assert.equal((await tool(env, BOT_A, 'submit_task', args)).isError, false);
    const res = await macPull(env);
    assert.equal(res.status, 200);
    const { records } = await res.json();
    assert.equal(records.length, 1);
    const opened = openRecord(records[0], { keyFor: (c) => (c === CHANNEL ? KEY : null), now: env.clock.t });
    assert.equal(opened.ok, true);
    assert.equal(opened.record.source, 'bot-front');
    assert.equal(opened.record.channel, CHANNEL);
    assert.equal(opened.record.received_at, T0);
    assert.notEqual(opened.record.nonce, 'f'.repeat(32));
    const body = JSON.parse(opened.record.body);
    assert.deepEqual(Object.keys(body).sort(), ['business', 'idempotency_key', 'intent', 'params', 'summary', 'v']);
    assert.equal(body.v, 1);
    assert.deepEqual(body.params, { source: 'bot-back', note: 'n' }, 'params は解釈せずそのまま（source として扱われない）');
    assert.equal(openRecord(records[0], { keyFor: () => OTHER_KEY, now: env.clock.t }).ok, false, '別の鍵では開けない');
  } finally { await cleanup(env); }
});

test('source ごとの intent 許可：許可に無い intent は intent_not_allowed・`a.*` は前方一致', async () => {
  const sources = { 'bot-front': { key_sha256: sha(BOT_A), intents: ['report.summarize', 'note.*'] }, 'bot-back': { key_sha256: sha(BOT_B) } };
  const env = await boot({ sources });
  try {
    assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(1))).isError, false);
    assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(2, { intent: 'note.add' }))).isError, false);
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', submitArgs(3, { intent: 'server.restart' }))).data, { error: 'intent_not_allowed' });
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', submitArgs(4, { intent: 'report.other' }))).data, { error: 'intent_not_allowed' });
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', submitArgs(5, { intent: 'notes.add' }))).data, { error: 'intent_not_allowed' }, 'note.* は notes.add に合わない');
    assert.equal((await tool(env, BOT_B, 'submit_task', submitArgs(6, { intent: 'server.restart' }))).isError, false, '許可の無い source は全部可（Mac 側の policy が最終）');
    assert.equal(intentAllowed('a.b', null), true);
    assert.equal(intentAllowed('a.b', ['a.*']), true);
    assert.equal(intentAllowed('ab.c', ['a.*']), false);
    // 形の違う設定は捨てる
    const { sources: m, skipped } = normalizeSources({ 'Bad Id': { key_sha256: sha('x') }, ok1: { key_sha256: 'short' }, ok2: { key_sha256: sha('y'), intents: 'x' }, dup1: { key_sha256: sha('z') }, dup2: { key_sha256: sha('z') }, good: { key_sha256: sha('w'), intents: ['a.b'] } });
    assert.deepEqual([...m.keys()].sort(), ['dup1', 'good']);
    assert.equal(skipped, 4);
    assert.equal(normalizeSources([1]).sources.size, 0);
  } finally { await cleanup(env); }
});

test('rate limit：submit は 1 時間 60 件・全呼び出しは 600 回（sliding window）・source ごと', async () => {
  assert.equal(LIMITS.submit_per_hour, 60);
  assert.equal(LIMITS.calls_per_hour, 600);
  const env = await boot({ limits: { submit_per_hour: 3, calls_per_hour: 8, queue_per_source: 100 } });
  try {
    for (let i = 1; i <= 3; i += 1) assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(i))).isError, false);
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', submitArgs(4))).data, { error: 'rate_limited' });
    assert.equal((await tool(env, BOT_B, 'submit_task', submitArgs(5))).isError, false, '別の source は別の枠');
    env.clock.t += 30 * 60_000;
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', submitArgs(6))).data, { error: 'rate_limited' }, '30 分では空かない');
    env.clock.t += 31 * 60_000;
    assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(7))).isError, false, '1 時間たつと空く');
    // 全呼び出しの枠
    const env2 = await boot({ limits: { calls_per_hour: 4 } });
    try {
      const caps = async (bearer) => (await rpc(env2, bearer, 'tools/call', { name: 'list_capabilities', arguments: {} })).json.result;
      for (let i = 0; i < 4; i += 1) assert.equal((await caps(BOT_A)).isError, undefined);
      assert.deepEqual((await tool(env2, BOT_A, 'get_task_status', { task_ref: 'task-0001-abcd' })).data, { error: 'rate_limited' });
      assert.equal((await rpc(env2, BOT_A, 'ping')).status, 200, 'tools/call 以外は数えない');
      assert.equal((await caps(BOT_B)).isError, undefined);
    } finally { await cleanup(env2); }
  } finally { await cleanup(env); }
});

test('queue_full：source ごとの上限と全体の上限・取り出して ack すると空く', async () => {
  const env = await boot({ limits: { queue_per_source: 2, queue_total: 3, submit_per_hour: 100 } });
  try {
    assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(1))).isError, false);
    assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(2))).isError, false);
    assert.deepEqual((await tool(env, BOT_A, 'submit_task', submitArgs(3))).data, { error: 'queue_full' });
    assert.equal((await tool(env, BOT_B, 'submit_task', submitArgs(4))).isError, false);
    assert.deepEqual((await tool(env, BOT_B, 'submit_task', submitArgs(5))).data, { error: 'queue_full' }, '全体の上限');
    const { records } = await (await macPull(env)).json();
    assert.equal((await (await macAck(env, [records[0].nonce])).json()).deleted, 1);
    assert.equal((await tool(env, BOT_B, 'submit_task', submitArgs(5))).isError, false);
    assert.equal(LIMITS.queue_total, 500);
    assert.equal(LIMITS.queue_per_source, 100);
  } finally { await cleanup(env); }
});

test('/pull の認証：署名違い・鍵違い・時刻のずれ・再送・形の違い・欠けは 404。max と順序（古い順）・削除しない', async () => {
  const env = await boot();
  try {
    for (let i = 1; i <= 4; i += 1) { env.clock.t += 10; await tool(env, BOT_A, 'submit_task', submitArgs(i)); }
    assert.equal((await macPull(env, { key: OTHER_KEY })).status, 404, '鍵違い');
    assert.equal((await fetch(`${env.url}/pull`, { signal: AbortSignal.timeout(10_000), headers: { 'x-edl-ts': String(env.clock.t), 'x-edl-sig': 'z'.repeat(64) } })).status, 404, '署名の形');
    assert.equal((await fetch(`${env.url}/pull`, { signal: AbortSignal.timeout(10_000) })).status, 404, 'header 無し');
    assert.equal((await fetch(`${env.url}/pull`, { signal: AbortSignal.timeout(10_000), headers: { 'x-edl-ts': 'abc', 'x-edl-sig': 'a'.repeat(64) } })).status, 404);
    assert.equal((await macPull(env, { ts: env.clock.t + 5 * 60_000 + 1 })).status, 404, '未来にずれすぎ');
    assert.equal((await macPull(env, { ts: env.clock.t - 5 * 60_000 - 1 })).status, 404, '過去にずれすぎ');
    const ts = env.clock.t + 100;
    const good = await macPull(env, { ts }, '?max=2');
    assert.equal(good.status, 200);
    const { records } = await good.json();
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => JSON.parse(r.body).idempotency_key), ['task-0001-abcd', 'task-0002-abcd'], '古い順');
    assert.equal((await macPull(env, { ts })).status, 404, '同じ ts の再送');
    assert.equal((await macPull(env, { ts: ts - 1 })).status, 404, '前より小さい ts');
    assert.equal((await macPull(env, { ts: ts + 1 })).status, 200);
    env.clock.t += 1000; // 以降の既定の ts は前の ts より大きくなるように
    assert.equal((await (await macPull(env, {}, '?max=abc')).json()).records.length, 4, 'max が不正なら既定（50）・消えていない');
    assert.equal((await (await macPull(env, {}, '?max=0')).json()).records.length, 4);
    // 署名は method と path の語に固定（ack 用の署名では pull に入れない）
    const t = (env.clock.t += 5);
    const crossed = await fetch(`${env.url}/pull`, { signal: AbortSignal.timeout(10_000), headers: macHeaders(env, 'edl-ack-v1', pullTail(''), { ts: t }) });
    assert.equal(crossed.status, 404, 'domain が違う署名');
  } finally { await cleanup(env); }
});

test('/ack：渡した nonce だけ消す・本文の署名が要る・形の違いは 400・再送は 404', async () => {
  const env = await boot();
  try {
    for (let i = 1; i <= 3; i += 1) await tool(env, BOT_A, 'submit_task', submitArgs(i));
    const { records } = await (await macPull(env)).json();
    const ts = env.clock.t + 50;
    const text = JSON.stringify({ nonces: [records[0].nonce, records[2].nonce] });
    const bad = await fetch(`${env.url}/ack`, { method: 'POST', signal: AbortSignal.timeout(10_000), body: text, headers: macHeaders(env, 'edl-ack-v1', sha(text + ' '), { ts }) });
    assert.equal(bad.status, 404, '本文を差し替えると署名が合わない');
    const res = await macAck(env, [records[0].nonce, records[2].nonce, 'f'.repeat(32)], { ts });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 2, '知らない nonce は数えない');
    assert.equal((await macAck(env, [records[1].nonce], { ts })).status, 404, '同じ ts の再送');
    env.clock.t += 1000;
    const left = (await (await macPull(env)).json()).records;
    assert.deepEqual(left.map((r) => r.nonce), [records[1].nonce]);
    assert.equal((await macAck(env, ['not-a-nonce'])).status, 400);
    assert.equal((await macAck(env, 'x'.repeat(201).split(''))).status, 400);
    assert.equal((await macPost(env, '/ack', 'edl-ack-v1', '{"nonces":')).status, 400);
    assert.equal((await macAck(env, [records[1].nonce], { key: OTHER_KEY })).status, 404);
    const redo = await tool(env, BOT_A, 'submit_task', submitArgs(1));
    assert.equal(redo.data.duplicate, true, 'ack の後でも同じ key の置き直しは重ならない');
    assert.equal(env.stats().queue, 1);
  } finally { await cleanup(env); }
});

test('/status：署名を検査して板へ・source ごとに分かれる（bot-back は bot-front の状態を見られない）', async () => {
  const env = await boot();
  try {
    const a = submitArgs(1);
    await tool(env, BOT_A, 'submit_task', a);
    const ref = a.idempotency_key;
    const t = env.clock.t;
    const res = await macStatus(env, [status(ref, 'bot-front', 'succeeded', t, { summary: 'done', n: 3 })]);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results, [{ ok: true, code: 'stored' }]);
    const mine = await tool(env, BOT_A, 'get_task_status', { task_ref: ref });
    assert.deepEqual(mine.data, { task_ref: ref, state: 'succeeded', updated_at: t, result: { summary: 'done', n: 3 } });
    const theirs = await tool(env, BOT_B, 'get_task_status', { task_ref: ref });
    assert.deepEqual(theirs.data, { task_ref: ref, state: 'unknown' }, '別の source には見えない');
    // 同じ ref を bot-back も使い、Mac がそちらの状態を返しても混ざらない
    await tool(env, BOT_B, 'submit_task', a);
    await macStatus(env, [status(ref, 'bot-back', 'failed', t + 1, { why: 'x' })]);
    assert.equal((await tool(env, BOT_B, 'get_task_status', { task_ref: ref })).data.state, 'failed');
    assert.equal((await tool(env, BOT_A, 'get_task_status', { task_ref: ref })).data.state, 'succeeded');
    // 新しい updated_at が勝つ・古いものは捨てる
    assert.deepEqual((await (await macStatus(env, [status(ref, 'bot-front', 'running', t - 5)])).json()).results, [{ ok: true, code: 'stale' }]);
    assert.equal((await tool(env, BOT_A, 'get_task_status', { task_ref: ref })).data.state, 'succeeded');
    await macStatus(env, [status(ref, 'bot-front', 'failed', t + 10, { retry: false })]);
    assert.equal((await tool(env, BOT_A, 'get_task_status', { task_ref: ref })).data.state, 'failed');
    // 板に無い ref は unknown・source を名乗る引数は無い
    assert.equal((await tool(env, BOT_A, 'get_task_status', { task_ref: 'never-seen-ref', source: 'bot-back' })).data.state, 'unknown');
  } finally { await cleanup(env); }
});

test('/status の拒否：署名違い・別 channel・知らない source・本文が JSON でない・未来の時刻・形の違い', async () => {
  const env = await boot();
  try {
    const t = env.clock.t;
    const good = status('task-0001-abcd', 'bot-front', 'queued', t);
    const forged = { ...good, state: 'succeeded' }; // 署名後の改ざん
    const otherKey = status('task-0002-abcd', 'bot-front', 'queued', t, { a: 1 }, { key: OTHER_KEY });
    const otherChan = sealStatus(OTHER_KEY, { channel: 'other-channel', task_ref: 'task-0003-abcd', source: 'bot-front', state: 'queued', updated_at: t, body: '{}' });
    const noSource = status('task-0004-abcd', 'ghost-bot', 'queued', t);
    const notJson = sealStatus(KEY, { channel: CHANNEL, task_ref: 'task-0005-abcd', source: 'bot-front', state: 'queued', updated_at: t, body: 'plain text' });
    const future = status('task-0006-abcd', 'bot-front', 'queued', t + 10 * 60_000);
    const res = await macStatus(env, [forged, otherKey, otherChan, noSource, notJson, future, { junk: 1 }, good]);
    const codes = (await res.json()).results.map((r) => r.code);
    assert.deepEqual(codes, ['bad_signature', 'bad_signature', 'unknown_channel', 'unknown_source', 'body_not_json', 'future', 'unknown_field', 'stored']);
    assert.equal(env.stats().board, 1);
    assert.equal((await macStatus(env, [])).status, 400, '空');
    assert.equal((await macStatus(env, Array.from({ length: 21 }, () => good))).status, 400, '21 件');
    assert.equal((await macStatus(env, [good], { key: OTHER_KEY })).status, 404, '要求の署名が違う');
    assert.equal((await macPost(env, '/status', 'edl-status-v1', { statuses: [good] }, { ts: t + 6 * 60_000 })).status, 404, '要求の時刻のずれ');
    // 状態 20 件 × 本文 16KiB 近くも通る（64KiB を超えるので status は別の上限）
    const big = Array.from({ length: 20 }, (_, i) => sealStatus(KEY, { channel: CHANNEL, task_ref: `task-big-${i}-abcd`, source: 'bot-front', state: 'succeeded', updated_at: t + i, body: JSON.stringify({ blob: 'x'.repeat(15 * 1024) }) }));
    const bigRes = await macStatus(env, big);
    assert.equal(bigRes.status, 200);
    assert.equal((await bigRes.json()).results.filter((r) => r.code === 'stored').length, 20);
    const huge = await macPost(env, '/status', 'edl-status-v1', 'x'.repeat(2 * 1024 * 1024)).then((r) => r.status, () => 413); // 送っている途中で閉じられると fetch が失敗することがある
    assert.equal(huge, 413);
  } finally { await cleanup(env); }
});

test('期限：板は 14 日で消える・取りに来られない依頼は 7 日で捨てる（コードだけ記録）・捨てた後は置き直せる', async () => {
  const env = await boot();
  try {
    const a = submitArgs(1);
    const b = submitArgs(2);
    await tool(env, BOT_A, 'submit_task', a);
    await tool(env, BOT_A, 'submit_task', b);
    const { records } = await (await macPull(env)).json();
    await macAck(env, [records[0].nonce]); // a は取得済み
    await macStatus(env, [status(a.idempotency_key, 'bot-front', 'succeeded', env.clock.t)]);
    env.clock.t += 7 * DAY - 1000;
    env.tick();
    assert.equal(env.stats().queue, 1, '7 日の手前では残る');
    env.clock.t += 2000;
    env.tick();
    assert.equal(env.stats().queue, 0);
    assert.ok(env.logs.some((l) => l.code === 'queue_expired' && l.n === 1));
    assert.equal((await tool(env, BOT_A, 'get_task_status', { task_ref: b.idempotency_key })).data.state, 'unknown');
    const redo = await tool(env, BOT_A, 'submit_task', b);
    assert.equal(redo.data.duplicate, undefined, '捨てた依頼は置き直せる');
    assert.equal((await tool(env, BOT_A, 'get_task_status', { task_ref: a.idempotency_key })).data.state, 'succeeded', '板はまだ 14 日の中');
    env.clock.t += 7 * DAY + 5000;
    const gone = await tool(env, BOT_A, 'get_task_status', { task_ref: a.idempotency_key });
    assert.deepEqual(gone.data, { task_ref: a.idempotency_key, state: 'unknown' });
    assert.equal(env.stats().board, 0);
    const files = readFileSync(path.join(env.stateDir, 'board.json'), 'utf8');
    assert.equal(JSON.parse(files).entries.length, 0, '保存物からも消える');
  } finally { await cleanup(env); }
});

test('保存物：0600・再起動で残る（queue・板・Mac の ts）・Mac の再送は再起動後も拒む', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  const clock = { t: T0 };
  const a = await boot({ dir, clock });
  let ts;
  try {
    const args = submitArgs(1);
    await tool(a, BOT_A, 'submit_task', args);
    ts = clock.t + 77;
    assert.equal((await macPull(a, { ts })).status, 200);
    await macStatus(a, [status('task-0009-abcd', 'bot-front', 'running', clock.t)]);
    for (const f of ['queue.json', 'board.json', 'mac.json']) assert.equal(statSync(path.join(a.stateDir, f)).mode & 0o777, 0o600, f);
    assert.deepEqual(readdirSync(a.stateDir).filter((f) => f.endsWith('.tmp')), [], 'tmp が残らない');
  } finally { await a.close(); }
  const b = await boot({ dir, clock });
  try {
    assert.deepEqual([b.stats().queue, b.stats().board], [1, 1]);
    assert.equal((await macPull(b, { ts })).status, 404, '再起動後も同じ ts は再送');
    assert.equal((await macPull(b, { ts: ts + 1 })).status, 200);
    assert.equal((await tool(b, BOT_A, 'get_task_status', { task_ref: 'task-0009-abcd' })).data.state, 'running');
    assert.equal((await tool(b, BOT_A, 'submit_task', submitArgs(1))).data.duplicate, true, '再起動後も idempotent');
  } finally { await cleanup(b); }
});

test('壊れた保存物：落ちない・偽の封や未来の時刻を受け入れない・Mac を永久に締め出さない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(path.join(stateDir, 'queue.json'), '{{{ not json');
    writeFileSync(path.join(stateDir, 'board.json'), 'null');
    writeFileSync(path.join(stateDir, 'mac.json'), '[]');
    const a = await boot({ dir });
    assert.deepEqual([a.stats().queue, a.stats().board], [0, 0]);
    assert.equal((await tool(a, BOT_A, 'submit_task', submitArgs(1))).isError, false, '壊れていても使える');
    await a.close();
    // 形が合う物と偽の物が混ざる
    const good = sealRecord(KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0, body: JSON.stringify({ v: 1, idempotency_key: 'task-good-0001', business: 'biz-a', intent: 'a.b', params: {}, summary: '' }) });
    const forged = { ...sealRecord(OTHER_KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0, body: JSON.stringify({ idempotency_key: 'task-forged-01' }) }) };
    const futureRec = sealRecord(KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0 + 30 * DAY, body: JSON.stringify({ idempotency_key: 'task-future-01' }) });
    const noRef = sealRecord(KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0, body: '{"x":1}' });
    writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ records: [{ ref: 'task-good-0001', stored_at: T0 + 30 * DAY, record: good }, { ref: 'x', stored_at: T0, record: forged }, { ref: 'x', stored_at: T0, record: futureRec }, { ref: 'x', stored_at: T0, record: noRef }, { ref: 'x', stored_at: T0, record: good }, 'junk', null], seen: [['bot-front', 'task-seen-0001', 'x'], ['Bad Id', 'task-xx-0001', T0], 7] }));
    const futureStatus = sealStatus(KEY, { channel: CHANNEL, task_ref: 'task-fut-00001', source: 'bot-front', state: 'queued', updated_at: T0 + 30 * DAY, body: '{}' });
    const okStatus = sealStatus(KEY, { channel: CHANNEL, task_ref: 'task-ok-000001', source: 'bot-front', state: 'queued', updated_at: T0, body: '{"a":1}' });
    writeFileSync(path.join(stateDir, 'board.json'), JSON.stringify({ entries: [{ stored_at: T0, status: futureStatus }, { stored_at: T0, status: okStatus }, { stored_at: T0, status: { ...okStatus, state: 'failed' } }, 5] }));
    writeFileSync(path.join(stateDir, 'mac.json'), JSON.stringify({ pull: Number.MAX_SAFE_INTEGER, ack: -5, status: 'x' }));
    const b = await boot({ dir });
    assert.equal(b.stats().queue, 1, '偽・未来・本文の形の違い・重複は捨てる');
    assert.equal(b.stats().board, 1);
    assert.ok(b.logs.some((l) => l.code === 'state_entries_dropped'));
    assert.ok(b.stats().mac.pull <= T0 + 5 * 60_000, '未来の last ts は切る');
    assert.equal(b.stats().mac.ack, 0);
    b.clock.t += 5 * 60_000 + 10;
    assert.equal((await macPull(b)).status, 200, '時間がたてば Mac の pull を受ける');
    assert.equal((await tool(b, BOT_A, 'get_task_status', { task_ref: 'task-ok-000001' })).data.state, 'queued');
    assert.equal((await tool(b, BOT_A, 'get_task_status', { task_ref: 'task-fut-00001' })).data.state, 'unknown');
    await b.close();
    // 書けない場所でも落ちない（メモリで続ける）
    const c = await boot({ dir: mkdtempSync(path.join(tmpdir(), 'edl-ti-')) });
    rmSync(c.stateDir, { recursive: true, force: true });
    writeFileSync(c.stateDir, 'a file where a directory should be');
    assert.equal((await tool(c, BOT_A, 'submit_task', submitArgs(1))).isError, false);
    assert.ok(c.logs.some((l) => l.code === 'state_unwritable'));
    rmSync(c.stateDir, { force: true });
    await cleanup(c);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('記録：コードだけ。鍵・Bearer・本文・params・summary は journal に出ない', async () => {
  const env = await boot();
  try {
    await tool(env, BOT_A, 'submit_task', submitArgs(1, { params: { secret: 'PARAM-MARKER-XYZ' }, summary: 'SUMMARY-MARKER-XYZ' }));
    await post(env, 'wrong-key-MARKER', { jsonrpc: '2.0', id: 1, method: 'ping' });
    await macPull(env, { key: OTHER_KEY });
    await macStatus(env, [status('task-0001-abcd', 'ghost-bot', 'queued', env.clock.t, { r: 'RESULT-MARKER-XYZ' })]);
    env.clock.t += 8 * DAY;
    env.tick();
    const all = JSON.stringify(env.logs);
    for (const s of [KEY_HEX, BOT_A, BOT_B, 'wrong-key-MARKER', 'PARAM-MARKER', 'SUMMARY-MARKER', 'RESULT-MARKER', sha(BOT_A), 'task-0001']) assert.ok(!all.includes(s), s);
    for (const l of env.logs) assert.ok(/^[a-z_]+$/.test(l.code));
  } finally { await cleanup(env); }
});

test('bot 鍵の管理：addSource は hash だけを書く（鍵は戻り値だけ）・重複は拒む・removeSource', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    const file = path.join(dir, 'sources.json');
    const key = addSource(file, 'bot-front', ['report.*']);
    assert.match(key, /^etk_[0-9a-f]{64}$/);
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes(key), '鍵そのものを書かない');
    assert.equal(JSON.parse(text)['bot-front'].key_sha256, sha(key));
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.throws(() => addSource(file, 'bot-front'), /already exists/);
    assert.throws(() => addSource(file, 'Bad Id'), /invalid/);
    assert.throws(() => addSource(file, 'bot-back', ['UPPER']), /invalid/);
    const key2 = addSource(file, 'bot-back');
    assert.notEqual(key, key2);
    assert.equal(authenticate(`Bearer ${key2}`, normalizeSources(JSON.parse(readFileSync(file, 'utf8'))).sources), 'bot-back');
    assert.equal(removeSource(file, 'bot-front'), true);
    assert.equal(removeSource(file, 'bot-front'), false);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['bot-back']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------- Mac 側（vps-client・CLI） ----------------

const okFetch = (json, status = 200) => async () => ({ status, text: async () => JSON.stringify(json) });

test('vps-client：baseUrl は https か loopback の http だけ・path や認証情報を持つ物は不可・鍵の形', () => {
  assert.equal(normalizeBase('https://intake.example.com'), 'https://intake.example.com');
  assert.equal(normalizeBase('https://intake.example.com/'), 'https://intake.example.com');
  assert.equal(normalizeBase('http://127.0.0.1:8796'), 'http://127.0.0.1:8796');
  for (const bad of ['http://intake.example.com', 'http://localhost:8796', 'ftp://x.example.com', 'https://u:p@x.example.com', 'https://x.example.com/mcp', 'https://x.example.com/?a=1', 'nope', '']) assert.equal(normalizeBase(bad), null, bad);
  assert.equal(keyFromHex('zz'), null);
  assert.equal(keyFromHex('ab'.repeat(16)), null, '32 byte 未満');
  assert.equal(keyFromHex(`${KEY_HEX}\n`).length, 32);
});

test('vps-client：redirect に従わない・時間切れを持つ・失敗は code だけ（鍵・応答の中身を出さない）', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push([u, o]); return { status: 200, text: async () => JSON.stringify({ records: [] }) }; };
  const r = await pull({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl, now: () => T0, max: 7 });
  assert.equal(r.ok, true);
  const [u, o] = seen[0];
  assert.equal(u, 'https://intake.example.com/pull?offset=0&max=7');
  assert.equal(o.redirect, 'error');
  assert.ok(o.signal instanceof AbortSignal);
  assert.equal(o.headers['x-edl-sig'], createHmac('sha256', KEY).update(`edl-pull-v1\n${T0}\nGET /pull?offset=0&max=7`).digest('hex'));
  assert.deepEqual(await pull({ baseUrl: 'http://example.com', key: KEY, fetchImpl }), { ok: false, code: 'bad_config' });
  assert.deepEqual(await pull({ baseUrl: 'https://intake.example.com', key: Buffer.alloc(8), fetchImpl }), { ok: false, code: 'bad_config' });
  assert.deepEqual(await pull({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: async () => { throw new Error(`boom ${KEY_HEX}`); } }), { ok: false, code: 'network' });
  assert.deepEqual(await pull({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okFetch({}, 404) }), { ok: false, code: 'http_404' });
  assert.deepEqual(await pull({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okFetch({ records: 'x' }) }), { ok: false, code: 'bad_response' });
  assert.deepEqual(await pull({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: async () => ({ status: 200, text: async () => 'not json' }) }), { ok: false, code: 'bad_response' });
});

test('vps-client：pull は偽の封（署名違い・形の違い・古すぎ）を捨てて数える・writeInbox は <nonce>.json を 0600 で O_EXCL 的に置く', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    const body = JSON.stringify({ v: 1, idempotency_key: 'task-0001-abcd' });
    const good = sealRecord(KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0, body });
    const forged = sealRecord(OTHER_KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0, body });
    const old = sealRecord(KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0 - 30 * DAY, body });
    const r = await pull({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okFetch({ records: [good, forged, old, { junk: 1 }, null] }), now: () => T0, channel: CHANNEL });
    assert.deepEqual(r.records, [good]);
    assert.deepEqual(r.invalid.sort(), [forged.nonce, old.nonce].sort());
    assert.equal(r.invalid_count, 3);
    assert.equal(r.kept_count, 1, '知らない field（版の違いかもしれない）は消さずに残す');
    const inbox = path.join(dir, 'inbox');
    const w = writeInbox([good], inbox);
    assert.deepEqual(w, { written: [good.nonce], existing: [], failed: 0 });
    const f = path.join(inbox, `${good.nonce}.json`);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(inbox).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), good);
    assert.deepEqual(readdirSync(inbox), [`${good.nonce}.json`], 'tmp が残らない');
    const again = writeInbox([{ ...good, body: '{"changed":true}' }], inbox);
    assert.deepEqual(again, { written: [], existing: [good.nonce], failed: 0 });
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), good, '既にある物を上書きしない');
    const evil = writeInbox([{ ...good, nonce: '../../../etc/x' }, { ...good, nonce: 'short' }, null], inbox);
    assert.equal(evil.failed, 3, 'nonce が形に合わなければファイル名にしない');
    assert.deepEqual(readdirSync(inbox).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('vps-client：pushStatuses は 20 件ずつ送り、届いた物だけ sentDir へ移す・失敗や拒否は outbox に残す', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    const outbox = path.join(dir, 'outbox');
    const sent = path.join(dir, 'sent');
    mkdirSync(outbox);
    const put = (name, over = {}) => writeFileSync(path.join(outbox, name), JSON.stringify({ task_ref: `task-${name}-abcd`.replace('.json', ''), source: 'bot-front', channel: CHANNEL, business: 'biz-a', state: 'succeeded', updated_at: T0, body: JSON.stringify({ ok: true }), ...over }));
    for (let i = 0; i < 45; i += 1) put(`s${String(i).padStart(3, '0')}.json`);
    writeFileSync(path.join(outbox, 'broken.json'), '{nope');
    writeFileSync(path.join(outbox, '.hidden.json'), '{}');
    writeFileSync(path.join(outbox, 'notes.txt'), 'x');
    put('wrongchan.json', { channel: 'other-channel' });
    put('badstate.json', { state: 'weird' });
    let t = T0;
    const now = () => (t += 1);
    const calls = [];
    const okAll = async (u, o) => { const b = JSON.parse(o.body); calls.push([u, b.statuses.length, o.headers['x-edl-ts']]); return { status: 200, text: async () => JSON.stringify({ results: b.statuses.map(() => ({ ok: true, code: 'stored' })) }) }; };
    // 先に全部失敗
    const down = await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: async () => ({ status: 502, text: async () => '' }), now, outboxDir: outbox, sentDir: sent, channel: CHANNEL });
    assert.equal(down.sent, 0);
    assert.equal(down.kept, 45);
    assert.equal(down.failed_batches, 3);
    assert.equal(down.invalid, 3, '壊れた・channel 違い・state 違い（.hidden／.txt は対象外）');
    assert.equal(down.code, 'http_502');
    assert.equal(readdirSync(outbox).filter((f) => f.startsWith('s0')).length, 45, '失敗なら残る');
    const r = await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okAll, now, outboxDir: outbox, sentDir: sent, channel: CHANNEL });
    assert.deepEqual(calls.map((c) => c[1]), [20, 20, 5]);
    assert.ok(calls.every((c) => c[0] === 'https://intake.example.com/status'));
    const tss = calls.map((c) => Number(c[2]));
    assert.ok(tss[0] < tss[1] && tss[1] < tss[2], 'ts は増える');
    assert.equal(r.sent, 45);
    assert.equal(readdirSync(sent).length, 45);
    assert.equal(readdirSync(outbox).filter((f) => f.startsWith('s0')).length, 0);
    assert.ok(readdirSync(outbox).includes('broken.json'), '壊れた物は動かさない');
    assert.equal(statSync(sent).mode & 0o777, 0o700);
    // 一部拒否
    put('r1.json');
    put('r2.json', { task_ref: 'task-r2-abcdefgh' });
    put('r4.json', { task_ref: 'task-r4-abcdefgh' });
    const mixed = async (u, o) => ({ status: 200, text: async () => JSON.stringify({ results: JSON.parse(o.body).statuses.map((s) => (s.task_ref.includes('r2') ? { ok: false, code: 'body_not_json' } : (s.task_ref.includes('r4') ? { ok: false, code: 'unknown_source' } : { ok: true, code: 'stored' }))) }) });
    const m = await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: mixed, now, outboxDir: outbox, sentDir: sent, channel: CHANNEL });
    assert.deepEqual([m.sent, m.kept, m.quarantined, m.rejected], [1, 1, 1, [{ file: 'r4.json', code: 'unknown_source' }]], 'VPS の設定で起きうる拒否（unknown_source）は outbox に残り、何度送っても受からない物（body_not_json）だけ退避される');
    assert.ok(existsSync(path.join(outbox, 'r4.json')));
    assert.ok(!existsSync(path.join(outbox, 'r2.json')), '永久に拒まれる物は毎回送り直さない');
    assert.ok(existsSync(path.join(dir, 'outbox-rejected', 'r2.json')), 'outbox の隣の outbox-rejected/ へ');
    assert.equal(statSync(path.join(dir, 'outbox-rejected')).mode & 0o777, 0o700);
    assert.ok(existsSync(path.join(sent, 'r1.json')));
    rmSync(path.join(outbox, 'r4.json'));
    // 同じ名前が sent にあっても失わない
    put('r1.json');
    await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okAll, now, outboxDir: outbox, sentDir: sent, channel: CHANNEL });
    assert.ok(existsSync(path.join(sent, 'r1.json.1')));
    // 応答の件数が合わない
    put('r3.json');
    const odd = await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okFetch({ results: [] }), now, outboxDir: outbox, sentDir: sent, channel: CHANNEL });
    assert.equal(odd.code, 'bad_response');
    assert.ok(existsSync(path.join(outbox, 'r3.json')));
    assert.equal((await pushStatuses({ baseUrl: 'http://example.com', key: KEY, fetchImpl: okAll, outboxDir: outbox, sentDir: sent, channel: CHANNEL })).code, 'bad_config');
    assert.equal((await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: okAll, outboxDir: path.join(dir, 'nope'), sentDir: sent, channel: CHANNEL })).code, 'outbox_unreadable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI：鍵か URL が Keychain に無ければ not_configured で exit 0（休眠）・形が違えば config_invalid・引数の誤りは exit 2', async () => {
  const none = async () => { throw new Error('should not fetch'); };
  const kc = (map) => (name) => map[name] ?? null;
  const base = ['pull', '--inbox', '/nonexistent/inbox'];
  assert.deepEqual(await runSync({ argv: base, keychain: kc({}), fetchImpl: none }), { code: 'not_configured', exit: 0 });
  assert.deepEqual(await runSync({ argv: base, keychain: kc({ [KEYCHAIN_URL]: 'https://intake.example.com' }), fetchImpl: none }), { code: 'not_configured', exit: 0 });
  assert.deepEqual(await runSync({ argv: base, keychain: kc({ [keychainKeyTarget(CHANNEL)]: KEY_HEX }), fetchImpl: none }), { code: 'not_configured', exit: 0 });
  assert.equal((await runSync({ argv: base, keychain: kc({ [KEYCHAIN_URL]: 'http://example.com', [keychainKeyTarget(CHANNEL)]: KEY_HEX }), fetchImpl: none })).code, 'config_invalid');
  assert.equal((await runSync({ argv: base, keychain: kc({ [KEYCHAIN_URL]: 'https://intake.example.com', [keychainKeyTarget(CHANNEL)]: 'short' }), fetchImpl: none })).code, 'config_invalid');
  for (const argv of [[], ['pull'], ['push', '--outbox', 'x'], ['frob'], ['pull', '--inbox'], ['pull', '--inbox', 'x', '--channel', 'Bad Channel']]) assert.equal((await runSync({ argv, keychain: kc({}), fetchImpl: none })).exit, 2, argv.join(' '));
  assert.deepEqual(parseArgs(['pull', '--inbox', 'a']), { command: 'pull', opts: { inbox: 'a' } });
  assert.equal(keychainKeyTarget('vps-intake'), 'E-NEXUS/edl/task-intake-vps-intake');
  assert.match(KEYCHAIN_URL, /^E-NEXUS\/edl\/[a-z0-9-]+$/);
});

test('E2E：mock Grok（MCP client）→ intake → vps-client.pull → writeInbox → ack → outbox の結果 → pushStatuses → get_task_status（CLI の運びも同じ道）', async () => {
  const clock = { t: T0 };
  const env = await boot({ clock });
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    const inbox = path.join(dir, 'inbox');
    const outbox = path.join(dir, 'outbox');
    const sentDir = path.join(dir, 'sent');
    mkdirSync(outbox);
    const now = () => (clock.t += 1000);
    // 1. Grok Bot が MCP で入れる
    const init = await rpc(env, BOT_A, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock-grok', version: '0' } });
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    const t1 = submitArgs(1, { business: 'biz-a', intent: 'report.summarize', params: { topic: 'weekly' }, summary: 'weekly report' });
    const t2 = submitArgs(2, { business: 'biz-b', intent: 'note.add', params: { text: 'hello' } });
    assert.equal((await tool(env, BOT_A, 'submit_task', t1)).data.state, 'received');
    assert.equal((await tool(env, BOT_B, 'submit_task', t2)).data.state, 'received');
    // 2. Mac が outbound で取る（CLI の経路：Keychain は差し替え）
    const keychain = (name) => ({ [KEYCHAIN_URL]: env.url, [keychainKeyTarget(CHANNEL)]: KEY_HEX })[name] ?? null;
    const pulled = await runSync({ argv: ['pull', '--inbox', inbox], keychain, fetchImpl: globalThis.fetch, now });
    assert.deepEqual([pulled.code, pulled.exit, pulled.pulled, pulled.written, pulled.deleted], ['pulled', 0, 2, 2, 2]);
    assert.equal(env.stats().queue, 0, 'ack で消えた');
    const files = readdirSync(inbox).sort();
    assert.equal(files.length, 2);
    const parsed = files.map((f) => JSON.parse(readFileSync(path.join(inbox, f), 'utf8')));
    for (const [i, rec] of parsed.entries()) {
      assert.equal(files[i], `${rec.nonce}.json`);
      const o = openRecord(rec, { keyFor: (c) => (c === CHANNEL ? KEY : null), now: clock.t });
      assert.equal(o.ok, true);
    }
    const bySource = Object.fromEntries(parsed.map((r) => [r.source, JSON.parse(r.body)]));
    assert.equal(bySource['bot-front'].intent, 'report.summarize');
    assert.equal(bySource['bot-back'].business, 'biz-b');
    // 2 回目の pull は空
    assert.equal((await runSync({ argv: ['pull', '--inbox', inbox], keychain, fetchImpl: globalThis.fetch, now })).pulled, 0);
    // 3. Mac の store が outbox へ結果を書いたことにする
    const result = { summary: 'report ready', items: 3 };
    writeFileSync(path.join(outbox, 'a.json'), JSON.stringify({ task_ref: t1.idempotency_key, source: 'bot-front', channel: CHANNEL, business: 'biz-a', state: 'succeeded', updated_at: clock.t, body: JSON.stringify(result) }));
    writeFileSync(path.join(outbox, 'b.json'), JSON.stringify({ task_ref: t2.idempotency_key, source: 'bot-back', channel: CHANNEL, business: 'biz-b', state: 'awaiting_approval', updated_at: clock.t, body: JSON.stringify({ needs: 'human approval on the Mac' }) }));
    const pushed = await runSync({ argv: ['push', '--outbox', outbox, '--sent', sentDir], keychain, fetchImpl: globalThis.fetch, now });
    assert.deepEqual([pushed.code, pushed.exit, pushed.sent, pushed.kept], ['pushed', 0, 2, 0]);
    assert.deepEqual(readdirSync(outbox), []);
    assert.deepEqual(readdirSync(sentDir).sort(), ['a.json', 'b.json']);
    // 4. Grok Bot が status を見る（自分の分だけ）
    const s1 = await tool(env, BOT_A, 'get_task_status', { task_ref: t1.idempotency_key });
    assert.equal(s1.data.state, 'succeeded');
    assert.deepEqual(s1.data.result, result);
    assert.equal((await tool(env, BOT_B, 'get_task_status', { task_ref: t1.idempotency_key })).data.state, 'unknown');
    assert.equal((await tool(env, BOT_B, 'get_task_status', { task_ref: t2.idempotency_key })).data.state, 'awaiting_approval');
    // 直接 API でも同じ（ack は消した分だけ・VPS が落ちている時は outbox に残る）
    const offline = await pushStatuses({ baseUrl: 'http://127.0.0.1:1', key: KEY, fetchImpl: globalThis.fetch, now, outboxDir: outbox, sentDir, channel: CHANNEL });
    assert.deepEqual([offline.sent, offline.kept], [0, 0]);
    const a2 = await ack({ baseUrl: env.url, key: KEY, fetchImpl: globalThis.fetch, now, nonces: [] });
    assert.deepEqual(a2, { ok: true, deleted: 0 });
    // 鍵が違えば VPS は何も教えない（404 → http_404）
    const wrong = await pull({ baseUrl: env.url, key: OTHER_KEY, fetchImpl: globalThis.fetch, now });
    assert.deepEqual(wrong, { ok: false, code: 'http_404' });
    assert.ok(!JSON.stringify(env.logs).includes(KEY_HEX));
    assert.equal(newNonce().length, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await cleanup(env);
  }
});

test('監査の修正：外した source の依頼は再起動後に Mac へ渡さない・板からも消える', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  const clock = { t: T0 };
  const a = await boot({ dir, clock });
  assert.equal((await tool(a, BOT_A, 'submit_task', submitArgs(901))).data.accepted, true);
  assert.equal((await tool(a, BOT_B, 'submit_task', submitArgs(902))).data.accepted, true);
  await a.close();
  const b = await boot({ dir, clock, sources: { 'bot-back': { key_sha256: sha(BOT_B) } } });
  try {
    assert.equal((await rpc(b, BOT_A, 'tools/list', {})).status, 401);
    const got = await pull({ baseUrl: b.url, key: KEY, now: () => (clock.t += 1), channel: CHANNEL });
    assert.equal(got.ok, true);
    assert.deepEqual(got.records.map((r) => r.source), ['bot-back']);
  } finally {
    await cleanup(b);
  }
});

test('監査の修正：古さの上限は運び手と取り込みで同じ（VPS の保存 7 日より長い）・消すのは偽物と古すぎる物だけ', async () => {
  const { RECORD_MAX_AGE_MS } = await import('../scripts/lib/task-hub/wire.mjs');
  assert.ok(RECORD_MAX_AGE_MS > LIMITS.queue_ttl_ms);
  const env = await boot();
  try {
    assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(903))).data.accepted, true);
    env.clock.t += 4 * DAY;
    const got = await pull({ baseUrl: env.url, key: KEY, now: () => (env.clock.t += 1), channel: CHANNEL });
    assert.equal(got.records.length, 1, '4 日前の依頼も取り込める');
    assert.equal(openRecord(got.records[0], { keyFor: () => KEY, now: env.clock.t }).ok, true, '取り込み側の既定でも too_old にならない');
    const wrongKey = await pull({ baseUrl: env.url, key: KEY, now: () => (env.clock.t += 1), channel: 'other-channel' });
    assert.deepEqual([wrongKey.invalid.length, wrongKey.kept_count], [0, 1], '鍵・channel の設定違いでは消さない');
  } finally {
    await cleanup(env);
  }
});

// ─── 再検証の指摘（head-of-line・seen・dir の fsync）───

test('pull：offset は署名の対象（付け替えると 404）・範囲は 0..queue_total・offset の後ろから max 件を返す', async () => {
  const env = await boot();
  try {
    for (let i = 1; i <= 5; i += 1) await tool(env, BOT_A, 'submit_task', submitArgs(i));
    const keys = async (query) => (await (await macPull(env, {}, query)).json()).records.map((r) => JSON.parse(r.body).idempotency_key);
    assert.deepEqual(await keys('?offset=0&max=2'), ['task-0001-abcd', 'task-0002-abcd']);
    assert.deepEqual(await keys('?offset=2&max=2'), ['task-0003-abcd', 'task-0004-abcd']);
    assert.deepEqual(await keys('?offset=4&max=50'), ['task-0005-abcd']);
    assert.deepEqual(await keys('?offset=5&max=50'), [], 'queue の外は空');
    // offset を署名と違う値にして送る（途中で書き換えられた）：404
    const t = (env.clock.t += 5);
    const swapped = await fetch(`${env.url}/pull?offset=3&max=2`, { signal: AbortSignal.timeout(10_000), headers: macHeaders(env, 'edl-pull-v1', 'GET /pull?offset=0&max=2', { ts: t }) });
    assert.equal(swapped.status, 404, 'offset は署名の対象');
    // 範囲外・形の違いは 404（署名が正しくても）
    for (const bad of ['?offset=501&max=2', '?offset=-1&max=2', '?offset=abc&max=2', '?offset=1.5&max=2', '?offset=00000&max=2']) {
      const tt = (env.clock.t += 5);
      const res = await fetch(`${env.url}/pull${bad}`, { signal: AbortSignal.timeout(10_000), headers: macHeaders(env, 'edl-pull-v1', `GET /pull?offset=${new URLSearchParams(bad).get('offset')}&max=2`, { ts: tt }) });
      assert.equal(res.status, 404, bad);
    }
    // offset 無しの要求は 0 として署名する
    assert.deepEqual((await keys('?max=1')), ['task-0001-abcd']);
  } finally { await cleanup(env); }
});

test('head-of-line：残してある封（未来の時刻の物 50 件）が先頭を塞いでも、後ろの有効な 5 件を 1 回で取る・kept を報告して exit 1', async () => {
  const clock = { t: T0 };
  const env = await boot({ clock, limits: { submit_per_hour: 1000, calls_per_hour: 1000, skew_ms: 15 * 60_000 } });
  const inbox = mkdtempSync(path.join(tmpdir(), 'edl-ti-in-'));
  try {
    clock.t = T0 + 10 * 60_000; // VPS の時計が Mac より 10 分進んでいる間に 50 件（Mac から見ると「未来」＝残す）
    for (let i = 0; i < 50; i += 1) await tool(env, BOT_A, 'submit_task', submitArgs(100 + i));
    clock.t = T0;
    for (let i = 0; i < 5; i += 1) await tool(env, BOT_A, 'submit_task', submitArgs(200 + i));
    assert.equal(env.stats().queue, 55);
    let mac = T0 + 1000;
    const keychain = (name) => (name === KEYCHAIN_URL ? env.url : (name === keychainKeyTarget(CHANNEL) ? KEY_HEX : null));
    const out = await runSync({ argv: ['pull', '--inbox', inbox], keychain, now: () => (mac += 1) });
    assert.equal(out.written, 5, '先頭の 50 件を飛び越えて有効な 5 件を取る');
    assert.equal(out.kept, 50, 'kept を出す');
    assert.equal(out.exit, 1, 'kept があれば exit 1（定期実行が止まりに気づける）');
    assert.equal(readdirSync(inbox).filter((f) => f.endsWith('.json')).length, 5);
    assert.equal(env.stats().queue, 50, '残した 50 件は VPS に残る');
    // 次の回：有効な物は無く、kept だけが報告され続ける
    const again = await runSync({ argv: ['pull', '--inbox', inbox], keychain, now: () => (mac += 1) });
    assert.deepEqual([again.written, again.kept, again.exit], [0, 50, 1]);
  } finally { rmSync(inbox, { recursive: true, force: true }); await cleanup(env); }
});

test('head-of-line：kept が無ければ exit 0 のまま（ページを進めない）', async () => {
  const env = await boot();
  const inbox = mkdtempSync(path.join(tmpdir(), 'edl-ti-in-'));
  try {
    for (let i = 0; i < 3; i += 1) await tool(env, BOT_A, 'submit_task', submitArgs(300 + i));
    const keychain = (name) => (name === KEYCHAIN_URL ? env.url : (name === keychainKeyTarget(CHANNEL) ? KEY_HEX : null));
    const out = await runSync({ argv: ['pull', '--inbox', inbox], keychain, now: () => (env.clock.t += 1) });
    assert.deepEqual([out.written, out.kept, out.exit, out.deleted], [3, 0, 0, 3]);
  } finally { rmSync(inbox, { recursive: true, force: true }); await cleanup(env); }
});

test('seen：設定から外した source の重複の印は再起動で捨てる・その source を足し直した時に古い「重複」で答えない（保存物からも消える）', async () => {
  const env1 = await boot();
  const root = env1.root;
  const clock = env1.clock;
  try {
    await tool(env1, BOT_A, 'submit_task', submitArgs(1));
    const { records } = await (await macPull(env1)).json();
    assert.equal((await macAck(env1, records.map((r) => r.nonce))).status, 200);
    assert.equal(env1.stats().queue, 0);
    assert.equal(env1.stats().seen, 1, '取得済みの依頼の印は残る');
    await env1.close();
    // bot-front を外して再起動：印は読み込みで捨てられ、保存物も書き直される
    const env2 = await boot({ dir: root, clock, sources: { 'bot-back': { key_sha256: sha(BOT_B) } } });
    assert.equal(env2.stats().seen, 0);
    assert.ok(env2.logs.some((l) => l.code === 'seen_entries_dropped'));
    await env2.close();
    // 同じ id で足し直して同じ key を出し直す：重複ではなく新しい依頼として queue に入る
    const env3 = await boot({ dir: root, clock });
    try {
      assert.equal(env3.stats().seen, 0);
      const again = await tool(env3, BOT_A, 'submit_task', submitArgs(1));
      assert.equal(again.isError, false);
      assert.equal(env3.stats().queue, 1);
    } finally { await env3.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeInbox：置いた後に inbox フォルダを fsync する（拒む platform では何もしない・本当の I/O エラーなら ack させない）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    const rec = sealRecord(KEY, { channel: CHANNEL, source: 'bot-front', received_at: T0, body: JSON.stringify({ v: 1 }) });
    const src = readFileSync(new URL('../scripts/lib/task-hub/vps-client.mjs', import.meta.url), 'utf8');
    assert.match(src, /function fsyncDir\(dir\)[\s\S]*O_RDONLY[\s\S]*fsyncSync\(fd\)/, 'フォルダを O_RDONLY で開いて fsync');
    assert.match(src, /EINVAL[\s\S]*EPERM/, '拒む platform の errno は無視');
    assert.match(src, /fsyncDir\(inboxDir\)/);
    const w = writeInbox([rec], path.join(dir, 'inbox'));
    assert.deepEqual(w.written, [rec.nonce]);
    assert.equal(w.failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pushStatuses：outbox の symlink・FIFO は読まない（invalid）・外の file の中身を VPS へ送らない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    const outbox = path.join(dir, 'outbox');
    mkdirSync(outbox);
    const outside = path.join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ task_ref: 'task-link-abcdefg', source: 'bot-front', channel: CHANNEL, business: 'biz-a', state: 'succeeded', updated_at: T0, body: '{}' }));
    symlinkSync(outside, path.join(outbox, 'link.json'));
    let called = 0;
    const r = await pushStatuses({ baseUrl: 'https://intake.example.com', key: KEY, fetchImpl: async () => { called += 1; return { status: 200, text: async () => '{}' }; }, now: () => T0, outboxDir: outbox, sentDir: path.join(dir, 'sent'), channel: CHANNEL });
    assert.equal(r.invalid, 1, 'symlink は invalid');
    assert.equal(called, 0, '送らない');
    assert.ok(existsSync(outside));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI の pull：時計が進まなくても（同じ ms）ページと ack をまたいで要求の時刻を進める＝2 ページ目が再送として拒まれない（2026-11-10）', async () => {
  const clock = { t: T0 };
  const env = await boot({ clock });
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-ti-'));
  try {
    for (let i = 1; i <= 3; i += 1) { clock.t += 10; assert.equal((await tool(env, BOT_A, 'submit_task', submitArgs(i))).data.state, 'received'); }
    const keychain = (name) => ({ [KEYCHAIN_URL]: env.url, [keychainKeyTarget(CHANNEL)]: KEY_HEX })[name] ?? null;
    const frozen = () => clock.t; // 進まない時計
    const r = await runSync({ argv: ['pull', '--inbox', path.join(dir, 'inbox'), '--max', '1'], keychain, fetchImpl: globalThis.fetch, now: frozen });
    assert.deepEqual([r.code, r.exit, r.pulled, r.written, r.deleted], ['pulled', 0, 3, 3, 3]);
    assert.equal(env.stats().queue, 0);
    // 次の回（新しい時計）も、前の回が先へ進めた時刻より後なら通る
    clock.t += 1000;
    assert.deepEqual([(await runSync({ argv: ['pull', '--inbox', path.join(dir, 'inbox')], keychain, fetchImpl: globalThis.fetch, now: frozen })).exit], [0]);
  } finally {
    await cleanup(env);
    rmSync(dir, { recursive: true, force: true });
  }
});
