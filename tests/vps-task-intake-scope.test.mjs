/**
 * VPS の受け口の source ごとの business の制限（2026-11-13・MA-24）：Bot の説明文だけに頼らず、鍵（source）ごとに intent と business を VPS で絞る。
 * loopback の実 server（port 0）。外部へは接続しない。id・鍵は試験用の作り物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPABILITIES_TEXT, addSource, normalizeSources, setSourceScope, startIntake } from '../deploy/vps-task-intake/intake.mjs';

const KEY = Buffer.from('ab'.repeat(32), 'hex');
const BOT = `etk_${'1'.repeat(64)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('normalizeSources：businesses は空でない一覧だけ（形の違う一覧の source は捨てる）', () => {
  const ok = normalizeSources({ 'bot-a': { key_sha256: sha('a'), intents: ['status.query'], businesses: ['e-nexus'] }, 'bot-b': { key_sha256: sha('b') } });
  assert.deepEqual([ok.skipped, ok.sources.get('bot-a').businesses, ok.sources.get('bot-b').businesses], [0, ['e-nexus'], null]);
  for (const bad of [[], ['E-NEXUS'], 'e-nexus', ['x'.repeat(70)]]) assert.equal(normalizeSources({ 'bot-a': { key_sha256: sha('a'), businesses: bad } }).skipped, 1, JSON.stringify(bad));
});

test('submit_task：許されていない business は business_not_allowed（task を作らない）・許された business は受ける', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-ti-scope-'));
  const sources = { 'grok-commander': { key_sha256: sha(BOT), intents: ['status.query'], businesses: ['e-nexus'] } };
  const r = await startIntake({ channelKey: KEY, channel: 'vps-intake', sources, stateDir: path.join(root, 'state'), port: 0, clock: () => Date.parse('2026-11-13T00:00:00Z'), log: () => {} });
  const call = async (args) => {
    const res = await fetch(`http://127.0.0.1:${r.port}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${BOT}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_task', arguments: args } }) });
    const j = await res.json();
    return { isError: j.result.isError === true, data: JSON.parse(j.result.content[0].text) };
  };
  try {
    assert.deepEqual(await call({ idempotency_key: 'k-0001-abcd', business: 'e-step', intent: 'status.query' }), { isError: true, data: { error: 'business_not_allowed' } });
    assert.deepEqual(await call({ idempotency_key: 'k-0002-abcd', business: 'personal', intent: 'status.query' }), { isError: true, data: { error: 'business_not_allowed' } });
    assert.deepEqual(await call({ idempotency_key: 'k-0003-abcd', business: 'e-nexus', intent: 'mail.send' }), { isError: true, data: { error: 'intent_not_allowed' } });
    const ok = await call({ idempotency_key: 'k-0004-abcd', business: 'e-nexus', intent: 'status.query' });
    assert.deepEqual([ok.isError, ok.data.state], [false, 'received']);
  } finally {
    await new Promise((res) => { r.server.close(res); });
    rmSync(root, { recursive: true, force: true });
  }
});

test('setSourceScope：鍵の hash は変えずに intents・businesses を替える・intents は必須・無い source は拒否・同じなら false', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-ti-scope-'));
  const file = path.join(root, 'sources.json');
  writeFileSync(file, '{}');
  try {
    const key = addSource(file, 'grok-commander', ['status.query'], ['e-nexus']);
    const before = JSON.parse(readFileSync(file, 'utf8'))['grok-commander'];
    assert.deepEqual(before, { key_sha256: sha(key), intents: ['status.query'], businesses: ['e-nexus'] });
    assert.equal(setSourceScope(file, 'grok-commander', ['status.query'], ['e-nexus']), false);
    assert.equal(setSourceScope(file, 'grok-commander', ['status.query', 'task.status'], ['e-nexus']), true);
    const after = JSON.parse(readFileSync(file, 'utf8'))['grok-commander'];
    assert.deepEqual(after, { key_sha256: sha(key), intents: ['status.query', 'task.status'], businesses: ['e-nexus'] }, '鍵は同じ');
    assert.equal(setSourceScope(file, 'grok-commander', ['status.query']), true, 'businesses を省いた再実行は intents だけ替える');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))['grok-commander'].businesses, ['e-nexus'], '省いても制限を外さない（監査 F5）');
    assert.equal(setSourceScope(file, 'grok-commander', ['status.query'], null), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))['grok-commander'].businesses, undefined, '明示の null（CLI の all）だけが外す');
    assert.throws(() => setSourceScope(file, 'grok-commander', [], ['e-nexus']), /intents are required/);
    assert.throws(() => setSourceScope(file, 'nobody', ['status.query'], null), /not found/);
    assert.throws(() => setSourceScope(file, 'grok-commander', ['status.query'], ['Bad']), /invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('list_capabilities：その鍵に許された intent・business だけを添える（他の source の範囲は出さない）・道具の説明は result.hint を案内する（2026-11-16）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-ti-caps-'));
  const OTHER = `etk_${'2'.repeat(64)}`;
  const OPEN = `etk_${'3'.repeat(64)}`;
  const sources = {
    'grok-commander': { key_sha256: sha(BOT), intents: ['status.query', 'task.status'], businesses: ['e-nexus'] },
    'bot-other': { key_sha256: sha(OTHER), intents: ['secret-intent.x'], businesses: ['biz-other'] },
    'bot-open': { key_sha256: sha(OPEN) },
  };
  const r = await startIntake({ channelKey: KEY, channel: 'vps-intake', sources, stateDir: path.join(root, 'state'), port: 0, clock: () => Date.parse('2026-11-16T00:00:00Z'), log: () => {} });
  const rpc = async (bearer, method, params) => (await (await fetch(`http://127.0.0.1:${r.port}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
  try {
    const mine = (await rpc(BOT, 'tools/call', { name: 'list_capabilities', arguments: {} })).content[0].text;
    assert.ok(mine.startsWith(CAPABILITIES_TEXT));
    assert.match(mine, /Intents your key may submit: status\.query, task\.status\n/);
    assert.match(mine, /Businesses your key may use: e-nexus$/);
    assert.ok(!mine.includes('secret-intent') && !mine.includes('biz-other') && !mine.includes('bot-other'), '他の source の範囲・名前は出さない');
    assert.match(mine, /result\.hint/);
    const open = (await rpc(OPEN, 'tools/call', { name: 'list_capabilities', arguments: {} })).content[0].text;
    assert.match(open, /Intents your key may submit: \(not restricted here/);
    const tools = (await rpc(BOT, 'tools/list', {})).tools;
    assert.match(tools.find((t) => t.name === 'submit_task').inputSchema.properties.params.description, /result\.hint/);
    assert.match(tools.find((t) => t.name === 'get_task_status').description, /result\.hint/);
    assert.match(tools.find((t) => t.name === 'submit_task').description, /list_capabilities/);
    // 説明に実在の business・intent の名前を書かない（公開 repo・Bot ごとに範囲が違う）
    assert.ok(!JSON.stringify(tools).includes('e-nexus') && !JSON.stringify(tools).includes('task.status'));
  } finally {
    await new Promise((res) => { r.server.close(res); });
    rmSync(root, { recursive: true, force: true });
  }
});
