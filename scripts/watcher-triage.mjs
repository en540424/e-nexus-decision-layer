#!/usr/bin/env node
/**
 * AI Infrastructure Watcher（Vault MA-33-3・repo e-nexus-knowledge-layer の watcher/）の consumer（2026-10-02）。
 * Watcher が作った型付き request（`watcher triage` の出力 data/triage/requests.jsonl：{schema, change_id, request}）を
 * Common Decision Gateway へ 1 件ずつ渡し、envelope を change_id に結び付けて JSONL で出す。Watcher は Decision Layer を import しない・
 * Decision Layer は Watcher を import しない（process 境界と JSON だけ＝構想正本§11）。
 *
 *   node scripts/watcher-triage.mjs --requests <requests.jsonl> [--out <decisions.jsonl>] [--verification]
 *
 * infra-change-triage は rules-reference（catch-all まで rules が答える）：Jev を呼ばない・課金なし・ネットワークなし。
 * envelope は承認ではない（tier=human は Human review）。出力は {change_id, envelope} の JSONL（--out が無ければ stdout）。
 * 終了コード：0＝全件 envelope.ok／1＝ok でない envelope あり（failure policy 付きで出力済み）／2＝引数・入力エラー。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const requestsPath = opt('requests');
if (!requestsPath || !fs.existsSync(requestsPath)) { process.stderr.write('usage: node scripts/watcher-triage.mjs --requests <requests.jsonl> [--out <decisions.jsonl>] [--verification]\n'); process.exit(2); }

const lines = fs.readFileSync(requestsPath, 'utf8').replace(/^﻿/, '').split('\n').filter((l) => l.trim());
const records = [];
for (const [i, l] of lines.entries()) {
  try { records.push(JSON.parse(l)); } catch { process.stderr.write(`line ${i + 1}: malformed JSON\n`); process.exit(2); }
}
for (const [i, r] of records.entries()) {
  if (r?.schema !== 'enexus-watcher-triage-request-v1' || typeof r.change_id !== 'string' || !r.request || r.request.decision_type !== 'infra-change-triage') {
    process.stderr.write(`line ${i + 1}: not a watcher triage request（schema／change_id／decision_type）\n`); process.exit(2);
  }
}

const mode = args.includes('--verification') ? 'verification' : 'production';
const gateway = createGateway({ engine: createDecisionLayerEngine({ mode }) });
const out = [];
let notOk = 0;
for (const r of records) {
  const envelope = await gateway.decide(r.request, { via: 'cli' });
  if (!envelope.ok) notOk += 1;
  out.push({ change_id: r.change_id, request_id: r.id ?? null, envelope });
}
const text = out.map((o) => JSON.stringify(o)).join('\n') + (out.length ? '\n' : '');
if (opt('out')) { fs.mkdirSync(path.dirname(path.resolve(opt('out'))), { recursive: true }); fs.writeFileSync(opt('out'), text, 'utf8'); process.stdout.write(`${JSON.stringify({ ok: notOk === 0, requests: records.length, decided: out.length - notOk, not_ok: notOk, out: opt('out') })}\n`); }
else process.stdout.write(text);
process.exit(notOk === 0 ? 0 : 1);
