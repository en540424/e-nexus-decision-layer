#!/usr/bin/env node
/**
 * Task Hub の受け口の入口（Cloudflare の hostname → VPS の task intake）の検収（2026-11-10・MA-24）。
 * Human が Cloudflare の hostname・WAF を作った後に実行する（docs/vps-maintenance.md「検収」・deploy/cloudflare-task-intake/README.md）。
 *
 *   node scripts/task-intake-edge-check.mjs --url https://<hostname> [--edge cloudflare|none] [--bearer-credential credential:E-NEXUS/edl/<name>] [--json]
 *
 * 読むだけ：依頼を置かない（submit_task を呼ばない）・連打しない（rate limit は数えない＝README の手作業）。1 回に 8〜11 本の request。
 * 出すのは status code と合否だけ（本文・鍵・header の値は出さない）。redirect に従わない。https 以外は loopback の http だけ（試験用）。
 * --edge cloudflare（既定）：WAF の Block を 403 と見る。--edge none：受け口に直接（loopback の試験）＝止めるのは受け口の 404／405。
 * exit 0＝全部合格・1＝不合格あり・2＝使い方の誤り。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TIMEOUT_MS = 10_000;
const PROTOCOL = '2025-06-18';

export function parseArgs(argv) {
  const a = { edge: 'cloudflare', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--json') { a.json = true; continue; }
    if (!['--url', '--edge', '--bearer-credential'].includes(k)) throw new Error(`unknown argument: ${k}`);
    if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
    a[{ '--url': 'url', '--edge': 'edge', '--bearer-credential': 'bearerCredential' }[k]] = argv[i + 1];
    i += 1;
  }
  return a;
}

export function validateArgs(a) {
  const errors = [];
  let u = null;
  try { u = new URL(a.url); } catch { errors.push('--url must be a URL'); }
  if (u) {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) errors.push('--url must be https (http only for loopback)');
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) errors.push('--url must be just the origin (no path, query or credentials)');
  }
  if (!['cloudflare', 'none'].includes(a.edge)) errors.push('--edge must be cloudflare|none');
  if (a.bearerCredential !== undefined && !/^credential:E-NEXUS\/edl\/[A-Za-z0-9._-]{1,64}$/.test(a.bearerCredential)) errors.push('--bearer-credential must be credential:E-NEXUS/edl/<name>');
  return errors;
}

async function req(fetchImpl, origin, method, p, { bearer = null, body = null } = {}) {
  const headers = { accept: 'application/json, text/event-stream' };
  if (body !== null) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  try {
    const res = await fetchImpl(new URL(p, origin), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    let json = null;
    if (res.status === 200 && /json/.test(res.headers.get('content-type') ?? '')) { try { json = await res.json(); } catch { json = null; } }
    else { try { await res.arrayBuffer(); } catch { /* 捨てる */ } }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, error: e?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/**
 * 検収を回す。戻り値 { ok, checks: [{ id, want, got, ok }] }。bearer は渡された時だけ（読むだけの 3 つ）
 */
export async function runEdgeCheck({ url, edge = 'cloudflare', bearer = null, fetchImpl = globalThis.fetch }) {
  const origin = new URL(url).origin;
  const blocked = edge === 'cloudflare' ? [403] : [404, 405]; // 受け口に直接：知らない path は 404・知っている path の違う method は 405
  const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const init = rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'edl-edge-check', version: '1' } });
  const checks = [];
  const add = (id, want, r, extra = true) => checks.push({ id, want: want.join('|'), got: r.status || r.error, ok: want.includes(r.status) && extra });

  add('mcp_no_auth', [401], await req(fetchImpl, origin, 'POST', '/mcp', { body: init }));
  add('mcp_bad_bearer', [401], await req(fetchImpl, origin, 'POST', '/mcp', { bearer: `etk_${'0'.repeat(64)}`, body: init }));
  add('mcp_get_no_sse', [405], await req(fetchImpl, origin, 'GET', '/mcp'));
  add('root_blocked', blocked, await req(fetchImpl, origin, 'GET', '/'));
  add('mcp_put_blocked', blocked, await req(fetchImpl, origin, 'PUT', '/mcp', { body: init }));
  add('pull_post_blocked', blocked, await req(fetchImpl, origin, 'POST', '/pull', { body: '{}' }));
  add('pull_unsigned', [404], await req(fetchImpl, origin, 'GET', '/pull'));
  add('dotfile_blocked', blocked, await req(fetchImpl, origin, 'GET', '/.env'));
  if (bearer) {
    const r1 = await req(fetchImpl, origin, 'POST', '/mcp', { bearer, body: init });
    add('mcp_initialize', [200], r1, typeof r1.json?.result?.protocolVersion === 'string');
    const r2 = await req(fetchImpl, origin, 'POST', '/mcp', { bearer, body: rpc('tools/list', {}, 2) });
    const names = (r2.json?.result?.tools ?? []).map((t) => t?.name);
    add('mcp_tools', [200], r2, ['submit_task', 'get_task_status', 'list_capabilities'].every((n) => names.includes(n)));
    const r3 = await req(fetchImpl, origin, 'POST', '/mcp', { bearer, body: rpc('tools/call', { name: 'list_capabilities', arguments: {} }, 3) });
    add('mcp_capabilities', [200], r3, r3.json?.result?.isError !== true && Array.isArray(r3.json?.result?.content));
  }
  return { ok: checks.every((c) => c.ok), checks };
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validateArgs(a);
  if (errors.length) { for (const e of errors) console.error(e); return 2; }
  let bearer = null;
  if (a.bearerCredential) {
    const { readCredential } = await import('./lib/env-file.mjs');
    try { bearer = (await readCredential(a.bearerCredential.slice('credential:'.length))).trim(); } catch { console.error('bearer credential not readable'); return 1; }
  }
  const r = await runEdgeCheck({ url: a.url, edge: a.edge, bearer });
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const c of r.checks) console.log(`${c.ok ? 'OK  ' : 'NG  '} ${c.id.padEnd(18)} want ${c.want.padEnd(4)} got ${c.got}`);
    console.log(r.ok ? '合格' : '不合格あり（deploy/cloudflare-task-intake/README.md の「NG の時」）');
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
