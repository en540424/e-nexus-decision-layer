#!/usr/bin/env node
/**
 * 常駐用の起動 wrapper（2026-09-29・FB-05）。service manager が呼ぶ：
 *
 *   node scripts/run-gateway.mjs --env-file <path> [--host 0.0.0.0] [--port 8787]
 *
 * env file（scripts/lib/env-file.mjs の形式）を読み、`credential:` の値を OS 資格情報ストアから解決して process.env へ入れてから、
 * `node src/cli.mjs gateway serve` と同じ処理を同じ process で起動する（Secret を子 process の引数・環境に渡さない）。
 * 起動条件（staging / production は token・pinned release 必須）は gateway serve 側の検証がそのまま効く。
 * このファイルの実行・常駐登録・env file の作成は Human-only（docs/deploy-production-gateway.md）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './lib/env-file.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-file') { out.envFile = argv[i + 1]; i += 1; } else if (argv[i] === '--host' || argv[i] === '--port') { out.rest.push(argv[i], argv[i + 1]); i += 1; } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.envFile) throw new Error('--env-file is required');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnvFile(args.envFile);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  process.argv = [process.argv[0], path.join(ROOT, 'src', 'cli.mjs'), 'gateway', 'serve', ...args.rest];
  await import(pathToFileURL(path.join(ROOT, 'src', 'cli.mjs')).href);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ component: 'edl-gateway-http', event: 'refused_to_start', errors: [err.message] })}\n`);
    process.exitCode = 2;
  });
}
