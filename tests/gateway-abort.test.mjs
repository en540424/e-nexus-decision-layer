/**
 * Gateway timeout / client 切断で engine と in-flight の Jev fetch を止める（2026-09-29 FB-01）。
 *
 *   consumer → Gateway（timeout・同時実行枠）→ engine（signal）→ fallback chain → Jev adapter → Direct provider（fetch・backoff）
 *
 * 検査すること：
 *   - timeout で in-flight の fetch が abort される（Jev 呼び出しが走り続けない）
 *   - abort 後に後続 Adapter（human 含む）を呼ばない＝判定を作らない
 *   - 送信済みの Jev attempt は aborted=true の usage 行に残る（課金の証跡を失わない）。attempt 0 件なら行を書かない
 *   - 同時実行枠は engine が実際に止まるまで保持し、signal を無視する engine は grace で打ち切って stats.abandoned に数える
 *   - backoff 待機も abort で中断する／送信前の中断は networked=false
 *   - HTTP：通常の POST は abort されない（回帰）・client 切断で DECISION_ABORTED（ENGINE_ERROR ではない）
 *   - 未処理の Promise rejection が起きない
 * 実ネットワークは使わない（fetchImpl 注入）。meter は memory。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { startGatewayServer } from '../src/gateway/http-server.mjs';
import { createMemoryMeter, summarize, USAGE_FIELDS } from '../src/usage/metering.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { createDirectJevProvider } from '../src/adapters/jev/jev-direct-provider.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { DecisionAbortedError } from '../src/core/errors.mjs';

const USABLE = Object.freeze({ EDL_ALLOW_NETWORK: 'true', JEV_PROVIDER: 'direct', JEV_API_KEY: 'test-key-not-real' });
// rules に一致しない paid-generation-gate 入力 → Jev まで届く（gateway-real-jev-path.test.mjs と同じ）
const INPUT = { asset_kind: 'scene', purpose: 'product hero shot we do not have locally', style: 'photoreal', estimated_paid_cost_usd_micros: 300000 };
const req = (extra = {}) => ({ decision_type: 'paid-generation-gate', application_id: 'claude-code', project_id: 'en-generate-hub', input: INPUT, ...extra });

/** signal を尊重する「応答しない」fetch（abort されたら AbortError で reject） */
function hangingFetch(counter) {
  return async (url, init) => {
    counter.calls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        counter.aborted += 1;
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    });
  };
}

function spyHuman() {
  const human = createHumanAdapter();
  const spy = { calls: 0 };
  return { spy, adapter: { ...human, decide: async (args) => { spy.calls += 1; return human.decide(args); } } };
}

function engineWith({ fetchImpl, sleepImpl = async () => {}, meter = createMemoryMeter(), human = createHumanAdapter() }) {
  const provider = createDirectJevProvider({ fetchImpl, sleepImpl });
  const adapters = [createRulesAdapter(), createJevAdapter({ env: USABLE, provider }), createLocalAdapterStub(), createLlmAdapterStub({ env: USABLE }), human];
  return { engine: createDecisionLayerEngine({ env: USABLE, mode: 'production', meter, adapters }), meter };
}

