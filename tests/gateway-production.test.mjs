/**
 * Production-capable HTTP Gateway（2026-09-29・Full Autonomous Build FB-05）。deploy・token 発行・常駐登録は Human-only で、
 * ここはそれが無くても検証できる部分：起動条件（環境別）・rate limit・access log・/ready・graceful shutdown・HTTP transport（Node / Python）・
 * service 定義生成・env file・pinned release・smoke。すべて 127.0.0.1 の空きポートだけを使い、外部ネットワーク・実 Jev・usage.jsonl に触れない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { startGatewayServer, createRateLimiter } from '../src/gateway/http-server.mjs';
import { resolveServeConfig, MIN_TOKEN_LENGTH } from '../src/gateway/serve-config.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { ROOT } from '../src/core/paths.mjs';
import { createHttpTransport, checkBaseUrl, verifyEnvelope } from '../consumer-kit/node/http-transport.mjs';
import { validateServiceArgs, renderService } from '../scripts/gateway-service.mjs';
import { parseEnvFile, loadEnvFile } from '../scripts/lib/env-file.mjs';
import { previousRelease, buildRelease } from '../scripts/gateway-release.mjs';
import { runSmoke, SMOKE_REQUEST } from '../scripts/gateway-smoke.mjs';
import { parseArgs as parseRunArgs } from '../scripts/run-gateway.mjs';

const TOKEN = 'test-gateway-token-0123456789abcdef-xyz';
const RELEASE = { commit: 'a'.repeat(40), version: '0.1.0' };
const SUBTITLE = { ...SMOKE_REQUEST };

function devGateway(engine) {
  return createGateway({ engine: engine ?? createDecisionLayerEngine({ env: {}, meter: createMemoryMeter() }), env: {} });
}

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ─── 起動条件 ─────────────────────────────────────────

test('serve config: dev loopback needs no token; non-loopback needs a token', () => {
  assert.equal(resolveServeConfig({ env: {}, release: null }).ok, true);
  const r = resolveServeConfig({ env: {}, host: '0.0.0.0', release: null });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /EDL_GATEWAY_TOKEN/);
  assert.equal(resolveServeConfig({ env: {}, release: null }).config.rateLimitPerMin, 0, 'dev: rate limit off by default');
});

test('serve config: staging / production refuse to start without a long token, release.json and a matching EDL_EXPECTED_RELEASE', () => {
  for (const EDL_ENVIRONMENT of ['staging', 'production']) {
    const base = { EDL_ENVIRONMENT, EDL_GATEWAY_TOKEN: TOKEN, EDL_EXPECTED_RELEASE: RELEASE.commit };
    assert.equal(resolveServeConfig({ env: base, release: RELEASE }).ok, true, EDL_ENVIRONMENT);
    assert.equal(resolveServeConfig({ env: base, release: RELEASE }).config.rateLimitPerMin, 600);
    assert.equal(resolveServeConfig({ env: { ...base, EDL_GATEWAY_TOKEN: undefined }, release: RELEASE }).ok, false, 'no token even on loopback');
    assert.equal(resolveServeConfig({ env: { ...base, EDL_GATEWAY_TOKEN: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }, release: RELEASE }).ok, false, 'short token');
    assert.equal(resolveServeConfig({ env: base, release: null }).ok, false, 'no release.json');
    assert.equal(resolveServeConfig({ env: { ...base, EDL_EXPECTED_RELEASE: undefined }, release: RELEASE }).ok, false, 'not pinned');
    assert.equal(resolveServeConfig({ env: { ...base, EDL_EXPECTED_RELEASE: 'b'.repeat(40) }, release: RELEASE }).ok, false, 'different version');
    const errs = resolveServeConfig({ env: { ...base, EDL_EXPECTED_RELEASE: 'b'.repeat(40) }, release: RELEASE }).errors.join(' ');
    assert.ok(!errs.includes(TOKEN), 'token value never appears in errors');
  }
  assert.equal(resolveServeConfig({ env: { EDL_ENVIRONMENT: 'prod' }, release: null }).ok, false, 'unknown environment is not guessed');
  assert.equal(resolveServeConfig({ env: { EDL_GATEWAY_RATE_LIMIT_PER_MIN: 'many' }, release: null }).ok, false);
});

// ─── HTTP の運用機能 ────────────────────────────────────

test('HTTP: /ready, /version carries the pinned release, access log has no token/body/outcome', async () => {
  const lines = [];
  const server = await startGatewayServer({ gateway: devGateway(), port: 0, token: TOKEN, release: RELEASE, accessLog: (l) => lines.push(l) });
  const port = server.address().port;
  try {
    assert.deepEqual((await call(port, { path: '/ready' })).json, { status: 'ready' });
    assert.equal((await call(port, { path: '/version' })).json.release.commit, RELEASE.commit);
    const d = await call(port, { method: 'POST', path: '/v1/decisions?x=secret-query', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: SUBTITLE });
    assert.equal(d.status, 200);
    const text = JSON.stringify(lines);
    for (const s of [TOKEN, 'smoke: rules-only', 'secret-query', 'remotion', '127.0.0.1']) assert.ok(!text.includes(s), `access log leaked ${s}`);
    const decisionLine = lines.find((l) => l.path === '/v1/decisions');
    assert.equal(decisionLine.status, 200);
    assert.match(decisionLine.request_id, /^req_/);
    assert.deepEqual(Object.keys(decisionLine).sort(), ['component', 'environment', 'error_code', 'latency_ms', 'method', 'path', 'request_id', 'status', 'ts']);
    assert.equal((await call(port, { path: '/nope?token=abc' })).status, 404);
    assert.equal(lines.at(-1).path, 'other', 'unknown paths are not recorded verbatim');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP: rate limit returns 429 with Retry-After once the per-minute budget is spent (/v1 only)', async () => {
  const server = await startGatewayServer({ gateway: devGateway(), port: 0, rateLimitPerMin: 2 });
  const port = server.address().port;
  try {
    assert.equal((await call(port, { path: '/v1/health' })).status, 200);
    assert.equal((await call(port, { path: '/v1/health' })).status, 200);
    const limited = await call(port, { path: '/v1/health' });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await call(port, { path: '/health' })).status, 200, 'health is not rate limited');
  } finally {
    await new Promise((r) => server.close(r));
  }
  let t = 0;
  const lim = createRateLimiter(1, () => t);
  assert.equal(lim.take().ok, true);
  assert.equal(lim.take().ok, false);
  t = 60_001;
  assert.equal(lim.take().ok, true, 'new window');
});

test('HTTP: graceful shutdown stops accepting, aborts the in-flight decision (SHUTDOWN) and resolves without forcing', async () => {
  let started;
  const startedP = new Promise((r) => { started = r; });
  const hanging = {
    id: 'hang', version: '0', mode: 'production', health: () => ({}),
    decide: (_req, { signal } = {}) => new Promise((_, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'DecisionAbortedError' })), { once: true });
    }),
  };
  const gateway = createGateway({ engine: hanging, env: {}, timeoutMs: 60_000 });
  const server = await startGatewayServer({ gateway, port: 0 });
  const port = server.address().port;
  const inflight = call(port, { method: 'POST', path: '/v1/decisions', headers: { 'content-type': 'application/json' }, body: SUBTITLE });
  await startedP;
  const stopping = server.shutdown({ timeoutMs: 5000 });
  const res = await inflight;
  assert.equal(res.json.ok, false, 'no decision is produced during shutdown');
  assert.equal(res.json.failure.proceed_automatically, false);
  const { forced } = await stopping;
  assert.equal(forced, false);
  await assert.rejects(() => call(port, { path: '/ready' }), 'no longer accepting connections');
});

// ─── consumer-kit HTTP transport ───────────────────────

test('Node HTTP transport: real local Gateway (dev loopback) → verified envelope; https required outside dev loopback', async () => {
  const server = await startGatewayServer({ gateway: devGateway(), port: 0, token: TOKEN });
  const port = server.address().port;
  try {
    const t = createHttpTransport({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, environment: 'dev' });
    const env = await t.call({ ...SUBTITLE });
    assert.equal(env.ok, true);
    assert.equal(env.decision.resolved_by, 'rules');
    const bad = await createHttpTransport({ baseUrl: `http://127.0.0.1:${port}`, token: 'wrong-token', environment: 'dev' }).call({ ...SUBTITLE });
    assert.deepEqual([bad.ok, bad.error.code, bad.failure.policy], [false, 'GATEWAY_UNAUTHORIZED', 'human-required']);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(checkBaseUrl('http://127.0.0.1:1', 'production').code, 'GATEWAY_URL_INSECURE');
  assert.equal(checkBaseUrl('http://gateway.example:8787', 'dev').code, 'GATEWAY_URL_INSECURE');
  assert.equal(checkBaseUrl('https://gateway.example', 'production').ok, true);
});

test('Node HTTP transport: environment mismatch, rate limit, timeout, non-JSON and missing token fail closed (never proceed)', async () => {
  const okEnvelope = (environment) => ({ contract_version: '1', ok: true, request_id: 'r', correlation_id: null, decision: { tier: 'auto' }, gateway: { environment } });
  const mk = (impl, environment = 'production', token = TOKEN) => createHttpTransport({ baseUrl: 'https://gw.example', token, environment, fetchImpl: impl, timeoutMs: 30 });
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const cases = [
    [mk(json(200, okEnvelope('staging'))), 'ENVIRONMENT_MISMATCH'],
    [mk(json(429, { error: 'RATE_LIMITED' })), 'GATEWAY_RATE_LIMITED'],
    [mk(async () => new Response('<html>', { status: 502 })), 'GATEWAY_BAD_RESPONSE'],
    [mk((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))), 'GATEWAY_TIMEOUT'],
    [mk(async () => { throw new TypeError('fetch failed'); }), 'GATEWAY_UNREACHABLE'],
    [mk(json(200, okEnvelope('production')), 'production', ''), 'GATEWAY_TOKEN_MISSING'],
    [mk(json(200, okEnvelope('production')), 'prod'), 'ENVIRONMENT_UNKNOWN'],
  ];
  for (const [t, code] of cases) {
    const e = await t.call({ ...SUBTITLE });
    assert.equal(e.ok, false, code);
    assert.equal(e.error.code, code);
    assert.equal(e.failure.proceed_automatically, false);
  }
  const busyEnvelope = { contract_version: '1', ok: false, request_id: 'r', correlation_id: null, decision: null, error: { code: 'GATEWAY_BUSY', kind: 'busy', retryable: true }, failure: { policy: 'human-required' }, gateway: { environment: 'production' } };
  assert.equal((await mk(json(429, busyEnvelope)).call({ ...SUBTITLE })).error.code, 'GATEWAY_BUSY', "the Gateway's own envelope passes through");
  assert.equal(verifyEnvelope(okEnvelope('production'), 'production').ok, true);
});

test('Python HTTP transport: same contract against the real local Gateway (skipped when python is unavailable)', async (t) => {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('python not available'); return; }
  const server = await startGatewayServer({ gateway: devGateway(), port: 0, token: TOKEN });
  const port = server.address().port;
  try {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'consumer-kit', 'python'))})`,
      'from enexus_http_transport import HttpTransport',
      `req = ${JSON.stringify(SUBTITLE)}`,
      `ok = HttpTransport("http://127.0.0.1:${port}", ${JSON.stringify(TOKEN)}, "dev").call(req)`,
      `bad = HttpTransport("http://127.0.0.1:${port}", "wrong", "dev").call(req)`,
      `insecure = HttpTransport("http://127.0.0.1:${port}", ${JSON.stringify(TOKEN)}, "production").call(req)`,
      'print(json.dumps({"ok": ok["ok"], "by": ok["decision"]["resolved_by"], "bad": bad["error"]["code"], "insecure": insecure["error"]["code"], "repr": repr(HttpTransport("https://x", "s3cr3t", "dev"))}))',
    ].join('\n');
    const { spawn } = await import('node:child_process');
    const out = await new Promise((resolve) => {
      const child = spawn('python', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    const parsed = JSON.parse(out);
    assert.deepEqual({ ...parsed, repr: undefined }, { ok: true, by: 'rules', bad: 'GATEWAY_UNAUTHORIZED', insecure: 'GATEWAY_URL_INSECURE', repr: undefined });
    assert.ok(!parsed.repr.includes('s3cr3t'), 'repr hides the token');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ─── 常駐・release・smoke ───────────────────────────────

test('service definitions: systemd / launchd / windows run run-gateway.mjs with the env file, contain no secrets, and refuse unsafe input', () => {
  const a = { target: 'systemd', environment: 'production', dir: '/opt/e-nexus-decision-layer', envFile: '/etc/e-nexus/gateway-production.env', host: '127.0.0.1', port: 8787, user: 'edl' };
  assert.deepEqual(validateServiceArgs(a), []);
  const sd = renderService(a);
  assert.match(sd.content, /ExecStart=\/usr\/bin\/env node scripts\/run-gateway\.mjs --env-file \/etc\/e-nexus\/gateway-production\.env --host 127\.0\.0\.1 --port 8787/);
  assert.match(sd.content, /KillSignal=SIGTERM/);
  assert.match(sd.content, /User=edl/);
  assert.ok(sd.content.indexOf('StartLimitBurst=5') < sd.content.indexOf('[Service]') && sd.content.includes('StartLimitIntervalSec=300\nStartLimitBurst=5\n'), 'StartLimit* live in [Unit] (systemd ignores them in [Service])');
  assert.match(sd.content, /RestartPreventExitStatus=2/, 'a refusal to start (exit 2) is not restarted forever');
  assert.ok(!/MemoryMax=/.test(sd.content), 'no memory cap unless asked');
  assert.match(renderService({ ...a, memoryMax: '256M' }).content, /MemoryMax=256M/);
  assert.ok(validateServiceArgs({ ...a, memoryMax: '256MB; rm' }).some((e) => e.includes('--memory-max')));
  const ld = renderService({ ...a, target: 'launchd', node: '/opt/homebrew/bin/node' });
  assert.match(ld.content, /<string>scripts\/run-gateway\.mjs<\/string>/);
  assert.match(ld.content, /<key>StandardErrorPath<\/key>/);
  assert.ok(!/<key>PATH<\/key>/.test(ld.content), 'no guessed PATH when node is given as an absolute path');
  const ldPath = renderService({ ...a, target: 'launchd', path: '/opt/homebrew/bin:/usr/bin:/bin' });
  assert.match(ldPath.content, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/, 'PATH only from --path（実機で確定）');
  assert.ok(validateServiceArgs({ ...a, target: 'launchd' }).some((e) => e.includes('--node')), 'launchd without --node / --path is refused (node would not be found)');
  assert.ok(validateServiceArgs({ ...a, target: 'launchd', path: 'relative:/usr/bin' }).length > 0);
  assert.ok(validateServiceArgs({ ...a, target: 'launchd', path: '/usr/bin;rm -rf /' }).length > 0);
  const win = renderService({ ...a, target: 'windows', dir: 'C:\\edl', envFile: 'C:\\edl-env\\gateway-staging.env', environment: 'staging', node: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.match(win.content, /Register-ScheduledTask/);
  for (const r of [sd, ld, win]) assert.ok(!/TOKEN=|KEY=|Bearer/.test(r.content), 'no secrets in definitions');
  assert.ok(validateServiceArgs({ ...a, environment: 'dev' }).length > 0, 'dev is not installed as a service');
  assert.ok(validateServiceArgs({ ...a, dir: 'relative/path' }).length > 0);
  assert.ok(validateServiceArgs({ ...a, envFile: '/etc/x.env; rm -rf /' }).length > 0);
  assert.ok(validateServiceArgs({ ...a, host: 'evil.example' }).length > 0);
});

test('env file: NAME=value only, credential: references resolve from the OS store, errors never include values', async () => {
  const text = '# comment\nEDL_ENVIRONMENT=staging\nEDL_GATEWAY_TOKEN=credential:E-NEXUS/edl/gateway-token-staging\n\nJEV_API_KEY=credential:E-NEXUS/edl/jev-key\n';
  const p = parseEnvFile(text);
  assert.deepEqual(p.values, { EDL_ENVIRONMENT: 'staging' });
  assert.deepEqual(p.credentials, { EDL_GATEWAY_TOKEN: 'E-NEXUS/edl/gateway-token-staging', JEV_API_KEY: 'E-NEXUS/edl/jev-key' });
  assert.deepEqual(parseEnvFile('lower=x\nA=1\nA=2\nB=credential:other/place').errors.length, 3);
  const env = await loadEnvFile('x', { read: () => text, readCredentialImpl: async (t) => `value-of-${t.split('/').pop()}` });
  assert.equal(env.EDL_GATEWAY_TOKEN, 'value-of-gateway-token-staging');
  await assert.rejects(() => loadEnvFile('x', { read: () => 'S=super-secret-value\nT=credential:E-NEXUS/edl/missing', readCredentialImpl: async () => null }), (e) => /T → credential/.test(e.message) && !e.message.includes('super-secret-value'));
  assert.deepEqual(parseRunArgs(['--env-file', '/etc/x.env', '--port', '9000']), { envFile: '/etc/x.env', rest: ['--port', '9000'] });
  assert.throws(() => parseRunArgs(['--port', '1']), /--env-file/);
});

test('pinned release: stamp needs a full sha; rollback target is the previous different commit', () => {
  assert.throws(() => buildRelease({ commit: 'abc', version: '1' }));
  const r = buildRelease({ commit: 'c'.repeat(40), version: '0.1.0', now: new Date('2026-09-29T00:00:00Z') });
  assert.deepEqual(r, { commit: 'c'.repeat(40), version: '0.1.0', stamped_at: '2026-09-29T00:00:00.000Z' });
  const log = [{ commit: 'a'.repeat(40) }, { commit: 'b'.repeat(40) }, { commit: 'c'.repeat(40) }, { commit: 'c'.repeat(40) }].map((x) => JSON.stringify(x));
  assert.equal(previousRelease(log, 'c'.repeat(40)).commit, 'b'.repeat(40));
  assert.equal(previousRelease(['not json'], 'c'.repeat(40)), null);
});

test('smoke: passes against a correctly configured Gateway (rules-only decision, no engine network) and fails on a wrong pin', async () => {
  const server = await startGatewayServer({ gateway: devGateway(), port: 0, token: TOKEN, release: RELEASE });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await runSmoke({ url, token: TOKEN, environment: 'dev', release: RELEASE.commit });
    assert.equal(ok.pass, true, JSON.stringify(ok.results.filter((x) => !x.pass)));
    const wrong = await runSmoke({ url, token: TOKEN, environment: 'dev', release: 'b'.repeat(40) });
    assert.equal(wrong.pass, false);
    assert.equal(wrong.results.find((x) => x.name === 'release pinned').pass, false);
    const wrongEnv = await runSmoke({ url, token: TOKEN, environment: 'staging' });
    assert.equal(wrongEnv.pass, false, 'environment mismatch fails the smoke');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
