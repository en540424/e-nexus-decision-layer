#!/usr/bin/env node
/**
 * VPS staging Gateway の smoke / E2E（2026-09-30・Deployment Completion Phase）。PC（または Mac mini）から
 * Tailnet の HTTPS（Tailscale Serve → 127.0.0.1 の Gateway）を叩く。consumer-kit の https 必須ルールはそのまま使う。
 *
 *   EDL_GATEWAY_TOKEN=… node deploy/vps-staging/e2e.mjs --url https://<vps>.<tailnet>.ts.net:<port> --release <commit> [--smoke-only] [--python <exe>]
 *
 * token は env EDL_GATEWAY_TOKEN から読む（値は出さない）。staging は Jev を切っている（EDL_ALLOW_NETWORK 無し）ので、
 * Jev が要る判定は human に倒れる＝課金なし。E2E_CASES の期待値は tests/vps-staging-kit.test.mjs が in-process の staging Gateway で固定する。
 * 終了コード：0＝全 PASS／1＝FAIL あり／2＝引数不正。
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSmoke } from '../../scripts/gateway-smoke.mjs';
import { createHttpTransport } from '../../consumer-kit/node/http-transport.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT = 'e-nexus-staging-e2e';

const ASG = { automation_kind: 'crm-line-push', environment: 'staging', target_scope: 'single-contact', external_send: true, paid_api: false, writes_external_system: true, irreversible: true, touches_secrets: true, personal_data: true, existing_gate: 'human-approval-chain', rollback_available: false, rate_or_cap_limited: true, summary: 'staging e2e' };
const CRG = { reply_ref: 'e2e-reply-0001', channel: 'line', contact_consent_state: 'withdrawn', subscription_state: 'subscribed', inbound_category: 'consent-withdrawal', draft_author: 'human', language: 'ja' };
const LT = { subject_ref: 'ct_e2e0000001', channel: 'line', consent_context: 'granted', subscription_state: 'subscribed', lifecycle_stage: 'lead', inbound_category: 'inquiry', interaction_count: 2, recency: 'today', has_explicit_request: true, product_interest: 'scaffold-saas', business_signal: 'business' };

/** consumer の形をした判定（MA-17・CRM）と fail-closed。どれも実 LINE・実 SNS・有料 API に触れない */
export const E2E_CASES = Object.freeze([
  { name: 'MA-17 subtitle: rules only (no Jev)', request: { decision_type: 'paid-generation-gate', application_id: 'en-generate-hub', project_id: PROJECT, input: { asset_kind: 'subtitle', purpose: 'staging e2e: rules-only' } }, expect: { ok: true, tier: 'auto', resolved_by: 'rules' } },
  { name: 'MA-17 paid video: Jev off -> human (no paid call)', request: { decision_type: 'paid-generation-gate', application_id: 'en-generate-hub', project_id: PROJECT, input: { asset_kind: 'talking-head', purpose: 'staging e2e: needs a paid provider', style: 'photoreal', duration_sec: 8 } }, expect: { ok: true, tier: 'human', resolved_by: 'human' } },
  { name: 'CRM automation-safety-gate: secrets -> human by rules', request: { decision_type: 'automation-safety-gate', application_id: 'e-nexus-crm-core', project_id: PROJECT, input: ASG }, expect: { ok: true, tier: 'human', resolved_by: 'rules' } },
  { name: 'CRM customer-reply-gate: consent withdrawn -> human by rules', request: { decision_type: 'customer-reply-gate', application_id: 'e-nexus-crm-core', project_id: PROJECT, input: CRG }, expect: { ok: true, tier: 'human', resolved_by: 'rules' } },
  { name: 'CRM lead-triage: Jev off -> human', request: { decision_type: 'lead-triage', application_id: 'e-nexus-crm-core', project_id: PROJECT, input: LT }, expect: { ok: true, tier: 'human', resolved_by: 'human' } },
  { name: 'unknown decision type fails closed', request: { decision_type: 'no-such-type', application_id: 'e-nexus-staging-e2e', project_id: PROJECT, input: {} }, expect: { ok: false, code: 'UNKNOWN_DECISION_TYPE' } },
]);

/** envelope が期待どおりか（staging の環境照合は transport が済ませる） */
export function checkCase(envelope, expect) {
  if (envelope?.ok !== expect.ok) return `ok=${envelope?.ok} error=${envelope?.error?.code ?? null}`;
  if (!expect.ok) return envelope.error?.code === expect.code && envelope.failure?.proceed_automatically === false ? null : `error=${envelope.error?.code}`;
  if (envelope.gateway?.environment !== 'staging') return `environment=${envelope.gateway?.environment}`;
  if (envelope.decision?.tier !== expect.tier) return `tier=${envelope.decision?.tier}`;
  if (envelope.decision?.resolved_by !== expect.resolved_by) return `resolved_by=${envelope.decision?.resolved_by}`;
  return null;
}