function trackUnhandled() {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  return { seen, stop: () => process.off('unhandledRejection', onUnhandled) };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('timeout aborts the in-flight Jev fetch; human adapter is not called; aborted usage row keeps the networked Jev attempt', async () => {
  const unhandled = trackUnhandled();
  const counter = { calls: 0, aborted: 0 };
  const { spy, adapter: human } = spyHuman();
  const { engine, meter } = engineWith({ fetchImpl: hangingFetch(counter), human });
  const gateway = createGateway({ engine, env: USABLE, timeoutMs: 30 });

  const env = await gateway.decide(req(), { via: 'sdk' });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'GATEWAY_TIMEOUT');
  assert.equal(env.failure.human_required, true);
  await tick();
  assert.equal(counter.calls, 1, 'one fetch was sent');
  assert.equal(counter.aborted, 1, 'the in-flight fetch was aborted (not left running)');
  assert.equal(spy.calls, 0, 'no escalation / decision is produced after abort');

  const rows = meter.readAll();
  assert.equal(rows.length, 1);
  const [row] = rows;
  for (const f of USAGE_FIELDS) assert.ok(f in row, f);
  assert.equal(row.aborted, true);
  assert.equal(row.abort_reason, 'GATEWAY_TIMEOUT');
  assert.equal(row.tier, null, 'aborted rows never look like a decision');
  assert.equal(row.resolved_by, null);
  assert.equal(row.human_escalation, false);
  const jev = row.attempts.find((a) => a.adapter === 'jev');
  assert.equal(jev.status, 'unavailable');
  assert.equal(jev.reason, 'JEV_ABORTED');
  assert.equal(jev.networked, true, 'sent → billable');
  assert.equal(jev.usage_known, false, 'sent but no usage → unknown, never 0');
  assert.equal(row.usage_total.unknown_usage_attempts, 1);
  assert.equal(gateway.health().stats.aborted, 1);
  assert.equal(gateway.health().stats.in_flight, 0, 'slot released once the engine actually stopped');
  assert.equal(summarize(rows, 'decision_type')['paid-generation-gate'].aborted, 1);
  unhandled.stop();
  assert.deepEqual(unhandled.seen, [], 'no unhandled promise rejection');
});

test('abort before the first send: networked=false (cost 0 known) and no usage row when nothing was attempted', async () => {
  const counter = { calls: 0, aborted: 0 };
  const { engine, meter } = engineWith({ fetchImpl: hangingFetch(counter) });
  const ctrl = new AbortController();
  ctrl.abort('SHUTDOWN');
  await assert.rejects(() => engine.decide(req(), { signal: ctrl.signal }), (e) => e instanceof DecisionAbortedError && e.details.reason === 'SHUTDOWN');
  assert.equal(counter.calls, 0);
  assert.equal(meter.readAll().length, 0, 'no attempt → no row');

  // provider 単体：送信前に中断されていれば networked=false
  const provider = createDirectJevProvider({ fetchImpl: hangingFetch(counter) });
  await assert.rejects(
    () => provider.send({ request: {}, env: USABLE, signal: ctrl.signal }),
    (e) => e.details.reason === 'JEV_ABORTED' && e.details.networked === false && e.details.abort_reason === 'SHUTDOWN',
  );
  assert.equal(counter.calls, 0);
});

test('backoff wait is interrupted by abort (long Retry-After does not keep the decision alive)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 429, ok: false, headers: { get: (n) => (n === 'retry-after' ? '60' : null) }, json: async () => ({}) }; };
  const provider = createDirectJevProvider({ fetchImpl }); // 既定の実時間 sleep（abort で早期復帰する）
  const ctrl = new AbortController();
  const started = Date.now();
  const p = provider.send({ request: {}, env: USABLE, signal: ctrl.signal });
  setTimeout(() => ctrl.abort('GATEWAY_TIMEOUT'), 30);
  await assert.rejects(() => p, (e) => e.details.reason === 'JEV_ABORTED' && e.details.networked === true && e.details.retryable === false);
  assert.ok(Date.now() - started < 5000, 'did not wait for the 60s Retry-After');
  assert.equal(calls, 1, 'no resend after abort');
});

