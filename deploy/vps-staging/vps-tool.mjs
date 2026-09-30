#!/usr/bin/env node
/**
 * VPS staging の補助（2026-09-30）。stage.sh が VPS 上の node で呼ぶ。Secret を読まない・出さない。
 *
 *   node vps-tool.mjs render-gateway --repo <R> --env-path <F> --user <U> --port <P> --node <N> --memory-max <M> --out <DIR>
 *   node vps-tool.mjs render-digest  --repo <R> --user <U> --node <N> --hour <H> --minute <M> --out <DIR>
 *   tailscale serve status --json | node vps-tool.mjs serve-parse      → 1 行 1 port：PORT <p> https=<0|1> proxy=<target|-> funnel=<0|1>
 *   … | node vps-tool.mjs json-get <a.b.c>                              → 値（無ければ空）
 *   node vps-tool.mjs usage-check <usage.jsonl>                         → USAGE lines=<n> networked=<n> cost_usd_micros=<n>（有料 0 なら exit 0）
 *
 * unit は deploy 先 checkout の生成関数（scripts/gateway-service.mjs・scripts/scheduled-job-service.mjs）を直接 import して作る
 * （CLI の出力＝コメント行と日本語の登録手順を解析しない）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseServeStatus(json) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json || '{}') : (json ?? {}); } catch { return []; }
  const ports = new Map();
  const at = (p) => {
    if (!ports.has(p)) ports.set(p, { port: p, https: false, proxy: null, funnel: false });
    return ports.get(p);
  };
  for (const [p, v] of Object.entries(j.TCP ?? {})) {
    const e = at(String(p));
    e.https = Boolean(v?.HTTPS);
    if (v?.TCPForward) e.proxy = `tcp://${v.TCPForward}`;
  }
  for (const [hostPort, v] of Object.entries(j.Web ?? {})) {
    const p = String(hostPort).split(':').pop();
    const handlers = v?.Handlers ?? {};
    const h = handlers['/'] ?? Object.values(handlers)[0] ?? {};
    at(p).proxy = h.Proxy ?? (h.Path ? 'path' : h.Text ? 'text' : at(p).proxy);
  }
  for (const [hostPort, on] of Object.entries(j.AllowFunnel ?? {})) {
    if (on) at(String(hostPort).split(':').pop()).funnel = true;
  }
  return [...ports.values()].sort((a, b) => Number(a.port) - Number(b.port));
}

export function formatServe(entries) {
  return entries.map((e) => `PORT ${e.port} https=${e.https ? 1 : 0} proxy=${e.proxy ?? '-'} funnel=${e.funnel ? 1 : 0}`).join('\n');
}

export function jsonGet(obj, dotted) {
  let v = obj;
  for (const k of String(dotted).split('.')) {
    if (v === null || typeof v !== 'object') return '';
    v = v[k];
  }
  return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** usage.jsonl：有料・ネットワーク呼び出しが 0 件か（staging は Jev を切っている） */
export function checkUsage(text) {
  let lines = 0;
  let networked = 0;
  let cost = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    lines += 1;
    cost += Number(row.estimated_cost_usd_micros ?? 0) || 0;
    for (const a of row.attempts ?? []) {
      if (a?.networked) networked += 1;
      cost += Number(a?.estimated_cost_usd_micros ?? 0) || 0;
    }
  }
  return { lines, networked, cost_usd_micros: cost };
}

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    o[argv[i].slice(2)] = argv[i + 1];
  }
  return o;
}

async function load(repo, rel) {
  return import(pathToFileURL(path.join(repo, rel)).href);
}

async function stdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main([cmd, ...rest]) {
  if (cmd === 'render-gateway') {
    const o = opts(rest);
    const { validateServiceArgs, renderService } = await load(o.repo, 'scripts/gateway-service.mjs');
    const a = { target: 'systemd', environment: 'staging', dir: o.repo, envFile: o['env-path'], host: '127.0.0.1', port: Number(o.port), node: o.node, user: o.user, memoryMax: o['memory-max'] };
    const errors = validateServiceArgs(a);
    if (errors.length) { console.error(errors.join('\n')); return 2; }
    const r = renderService(a);
    writeFileSync(path.join(o.out, r.filename), r.content);
    console.log(r.filename);
    return 0;
  }
  if (cmd === 'render-digest') {
    const o = opts(rest);
    const { validateJobArgs, renderJob } = await load(o.repo, 'scripts/scheduled-job-service.mjs');
    const a = { job: 'usage-digest', target: 'systemd', dir: o.repo, node: o.node, environment: 'staging', user: o.user, onAnomaly: 'report', hour: Number(o.hour), minute: Number(o.minute) };
    const errors = validateJobArgs(a);
    if (errors.length) { console.error(errors.join('\n')); return 2; }
    for (const f of renderJob(a).files) { writeFileSync(path.join(o.out, f.filename), f.content); console.log(f.filename); }
    return 0;
  }
  if (cmd === 'serve-parse') {
    const out = formatServe(parseServeStatus(await stdin()));
    if (out) console.log(out);
    return 0;
  }
  if (cmd === 'json-get') {
    let obj = null;
    try { obj = JSON.parse(await stdin()); } catch { obj = null; }
    console.log(jsonGet(obj, rest[0]));
    return 0;
  }
  if (cmd === 'usage-check') {
    const r = checkUsage(existsSync(rest[0]) ? readFileSync(rest[0], 'utf8') : '');
    console.log(`USAGE lines=${r.lines} networked=${r.networked} cost_usd_micros=${r.cost_usd_micros}`);
    return r.networked === 0 && r.cost_usd_micros === 0 ? 0 : 1;
  }
  console.error('usage: vps-tool.mjs <render-gateway|render-digest|serve-parse|json-get|usage-check> …');
  return 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 2; });
