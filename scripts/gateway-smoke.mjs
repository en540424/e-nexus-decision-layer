#!/usr/bin/env node
/**
 * deploy した HTTP Gateway の smoke（2026-09-29・FB-05）。staging で行い、production への昇格前・rollback 後にも使う。
 *
 *   EDL_GATEWAY_TOKEN=… node scripts/gateway-smoke.mjs --url https://… --environment <staging|production> [--release <commit>]
 *
 * 確かめること（どれも課金・外部送信なし）：
 *   /health・/ready が 200・環境が一致／/version の release が --release と一致／token 無しの /v1/health が 401／
 *   Origin 付きが 403／token 付きの /v1/health が 200／rules だけで決まる判定（paid-generation-gate の字幕＝Jev を呼ばない）が
 *   Contract v1 の envelope で返り、gateway.environment が一致
 * token は env EDL_GATEWAY_TOKEN から読む（値は出さない）。終了コード：0＝全項目 PASS／1＝FAIL あり／2＝引数不正。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpTransport } from '../consumer-kit/node/http-transport.mjs';

/** rules の `subtitle-local` に当たる＝Jev を呼ばない判定 */
export const SMOKE_REQUEST = Object.freeze({
  decision_type: 'paid-generation-gate',
  application_id: 'edl-smoke',
  project_id: 'e-nexus-decision-layer',
  input: { asset_kind: 'subtitle', purpose: 'smoke: rules-only decision' },
});

export async function runSmoke({ url, token, environment, release = null, fetchImpl = globalThis.fetch }) {
  const results = [];
  const check = (name, pass, detail = null) => results.push({ name, pass: Boolean(pass), ...(detail ? { detail } : {}) });
  const get = async (p, headers = {}) => {
    try {
      const r = await fetchImpl(new URL(p, url).href, { headers });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    } catch (err) {
      return { status: null, body: null, error: err?.name ?? 'ERROR' };
    }
  };

  const health = await get('/health');
  check('health 200', health.status === 200, `status=${health.status}`);
  check('health environment', health.body?.environment === environment, `environment=${health.body?.environment}`);
  const ready = await get('/ready');
  check('ready 200', ready.status === 200, `status=${ready.status}`);
  const version = await get('/version');
  check('version engine mode production', version.body?.engine?.mode === 'production', `mode=${version.body?.engine?.mode}`);
  if (release) check('release pinned', typeof version.body?.release?.commit === 'string' && version.body.release.commit.startsWith(release), `release=${version.body?.release?.commit ?? null}`);
  check('unauthenticated /v1/health is 401', (await get('/v1/health')).status === 401);
  check('Origin is rejected (403)', (await get('/v1/health', { origin: 'https://example.invalid', authorization: `Bearer ${token}` })).status === 403);
  const detail = await get('/v1/health', { authorization: `Bearer ${token}` });
  check('authenticated /v1/health 200', detail.status === 200, `status=${detail.status}`);

  const envelope = await createHttpTransport({ baseUrl: url, token, environment, fetchImpl }).call({ ...SMOKE_REQUEST });
  check('decision envelope ok', envelope.ok === true, envelope.ok ? null : `error=${envelope.error?.code}`);
  check('decision resolved by rules (no Jev call)', envelope.decision?.resolved_by === 'rules', `resolved_by=${envelope.decision?.resolved_by ?? null}`);
  check('decision environment', envelope.gateway?.environment === environment);
  return { pass: results.every((r) => r.pass), results };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

async function main(argv) {
  const url = arg(argv, '--url');
  const environment = arg(argv, '--environment');
  const token = process.env.EDL_GATEWAY_TOKEN;
  if (!url || !['dev', 'staging', 'production'].includes(environment) || !token) {
    console.error('usage: EDL_GATEWAY_TOKEN=… node scripts/gateway-smoke.mjs --url <https://…> --environment <staging|production> [--release <commit>]');
    return 2;
  }
  const r = await runSmoke({ url, token, environment, release: arg(argv, '--release') });
  for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? `  (${x.detail})` : ''}`);
  console.log(r.pass ? 'SMOKE PASS' : 'SMOKE FAIL');
  return r.pass ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