test('slot is held until an abort-ignoring engine settles, and released at grace (stats.abandoned) — never leaks', async () => {
  const unhandled = trackUnhandled();
  let release;
  const stubborn = {
    id: 'stubborn', version: '0', mode: 'production', health: () => ({}),
    // signal を無視して走り続け、最後は reject する（未処理 rejection にならないこと）
    decide: () => new Promise((_, reject) => { release = () => reject(new Error('late failure')); }),
  };
  const gateway = createGateway({ engine: stubborn, env: {}, timeoutMs: 10, maxConcurrent: 1, abortGraceMs: 60 });
  const first = await gateway.decide(req());
  assert.equal(first.error.code, 'GATEWAY_TIMEOUT');
  assert.equal(gateway.health().stats.in_flight, 1, 'still running → slot still held');
  const busy = await gateway.decide(req());
  assert.equal(busy.error.code, 'GATEWAY_BUSY', 'real concurrency does not exceed max_concurrent');
  await tick(100);
  assert.equal(gateway.health().stats.in_flight, 0, 'released at grace');
  assert.equal(gateway.health().stats.abandoned, 1);
  release();
  await tick();
  assert.equal(gateway.health().stats.in_flight, 0, 'late settle does not double-release');
  unhandled.stop();
  assert.deepEqual(unhandled.seen, [], 'late engine rejection is handled');
});

test('an engine that honours the signal releases the slot immediately after abort (no grace wait)', async () => {
  const counter = { calls: 0, aborted: 0 };
  const { engine } = engineWith({ fetchImpl: hangingFetch(counter) });
  const gateway = createGateway({ engine, env: USABLE, timeoutMs: 20, maxConcurrent: 1, abortGraceMs: 60000 });
  const first = await gateway.decide(req());
  assert.equal(first.error.code, 'GATEWAY_TIMEOUT');
  await tick();
  assert.equal(gateway.health().stats.in_flight, 0);
  assert.equal(gateway.health().stats.abandoned, 0);
});

test('external signal (e.g. shutdown) → DECISION_ABORTED envelope (not ENGINE_ERROR), failure policy still attached', async () => {
  const counter = { calls: 0, aborted: 0 };
  const { engine } = engineWith({ fetchImpl: hangingFetch(counter) });
  const gateway = createGateway({ engine, env: USABLE, timeoutMs: 5000 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort('SHUTDOWN'), 20);
  const env = await gateway.decide(req(), { signal: ctrl.signal });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'DECISION_ABORTED');
  assert.equal(env.error.kind, 'aborted');
  assert.equal(env.failure.proceed_automatically, false);
  assert.equal(gateway.health().stats.errors_by_code.ENGINE_ERROR, undefined);
  await tick();
  assert.equal(counter.aborted, 1);
});

function post(port, body, { destroyAfterMs = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/v1/decisions', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    r.on('error', (err) => (destroyAfterMs !== null ? resolve({ destroyed: true, err: err.code }) : reject(err)));
    r.write(JSON.stringify(body));
    r.end();
    if (destroyAfterMs !== null) setTimeout(() => r.destroy(), destroyAfterMs);
  });
}

test('HTTP: a normal POST /v1/decisions is NOT aborted (body consumed ≠ client gone) — regression', async () => {
  const gateway = createGateway({ engine: createDecisionLayerEngine({ env: {}, meter: createMemoryMeter() }), env: {} });
  const server = await startGatewayServer({ gateway, port: 0 });
  try {
    const res = await post(server.address().port, { ...req(), input: { asset_kind: 'subtitle', purpose: 'jp caption' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(gateway.health().stats.aborted, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP: client disconnect aborts the decision and the in-flight Jev fetch (counted as DECISION_ABORTED)', async () => {
  const counter = { calls: 0, aborted: 0 };
  const { engine, meter } = engineWith({ fetchImpl: hangingFetch(counter) });
  const gateway = createGateway({ engine, env: USABLE, timeoutMs: 5000 });
  const server = await startGatewayServer({ gateway, port: 0 });
  try {
    const res = await post(server.address().port, req(), { destroyAfterMs: 50 });
    assert.equal(res.destroyed, true);
    await tick(80);
    assert.equal(counter.aborted, 1, 'fetch aborted after the client went away');
    const stats = gateway.health().stats;
    assert.equal(stats.errors_by_code.DECISION_ABORTED, 1);
    assert.equal(stats.errors_by_code.ENGINE_ERROR, undefined);
    assert.equal(stats.in_flight, 0);
    assert.equal(meter.readAll()[0].abort_reason, 'CLIENT_DISCONNECTED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
