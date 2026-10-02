/**
 * executor-route × Knowledge（2026-10-03・Vault MA-32 LATER「executor の稼働実測」）。
 *   - 単調性：どの input × どの Knowledge 状態でも、Knowledge は判断を緩めない（human を非 human にしない・review を外さない・
 *     Human-only の結果を変えない）。availability_checked=true は local が effective の時だけ（stale・unknown・ベンダー status だけでは true にしない）
 *   - local と external の優先関係：local unavailable＋external healthy → human／local healthy＋external unavailable → 同じ executor＋review／
 *     local degraded → 同じ executor＋review（human にはしない）
 *   - Gateway 経由（provider 注入）：Human-only は Knowledge を問い合わせない（Rules First）・subject_not_found でも executors で確認できる・
 *     壊れた executors fact は受け取らない（not_checked に倒れる）・Jev を呼ばない
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, loadDecisionType } from '../src/schemas/loader.mjs';
import { validate } from '../src/schemas/validate.mjs';
import { evaluateRules, createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { loadKnowledgeRequirements, checkKnowledgeContext } from '../src/knowledge/knowledge-enricher.mjs';

const RULES = readJson('policies/routing/rules/executor-route.json').rules;
const DT = loadDecisionType('executor-route');
const BOOLS = ['needs_vault_write', 'needs_repo_write', 'needs_browser', 'independent_review', 'touches_secrets', 'paid_api', 'external_send', 'production_change', 'irreversible'];
const HUMAN_ONLY = ['touches_secrets', 'paid_api', 'external_send', 'production_change', 'irreversible'];

function* allInputs() {
  for (const work_center of ['implementation', 'design-judgment', 'reading-comparison-audit', 'operations']) for (const execution_mode of ['interactive', 'long-running', 'scheduled']) for (const environment of ['dev', 'staging', 'production']) {
    for (let m = 0; m < 2 ** BOOLS.length; m += 1) {
      const input = { work_center, execution_mode, environment };
      BOOLS.forEach((b, i) => { input[b] = Boolean(m & (1 << i)); });
      yield input;
    }
  }
}
const side = (status, value, reason = null) => ({ status, value, reason, observed_at: status === 'unknown' ? null : '2026-10-03T00:00:00Z', expires_at: status === 'unknown' ? null : '2026-10-04T00:00:00Z', origin: status === 'unknown' ? null : 'runtime_observation' });
const ctx = (cc, cx, { status = 'ok' } = {}) => ({
  contract: 'enexus-knowledge-context-v1', status, reason: status === 'unavailable' ? 'source_unavailable' : null, as_of: '2026-10-03T00:00:00Z', environment: 'dev',
  subject: status === 'ok' ? { ref: { type: 'project', match: 'edlRegistryId', value: 'e-nexus-decision-layer' }, id: 'project:e-nexus-decision-layer', type: 'project', lifecycle: 'active', attrs: {}, authority: 0 } : null,
  facts: status === 'unavailable' ? {} : { executors: { status: 'ok', items: { 'claude-code': { registry_status: 'active', ...cc }, codex: { registry_status: 'active', ...cx } } } },
  authorities: status === 'ok' ? [{ origins: ['deterministic_extraction'], validation: ['unverified'], min_confidence: 1 }] : [], warnings: [], omitted: { unsafe_ids: 0, unsafe_values: 0 },
});
// ['unknown', 'effective']＝probe が timeout・error だった観測（status は effective・値が unknown）。実際に起こる失敗経路
const LOCALS = [['healthy', 'effective'], ['degraded', 'effective'], ['unavailable', 'effective'], ['unknown', 'effective'], [null, 'unknown'], ['healthy', 'stale'], ['unavailable', 'stale']];
const EXTERNALS = [['healthy', 'effective'], ['unavailable', 'effective'], [null, 'unknown']];
function* contexts() {
  yield { name: 'none', ctx: undefined };
  yield { name: 'unavailable', ctx: ctx(null, null, { status: 'unavailable' }) };
  for (const [lv, ls] of LOCALS) for (const [ev, es] of EXTERNALS) {
    const s = { local: side(ls, lv), external: side(es, ev) };
    yield { name: `cc:${ls}/${lv}+${es}/${ev}`, ctx: ctx(s, s), local: { value: lv, status: ls }, external: { value: ev, status: es } };
  }
}

test('Rules First の順序：Knowledge を見る rule は input だけの rule の後ろ（loader の検査を通る）・Human-only の rule は Knowledge を見ない', () => {
  loadKnowledgeRequirements();
  const firstK = RULES.findIndex((r) => Object.keys(r.when).some((k) => k.startsWith('knowledge_context')));
  assert.ok(firstK > 0);
  assert.ok(RULES.slice(0, firstK).every((r) => r.id.startsWith('human-only-')), 'input だけの rule は Human-only だけ');
  assert.ok(RULES.slice(firstK).every((r) => Object.keys(r.when).some((k) => k.startsWith('knowledge_context'))));
});

test('単調性（反証）：全 input × 全 Knowledge 状態で、Knowledge は判断を緩めない・Human-only は不変・checked は local effective の時だけ・全組み合わせに rules が答える（両 executor は同じ状態。混在〈claude healthy・codex unavailable〉は下の個別 test）', () => {
  const outcomeSchema = DT.schema.properties.outcome;
  let n = 0;
  for (const input of allInputs()) {
    const base = evaluateRules(RULES, input).outcome; // Knowledge 無し
    for (const c of contexts()) {
      n += 1;
      const i2 = c.ctx ? { ...input, knowledge_context: c.ctx } : input;
      const rule = evaluateRules(RULES, i2);
      assert.ok(rule, `rules が答えない: ${c.name}`);
      const o = rule.outcome;
      assert.deepEqual(validate(outcomeSchema, o), [], rule.id);
      if (HUMAN_ONLY.some((k) => input[k]) || (input.environment === 'production' && input.needs_repo_write)) { assert.deepEqual(o, base, `Human-only は Knowledge で変わらない: ${rule.id}`); continue; }
      if (base.recommended_executor === 'human') assert.equal(o.recommended_executor, 'human', 'human を非 human にしない');
      if (base.human_review_required) assert.equal(o.human_review_required, true, 'review を外さない');
      if (o.recommended_executor !== 'human') assert.equal(o.recommended_executor, base.recommended_executor, 'Knowledge で別の executor へ振り替えない');
      if (o.availability_checked) assert.equal(c.local?.status, 'effective', `checked は local が effective の時だけ: ${c.name} ${rule.id}`);
      if (c.local?.status === 'stale' || c.local?.status === 'unknown' || !c.local || c.local.value === 'unknown') assert.equal(o.availability, 'not_checked', `${c.name}`);
      if (c.local?.status === 'effective' && c.local.value === 'unavailable') assert.equal(o.recommended_executor, 'human', 'このノードに無い executor へ振らない');
      if (c.local?.status === 'effective' && c.local.value === 'degraded') { assert.notEqual(o.recommended_executor, 'human', '設定未確認は human にしない'); assert.equal(o.human_review_required, true); }
    }
  }
  assert.equal(n, 4 * 3 * 3 * 2 ** BOOLS.length * (2 + LOCALS.length * EXTERNALS.length));
});

test('local と external は別の事実：local unavailable＋external healthy → human／local healthy＋external unavailable → 同じ executor＋review（vendor_outage）／local healthy＋external unknown → available', () => {
  const base = { work_center: 'implementation', execution_mode: 'interactive', environment: 'dev', needs_repo_write: true };
  const pick = (cc) => evaluateRules(RULES, { ...base, knowledge_context: ctx(cc, cc) }).outcome;
  const a = pick({ local: side('effective', 'unavailable', 'not_installed'), external: side('effective', 'healthy') });
  assert.deepEqual([a.recommended_executor, a.availability, a.availability_checked], ['human', 'local_unavailable', true]);
  const b = pick({ local: side('effective', 'healthy', 'ready'), external: side('effective', 'unavailable') });
  assert.deepEqual([b.recommended_executor, b.availability, b.human_review_required], ['claude-code', 'vendor_outage', true]);
  const c = pick({ local: side('effective', 'healthy', 'ready'), external: side('unknown', null) });
  assert.deepEqual([c.recommended_executor, c.availability, c.availability_checked, c.human_review_required], ['claude-code', 'available', true, false]);
  const d = pick({ local: side('stale', 'healthy', 'ready'), external: side('effective', 'healthy') });
  assert.deepEqual([d.availability, d.availability_checked], ['not_checked', false], 'ベンダーが healthy でも local が古ければ確認していない');
  const r = evaluateRules(RULES, { ...base, independent_review: true, knowledge_context: ctx({ local: side('effective', 'healthy'), external: side('unknown', null) }, { local: side('effective', 'unavailable', 'not_installed'), external: side('unknown', null) }) }).outcome;
  assert.deepEqual([r.recommended_executor, r.availability], ['human', 'local_unavailable'], 'Codex が無ければ独立レビューは Human（同じ系統で代替しない）');
});

test('enricher の検査：executors fact は subject_not_found でも受け取る・壊れた形・判断の key・未知の key は受け取らない', () => {
  const ok = ctx({ local: side('effective', 'healthy'), external: side('unknown', null) }, { local: side('unknown', null), external: side('unknown', null) });
  assert.deepEqual(checkKnowledgeContext(ok, { environment: 'dev' }), []);
  const nf = { ...ok, status: 'subject_not_found', subject: null, authorities: [] };
  assert.deepEqual(checkKnowledgeContext(nf, { environment: 'dev' }), [], 'subject に依存しない fact は subject_not_found でも持てる');
  assert.ok(checkKnowledgeContext({ ...nf, facts: { ...nf.facts, impact: { status: 'ok', nodes: [], truncated: false } } }, { environment: 'dev' }).length > 0, 'subject に依存する fact は持てない');
  const bad = (mut) => { const c = structuredClone(ok); mut(c); return checkKnowledgeContext(c, { environment: 'dev' }).length > 0; };
  assert.ok(bad((c) => { c.facts.executors.items['claude-code'].local.status = 'current'; }));
  assert.ok(bad((c) => { c.facts.executors.items['claude-code'].local.value = 'see https://x y'; }));
  assert.ok(bad((c) => { c.facts.executors.items['claude-code'].recommended = true; }));
  assert.ok(bad((c) => { c.facts.executors.items['claude-code'].extra = 1; }));
  assert.ok(bad((c) => { c.facts.executors.items['Bad Slug'] = c.facts.executors.items.codex; }));
  assert.ok(bad((c) => { c.facts.executors.items['claude-code'].local.reason = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'; }));
});

function engineWith(provider) {
  const calls = { jev: 0, knowledge: 0 };
  const jevProvider = { id: 'count', available: () => ({ ok: true }), async send() { calls.jev += 1; throw new Error('must not be called'); } };
  const wrapped = provider ? { ...provider, async getContext(r, o) { calls.knowledge += 1; return provider.getContext(r, o); } } : undefined;
  const engine = createDecisionLayerEngine({ env: {}, mode: 'production', meter: createMemoryMeter(), adapters: [createRulesAdapter(), createJevAdapter({ env: { EDL_ALLOW_NETWORK: 'true' }, provider: jevProvider }), createHumanAdapter()], ...(wrapped ? { knowledge: { provider: wrapped } } : {}) });
  return { gw: createGateway({ engine, env: {} }), calls };
}
const req = (input, over = {}) => ({ contract_version: '1', decision_type: 'executor-route', application_id: 'claude-code', project_id: 'e-nexus-decision-layer', input, ...over });

test('Gateway 経由（provider 注入）：Human-only は Knowledge を問い合わせない・使える executor は availability_checked=true・subject_not_found でも確認できる・壊れた応答は not_checked・Jev を呼ばない', async () => {
  const good = { local: side('effective', 'healthy', 'ready'), external: side('effective', 'healthy') };
  let next = ctx(good, good);
  const provider = { id: 'fake-knowledge', version: '0', async getContext() { return structuredClone(next); } };
  const { gw, calls } = engineWith(provider);
  const base = { work_center: 'implementation', execution_mode: 'interactive', environment: 'dev', needs_repo_write: true };
  const paid = await gw.decide(req({ ...base, paid_api: true }), { via: 'sdk' });
  assert.equal(paid.decision.outcome.recommended_executor, 'human');
  assert.equal(calls.knowledge, 0, 'Human-only は input だけで決まり Knowledge を問い合わせない');
  const ok = await gw.decide(req(base), { via: 'sdk' });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.deepEqual([ok.decision.outcome.recommended_executor, ok.decision.outcome.availability, ok.decision.outcome.availability_checked], ['claude-code', 'available', true]);
  assert.equal(calls.knowledge, 1);
  next = { ...ctx(good, good), status: 'subject_not_found', subject: null, authorities: [] };
  const nf = await gw.decide(req(base, { project_id: 'en-generate-hub' }), { via: 'sdk' });
  assert.equal(nf.decision.outcome.availability, 'available', '呼び手の project が Knowledge に無くても executor の事実で確認できる');
  next = ctx({ local: side('effective', 'unavailable', 'not_installed'), external: side('effective', 'healthy') }, good);
  const gone = await gw.decide(req(base), { via: 'sdk' });
  assert.deepEqual([gone.decision.outcome.recommended_executor, gone.decision.tier], ['human', 'human']);
  next = { ...ctx(good, good), facts: { executors: { status: 'ok', items: { 'claude-code': { registry_status: 'active', local: { status: 'effective', value: 'healthy', reason: 'ready', observed_at: 'x', expires_at: null, origin: null }, external: good.external } } } } };
  const broken = await gw.decide(req(base), { via: 'sdk' });
  assert.deepEqual([broken.decision.outcome.availability, broken.decision.outcome.availability_checked], ['not_checked', false], '検査に通らない応答は使わない（unavailable に置き換え）');
  assert.equal(calls.jev, 0, 'Jev を呼ばない');
  // consumer が knowledge_context を名乗る request は受け取らない（Knowledge は判断層が付ける）
  const forged = await gw.decide(req({ ...base, knowledge_context: next }), { via: 'cli' });
  assert.equal(forged.ok, false);
});

test('provider を注入しない経路（HTTP・test）でも全 input に rules が答える＝not_checked', async () => {
  const { gw, calls } = engineWith(null);
  const r = await gw.decide(req({ work_center: 'operations', execution_mode: 'scheduled', environment: 'dev' }), { via: 'sdk' });
  assert.deepEqual([r.decision.resolved_by, r.decision.outcome.recommended_executor, r.decision.outcome.availability, r.decision.outcome.human_review_required], ['rules', 'claude-code', 'not_checked', true]);
  assert.equal(calls.jev, 0);
});
