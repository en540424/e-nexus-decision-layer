/**
 * Common Decision Gateway — CLI transport（`gateway decide --stdin`）と MCP stdio を実 subprocess で確認する。
 * en-generate-hub 等の Node 以外／別 repo の consumer が使う process 境界の契約。usage は tmp へ（実 usage.jsonl に書かない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../src/core/paths.mjs';

const CLI = join(ROOT, 'src', 'cli.mjs');

function runGateway(args, stdin, extraEnv = {}) {
  const usage = join(mkdtempSync(join(tmpdir(), 'edl-gw-cli-')), 'usage.jsonl');
  // 親のキー・Network Gate を持ち込まない（テストは常にネットワーク無し）
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EDL_USAGE_PATH: usage, ...extraEnv };
  const r = spawnSync(process.execPath, [CLI, 'gateway', ...args], { input: stdin, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, usage };
}

const request = {
  decision_type: 'paid-generation-gate', application_id: 'en-generate-hub', project_id: 'en-generate-hub',
  correlation_id: 'sha256-abc', input: { asset_kind: 'subtitle', purpose: 'caption' },
};

test('CLI: gateway decide --stdin prints the v1 envelope and records usage with via=cli + correlation_id', () => {
  const r = runGateway(['decide', '--stdin'], JSON.stringify(request));
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.gateway.via, 'cli');
  assert.equal(r.out.gateway.engine.mode, 'production');
  assert.ok(existsSync(r.usage));
  const row = JSON.parse(readFileSync(r.usage, 'utf8').trim().split('\n').pop());
  assert.equal(row.application_id, 'en-generate-hub');
  assert.equal(row.correlation_id, 'sha256-abc');
  assert.equal(row.via, 'cli');
});

test('CLI: malformed stdin still yields an envelope with failure policy on stdout (exit 2)', () => {
  const r = runGateway(['decide', '--stdin'], '{oops');
  assert.equal(r.code, 2);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.failure.human_required, true);
});

test('CLI: --verification switches the engine mode; health shows adapters without secrets', () => {
  const h = runGateway(['health', '--verification'], '', { JEV_API_KEY: 'sk-cli-secret' });
  assert.equal(h.out.engine.mode, 'verification');
  assert.equal(JSON.stringify(h.out).includes('sk-cli-secret'), false);
  const p = runGateway(['health'], '');
  assert.equal(p.out.engine_health.adapters.includes('mock-jev'), false);
});

test('CLI: gateway mcp speaks JSON-RPC over stdio (initialize + tools/list)', async () => {
  const usage = join(mkdtempSync(join(tmpdir(), 'edl-gw-mcp-')), 'usage.jsonl');
  const child = spawn(process.execPath, [CLI, 'gateway', 'mcp'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EDL_USAGE_PATH: usage } });
  let buf = '';
  child.stdout.on('data', (c) => { buf += c.toString('utf8'); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const deadline = Date.now() + 5000;
  while (buf.split('\n').filter(Boolean).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.stdin.end();
  child.kill();
  const msgs = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(msgs[0].result.serverInfo.name, 'e-nexus-decision-gateway');
  assert.ok(msgs[1].result.tools.some((t) => t.name === 'enexus_decide'));
});
