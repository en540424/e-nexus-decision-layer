/**
 * Consumer Integration Kit（consumer-kit/）— local CLI transport の conformance。
 * - 言語非依存の cases（consumer-kit/conformance/transport-cases.json）を Node reference transport で全件通す
 * - 1 consumer 専用の helper にしないため、env allowlist は 3 consumer 相当の profile で確認する
 * - 実 Gateway CLI との往復（ネットワーク無し・usage は tmp）で、kit の前提（envelope 形・environment=dev）が現物と一致することを確認
 * - kit は Decision Engine 固有の名前（Jev の env 名・endpoint）を持たない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/core/paths.mjs';
import {
  createCliTransport, buildChildEnv, loadEngineEnvSpec, verifyEnvelope, resolveLocalTransportEnvironment, KIT_VERSION,
} from '../consumer-kit/node/cli-transport.mjs';

const KIT = join(ROOT, 'consumer-kit');
const FAKE = join(KIT, 'conformance', 'fake-gateway');
const CASES = JSON.parse(readFileSync(join(KIT, 'conformance', 'transport-cases.json'), 'utf8'));
const BASE_ENV = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EDL_HOME: FAKE };
const REQUEST = { decision_type: 'paid-generation-gate', application_id: 'conformance', project_id: 'openmontage', correlation_id: 'c-1', input: { asset_kind: 'subtitle', purpose: 'P-SENTINEL' } };

function assertFailClosed(env, expect) {
  assert.equal(env.ok, false);
  assert.equal(env.decision, null);
  assert.equal(env.error.code, expect.error_code);
  if (expect.failure_policy) assert.equal(env.failure.policy, expect.failure_policy);
  assert.equal(env.failure.proceed_automatically, false);
}

test('kit version and cases version agree', () => {
  assert.equal(CASES.kit_version, KIT_VERSION);
  assert.equal(CASES.contract_version, '1');
});

for (const c of CASES.gateway_cases) {
  test(`conformance/${c.id}: ${c.description}`, async () => {
    const t = createCliTransport({ environment: 'dev' });
    const env = await t.call(REQUEST, { env: { ...BASE_ENV, EDL_FAKE_CASE: c.id }, timeoutMs: c.test_timeout_ms ?? 10000 });
    if (c.expect.ok) {
      assert.equal(env.ok, true);
      assert.equal(env.request_id, c.expect.request_id);
      assert.equal(env.gateway.environment, 'dev');
    } else {
      assertFailClosed(env, c.expect);
    }
  });
}

test('conformance/echo: request goes over stdin (not argv) with expected_environment=dev and contract v1', async () => {
  const t = createCliTransport({ environment: 'dev' });
  const env = await t.call({ ...REQUEST, expected_environment: 'production' }, { env: { ...BASE_ENV, EDL_FAKE_CASE: 'echo' } });
  assert.equal(env.ok, true);
  assert.deepEqual(env.echo.argv, CASES.echo_case.expect.argv);
  assert.equal(JSON.stringify(env.echo.argv).includes('P-SENTINEL'), false);
  assert.equal(env.echo.request.input.purpose, 'P-SENTINEL');
  // consumer が別の値を混ぜても transport の環境で上書きされる
  assert.equal(env.echo.request.expected_environment, CASES.echo_case.expect.request_expected_environment);
  assert.equal(env.echo.request.contract_version, CASES.echo_case.expect.request_contract_version);
});

for (const p of CASES.env_forwarding.profiles) {
  test(`env allowlist (${p.consumer}): only OS + EDL_* + manifest names, never the consumer's own secrets`, async () => {
    const parent = Object.fromEntries(CASES.env_forwarding.parent_env.map((k) => [k, `v-${k}`]));
    const neverForward = new RegExp(p.never_forward);
    const direct = buildChildEnv(parent, loadEngineEnvSpec(FAKE), neverForward);
    assert.deepEqual(Object.keys(direct).sort(), [...p.expect_forwarded].sort());
    // 実 subprocess でも同じ（PATH 等の OS 変数は実値を使う）
    const t = createCliTransport({ environment: 'dev', neverForward });
    const env = await t.call(REQUEST, { env: { ...parent, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EDL_HOME: FAKE, EDL_FAKE_CASE: 'echo' } });
    for (const k of CASES.env_forwarding.parent_env) {
      assert.equal(env.echo.env_keys.includes(k), p.expect_forwarded.includes(k), k);
    }
  });
}

test('env allowlist: unreadable manifest forwards EDL_* only (engine falls back to human)', () => {
  const parent = Object.fromEntries(CASES.env_forwarding.parent_env.map((k) => [k, 'v']));
  const spec = loadEngineEnvSpec(join(ROOT, 'no-such-dir'));
  assert.deepEqual(spec, { prefixes: [], names: [] });
  assert.deepEqual(Object.keys(buildChildEnv(parent, spec)).sort(), ['EDL_ALLOW_NETWORK', 'EDL_FAKE_CASE', 'PATH']);
});

for (const c of CASES.configuration_cases) {
  test(`configuration/${c.id}: fail-closed without calling the Gateway`, async () => {
    let spawned = false;
    const t = createCliTransport({ environment: c.environment });
    const edlHome = c.edl_home === '<nonexistent>' ? join(ROOT, 'no-such-dir') : FAKE;
    const env = await t.call(REQUEST, { env: { ...BASE_ENV, EDL_HOME: edlHome }, spawnImpl: () => { spawned = true; throw new Error('must not spawn'); } });
    assertFailClosed(env, c.expect);
    assert.equal(spawned, c.expect.gateway_called);
  });
}

test('gateway error codes named in the cases exist in the real Gateway (consumer-local codes are the known set)', () => {
  const gatewaySrc = readFileSync(join(ROOT, 'src', 'gateway', 'gateway.mjs'), 'utf8');
  const consumerLocal = new Set(['GATEWAY_BAD_RESPONSE', 'GATEWAY_NOT_FOUND', 'GATEWAY_SPAWN_FAILED', 'GATEWAY_TIMEOUT', 'ENVIRONMENT_MISMATCH', 'ENVIRONMENT_UNKNOWN', 'ENVIRONMENT_NOT_SUPPORTED_BY_TRANSPORT']);
  for (const c of [...CASES.gateway_cases, ...CASES.configuration_cases]) {
    const code = c.expect.error_code;
    if (!code) continue;
    assert.ok(consumerLocal.has(code) || gatewaySrc.includes(`${code}:`), code);
  }
});

test('verifyEnvelope and resolveLocalTransportEnvironment are pure and fail closed', () => {
  assert.equal(verifyEnvelope(null, 'dev', { correlation_id: 'x' }).correlation_id, 'x');
  assert.equal(verifyEnvelope({ contract_version: '1', ok: true, decision: {}, gateway: { environment: 'production' } }, 'dev').error.code, 'ENVIRONMENT_MISMATCH');
  assert.deepEqual(resolveLocalTransportEnvironment('dev'), { ok: true, environment: 'dev' });
  assert.equal(resolveLocalTransportEnvironment(undefined).ok, true);
});

test('real Gateway round-trip (no network, tmp usage): envelope passes the kit checks and usage records the consumer', async () => {
  const usage = join(mkdtempSync(join(tmpdir(), 'edl-kit-')), 'usage.jsonl');
  const t = createCliTransport({ environment: 'dev', neverForward: /^(FAL_|WAVESPEED_)/ });
  const env = await t.call({ ...REQUEST, application_id: 'openmontage', input: { asset_kind: 'subtitle', purpose: 'jp caption' } },
    { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EDL_HOME: ROOT, EDL_USAGE_PATH: usage } });
  assert.equal(env.ok, true);
  assert.equal(env.gateway.environment, 'dev');
  assert.equal(env.gateway.via, 'cli');
  const row = JSON.parse(readFileSync(usage, 'utf8').trim().split('\n').pop());
  assert.equal(row.application_id, 'openmontage');
  assert.equal(row.environment, 'dev');
  assert.equal(row.correlation_id, 'c-1');
});

test('kit holds no Decision Engine specific names (Jev env names / endpoints / provider ids)', () => {
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) { if (e !== '__pycache__') walk(p); } else files.push(p); } };
  walk(KIT);
  assert.ok(files.length >= 4);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(/JEV_|AI_GATEWAY_|typesafe|vercel/i.test(text), false, f);
  }
});
