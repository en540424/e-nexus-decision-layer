/**
 * Common Decision Gateway — HTTP 入口（loopback・認証・Origin/Content-Type 境界）と MCP 入口（stdio JSON-RPC）。
 * HTTP は 127.0.0.1 の空きポートだけを使う（外部ネットワークに出ない）。Jev はキー無し。meter は memory。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { startGatewayServer, isLoopbackHost } from '../src/gateway/http-server.mjs';
import { createMcpHandler, runMcpStdio, SUPPORTED_PROTOCOL_VERSIONS, TOOLS } from '../src/gateway/mcp-server.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';

const makeGateway = () => createGateway({ engine: createDecisionLayerEngine({ env: {}, meter: createMemoryMeter() }), env: {} });
const decisionBody = {
  decision_type: 'paid-generation-gate', application_id: 'hermes', project_id: 'en-generate-hub',
  input: { asset_kind: 'subtitle', purpose: 'jp caption' },
};

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function withServer(opts, fn) {
  const server = await startGatewayServer({ gateway: makeGateway(), port: 0, ...opts });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const JSON_H = { 'content-type': 'application/json' };

test('HTTP: /health and /version are minimal (no stats, no provider detail) and unauthenticated', async () => {
  await withServer({ token: 'tok' }, async (port) => {
    const h = await call(port, { path: '/health' });
    assert.equal(h.status, 200);
    assert.deepEqual(Object.keys(h.json).sort(), ['contract_version', 'engine', 'environment', 'status']);
    const v = await call(port, { path: '/version' });
    assert.equal(v.json.contract_version, '1');
  });
});

test('HTTP: POST /v1/decisions returns the envelope (200 even when tier=human; status != decision result)', async () => {
  await withServer({}, async (port) => {
    const ok = await call(port, { method: 'POST', path: '/v1/decisions', headers: JSON_H, body: decisionBody });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.gateway.via, 'http');
    assert.equal(ok.json.decision.outcome.recommended_route, 'remotion');
    const human = await call(port, { method: 'POST', path: '/v1/decisions', headers: JSON_H, body: { ...decisionBody, input: { asset_kind: 'scene', purpose: 'x', style: 'photoreal' } } });
    assert.equal(human.status, 200);
    assert.equal(human.json.decision.tier, 'human');
  });
});

test('HTTP: invalid JSON / unknown decision_type -> 400 with failure policy', async () => {
  await withServer({}, async (port) => {
    const bad = await call(port, { method: 'POST', path: '/v1/decisions', headers: JSON_H, body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.failure.human_required, true);
    const unk = await call(port, { method: 'POST', path: '/v1/decisions', headers: JSON_H, body: { ...decisionBody, decision_type: 'x' } });
    assert.equal(unk.status, 400);
    assert.equal(unk.json.error.code, 'UNKNOWN_DECISION_TYPE');
  });
});

test('HTTP: bearer token required when configured; wrong / missing token -> 401', async () => {
  await withServer({ token: 'right-token' }, async (port) => {
    assert.equal((await call(port, { method: 'POST', path: '/v1/decisions', headers: JSON_H, body: decisionBody })).status, 401);
    assert.equal((await call(port, { method: 'POST', path: '/v1/decisions', headers: { ...JSON_H, authorization: 'Bearer wrong' }, body: decisionBody })).status, 401);
    assert.equal((await call(port, { path: '/v1/health' })).status, 401);
    const ok = await call(port, { method: 'POST', path: '/v1/decisions', headers: { ...JSON_H, authorization: 'Bearer right-token' }, body: decisionBody });
    assert.equal(ok.status, 200);
    const h = await call(port, { path: '/v1/health', headers: { authorization: 'Bearer right-token' } });
    assert.equal(h.status, 200);
    assert.equal(JSON.stringify(h.json).includes('right-token'), false);
    assert.equal(h.json.stats.requests, 1);
    const t = await call(port, { path: '/v1/decision-types', headers: { authorization: 'Bearer right-token' } });
    assert.ok(t.json.decision_types.length >= 4);
  });
});

test('HTTP: browser-originated requests are refused (Origin -> 403, non-JSON content type -> 415)', async () => {
  await withServer({}, async (port) => {
    const o = await call(port, { method: 'POST', path: '/v1/decisions', headers: { ...JSON_H, origin: 'https://evil.example' }, body: decisionBody });
    assert.equal(o.status, 403);
    const ct = await call(port, { method: 'POST', path: '/v1/decisions', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(decisionBody) });
    assert.equal(ct.status, 415);
    assert.equal((await call(port, { path: '/v1/unknown' })).status, 404);
  });
});

test('HTTP: body size cap -> 413', async () => {
  await withServer({ maxBodyBytes: 256 }, async (port) => {
    const big = { ...decisionBody, input: { asset_kind: 'other', purpose: 'x'.repeat(2000) } };
    const r = await call(port, { method: 'POST', path: '/v1/decisions', headers: JSON_H, body: big }).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
  });
});

test('HTTP: refuses to bind a non-loopback host without a token (fail-closed)', async () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.throws(() => startGatewayServer({ gateway: makeGateway(), host: '0.0.0.0', port: 0 }), /non-loopback/);
});

test('MCP: initialize negotiates a supported protocol version and declares tools', async () => {
  const handle = createMcpHandler({ gateway: makeGateway() });
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.ok(r.result.capabilities.tools);
  const r2 = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1900-01-01' } });
  assert.equal(r2.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const d = await handle({ jsonrpc: '2.0', id: 3, method: 'server/discover', params: {} });
  assert.equal(d.error.code, -32601); // modern client は legacy と判定して initialize へ fallback する
});

test('MCP: tools/list exposes engine-neutral tool names; decide calls the Gateway with via=mcp', async () => {
  const handle = createMcpHandler({ gateway: makeGateway() });
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['enexus_decide', 'enexus_decision_types', 'enexus_gateway_health']);
  for (const t of TOOLS) assert.equal(/jev/i.test(t.name), false);
  assert.match(TOOLS[0].description, /NEVER approves/);

  const r = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'enexus_decide', arguments: { ...decisionBody, application_id: 'cursor' } } });
  assert.equal(r.result.isError, false);
  assert.equal(r.result.structuredContent.ok, true);
  assert.equal(r.result.structuredContent.gateway.via, 'mcp');
  assert.equal(JSON.parse(r.result.content[0].text).request_id, r.result.structuredContent.request_id);

  const bad = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'enexus_decide', arguments: { decision_type: 'x' } } });
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.structuredContent.failure.human_required, true);

  const unknown = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknown.error.code, -32602);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
});

test('MCP stdio: newline-delimited JSON-RPC in/out; parse errors answered; stdout carries protocol only', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (c) => lines.push(...c.toString('utf8').split('\n').filter(Boolean)));
  const rl = runMcpStdio({ gateway: makeGateway(), input, output, log: () => {} });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write('not json\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'enexus_decide', arguments: decisionBody } })}\n`);
  await new Promise((r) => setTimeout(r, 100));
  rl.close();
  const msgs = lines.map((l) => JSON.parse(l));
  assert.equal(msgs.length, 3);
  assert.equal(msgs.find((m) => m.id === 1).result.protocolVersion, '2025-11-25');
  assert.equal(msgs.find((m) => m.id === null).error.code, -32700);
  assert.equal(msgs.find((m) => m.id === 2).result.structuredContent.ok, true);
});
