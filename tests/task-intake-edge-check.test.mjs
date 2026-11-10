// 入口の検収（scripts/task-intake-edge-check.mjs・2026-11-10）。loopback の本物の受け口（port 0）と、Cloudflare の WAF を真似た fetch で回す。外へ出ない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startIntake } from '../deploy/vps-task-intake/intake.mjs';
import { parseArgs, runEdgeCheck, validateArgs } from '../scripts/task-intake-edge-check.mjs';

const BOT = `etk_${'1'.repeat(64)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function boot() {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-edge-'));
  const r = await startIntake({ channelKey: Buffer.from('ab'.repeat(32), 'hex'), channel: 'vps-intake', sources: { 'bot-front': { key_sha256: sha(BOT) } }, stateDir: path.join(root, 'state'), port: 0, clock: () => Date.parse('2026-11-10T00:00:00Z'), log: () => {} });
  return { url: `http://127.0.0.1:${r.port}`, close: () => new Promise((res) => { r.server.close(res); }), root };
}

// docs/vps-maintenance.md の WAF の式と同じ：POST /mcp /ack /status・GET /pull /mcp だけを通す
function cloudflare(fetchImpl, { waf = true } = {}) {
  return (u, o) => {
    const p = new URL(u).pathname;
    const pass = (o.method === 'POST' && ['/mcp', '/ack', '/status'].includes(p)) || (o.method === 'GET' && ['/pull', '/mcp'].includes(p));
    if (waf && !pass) return Promise.resolve(new Response('blocked', { status: 403 }));
    return fetchImpl(u, o);
  };
}

test('受け口に直接（--edge none）：認証の前は 401・GET /mcp は 405・他は 404。Bearer があれば読むだけの 3 つも合格', async () => {
  const env = await boot();
  try {
    const r = await runEdgeCheck({ url: env.url, edge: 'none' });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.equal(r.checks.length, 8);
    const b = await runEdgeCheck({ url: env.url, edge: 'none', bearer: BOT });
    assert.equal(b.ok, true, JSON.stringify(b.checks));
    assert.deepEqual(b.checks.slice(-3).map((c) => c.id), ['mcp_initialize', 'mcp_tools', 'mcp_capabilities']);
    const wrong = await runEdgeCheck({ url: env.url, edge: 'none', bearer: `etk_${'9'.repeat(64)}` });
    assert.equal(wrong.ok, false, '違う鍵は initialize が 401');
  } finally { await env.close(); rmSync(env.root, { recursive: true, force: true }); }
});

test('Cloudflare の WAF あり：path・method の外は 403 で合格／WAF が無い（入れ忘れ）は不合格', async () => {
  const env = await boot();
  try {
    const ok = await runEdgeCheck({ url: env.url, edge: 'cloudflare', fetchImpl: cloudflare(globalThis.fetch) });
    assert.equal(ok.ok, true, JSON.stringify(ok.checks));
    const none = await runEdgeCheck({ url: env.url, edge: 'cloudflare', fetchImpl: cloudflare(globalThis.fetch, { waf: false }) });
    assert.equal(none.ok, false);
    assert.deepEqual(none.checks.filter((c) => !c.ok).map((c) => c.id), ['root_blocked', 'mcp_put_blocked', 'pull_post_blocked', 'dotfile_blocked']);
  } finally { await env.close(); rmSync(env.root, { recursive: true, force: true }); }
});

test('届かない・時間切れは不合格（投げない）・本文や鍵を結果に入れない', async () => {
  const r = await runEdgeCheck({ url: 'http://127.0.0.1:9', edge: 'none', bearer: BOT, fetchImpl: () => Promise.reject(new TypeError('fetch failed')) });
  assert.equal(r.ok, false);
  assert.ok(r.checks.every((c) => c.got === 'network'));
  assert.doesNotMatch(JSON.stringify(r), /etk_/);
});

test('引数：https の origin だけ（http は loopback だけ・path・query・認証情報は不可）・bearer は credential: だけ', () => {
  assert.deepEqual(validateArgs(parseArgs(['--url', 'https://intake.example.com'])), []);
  assert.deepEqual(validateArgs(parseArgs(['--url', 'http://127.0.0.1:8796', '--edge', 'none'])), []);
  for (const bad of ['http://intake.example.com', 'https://u:p@intake.example.com', 'https://intake.example.com/mcp', 'https://intake.example.com/?a=1', 'nope']) {
    assert.ok(validateArgs(parseArgs(['--url', bad])).length > 0, bad);
  }
  assert.ok(validateArgs(parseArgs(['--url', 'https://x.example.com', '--bearer-credential', 'etk_123'])).length > 0);
  assert.deepEqual(validateArgs(parseArgs(['--url', 'https://x.example.com', '--bearer-credential', 'credential:E-NEXUS/edl/grok-commander'])), []);
  assert.throws(() => parseArgs(['--bogus']));
});

test('設定の材料：WAF の式は docs と同じ・hostname で始まる・通す経路は試験の Cloudflare の真似と同じ', () => {
  const waf = JSON.parse(readFileSync(new URL('../deploy/cloudflare-task-intake/waf-custom-rule.json', import.meta.url), 'utf8'));
  assert.equal(waf.action, 'block');
  assert.match(waf.expression, /^\(http\.host eq "<HOSTNAME>"\) and not /);
  const sets = [...waf.expression.matchAll(/method eq "(\w+)" and http\.request\.uri\.path in \{([^}]*)\}/g)].map((m) => [m[1], m[2].match(/"[^"]+"/g).map((x) => x.slice(1, -1))]);
  assert.deepEqual(sets, [['POST', ['/mcp', '/ack', '/status']], ['GET', ['/pull', '/mcp']]]);
  const doc = readFileSync(new URL('../docs/vps-maintenance.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.ok(doc.includes('(http.request.method eq "POST" and http.request.uri.path in {"/mcp" "/ack" "/status"}) or (http.request.method eq "GET" and http.request.uri.path in {"/pull" "/mcp"})'));
  const rl = JSON.parse(readFileSync(new URL('../deploy/cloudflare-task-intake/rate-limit-rule.json', import.meta.url), 'utf8'));
  assert.equal(rl.ratelimit.period, 10);
});
