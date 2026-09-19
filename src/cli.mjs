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
 * 出力は常に JSON（機械可読）。終了コード: 0=成功 / 2=入力・schema エラー / 3=Human Gate 違反 / 1=その他。
 */
import { readFileSync } from 'node:fs';
import { createDecisionLayer, listDecisionTypes, loadRegistry, resolveCandidates, checkRegistries, createFileMeter, summarize, summarizeAttempts } from './index.mjs';
import { HumanGateViolationError, SchemaValidationError, DecisionLayerError } from './core/errors.mjs';

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
      process.stderr.write('usage: decide | types | registry <kind> | registry-check | usage\n');
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
