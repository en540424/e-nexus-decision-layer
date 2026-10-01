/**
 * Knowledge enricher（Vault MA-32-4 / K3・2026-10-01）— Knowledge / Relationship Layer の事実を、判断の材料として decision の input へ添える。
 *
 *   consumer → Gateway → engine（src/gateway/engine.mjs が組み立てる）
 *                          ├─ [この file] policies/knowledge/context-requirements.json に載った decision_type だけ：
 *                          │     1. Rules First：knowledge_context を見ない rule を input だけで評価し、一致すれば Knowledge を問い合わせない
 *                          │     2. 一致しなければ provider（注入）へ Knowledge Context request を渡し、返った context を検査して input.knowledge_context に置く
 *                          └─ Decision Layer core（schema → safety → rules → Jev → … → Human）。core は Knowledge Layer を知らない
 *
 * 責務の境界：
 *   - Knowledge は「何が分かっているか」（事実・経路・鮮度・出所）。判断（安全区分・route・tier）は Rules／Jev。ここは事実を運ぶだけで、
 *     context から判断を作らない（例：「影響範囲が狭いから low」をここで決めない）
 *   - Knowledge Layer を import しない・JSONL／data を読まない。provider port（{ id, version, getContext(request, {signal}) }）だけを知る。
 *     provider の実装は Knowledge Layer 側（Knowledge repo の createKnowledgeContextProvider）で、組み立てる側（SDK・test・script）が注入する。
 *     注入が無ければ何もしない（従来の挙動と同一）
 *   - 取れなかったことを正常へ丸めない：unavailable／subject_not_found／partial と reason、state の unknown／stale をそのまま input に載せる
 *   - provider の返り値は信頼しない：schema・id の形・判断 key・Secret 風の値・大きさ・authority 番号を検査し、通らなければ
 *     unavailable（malformed_response）に置き換える（部分的に使わない）
 *   - Human-only・MA-17・Budget Gate・forbidden keys は core のまま。Knowledge は承認ではなく、何も緩めない
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { readJson, loadDecisionType } from '../schemas/loader.mjs';
import { validate } from '../schemas/validate.mjs';
import { evaluateRules } from '../adapters/rules/rules-adapter.mjs';
import { DecisionLayerError } from '../core/errors.mjs';

export const KNOWLEDGE_CONTEXT_FIELD = 'knowledge_context';
export const KNOWLEDGE_CONTEXT_CONTRACT = 'enexus-knowledge-context-v1';
export const KNOWLEDGE_CONTEXT_REQUEST_CONTRACT = 'enexus-knowledge-context-request-v1';
export const KNOWLEDGE_REQUIREMENTS = Object.freeze(['optional', 'required']);
const TARGET_ENVIRONMENTS = Object.freeze(['dev', 'staging', 'production']);
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_CONTEXT_BYTES = 16384;
const SAFE_ID = /^[a-z][a-z_]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// 判断・承認・推奨を意味する key（Knowledge の返り値に現れたら provider の不具合として受け取らない）
const DECISION_KEYS = /^(approve|approved|approval|authorize|authorized|recommend|recommended|recommendation|best|should|severity|priority|risk|score|rank|decision|decisions|route|recommended_route|allow|allowed|allow_execution|safe|safe_to_proceed|proceed|tier|safety_class|human_review_required|outcome)$/i;
const SECRET_LIKE = [/sk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /\bBearer\s+\S{12,}/i, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const knowledgeField = (k) => k === KNOWLEDGE_CONTEXT_FIELD || k.startsWith(`${KNOWLEDGE_CONTEXT_FIELD}.`);

function rulesOf(decisionType) {
  const rel = join('policies/routing/rules', `${decisionType}.json`);
  return existsSync(join(ROOT, rel)) ? readJson(rel).rules ?? [] : null;
}
const isKnowledgeRule = (rule) => Object.keys(rule.when ?? {}).some(knowledgeField);

/** policies/knowledge/context-requirements.json の検査（起動時に壊れた設定で動かない） */
export function loadKnowledgeRequirements(policy = readJson('policies/knowledge/context-requirements.json'), { safety = readJson('policies/safety/human-only.json') } = {}) {
  const problems = [];
  if (!isObj(policy) || !isObj(policy.decision_types)) throw new Error('knowledge requirements: decision_types が無い');
  for (const [type, e] of Object.entries(policy.decision_types)) {
    const where = `knowledge requirements[${type}]`;
    const dt = loadDecisionType(type);
    if (!dt) { problems.push(`${where}: 未登録の decision_type`); continue; }
    if ((safety.human_only_decision_types ?? []).includes(type)) problems.push(`${where}: Human-only の decision_type に Knowledge を添えない（Adapter を呼ばない型）`);
    if (!isObj(dt.schema?.properties?.input?.properties?.[KNOWLEDGE_CONTEXT_FIELD])) problems.push(`${where}: input schema に ${KNOWLEDGE_CONTEXT_FIELD}（任意 field）が無い`);
    if (!KNOWLEDGE_REQUIREMENTS.includes(e.requirement)) problems.push(`${where}: requirement は ${KNOWLEDGE_REQUIREMENTS.join('|')}`);
    if (!isObj(e.subject) || e.subject.type !== 'project' || e.subject.match !== 'edlRegistryId' || e.subject.from !== 'project_id') problems.push(`${where}: subject は {type:project, match:edlRegistryId, from:project_id}`);
    if (typeof e.environment_from !== 'string' || !dt.schema.properties.input.properties?.[e.environment_from]) problems.push(`${where}: environment_from は input の field`);
    if (!Array.isArray(e.queries) || e.queries.length === 0) problems.push(`${where}: queries が空`);
    const rules = rulesOf(type);
    if (rules) {
      // knowledge を見る rule は input だけの rule の後ろ（Rules First の事前評価と、enrich 後の評価で一致する rule が変わらないため）
      const firstK = rules.findIndex(isKnowledgeRule);
      if (firstK >= 0 && rules.slice(firstK).some((r) => !isKnowledgeRule(r))) problems.push(`${where}: knowledge_context を見る rule は input だけの rule の後ろに置く`);
    }
    if (e.requirement === 'required' && !(rules ?? []).some((r) => Object.keys(r.when ?? {}).includes(`${KNOWLEDGE_CONTEXT_FIELD}.status`))) {
      problems.push(`${where}: required は ${KNOWLEDGE_CONTEXT_FIELD}.status を見る rule（取れないときの扱い）が rules に必要`);
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return policy;
}

/** provider port の形 */
export function assertKnowledgeContextProviderShape(p) {
  const problems = [];
  if (!p || typeof p !== 'object') problems.push('provider is not an object');
  else {
    if (typeof p.id !== 'string' || !SAFE_TOKEN.test(p.id)) problems.push('id missing');
    if (typeof p.version !== 'string' || !p.version) problems.push('version missing');
    if (typeof p.getContext !== 'function') problems.push('getContext() missing');
  }
  if (problems.length) throw new Error(`invalid knowledge context provider: ${problems.join(', ')}`);
  return p;
}

/** Decision Layer 自身が作る「取れなかった」context（provider が答えられなかった・返り値を受け取れなかった） */
export function unavailableKnowledgeContext(environment, reason) {
  return {
    contract: KNOWLEDGE_CONTEXT_CONTRACT, status: 'unavailable', reason, as_of: null,
    environment: TARGET_ENVIRONMENTS.includes(environment) ? environment : null,
    subject: null, facts: {}, authorities: [], warnings: [], omitted: { unsafe_ids: 0, unsafe_values: 0 },
  };
}

function walk(v, fn, path = '$') {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${path}[${i}]`));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { fn(k, x, `${path}.${k}`); walk(x, fn, `${path}.${k}`); }
}

function checkTraversal(name, f, nAuth, errors) {
  if (f.status === 'error') { if (typeof f.error !== 'string' || !SAFE_TOKEN.test(f.error)) errors.push(`${name}.error`); return; }
  if (f.status !== 'ok' || !Array.isArray(f.nodes) || typeof f.truncated !== 'boolean') { errors.push(`${name}: shape`); return; }
  for (const n of f.nodes) {
    if (!isObj(n) || !SAFE_ID.test(n.id ?? '') || !Number.isInteger(n.depth) || !isObj(n.via) || !SAFE_ID.test(n.via.from ?? '') || !SAFE_ID.test(n.via.to ?? '') || !SAFE_TOKEN.test(n.via.type ?? '')) { errors.push(`${name}: node`); continue; }
    for (const a of [n.authority, n.via.authority]) if (!Number.isInteger(a) || a < 0 || a >= nAuth) errors.push(`${name}: authority index`);
    if (!isObj(n.attrs) || Object.values(n.attrs).some((v) => typeof v !== 'string' || !SAFE_TOKEN.test(v))) errors.push(`${name}: attrs`);
  }
}

/**
 * provider の返り値の検査（受け取る側の二重確認）。schema＋形・id・判断 key・Secret／PII 風の値・大きさ。
 * @returns {string[]} 問題（空なら受け取ってよい）
 */
export function checkKnowledgeContext(ctx, { environment } = {}) {
  const schema = readJson('schemas/common/knowledge-context.schema.json');
  const errors = validate(schema, ctx);
  if (errors.length) return errors.slice(0, 10);
  if (environment !== undefined && ctx.environment !== null && ctx.environment !== environment) errors.push('environment が要求と違う');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(ctx), 'utf8'); } catch { return ['JSON にできない']; }
  if (size > MAX_CONTEXT_BYTES) errors.push(`大きすぎる（${size} > ${MAX_CONTEXT_BYTES} bytes）`);
  walk(ctx, (k, v, p) => {
    if (DECISION_KEYS.test(k)) errors.push(`${p}: 判断を意味する key`);
    if (typeof v === 'string' && SECRET_LIKE.some((re) => re.test(v))) errors.push(`${p}: Secret／PII 風の値`);
  });
  const nAuth = ctx.authorities.length;
  if (ctx.subject) {
    if (!SAFE_ID.test(ctx.subject.id) || ctx.subject.authority >= nAuth) errors.push('subject');
    if (Object.values(ctx.subject.attrs).some((v) => !SAFE_TOKEN.test(v))) errors.push('subject.attrs');
  }
  if (ctx.as_of !== null && !ISO.test(ctx.as_of)) errors.push('as_of');
  if (ctx.status === 'ok' || ctx.status === 'partial') {
    if (!ctx.subject) errors.push(`${ctx.status} なのに subject が無い`);
    if (ctx.status === 'ok' && Object.values(ctx.facts).some((f) => f?.status !== 'ok')) errors.push('ok なのに失敗した fact がある');
  } else if (Object.keys(ctx.facts).length) errors.push(`${ctx.status} なのに facts がある`);
  for (const name of ['impact', 'depends_on']) if (ctx.facts[name]) checkTraversal(name, ctx.facts[name], nAuth, errors);
  const st = ctx.facts.states;
  if (st) {
    if (st.status === 'error') { if (typeof st.error !== 'string' || !SAFE_TOKEN.test(st.error)) errors.push('states.error'); }
    if (!isObj(st.coverage) || Object.values(st.coverage).some((v) => !['observed', 'unknown'].includes(v))) errors.push('states.coverage');
    for (const it of st.items ?? []) {
      if (!isObj(it) || typeof it.key !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z]+\.[a-z0-9_]+$/.test(it.key) || !['effective', 'stale', 'unknown'].includes(it.status)) errors.push('states.item');
      else if (!(it.value === null || typeof it.value === 'boolean' || typeof it.value === 'number' || (typeof it.value === 'string' && (SAFE_TOKEN.test(it.value) || ISO.test(it.value))))) errors.push('states.item.value');
    }
  }
  return errors;
}

function refsOf(ctx) {
  const entities = new Set(ctx.subject ? [ctx.subject.id] : []);
  const relations = new Set();
  for (const name of ['impact', 'depends_on']) {
    for (const n of ctx.facts[name]?.nodes ?? []) { entities.add(n.id); relations.add(`${n.via.from} -[${n.via.type}]-> ${n.via.to}`); }
  }
  const states = (ctx.facts.states?.items ?? []).map((x) => `${ctx.subject?.id}#${x.key}`);
  return { entities: [...entities].sort(), relations: [...relations].sort(), states: [...states].sort() };
}

/**
 * @param {object} opts
 * @param {object} opts.provider  Knowledge Context provider（port）。必須（無ければ enricher を作らない＝engine.mjs が従来どおり）
 * @param {object} [opts.policy]  context-requirements（既定は policies/knowledge/context-requirements.json）
 * @param {number} [opts.timeoutMs]  provider を待つ上限（既定 2000ms。Gateway の 30s より十分短く、超えたら unavailable(timeout)）
 */
export function createKnowledgeEnricher({ provider, policy = loadKnowledgeRequirements(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const p = assertKnowledgeContextProviderShape(provider);
  loadKnowledgeRequirements(policy);
  const stats = { requested: 0, not_requested: 0, by_status: {}, rejected: 0, latency_ms: { last: null, max: 0, total: 0 } };

  async function ask(request, environment, signal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort('ABORTED');
    if (signal?.aborted) return unavailableKnowledgeContext(environment, 'aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const raced = await Promise.race([
        Promise.resolve().then(() => p.getContext(request, { signal: ac.signal })).then((v) => ({ v }), () => ({ reason: 'provider_error' })),
        new Promise((resolve) => { timer = setTimeout(() => { ac.abort('TIMEOUT'); resolve({ reason: 'timeout' }); }, timeoutMs); }),
      ]);
      if (raced.reason) return unavailableKnowledgeContext(environment, raced.reason);
      const ctx = raced.v;
      if (isObj(ctx)) delete ctx.problems; // invalid_request の説明文（自由文）は input へ入れない
      const problems = checkKnowledgeContext(ctx, { environment });
      if (problems.length) { stats.rejected += 1; return unavailableKnowledgeContext(environment, 'malformed_response'); }
      return ctx;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @returns {Promise<{ request: object, knowledge: object|null }>}  knowledge は decision 結果へ添える explainability 用の metadata（null＝対象外）
   */
  async function enrich(request, { signal } = {}) {
    const entry = policy.decision_types[request?.decision_type];
    if (!entry) return { request, knowledge: null };
    const input = request.input;
    if (isObj(input) && Object.hasOwn(input, KNOWLEDGE_CONTEXT_FIELD)) {
      // consumer は Knowledge の結果を名乗れない（Gateway も envelope で拒否する。直接 engine を呼ぶ経路の二重確認）
      throw new DecisionLayerError(`input.${KNOWLEDGE_CONTEXT_FIELD} is set by the Decision Layer from the Knowledge Layer, not by the caller`, 'INVALID_ENVELOPE');
    }
    const base = { contract: KNOWLEDGE_CONTEXT_CONTRACT, requirement: entry.requirement, provider: { id: p.id, version: p.version } };
    // 1. Rules First：Knowledge を見ない rule が input だけで決まるなら問い合わせない（schema 不正の input は core が先に止めるので、ここでは評価だけ）
    const rules = rulesOf(request.decision_type);
    const matched = rules && isObj(input) ? evaluateRules(rules.filter((r) => !isKnowledgeRule(r)), input) : null;
    if (matched) {
      stats.not_requested += 1;
      return { request, knowledge: { ...base, requested: false, status: 'not_requested', reason: 'rules_decided', rule_id: matched.id } };
    }
    // 2. Knowledge Context request（判断層が「何が必要か」を決め、Knowledge Layer が答える）
    const environment = isObj(input) ? input[entry.environment_from] : undefined;
    const ctxRequest = {
      contract: KNOWLEDGE_CONTEXT_REQUEST_CONTRACT,
      subject: { type: entry.subject.type, match: entry.subject.match, value: request[entry.subject.from] },
      environment,
      queries: structuredClone(entry.queries),
    };
    const started = Date.now();
    const ctx = TARGET_ENVIRONMENTS.includes(environment) ? await ask(ctxRequest, environment, signal) : unavailableKnowledgeContext(environment, 'invalid_request');
    const latency = Date.now() - started;
    stats.requested += 1;
    stats.by_status[ctx.status] = (stats.by_status[ctx.status] ?? 0) + 1;
    stats.latency_ms.last = latency;
    stats.latency_ms.max = Math.max(stats.latency_ms.max, latency);
    stats.latency_ms.total += latency;
    return {
      request: { ...request, input: { ...input, [KNOWLEDGE_CONTEXT_FIELD]: ctx } },
      knowledge: {
        ...base, requested: true, status: ctx.status, reason: ctx.reason, as_of: ctx.as_of, environment: ctx.environment,
        subject: ctx.subject?.id ?? null, warnings: ctx.warnings, refs: refsOf(ctx), latency_ms: latency,
      },
    };
  }

  function health() {
    return {
      configured: true,
      provider: { id: p.id, version: p.version },
      decision_types: Object.keys(policy.decision_types).sort(),
      timeout_ms: timeoutMs,
      stats: { ...stats, by_status: { ...stats.by_status }, latency_ms: { ...stats.latency_ms } },
    };
  }

  return { enrich, health };
}
