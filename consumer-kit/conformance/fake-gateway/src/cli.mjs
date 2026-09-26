#!/usr/bin/env node
// Consumer Integration Kit の fake Gateway（conformance 専用）。
// `gateway decide --stdin` だけを真似し、EDL_FAKE_CASE で ../../transport-cases.json の case を選んで応答する。
// 実 Gateway・Decision Engine・usage.jsonl には一切触れない（外部通信なし・書き込みなし）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'transport-cases.json'), 'utf8'));

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const id = process.env.EDL_FAKE_CASE ?? 'ok-dev';
  let request = null;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep null */ }

  if (id === CASES.echo_case.id) {
    process.stdout.write(JSON.stringify({
      contract_version: '1', ok: true, request_id: 'req_conformance_echo', correlation_id: request?.correlation_id ?? null,
      decision: { decision_type: request?.decision_type ?? null, outcome: {}, tier: 'human', human_gate: { required: true } },
      gateway: { via: 'cli', environment: 'dev', engine: { id: 'fake', version: '0', mode: 'production' } },
      echo: { request, env_keys: Object.keys(process.env).sort(), argv: process.argv.slice(2) },
    }));
    return;
  }
  const c = CASES.gateway_cases.find((x) => x.id === id);
  if (!c) { process.stderr.write(`unknown EDL_FAKE_CASE ${id}\n`); process.exitCode = 1; return; }
  const g = c.gateway;
  if (g.hang) { setTimeout(() => {}, 60000); return; }
  process.stdout.write('raw_stdout' in g ? g.raw_stdout : JSON.stringify(g.stdout));
  if (g.exit_code) process.exitCode = g.exit_code;
});
