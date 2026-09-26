/**
 * Runtime environment（2026-09-26・Environment Isolation。Vault 技術スタック正本 §3-8 / Decision Layer 正本 §18-7 / docs/gateway.md §12）。
 * ネットワーク無し・キー無し・memory meter（usage.jsonl に書かない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { startGatewayServer } from '../src/gateway/http-server.mjs';
import { createMemoryMeter, defaultUsagePath, USAGE_FIELDS } from '../src/usage/metering.mjs';
import { resolveRuntimeEnvironment, RUNTIME_ENVIRONMENTS } from '../src/core/environment.mjs';
import { ROOT } from '../src/core/paths.mjs';
import { request as httpRequest } from 'node:http';

const NO_NET = {};

function capturingGateway({ env = NO_NET, engineMode = 'production', ...rest } = {}) {
  const meter = createMemoryMeter();
  const engine = createDecisionLayerEngine({ env, mode: engineMode, meter });
  const seen = [];
  const wrapped = { ...engine, decide: (r) => { seen.push(structuredClone(r)); return engine.decide(r); } };
  return { gateway: createGateway({ engine: wrapped, env, ...rest }), meter, seen };
}

const input = { asset_kind: 'subtitle', purpose: 'jp caption' };
const req = (extra = {}) => ({ decision_type: 'paid-generation-gate', application_id: 'claude-code', project_id: 'en-generate-hub', input: { ...input }, ...extra });

test('resolveRuntimeEnvironment: unset / empty = dev; staging / production accepted; anything else is refused (no guessing)', () => {
  assert.deepEqual(RUNTIME_ENVIRONMENTS, ['dev', 'staging', 'production']);
  assert.equal(resolveRuntimeEnvironment({}), 'dev');
  assert.equal(resolveRuntimeEnvironment({ EDL_ENVIRONMENT: '' }), 'dev');
  assert.equal(resolveRuntimeEnvironment({ EDL_ENVIRONMENT: 'staging' }), 'staging');
  assert.equal(resolveRuntimeEnvironment({ EDL_ENVIRONMENT: 'production' }), 'production');
  for (const bad of ['prod', 'PRODUCTION', 'personal', 'test']) {
    assert.throws(() => resolveRuntimeEnvironment({ EDL_ENVIRONMENT: bad }), /not a runtime environment/);
  }
  assert.throws(() => capturingGateway({ env: { EDL_ENVIRONMENT: 'prod' } }), /not a runtime environment/, 'invalid config refuses to start');
});

test('environment is decided by the runtime: a consumer-written request.environment is overwritten (like via) and reaches usage', async () => {
  const { gateway, meter, seen } = capturingGateway();
  const env = await gateway.decide(req({ environment: 'production' }), { via: 'cli' });
  assert.equal(env.ok, true);
  assert.equal(env.gateway.environment, 'dev');
  assert.equal(seen[0].environment, 'dev', 'engine sees the runtime value, not the consumer value');
  const [row] = meter.readAll();
  assert.equal(row.environment, 'dev');
  assert.ok(USAGE_FIELDS.includes('environment'));
});

test('expected_environment: match proceeds; the envelope field never reaches the engine and input is untouched', async () => {
  const { gateway, seen } = capturingGateway();
  const env = await gateway.decide(req({ expected_environment: 'dev' }), { via: 'sdk' });
  assert.equal(env.ok, true);
  assert.equal('expected_environment' in seen[0], false);
  assert.deepEqual(seen[0].input, input, 'input is passed unchanged (environment lives at the request top level, not in input)');
});

test('expected_environment mismatch fails closed (ENVIRONMENT_MISMATCH, engine not called, nothing metered, never proceeds automatically)', async () => {
  const { gateway, meter, seen } = capturingGateway();
  const env = await gateway.decide(req({ expected_environment: 'production' }), { via: 'http' });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'ENVIRONMENT_MISMATCH');
  assert.equal(env.error.kind, 'environment_mismatch');
  assert.equal(env.error.retryable, false);
  assert.equal(env.failure.proceed_automatically, false);
  assert.equal(env.failure.human_required, true);
  assert.equal(env.gateway.environment, 'dev');
  assert.equal(seen.length, 0);
  assert.equal(meter.readAll().length, 0);
  const prodGw = capturingGateway({ env: { EDL_ENVIRONMENT: 'production' } });
  const env2 = await prodGw.gateway.decide(req({ expected_environment: 'dev' }), { via: 'http' });
  assert.equal(env2.error.code, 'ENVIRONMENT_MISMATCH', 'an experiment aimed at dev does not run on production either');
});

test('expected_environment with an unknown value is an invalid envelope', async () => {
  const { gateway } = capturingGateway();
  const env = await gateway.decide(req({ expected_environment: 'prod' }), { via: 'sdk' });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_ENVELOPE');
});

test('verification (mock-jev) is dev-only: staging / production runtimes refuse it; production engine mode is fine there', async () => {
  for (const e of ['staging', 'production']) {
    assert.throws(() => capturingGateway({ env: { EDL_ENVIRONMENT: e }, engineMode: 'verification' }), /verification \/ mock is dev-only/);
  }
  assert.doesNotThrow(() => capturingGateway({ engineMode: 'verification' }));
  const { gateway } = capturingGateway({ env: { EDL_ENVIRONMENT: 'production' } });
  assert.equal(gateway.environment, 'production');
  assert.equal(gateway.version().environment, 'production');
  assert.equal(gateway.health().environment, 'production');
  assert.equal(gateway.version().engine.mode, 'production', 'engine mode is a separate axis from the runtime environment');
});

test('usage is separated per environment by default; dev keeps the historical path; EDL_USAGE_PATH still wins', () => {
  assert.equal(defaultUsagePath({}), join(ROOT, 'data', 'usage', 'usage.jsonl'));
  assert.equal(defaultUsagePath({ EDL_ENVIRONMENT: 'dev' }), join(ROOT, 'data', 'usage', 'usage.jsonl'));
  assert.equal(defaultUsagePath({ EDL_ENVIRONMENT: 'staging' }), join(ROOT, 'data', 'usage', 'staging', 'usage.jsonl'));
  assert.equal(defaultUsagePath({ EDL_ENVIRONMENT: 'production' }), join(ROOT, 'data', 'usage', 'production', 'usage.jsonl'));
  assert.equal(defaultUsagePath({ EDL_ENVIRONMENT: 'production', EDL_USAGE_PATH: 'tmp/u.jsonl' }), join(ROOT, 'tmp', 'u.jsonl'));
});

test('HTTP: ENVIRONMENT_MISMATCH maps to 409 (not a Decision result, not 200)', async () => {
  const { gateway } = capturingGateway();
  const server = await startGatewayServer({ gateway, host: '127.0.0.1', port: 0 });
  try {
    const { port } = server.address();
    const body = JSON.stringify(req({ expected_environment: 'staging' }));
    const res = await new Promise((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/decisions', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => resolve({ status: resp.statusCode, json: JSON.parse(data) }));
      });
      r.on('error', reject);
      r.end(body);
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'ENVIRONMENT_MISMATCH');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