async function raw(url, pathName, { method = 'GET', headers = {}, body, fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = await fetchImpl(new URL(pathName, url).href, { method, headers, body, signal: AbortSignal.timeout(15000) });
    return r.status;
  } catch (err) {
    return `ERR:${err?.name ?? 'ERROR'}`;
  }
}

function runPython(python, url, token) {
  const script = [
    'import json, os, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'consumer-kit', 'python'))})`,
    'from enexus_http_transport import HttpTransport',
    `req = ${JSON.stringify(E2E_CASES[0].request)}`,
    `env = HttpTransport(${JSON.stringify(url)}, os.environ["EDL_GATEWAY_TOKEN"], "staging").call(req)`,
    'print(json.dumps({"ok": env["ok"], "by": (env.get("decision") or {}).get("resolved_by"), "environment": (env.get("gateway") or {}).get("environment"), "code": (env.get("error") or {}).get("code")}))',
  ].join('\n');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...minimalEnv(), EDL_GATEWAY_TOKEN: token }, windowsHide: true });
    } catch { resolve(null); return; }
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) { resolve({ error: `exit ${code}` }); return; }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); } catch { resolve({ error: 'bad output' }); }
    });
  });
}

/** 子 process へ渡す env（許可リスト）：Jev・有料 provider の鍵を持ち込まない */
export function minimalEnv(src = process.env) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG', 'LC_ALL', 'PYTHONIOENCODING'];
  const out = {};
  for (const k of keep) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

export async function runE2E({ url, token, release, smokeOnly = false, python = null, fetchImpl = globalThis.fetch }) {
  const results = [];
  const add = (name, pass, detail = null, { warn = false } = {}) => results.push({ name, pass: Boolean(pass), ...(warn ? { warn: true } : {}), ...(detail ? { detail } : {}) });
  const smoke = await runSmoke({ url, token, environment: 'staging', release, fetchImpl });
  for (const r of smoke.results) add(`smoke: ${r.name}`, r.pass, r.detail);
  if (smokeOnly) return { pass: results.every((r) => r.pass), results };

  const t = createHttpTransport({ baseUrl: url, token, environment: 'staging', fetchImpl });
  for (const c of E2E_CASES) {
    const why = checkCase(await t.call({ ...c.request }), c.expect);
    add(`e2e: ${c.name}`, why === null, why);
  }
  const wrong = await createHttpTransport({ baseUrl: url, token: 'wrong-token-for-staging-e2e-000000000000', environment: 'staging', fetchImpl }).call({ ...E2E_CASES[0].request });
  add('failure: invalid token -> GATEWAY_UNAUTHORIZED (human-required)', wrong.error?.code === 'GATEWAY_UNAUTHORIZED' && wrong.failure?.proceed_automatically === false, wrong.error?.code);
  const asDev = await createHttpTransport({ baseUrl: url, token, environment: 'production', fetchImpl }).call({ ...E2E_CASES[0].request });
  add('failure: a production consumer is refused by the staging Gateway', asDev.ok === false && asDev.failure?.proceed_automatically === false, asDev.error?.code);
  const malformed = await raw(url, '/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"not json', fetchImpl });
  add('failure: malformed JSON -> 400', malformed === 400, `status=${malformed}`);
  const wrongType = await raw(url, '/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: '{}', fetchImpl });
  add('failure: non-JSON content type -> 415', wrongType === 415, `status=${wrongType}`);
  const plain = await raw(url.replace(/^https:/, 'http:'), '/health', { fetchImpl });
  add('transport: plain http on the serve port is not served', plain !== 200, `status=${plain}`);
  if (python) {
    // Hermes は Mac mini の Python で動く。PC の Python（証明書ストア等）の事情で落ちても staging の合否は止めない＝WARN
    const py = await runPython(python, url, token);
    if (py === null) add('python transport (Hermes path): python not available on this PC', false, 'skipped', { warn: true });
    else add('python transport (Hermes path): https + token + staging envelope', py.ok === true && py.by === 'rules' && py.environment === 'staging', JSON.stringify({ ...py }), { warn: true });
  }
  return { pass: results.every((r) => r.pass || r.warn), results };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function main(argv) {
  const url = arg(argv, '--url');
  const release = arg(argv, '--release');
  const token = process.env.EDL_GATEWAY_TOKEN;
  if (!url || !/^https:\/\//.test(url) || !release || !token) {
    console.error('usage: EDL_GATEWAY_TOKEN=… node deploy/vps-staging/e2e.mjs --url https://<host>:<port> --release <commit> [--smoke-only] [--python <exe>]');
    return 2;
  }
  const r = await runE2E({ url, token, release, smokeOnly: argv.includes('--smoke-only'), python: arg(argv, '--python') });
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : x.warn ? 'WARN' : 'FAIL'}  ${x.name}${x.detail ? `  (${x.detail})` : ''}`);
  console.log(r.pass ? 'E2E PASS' : 'E2E FAIL');
  return r.pass ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
