/**
 * Usage / Cost Metering。
 * 1判定 = 1行の JSONL を追記する（data/usage/usage.jsonl。.gitignore 済み）。
 * 販売アプリの料金設計・原価管理に使うため、初期から以下を必ず持つ:
 *   application_id, project_id, tenant, provider, model, decision_type, request_count,
 *   input_tokens, output_tokens, estimated_cost_usd_micros, fallback_occurred, human_escalation, timestamp
 * 通貨は USD micros（整数）。en-generate-hub の budget.mjs と同じ単位にして転記時の桁ズレを防ぐ。
 *
 * 2つの意味を混ぜない（2026-09-19 Intermediate Adapter Metering）:
 *   - top-level の provider / model / resolved_by / input_tokens / output_tokens / estimated_cost_usd_micros
 *       = **final resolver**（decision を確定した Adapter）の usage。従来どおり。final が human なら 0。
 *   - attempts[]   = この decision を解くために adapter.decide() を呼んだ全 attempt（fallback.trace と同じ record の射影）。
 *                    final が human でも、途中で実際に呼んだ real provider（Jev 等）の provider / model / tokens /
 *                    cost / confidence / latency / status / networked をここに残す。
 *   - usage_total  = attempts のうち usage_known なものの合計（**final の分も含む**）。
 *                    top-level usage と usage_total を足すと二重計上になる。片方だけを使うこと。
 *                    unknown_usage_attempts > 0 なら実コストはこの合計より大きい可能性がある（unknown ≠ 0）。
 * 旧 record（attempts / usage_total 無し）はそのまま読める。読み手は attemptsOf() で旧行を final resolver 1 attempt として扱う
 * （旧行で known なのは final resolver の usage だけなので、それ以上を作らない）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { resolveRuntimeEnvironment, DEFAULT_RUNTIME_ENVIRONMENT } from '../core/environment.mjs';

export const USAGE_FIELDS = Object.freeze([
  'timestamp', 'decision_id', 'application_id', 'project_id', 'tenant',
  'provider', 'model', 'decision_type', 'resolved_by', 'request_count',
  'input_tokens', 'output_tokens', 'estimated_cost_usd_micros',
  'fallback_occurred', 'human_escalation', 'tier',
  'attempts', 'usage_total',
  // 2026-09-25 Common Decision Gateway：どの consumer の、どの request が、どの入口から来たか（旧行には無い＝null 扱い）
  'request_id', 'correlation_id', 'via',
  // 2026-09-26 Environment Isolation：どの runtime environment（dev|staging|production）で判定したか。Gateway が付ける（旧行・直接 decide() は null）
  'environment',
]);

/** attempts[] の1要素が持つフィールド（fallback.trace の record から `ms`（latency_ms と同値）だけ落とした射影） */
export const ATTEMPT_FIELDS = Object.freeze([
  'adapter', 'status', 'provider', 'model', 'route', 'confidence', 'tier', 'reason',
  'latency_ms', 'networked', 'usage_known', 'input_tokens', 'output_tokens', 'estimated_cost_usd_micros',
  'retry_count', 'final', 'continue_reason',
]);

/**
 * usage の置き場所。EDL_USAGE_PATH があればそれ。無ければ dev は従来どおり data/usage/usage.jsonl（既存の履歴・証跡 script と互換）、
 * staging / production は data/usage/<environment>/usage.jsonl に分ける（usage / logs の環境分離。技術スタック正本 §3-8-3）。
 */
export function defaultUsagePath(env = process.env) {
  const p = env.EDL_USAGE_PATH;
  if (p) return isAbsolute(p) ? p : join(ROOT, p);
  const environment = resolveRuntimeEnvironment(env);
  if (environment === DEFAULT_RUNTIME_ENVIRONMENT) return join(ROOT, 'data', 'usage', 'usage.jsonl');
  return join(ROOT, 'data', 'usage', environment, 'usage.jsonl');
}

/** fallback.trace（attempt record の配列）→ attempts[]。純粋な射影で、新しい情報は作らない */
export function attemptsFromTrace(trace = []) {
  return trace.map((t) => {
    const a = {};
    for (const f of ATTEMPT_FIELDS) if (f in t) a[f] = t[f];
    if (!('usage_known' in a)) a.usage_known = false; // 想定外の record は unknown 扱い（0 にしない）
    return a;
  });
}

/** attempts[] の合計。usage_known=false の attempt は数えず unknown_usage_attempts に計上する */
export function totalUsage(attempts = []) {
  const t = { attempts: 0, ok_attempts: 0, networked_attempts: 0, unknown_usage_attempts: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0 };
  for (const a of attempts) {
    t.attempts += 1;
    if (a.status === 'ok') t.ok_attempts += 1;
    if (a.networked === true) t.networked_attempts += 1;
    if (a.usage_known === true) {
      t.input_tokens += a.input_tokens ?? 0;
      t.output_tokens += a.output_tokens ?? 0;
      t.estimated_cost_usd_micros += a.estimated_cost_usd_micros ?? 0;
    } else {
      t.unknown_usage_attempts += 1;
    }
  }
  return t;
}

