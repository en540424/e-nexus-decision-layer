/**
 * 内部の異常 digest（2026-09-29 FB-18）。usage.jsonl と access log の集計・異常の基準・webhook（credential: だけ・https・既定 OFF）。
 * 実ネットワーク・資格情報ストアは使わない（fake）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, formatDigest, postWebhook, webhookBody, resolveWindow, parseJsonl, DEFAULT_ALERTS } from '../scripts/usage-digest.mjs';

const NOW = new Date('2026-09-29T12:00:00Z');
const SINCE = new Date('2026-09-28T12:00:00Z');
const at = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const jev = (status, reason = null, cost = 90) => ({ adapter: 'jev', status, reason, usage_known: status === 'ok', estimated_cost_usd_micros: status === 'ok' ? cost : 0 });
const row = (o) => ({ timestamp: at(1), application_id: 'en-sns-hub', decision_type: 'content-publish-gate', tier: 'review', resolved_by: 'jev', correlation_id: 'secret-business-id', request_id: 'req_secret', attempts: [jev('ok')], ...o });

test('集計：consumer ごとの件数・tier・Human 率・Jev の成否と理由・中断・費用。窓の外は数えない', () => {
  const rows = [
    row({}), row({ tier: 'human', resolved_by: 'human', attempts: [jev('unavailable', 'JEV_HTTP_503'), { adapter: 'human', status: 'ok', usage_known: true, estimated_cost_usd_micros: 0 }] }),
    row({ aborted: true, abort_reason: 'GATEWAY_TIMEOUT', tier: null, resolved_by: null }),
    row({ application_id: 'crm-executor', decision_type: 'automation-safety-gate', tier: 'human', resolved_by: 'rules', attempts: [{ adapter: 'rules', status: 'ok', usage_known: true, estimated_cost_usd_micros: 0 }] }),
    row({ timestamp: at(30) }), // 窓の外
  ];
  const d = buildDigest(rows, { since: SINCE, until: NOW });
  const s = d.by_application['en-sns-hub'];
  assert.equal(s.decisions, 2, 'aborted は判定に数えない');
  assert.deepEqual(s.tiers, { review: 1, human: 1 });
  assert.equal(s.human_rate, 0.5);
  assert.equal(s.jev_attempts, 3);
  assert.equal(s.jev_ok, 2);
  assert.deepEqual(s.jev_failed_reasons, { JEV_HTTP_503: 1 });
  assert.equal(s.aborted, 1);
  assert.deepEqual(s.abort_reasons, { GATEWAY_TIMEOUT: 1 });
  assert.equal(s.known_cost_usd_micros, 180);
  assert.equal(d.by_application['crm-executor'].decisions, 1);
  assert.equal(d.decisions, 3);
  assert.deepEqual(d.anomalies.map((a) => a.kind), ['aborted_decisions']);
});

test('異常の基準：Human 率（件数が少なければ騒がない）・Jev unavailable・access log の 5xx／401／429・費用（既定なし）', () => {
  const many = Array.from({ length: 6 }, () => row({ tier: 'human', attempts: [jev('unavailable', 'JEV_NETWORK_DISABLED')] }));
  const access = [
    { ts: at(1), component: 'edl-gateway-http', method: 'POST', path: '/v1/decisions', status: 500, error_code: null },
    ...Array.from({ length: 5 }, () => ({ ts: at(2), component: 'edl-gateway-http', method: 'POST', path: '/v1/decisions', status: 401, error_code: null })),
    { ts: at(2), component: 'edl-gateway-http', method: 'POST', path: '/v1/decisions', status: 409, error_code: 'ENVIRONMENT_MISMATCH' },
    { ts: at(2), component: 'edl-gateway-http', method: 'POST', path: '/v1/decisions', status: 429, error_code: 'GATEWAY_BUSY' },
    { ts: at(2), component: 'edl-gateway-http', event: 'listening' }, // request 以外の行は数えない
  ];
  const d = buildDigest(many, { since: SINCE, until: NOW, accessLines: access });
  assert.deepEqual(d.anomalies.map((a) => a.kind).sort(), ['gateway_5xx', 'high_human_rate', 'jev_unavailable', 'rate_limited', 'unauthorized']);
  assert.equal(d.access.requests, 8);
  assert.deepEqual(d.access.error_codes, { ENVIRONMENT_MISMATCH: 1, GATEWAY_BUSY: 1 });
  const few = buildDigest(many.slice(0, 2), { since: SINCE, until: NOW });
  assert.deepEqual(few.anomalies, [], '2 件の Human 率 1.0・Jev 失敗 2 回は基準未満');
  assert.equal(DEFAULT_ALERTS.cost_usd_micros_min, null);
  const costly = buildDigest([row({})], { since: SINCE, until: NOW, alerts: { cost_usd_micros_min: 50 } });
  assert.deepEqual(costly.anomalies.map((a) => a.kind), ['cost']);
});

test('持ち出さない：digest・整形・webhook body に correlation_id・request_id・input は入らない', () => {
  const d = buildDigest([row({ input: { title: 'secret title' } })], { since: SINCE, until: NOW });
  for (const body of [d, formatDigest(d), webhookBody(d, 'json', 'staging'), webhookBody(d, 'slack', 'staging'), webhookBody(d, 'discord', 'staging')]) {
    const s = JSON.stringify(body);
    for (const leak of ['secret-business-id', 'req_secret', 'secret title']) assert.ok(!s.includes(leak), leak);
  }
  assert.ok(webhookBody(d, 'discord', null).content.length <= 1900);
});

test('webhook：既定は異常がある時だけ・URL は credential: からだけ・https 必須・失敗しても投げない', async () => {
  const d0 = buildDigest([], { since: SINCE, until: NOW });
  const d1 = buildDigest([row({ aborted: true, abort_reason: 'SHUTDOWN' })], { since: SINCE, until: NOW });
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); };
  const cred = (value) => async (target) => { assert.equal(target, 'E-NEXUS/edl/digest-webhook'); return value; };
  const base = { spec: 'credential:E-NEXUS/edl/digest-webhook', fetchImpl, readCredentialImpl: cred('https://hooks.example/abc') };
  assert.equal((await postWebhook(d0, base)).code, 'NO_ANOMALY');
  assert.equal(sent.length, 0);
  assert.equal((await postWebhook(d0, { ...base, always: true })).code, 'SENT');
  assert.equal((await postWebhook(d1, { ...base, format: 'slack' })).code, 'SENT');
  assert.equal(typeof sent[1].body.text, 'string');
  assert.equal((await postWebhook(d1, { ...base, spec: 'https://hooks.example/abc' })).code, 'WEBHOOK_MUST_BE_CREDENTIAL', 'URL を引数で渡させない');
  assert.equal((await postWebhook(d1, { ...base, spec: 'credential:E-NEXUS/paid-provider/fal' })).code, 'WEBHOOK_CREDENTIAL_TARGET_INVALID');
  assert.equal((await postWebhook(d1, { ...base, readCredentialImpl: cred('http://hooks.example/abc') })).code, 'WEBHOOK_URL_INSECURE');
  assert.equal((await postWebhook(d1, { ...base, readCredentialImpl: cred(null) })).code, 'WEBHOOK_CREDENTIAL_MISSING');
  assert.equal((await postWebhook(d1, { ...base, readCredentialImpl: async () => { throw new Error('backend'); } })).code, 'WEBHOOK_CREDENTIAL_UNREADABLE');
  assert.equal((await postWebhook(d1, { ...base, fetchImpl: async () => new Response('', { status: 500 }) })).code, 'WEBHOOK_HTTP_500');
  assert.equal((await postWebhook(d1, { ...base, fetchImpl: async () => { throw new TypeError('down'); } })).code, 'WEBHOOK_UNREACHABLE');
  assert.equal((await postWebhook(d1, { ...base, format: 'xml' })).code, 'WEBHOOK_FORMAT_INVALID');
});

test('窓：--hours（既定 24）と --since。壊れた JSONL 行は読み飛ばす', () => {
  assert.equal(resolveWindow([], NOW).since.toISOString(), '2026-09-28T12:00:00.000Z');
  assert.equal(resolveWindow(['--hours', '6'], NOW).since.toISOString(), '2026-09-29T06:00:00.000Z');
  assert.equal(resolveWindow(['--since', '2026-09-01T00:00:00Z'], NOW).since.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.throws(() => resolveWindow(['--hours', '0'], NOW));
  assert.throws(() => resolveWindow(['--since', 'yesterday'], NOW));
  assert.equal(parseJsonl('{"a":1}\nnot json\n\n{"b":2}\n').length, 2);
});
