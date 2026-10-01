/**
 * Knowledge Context provider（子 process）と CLI の composition root（Vault MA-32-5・2026-10-02）。Knowledge Layer 本体は使わない（偽の provider script）。
 *   - 場所の決め方：off／dev 以外／EDL_KNOWLEDGE_HOME が使えない（misconfigured＝unavailable を返す）／兄弟フォルダが無い（未設定＝従来と同一）
 *   - 子 process：JSON を渡して受け取るだけ・env は最低限・不正応答／大きすぎる／中断は unavailable・例外を出さない
 *   - CLI：gateway decide／health だけに注入。serve（HTTP）・mcp・run-gateway・deploy は注入しない
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/core/paths.mjs';
import { readJson } from '../src/schemas/loader.mjs';
import { createProcessKnowledgeProvider, resolveKnowledgeProvider, childEnvFor } from '../src/knowledge/process-provider.mjs';

const POLICY = readJson('policies/knowledge/provider.json');
const REQ = { contract: 'enexus-knowledge-context-request-v1', subject: { type: 'project', match: 'edlRegistryId', value: 'e-nexus-decision-layer' }, environment: 'dev', queries: [{ kind: 'impact', depth: 1, max_nodes: 5 }] };
const CTX = { contract: 'enexus-knowledge-context-v1', status: 'ok', reason: null, as_of: '2026-10-02T00:00:00Z', environment: 'dev', subject: { ref: { type: 'project', match: 'edlRegistryId', value: 'e-nexus-decision-layer' }, id: 'project:e-nexus-decision-layer', type: 'project', lifecycle: 'active', attrs: {}, authority: 0 }, facts: {}, authorities: [{ origins: ['deterministic_extraction'], validation: ['unverified'], min_confidence: 1 }], warnings: [], omitted: { unsafe_ids: 0, unsafe_values: 0 } };

function fakeHome(body) {
  const d = mkdtempSync(join(tmpdir(), 'edl-kp-'));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'cli.mjs'), `import fs from 'node:fs';\nlet t='';for await (const c of process.stdin) t+=c;\nfs.writeFileSync('seen.json', JSON.stringify({ request: JSON.parse(t), env: Object.keys(process.env), argv: process.argv.slice(2) }));\n${body}\n`);
  return d;
}
const provFor = (home, extra = {}) => createProcessKnowledgeProvider({ command: process.execPath, args: [join(home, 'src', 'cli.mjs'), 'context'], cwd: home, env: { ...process.env, JEV_API_KEY: 'sk-test-should-not-pass-1234567890', EDL_ALLOW_NETWORK: 'true' }, ...extra });

test('resolve：off／dev 以外は使わない・EDL_KNOWLEDGE_HOME が使えない＝misconfigured（unavailable を返す provider）・兄弟フォルダが無い＝未設定', async () => {
  assert.equal(resolveKnowledgeProvider({ env: { EDL_KNOWLEDGE: 'off' }, environment: 'dev' }).status, 'disabled');
  for (const e of ['staging', 'production']) {
    const r = resolveKnowledgeProvider({ env: {}, environment: e });
    assert.equal(r.status, 'disabled', e);
    assert.equal(r.provider, null);
  }
  const mis = resolveKnowledgeProvider({ env: { EDL_KNOWLEDGE_HOME: join(tmpdir(), 'edl-no-such-knowledge-home') }, environment: 'dev' });
  assert.equal(mis.status, 'misconfigured');
  const ctx = await mis.provider.getContext(REQ);
  assert.deepEqual([ctx.status, ctx.reason], ['unavailable', 'source_unavailable'], '設定したのに使えないことを黙らない');
  const none = resolveKnowledgeProvider({ env: {}, environment: 'dev', policy: { ...POLICY, locate: { ...POLICY.locate, sibling_dir: 'edl-no-such-sibling-dir' } } });
  assert.deepEqual([none.status, none.provider], ['not_found', null], '兄弟フォルダが無い＝従来と同一');
  const home = fakeHome(`process.stdout.write(${JSON.stringify(JSON.stringify(CTX))});`);
  try {
    const ok = resolveKnowledgeProvider({ env: { EDL_KNOWLEDGE_HOME: home }, environment: 'dev' });
    assert.deepEqual([ok.status, ok.source], ['configured', 'env']);
    assert.equal((await ok.provider.getContext(REQ)).status, 'ok');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('process provider：request を stdin で渡し context を受け取る・子 process の env は最低限（Secret を継がせない）・exit code ではなく stdout を読む', async () => {
  const home = fakeHome(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...CTX, status: 'partial' }))}); process.exit(1);`);
  try {
    const ctx = await provFor(home).getContext(REQ);
    assert.equal(ctx.status, 'partial', 'status≠ok の exit 1 でも stdout の context を読む');
    const seen = JSON.parse(readFileSync(join(home, 'seen.json'), 'utf8'));
    assert.deepEqual(seen.request, REQ);
    assert.deepEqual(seen.argv, ['context']);
    assert.ok(!seen.env.some((n) => /^(JEV_|EDL_)/.test(n)), seen.env.join(','));
    assert.deepEqual(Object.keys(childEnvFor({ PATH: 'x', JEV_API_KEY: 'k', EDL_X: '1', SystemRoot: 'C' })).sort(), ['PATH', 'SystemRoot']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('process provider：JSON でない・大きすぎる・起動できない・中断は unavailable（例外を出さない・子 process を止める）', async () => {
  const garbage = fakeHome("process.stdout.write('nope');");
  const big = fakeHome("process.stdout.write('x'.repeat(300000));");
  const hang = fakeHome('setInterval(() => {}, 1000);');
  try {
    assert.equal((await provFor(garbage).getContext(REQ)).reason, 'malformed_response');
    assert.equal((await provFor(big).getContext(REQ)).reason, 'malformed_response');
    const bad = createProcessKnowledgeProvider({ command: join(tmpdir(), 'edl-no-such-binary.exe') });
    assert.equal((await bad.getContext(REQ)).reason, 'provider_error');
    const ac = new AbortController();
    const started = Date.now();
    const p = provFor(hang).getContext(REQ, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    assert.equal(r.reason, 'aborted');
    assert.ok(Date.now() - started < 5000);
    const pre = new AbortController(); pre.abort();
    assert.equal((await provFor(hang).getContext(REQ, { signal: pre.signal })).reason, 'aborted');
  } finally { for (const d of [garbage, big, hang]) rmSync(d, { recursive: true, force: true }); }
});

test('CLI：gateway decide／health は EDL_KNOWLEDGE_HOME の provider を注入する（実 CLI・Jev へは送らない）・EDL_KNOWLEDGE=off で従来と同一', () => {
  const home = fakeHome(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...CTX, subject: { ...CTX.subject, ref: { ...CTX.subject.ref, value: 'e-nexus-crm-core' }, id: 'project:e-nexus-crm-core' } }))});`);
  const usage = join(home, 'usage.jsonl');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, EDL_USAGE_PATH: usage, EDL_KNOWLEDGE_HOME: home };
  const request = { contract_version: '1', expected_environment: 'dev', decision_type: 'automation-safety-gate', application_id: 'claude-code', project_id: 'e-nexus-crm-core', input: { automation_kind: 'workflow', environment: 'dev', target_scope: 'internal-only', external_send: false, paid_api: false, writes_external_system: false, irreversible: false, touches_secrets: false, personal_data: false, existing_gate: 'human-manual', rollback_available: true, rate_or_cap_limited: true, summary: 'cli test' } };
  try {
    const run = (sub, e, input) => JSON.parse(spawnSync(process.execPath, [join(ROOT, 'src', 'cli.mjs'), 'gateway', sub, ...(input ? ['--stdin'] : [])], { input: input ? JSON.stringify(input) : undefined, encoding: 'utf8', env: e }).stdout);
    const d = run('decide', env, request);
    assert.equal(d.ok, true);
    assert.equal(d.decision.knowledge.status, 'ok');
    assert.equal(d.decision.knowledge.provider.id, 'knowledge-process');
    assert.equal(d.decision.tier, 'human', 'Jev が無いので自動にならない');
    const row = JSON.parse(readFileSync(usage, 'utf8').trim().split('\n').pop());
    assert.equal(row.knowledge.status, 'ok');
    assert.ok(!('knowledge' in d.decision.usage), 'envelope の usage は従来の形');
    assert.equal(run('health', env).knowledge_runtime.status, 'configured');
    const off = run('decide', { ...env, EDL_KNOWLEDGE: 'off' }, request);
    assert.ok(!('knowledge' in off.decision));
    const staging = run('health', { ...env, EDL_ENVIRONMENT: 'staging' });
    assert.equal(staging.knowledge_runtime.status, 'disabled', 'CLI の dev 以外は配線しない');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('構造：HTTP Gateway（serve・run-gateway・serve-config）・MCP・deploy は Knowledge provider を組み立てない（LATER）', () => {
  const files = [join(ROOT, 'src', 'gateway', 'http-server.mjs'), join(ROOT, 'src', 'gateway', 'mcp-server.mjs'), join(ROOT, 'src', 'gateway', 'serve-config.mjs'), join(ROOT, 'scripts', 'run-gateway.mjs')];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
  walk(join(ROOT, 'deploy'));
  for (const f of files) assert.ok(!/resolveKnowledgeProvider|process-provider|EDL_KNOWLEDGE/.test(readFileSync(f, 'utf8')), f);
  const cli = readFileSync(join(ROOT, 'src', 'cli.mjs'), 'utf8');
  assert.match(cli, /sub === 'decide' \|\| sub === 'health'/, 'CLI は decide／health だけに注入');
  assert.deepEqual(POLICY.environments, ['dev']);
});