export function buildUsageRecord({ request, result, adapter, adapterResult, fallbackOccurred, trace }) {
  const u = adapterResult?.usage ?? {};
  const attempts = attemptsFromTrace(trace ?? result?.fallback?.trace ?? []);
  return {
    timestamp: result.timestamp,
    decision_id: result.decision_id,
    application_id: request.application_id,
    project_id: request.project_id,
    tenant: request.tenant ?? null,
    provider: adapter?.provider ?? null,
    model: adapter?.model ?? null,
    decision_type: request.decision_type,
    resolved_by: adapter?.id ?? null,
    request_count: 1,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    estimated_cost_usd_micros: u.estimated_cost_usd_micros ?? 0,
    fallback_occurred: Boolean(fallbackOccurred),
    human_escalation: result.tier === 'human',
    tier: result.tier,
    attempts,
    usage_total: totalUsage(attempts),
    request_id: request.request_id ?? null,
    correlation_id: request.correlation_id ?? null,
    via: request.via ?? null,
    environment: request.environment ?? null,
  };
}

export function createFileMeter({ path = defaultUsagePath() } = {}) {
  return {
    path,
    record(rec) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(rec)}\n`, 'utf8');
      return rec;
    },
    readAll() {
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

export function createMemoryMeter() {
  const rows = [];
  return { path: null, record(rec) { rows.push(rec); return rec; }, readAll() { return rows.slice(); } };
}

/**
 * 1行から attempts を取り出す。旧 record（attempts 無し）は「final resolver 1 attempt」として読む
 * （旧行で known なのは final resolver の usage だけ。途中 attempt の情報は無いので作らない）。
 */
export function attemptsOf(row) {
  if (Array.isArray(row?.attempts)) return row.attempts;
  if (!row || typeof row !== 'object') return [];
  return [{
    adapter: row.resolved_by ?? null,
    status: 'ok',
    provider: row.provider ?? null,
    model: row.model ?? null,
    route: null,
    tier: row.tier ?? null,
    latency_ms: null,
    networked: null,
    usage_known: true,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    estimated_cost_usd_micros: row.estimated_cost_usd_micros ?? 0,
    retry_count: null,
    final: true,
    legacy: true,
  }];
}

function emptyGroup() {
  return {
    requests: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0, fallbacks: 0, human_escalations: 0, by_provider: {},
    // ---- attempt-level（2026-09-19 追加。上の final-resolver 集計とは別物。足さない） ----
    total_input_tokens: 0, total_output_tokens: 0, total_estimated_cost_usd_micros: 0,
    attempts: 0, networked_attempts: 0, unknown_usage_attempts: 0,
    attempts_by_provider: {},
  };
}

function emptyProviderBucket() {
  return { attempts: 0, ok: 0, unavailable: 0, networked: 0, unknown_usage: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0 };
}

function addAttempt(bucket, a) {
  bucket.attempts += 1;
  if (a.status === 'ok') bucket.ok += 1; else bucket.unavailable += 1;
  if (a.networked === true) bucket.networked += 1;
  if (a.usage_known === true) {
    bucket.input_tokens += a.input_tokens ?? 0;
    bucket.output_tokens += a.output_tokens ?? 0;
    bucket.estimated_cost_usd_micros += a.estimated_cost_usd_micros ?? 0;
  } else {
    bucket.unknown_usage += 1;
  }
}

/**
 * groupBy: 'application_id' | 'project_id' | 'tenant' | 'provider' | 'decision_type'
 * 既存フィールド（requests / input_tokens / ... / by_provider）は final resolver 基準のまま（互換）。
 * total_* / attempts* / attempts_by_provider は全 attempt 基準（途中で呼んだ real provider を含む）。
 */
export function summarize(rows, groupBy = 'application_id') {
  const out = {};
  for (const r of rows) {
    const key = r[groupBy] ?? '(none)';
    const g = (out[key] ??= emptyGroup());
    g.requests += r.request_count ?? 1;
    g.input_tokens += r.input_tokens ?? 0;
    g.output_tokens += r.output_tokens ?? 0;
    g.estimated_cost_usd_micros += r.estimated_cost_usd_micros ?? 0;
    if (r.fallback_occurred) g.fallbacks += 1;
    if (r.human_escalation) g.human_escalations += 1;
    const p = r.provider ?? '(none)';
    g.by_provider[p] = (g.by_provider[p] ?? 0) + 1;
    for (const a of attemptsOf(r)) {
      g.attempts += 1;
      if (a.networked === true) g.networked_attempts += 1;
      if (a.usage_known === true) {
        g.total_input_tokens += a.input_tokens ?? 0;
        g.total_output_tokens += a.output_tokens ?? 0;
        g.total_estimated_cost_usd_micros += a.estimated_cost_usd_micros ?? 0;
      } else {
        g.unknown_usage_attempts += 1;
      }
      addAttempt((g.attempts_by_provider[a.provider ?? '(none)'] ??= emptyProviderBucket()), a);
    }
  }
  return out;
}

/**
 * attempt 単位の集計。groupBy: 'provider' | 'model' | 'adapter' | 'route' | 'status'（attempt のフィールド）
 *   または 'application_id' | 'project_id' | 'tenant' | 'decision_type'（行のフィールド）。
 * 1 attempt = adapter.decide() 1回。provider 内部の再試行は retry_count であり attempt を増やさない（二重計上しない）。
 */
export function summarizeAttempts(rows, groupBy = 'provider') {
  const out = {};
  for (const r of rows) {
    for (const a of attemptsOf(r)) {
      const key = (groupBy in a ? a[groupBy] : r[groupBy]) ?? '(none)';
      const b = (out[key] ??= { ...emptyProviderBucket(), final: 0, decisions: new Set() });
      addAttempt(b, a);
      if (a.final === true) b.final += 1;
      b.decisions.add(r.decision_id ?? null);
    }
  }
  for (const b of Object.values(out)) b.decisions = b.decisions.size;
  return out;
}
