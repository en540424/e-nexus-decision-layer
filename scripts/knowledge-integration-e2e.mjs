#!/usr/bin/env node
/**
 * Knowledge Integration の実データ E2E（2026-10-01・Vault MA-32-4）。dev 専用・明示 path（Gateway の配線・deploy には入れない）。
 *
 *   node scripts/knowledge-integration-e2e.mjs --knowledge-layer <e-nexus-knowledge-layer の path> --map <project-integration-map.json の path>
 *
 * Decision Layer は Knowledge Layer を import しない（tests/knowledge-integration.test.mjs が src を検査）。この script だけが組み立て役
 * （composition root）として、引数で渡された Knowledge Layer の provider を engine へ注入する。
 * 確かめること（どれも課金・外部送信なし。Jev は送信しない capture provider・EDL_ALLOW_NETWORK は process env を見ない）：
 *   1. 実 Knowledge → Context → Decision Layer → Jev の request（capture）まで通り、impact の consumer 集合が Map から独立に計算した集合と一致
 *   2. Rules First（rule で決まる input では Knowledge を問い合わせない）
 *   3. failure injection（置き場なし・実測なし・壊れた record・壊れた実測・stale のみ・観測の無い環境・対象なし・timeout・空）で
 *      crash／silent success／false healthy にならない
 *   4. Gateway Contract v1 の envelope・偽造の拒否
 *   5. latency（Knowledge open・enrichment・decision 全体）・Jev 呼び出し回数・Jev request の token 見積もりの増分
 * 終了コード：0＝全 PASS／1＝FAIL あり／2＝引数不正。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, estimateRequestTokens } from '../src/adapters/jev/jev-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { getEntry } from '../src/registries/registry.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const klDir = opt('knowledge-layer');
const mapPath = opt('map');
if (!klDir || !mapPath || !fs.existsSync(path.join(klDir, 'src', 'index.mjs')) || !fs.existsSync(mapPath)) {
  process.stderr.write('usage: node scripts/knowledge-integration-e2e.mjs --knowledge-layer <dir> --map <project-integration-map.json>\n');
  process.exit(2);
}
const kl = await import(pathToFileURL(path.join(klDir, 'src', 'index.mjs')).href);
const KD = path.join(klDir, 'data', 'knowledge');
const SD = path.join(klDir, 'data', 'state');
const results = [];
const verbose = args.includes('--verbose');
const check = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), ...(detail !== undefined ? { detail } : {}) }); if (verbose) process.stderr.write(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ` ${JSON.stringify(detail)}`}
`); };

function capturingJev() {
  const sent = [];
  const provider = {
    id: 'capture', available: () => ({ ok: true }),
    async send({ request }) {
      sent.push(structuredClone(request));
      return { model: 'jev-e2e-0.0', answers: { safety_class: { type: 'choice', choice: 'elevated', confidence: 0.9 }, human_review_required: { type: 'noul', noul: 0.9 }, automation_route: { type: 'choice', choice: 'human-review', confidence: 0.9 } }, usage: { input_tokens: 0, output_tokens: 0 } };
    },
  };
  return { sent, adapter: createJevAdapter({ env: { EDL_ALLOW_NETWORK: 'true' }, provider }) };
}
function engineWith(provider, { timeoutMs } = {}) {
  const jev = capturingJev();
  const engine = createDecisionLayerEngine({
    env: {}, mode: 'production', meter: createMemoryMeter(),
    adapters: [createRulesAdapter(), jev.adapter, createHumanAdapter()],
    ...(provider ? { knowledge: { provider, ...(timeoutMs ? { timeoutMs } : {}) } } : {}),
  });
  return { engine, jev };
}
const input = (over = {}) => ({
  automation_kind: 'workflow', environment: 'dev', target_scope: 'internal-only', external_send: false, paid_api: false,
  writes_external_system: false, irreversible: false, touches_secrets: false, personal_data: false, existing_gate: 'human-manual',
  rollback_available: true, rate_or_cap_limited: true, summary: 'E2E: internal workflow (no send, no paid API).', ...over,
});
const req = (projectId, inp) => ({ decision_type: 'automation-safety-gate', application_id: 'knowledge-e2e', project_id: projectId, input: inp });

// ---- 独立計算：Map から「project P が provides する capability」と「それを consume する project（level を問わない）」
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
function expectedImpact(projectId) {
  const p = map.projects.find((x) => x.id === projectId);
  const caps = [...(p?.provides ?? [])].sort();
  const consumers = map.projects.filter((x) => x.id !== projectId && caps.some((c) => x.capabilities?.[c] && x.capabilities[c].level !== 'NONE')).map((x) => x.id).sort();
  return { caps, consumers, audience: Object.fromEntries(map.projects.map((x) => [x.id, x.audience])) };
}

// ---- 1. 実データの通し
const provider = kl.createKnowledgeContextProvider({ knowledgeDir: KD, stateDir: SD });
const t0 = Date.now();
const cold = await provider.getContext({ contract: 'enexus-knowledge-context-request-v1', subject: { type: 'project', match: 'edlRegistryId', value: 'e-nexus-decision-layer' }, environment: 'dev', queries: [{ kind: 'impact', depth: 1, max_nodes: 5 }] });
const openMs = Date.now() - t0;
check('Knowledge を開ける（実データ）', cold.status === 'ok', { status: cold.status, reason: cold.reason, open_ms: openMs });

const latency = [];
for (const [projectId, env] of [['e-nexus-decision-layer', 'dev'], ['e-nexus-crm-core', 'production'], ['en-generate-hub', 'staging']]) {
  const { engine, jev } = engineWith(provider);
  const s = Date.now();
  const r = await engine.decide(req(projectId, input({ environment: env })));
  latency.push({ projectId, total_ms: Date.now() - s, enrichment_ms: r.knowledge?.latency_ms });
  const ctx = jev.sent[0]?.state?.input?.knowledge_context;
  const exp = expectedImpact(projectId);
  const nodes = ctx?.facts?.impact?.nodes ?? [];
  const gotCaps = nodes.filter((n) => n.depth === 1 && n.type === 'capability').map((n) => n.id.replace(/^capability:/, '')).sort();
  const gotConsumers = nodes.filter((n) => n.depth === 2 && n.type === 'project').map((n) => n.id.replace(/^project:/, '')).sort();
  const truncated = ctx?.facts?.impact?.truncated === true;
  check(`[${projectId}/${env}] Jev へ届く context が実 Knowledge の事実（status ok・環境・subject）`, jev.sent.length === 1 && ctx?.status === 'ok' && ctx.environment === env && ctx.subject?.id === `project:${projectId}`, { status: ctx?.status, jev_calls: jev.sent.length });
  check(`[${projectId}/${env}] impact の提供 capability が Map と一致`, JSON.stringify(gotCaps) === JSON.stringify(exp.caps), { got: gotCaps, expected: exp.caps });
  check(`[${projectId}/${env}] impact の consumer project が Map から独立に計算した集合と一致${truncated ? '（打ち切りあり＝部分集合）' : ''}`,
    truncated ? gotConsumers.every((x) => exp.consumers.includes(x)) : JSON.stringify(gotConsumers) === JSON.stringify(exp.consumers), { got: gotConsumers, expected: exp.consumers, truncated });
  check(`[${projectId}/${env}] audience が Map と一致`, nodes.filter((n) => n.type === 'project').every((n) => n.attrs.audience === exp.audience[n.id.replace(/^project:/, '')]));
  check(`[${projectId}/${env}] 対象環境の観測は unknown のまま（project の実測は local だけ）・local は observed`, ctx?.facts?.states?.coverage?.[env] === 'unknown', ctx?.facts?.states?.coverage);
  check(`[${projectId}/${env}] decision.knowledge は refs だけ（Knowledge の中身を返さない）`, r.knowledge?.status === 'ok' && !('facts' in r.knowledge) && r.knowledge.refs.entities.includes(`project:${projectId}`));
  const without = structuredClone(jev.sent[0]);
  delete without.state.input.knowledge_context;
  const delta = estimateRequestTokens(jev.sent[0]) - estimateRequestTokens(without);
  const price = getEntry('models', 'jev')?.pricing?.input_usd_micros_per_million_tokens ?? null;
  latency[latency.length - 1].context_bytes = Buffer.byteLength(JSON.stringify(ctx), 'utf8');
  latency[latency.length - 1].jev_token_estimate_delta = delta;
  latency[latency.length - 1].jev_cost_estimate_delta_usd_micros = price ? Math.round((delta / 1e6) * price) : null;
}

// ---- 2. Rules First
{
  const counting = { ...provider, calls: 0 };
  const p2 = { id: provider.id, version: provider.version, getContext: (q, o) => { counting.calls += 1; return provider.getContext(q, o); } };
  const { engine, jev } = engineWith(p2);
  const r = await engine.decide(req('e-nexus-crm-core', input({ touches_secrets: true })));
  check('Rules First：rule で決まる input では Knowledge を問い合わせず Jev も呼ばない', counting.calls === 0 && jev.sent.length === 0 && r.knowledge?.status === 'not_requested' && r.knowledge.rule_id === 'touches-secrets');
}

// ---- 3. failure injection（実データのコピーを壊す）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-knowledge-e2e-'));
// fs.cpSync は Windows の Node 24 で process ごと落ちた（0xC0000409・2026-10-01 実測）ため、平らな dir を1段だけ手で写す
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) { const p = path.join(from, n); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(to, n)); } };
const copy = (name) => { const d = path.join(tmp, name.replace(/[^A-Za-z0-9]+/g, '_') + '_' + results.length); copyDir(KD, path.join(d, 'knowledge')); if (fs.existsSync(SD)) copyDir(SD, path.join(d, 'state')); return { kd: path.join(d, 'knowledge'), sd: path.join(d, 'state') }; };
async function inject(name, mk, env, expect) {
  const { kd, sd } = copy(name);
  const opts = mk(kd, sd) ?? {};
  const prov = opts.provider ?? kl.createKnowledgeContextProvider({ knowledgeDir: opts.kd ?? kd, stateDir: opts.sd === null ? undefined : (opts.sd ?? sd), ...(opts.now ? { now: opts.now } : {}) });
  const { engine, jev } = engineWith(prov, { timeoutMs: opts.timeoutMs });
  let r; let crashed = null;
  try { r = await engine.decide(req(opts.project ?? 'e-nexus-crm-core', input({ environment: env }))); } catch (e) { crashed = e.message; }
  const ctx = jev.sent[0]?.state?.input?.knowledge_context;
  const ok = !crashed && expect(r, ctx, jev);
  check(`failure injection：${name}（${env}）`, ok, { crashed, knowledge: r?.knowledge && { status: r.knowledge.status, reason: r.knowledge.reason, warnings: r.knowledge.warnings }, resolved_by: r?.resolved_by, route: r?.outcome?.automation_route, ctx_status: ctx?.status });
}
const notHealthy = (r) => r.knowledge.status !== 'ok';
await inject('Knowledge の置き場が無い', (kd) => ({ kd: path.join(kd, 'nope') }), 'dev', (r, ctx) => notHealthy(r) && r.knowledge.reason === 'source_unavailable' && ctx.status === 'unavailable');
await inject('Knowledge の置き場が無い', (kd) => ({ kd: path.join(kd, 'nope') }), 'production', (r) => r.resolved_by === 'rules' && r.outcome.automation_route === 'human-review' && r.tier === 'human');
await inject('実測の置き場が無い（未 sync のノード）', () => ({ sd: null }), 'dev', (r, ctx) => ctx.status === 'partial' && ctx.facts.states.error === 'source_unavailable' && ctx.warnings.includes('sync_metadata_missing'));
await inject('壊れた Knowledge record', (kd) => { fs.appendFileSync(path.join(kd, 'entities.jsonl'), '{"schema":"enexus-knowledge-entity-v1","id":\n'); }, 'dev', (r) => r.knowledge.status === 'unavailable' && r.knowledge.reason === 'data_integrity_error');
await inject('壊れた実測（MA-32-3 の潜在不具合：client 全体が開かない）', (kd, sd) => { fs.appendFileSync(path.join(sd, 'observations.jsonl'), 'not json\n'); }, 'production', (r) => r.knowledge.reason === 'data_integrity_error' && r.outcome.automation_route === 'human-review');
await inject('stale だけ（全観測が期限切れ）', () => ({ now: '2027-06-01T00:00:00Z' }), 'dev', (r, ctx) => ctx.status === 'ok' && ctx.facts.states.items.length > 0 && ctx.facts.states.items.every((x) => x.status === 'stale') && ctx.warnings.includes('stale_state'));
await inject('観測の無い環境（staging）', () => ({}), 'staging', (r, ctx) => ctx.facts.states.coverage.staging === 'unknown' && !ctx.facts.states.items.some((x) => x.environment === 'staging'));
await inject('対象が Knowledge に無い', () => ({ project: 'no-such-registry-project' }), 'production', (r) => r.knowledge.status === 'subject_not_found' && r.outcome.automation_route === 'human-review');
await inject('timeout', () => ({ provider: { id: 'slow', version: '0', getContext: () => new Promise(() => {}) }, timeoutMs: 50 }), 'dev', (r, ctx) => r.knowledge.reason === 'timeout' && ctx.status === 'unavailable');
await inject('空の Knowledge（実測も空）', (kd) => { for (const f of fs.readdirSync(kd)) fs.writeFileSync(path.join(kd, f), ''); return { sd: null }; }, 'dev', (r) => r.knowledge.status === 'subject_not_found');
await inject('Knowledge を空にして実測だけ残る（実測が無い Entity を指す）', (kd) => { for (const f of fs.readdirSync(kd)) fs.writeFileSync(path.join(kd, f), ''); }, 'dev', (r) => r.knowledge.status === 'unavailable' && r.knowledge.reason === 'data_integrity_error');
await inject('Secret 風の値が混入した Knowledge', (kd) => { fs.appendFileSync(path.join(kd, 'entities.jsonl'), `${JSON.stringify({ schema: 'enexus-knowledge-entity-v1', id: 'service:leak', type: 'service', name: 'leak', attrs: { note: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' }, lifecycle: { status: 'active' }, provenance: [{ origin: 'deterministic_extraction', source: { kind: 'registry', ref: 'x' }, observed_at: '2026-10-01T00:00:00Z', producer: { id: 'knowledge-sync/x', version: '0' }, confidence: 1, validation: 'unverified' }], revision: 1, updated_at: '2026-10-01T00:00:00Z' })}\n`); }, 'dev', (r) => r.knowledge.reason === 'data_integrity_error' && !JSON.stringify(r).includes('sk-ant'));
fs.rmSync(tmp, { recursive: true, force: true });

// ---- 4. Gateway Contract v1
{
  const { engine } = engineWith(provider);
  const gw = createGateway({ engine, env: {} });
  const ok = await gw.decide(req('e-nexus-crm-core', input()), { via: 'sdk' });
  check('Gateway v1：envelope の key は不変・decision.knowledge は任意 field', ok.ok && ok.contract_version === '1' && JSON.stringify(Object.keys(ok).sort()) === JSON.stringify(['contract_version', 'correlation_id', 'decision', 'gateway', 'ok', 'request_id']) && ok.decision.knowledge?.status === 'ok');
  const forged = await gw.decide(req('e-nexus-crm-core', { ...input(), knowledge_context: { contract: 'enexus-knowledge-context-v1', status: 'ok' } }));
  check('Gateway v1：consumer の knowledge_context は INVALID_ENVELOPE（failure human-required）', !forged.ok && forged.error.code === 'INVALID_ENVELOPE' && forged.failure.policy === 'human-required');
  check('engine health に Knowledge の統計（Secret なし）', gw.health().engine_health.knowledge.configured === true && !JSON.stringify(gw.health()).includes(klDir));
}

const failed = results.filter((r) => !r.pass);
process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, passed: results.length - failed.length, total: results.length, latency, provider_stats: provider.stats?.(), results }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
