#!/usr/bin/env node
/**
 * E-NEXUS Decision Layer CLI。IDE / Agent（Claude Code・Cursor・Hermes）からの共通入口。
 *
 *   node src/cli.mjs decide --json '{"decision_type":"paid-generation-gate","application_id":"openmontage","project_id":"openmontage","input":{...}}'
 *   node src/cli.mjs decide --file request.json
 *   node src/cli.mjs types                       decision_type 一覧
 *   node src/cli.mjs registry <projects|skills|agents|models> [--project <id>]
 *   node src/cli.mjs registry-check              4台帳の整合チェック
 *   node src/cli.mjs usage [--by application_id|project_id|tenant|provider|decision_type]
 *                               既存の final-resolver 集計＋ total_*／attempts_by_provider（途中 attempt を含む全 attempt 集計）
 *   node src/cli.mjs usage --attempts [--by provider|model|adapter|route|status|application_id|project_id|tenant|decision_type]
 *                               attempt 単位の集計（final が human でも途中で呼んだ real provider の usage を数える）
 *
 *
 * Common Decision Gateway（2026-09-25。consumer 向けの正式入口。docs/gateway.md）:
 *   node src/cli.mjs gateway decide --stdin | --json '<request>' | --file <request.json>   [--verification]
 *                               Gateway envelope（Common Decision Contract v1）を stdout へ。decision が返せなくても envelope＋failure policy を返す
 *   node src/cli.mjs gateway health [--verification]      version・engine mode・Jev 経路状態（Secret なし）
 *   node src/cli.mjs gateway types                        decision_type 一覧（failure policy 付き）
 *   node src/cli.mjs gateway serve [--host 127.0.0.1] [--port 8787]   HTTP 入口（loopback 以外は EDL_GATEWAY_TOKEN 必須）
 *   node src/cli.mjs gateway mcp                          MCP stdio 入口（接続設定は Human-only）
 *   --verification（または EDL_GATEWAY_MODE=verification）：実 Jev が使えないとき mock-jev を入れる配管検証モード。既定は production（mock 無し）
 *
 * 出力は常に JSON（機械可読）。終了コード: 0=成功 / 2=入力・schema エラー / 3=Human Gate 違反 / 1=その他。
 * gateway decide は envelope.ok=false でも stdout に envelope を出す（consumer は終了コードではなく envelope を読む）。
 */
import { readFileSync } from 'node:fs';
import { createDecisionLayer, listDecisionTypes, loadRegistry, resolveCandidates, checkRegistries, createFileMeter, summarize, summarizeAttempts } from './index.mjs';
import { HumanGateViolationError, SchemaValidationError, DecisionLayerError } from './core/errors.mjs';
import { createGateway } from './gateway/gateway.mjs';
import { createDecisionLayerEngine } from './gateway/engine.mjs';
import { startGatewayServer } from './gateway/http-server.mjs';
import { runMcpStdio } from './gateway/mcp-server.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

const GATEWAY_EXIT = { invalid_request: 2, human_gate_violation: 3 };

async function gatewayCommand(sub, opts) {
  const mode = opts.verification || process.env.EDL_GATEWAY_MODE === 'verification' ? 'verification' : 'production';
  const gateway = createGateway({ engine: createDecisionLayerEngine({ mode }) });
  switch (sub) {
    case 'decide': {
      const raw = opts.stdin ? await readStdin() : (opts.json ?? (opts.file ? readFileSync(opts.file, 'utf8') : null));
      if (raw === null || raw === undefined) throw new SchemaValidationError(['--stdin / --json / --file のいずれかが必要です']);
      let request;
      try { request = JSON.parse(raw); } catch { request = null; } // 不正 JSON も envelope（failure policy 付き）で返す
      const envelope = await gateway.decide(request, { via: 'cli' });
      out(envelope);
      if (!envelope.ok) process.exitCode = GATEWAY_EXIT[envelope.error.kind] ?? 1;
      return;
    }
    case 'health':
      out(gateway.health());
      return;
    case 'types':
      out({ decision_types: gateway.decisionTypes() });
      return;
    case 'serve': {
      const token = process.env.EDL_GATEWAY_TOKEN ? process.env.EDL_GATEWAY_TOKEN : null;
      const server = await startGatewayServer({ gateway, host: opts.host ?? '127.0.0.1', port: Number(opts.port ?? 8787), token });
      const a = server.address();
      process.stderr.write(`${JSON.stringify({ listening: `${a.address}:${a.port}`, auth: token ? 'bearer' : 'none(loopback only)', mode })}\n`);
      return;
    }
    case 'mcp':
      runMcpStdio({ gateway });
      return;
    default:
      process.stderr.write('usage: gateway <decide|health|types|serve|mcp>\n');
      process.exitCode = 2;
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i += 1; } else opts[key] = true;
    } else positional.push(a);
  }
  return { cmd, opts, positional };
}

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main() {
  const { cmd, opts, positional } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'decide': {
      const raw = opts.json ?? (opts.file ? readFileSync(opts.file, 'utf8') : null);
      if (!raw) throw new SchemaValidationError(['--json または --file が必要です']);
      const request = JSON.parse(raw);
      const edl = createDecisionLayer();
      out(await edl.decide(request));
      return;
    }
    case 'gateway':
      await gatewayCommand(positional[0], opts);
      return;
    case 'types':
      out(listDecisionTypes());
      return;
    case 'registry': {
      const kind = positional[0];
      if (!kind) throw new SchemaValidationError(['registry <projects|skills|agents|models>']);
      out(opts.project ? resolveCandidates(kind, { projectId: opts.project }) : loadRegistry(kind));
      return;
    }
    case 'registry-check': {
      const problems = checkRegistries();
      out({ ok: problems.length === 0, problems });
      if (problems.length) process.exitCode = 2;
      return;
    }
    case 'usage': {
      const meter = createFileMeter();
      if (opts.attempts) {
        out({ path: meter.path, unit: 'attempt', summary: summarizeAttempts(meter.readAll(), opts.by ?? 'provider') });
        return;
      }
      out({ path: meter.path, summary: summarize(meter.readAll(), opts.by ?? 'application_id') });
      return;
    }
    default:
      process.stderr.write('usage: decide | gateway <decide|health|types|serve|mcp> | types | registry <kind> | registry-check | usage\n');
      process.exitCode = 2;
  }
}

main().catch((err) => {
  const payload = { error: err.name, code: err.code ?? null, message: err.message, details: err.details ?? null };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (err instanceof HumanGateViolationError) process.exitCode = 3;
  else if (err instanceof SchemaValidationError || (err instanceof DecisionLayerError && err.code === 'UNKNOWN_DECISION_TYPE')) process.exitCode = 2;
  else process.exitCode = 1;
});
