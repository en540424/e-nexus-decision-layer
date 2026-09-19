/**
 * Usage / Cost Metering。
 * 1判定 = 1行の JSONL を追記する（data/usage/usage.jsonl。.gitignore 済み）。
 * 販売アプリの料金設計・原価管理に使うため、初期から以下を必ず持つ:
 *   application_id, project_id, tenant, provider, model, decision_type, request_count,
 *   input_tokens, output_tokens, estimated_cost_usd_micros, fallback_occurred, human_escalation, timestamp
 * 通貨は USD micros（整数）。en-generate-hub の budget.mjs と同じ単位にして転記時の桁ズレを防ぐ。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { ROOT } from '../core/paths.mjs';

export const USAGE_FIELDS = Object.freeze([
  'timestamp', 'decision_id', 'application_id', 'project_id', 'tenant',
  'provider', 'model', 'decision_type', 'resolved_by', 'request_count',
  'input_tokens', 'output_tokens', 'estimated_cost_usd_micros',
  'fallback_occurred', 'human_escalation', 'tier',
]);

export function defaultUsagePath(env = process.env) {
  const p = env.EDL_USAGE_PATH;
  if (p) return isAbsolute(p) ? p : join(ROOT, p);
  return join(ROOT, 'data', 'usage', 'usage.jsonl');
}

export function buildUsageRecord({ request, result, adapter, adapterResult, fallbackOccurred }) {
  const u = adapterResult?.usage ?? {};
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

/** groupBy: 'application_id' | 'project_id' | 'tenant' | 'provider' | 'decision_type' */
export function summarize(rows, groupBy = 'application_id') {
  const out = {};
  for (const r of rows) {
    const key = r[groupBy] ?? '(none)';
    const g = (out[key] ??= { requests: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0, fallbacks: 0, human_escalations: 0, by_provider: {} });
    g.requests += r.request_count ?? 1;
    g.input_tokens += r.input_tokens ?? 0;
    g.output_tokens += r.output_tokens ?? 0;
    g.estimated_cost_usd_micros += r.estimated_cost_usd_micros ?? 0;
    if (r.fallback_occurred) g.fallbacks += 1;
    if (r.human_escalation) g.human_escalations += 1;
    const p = r.provider ?? '(none)';
    g.by_provider[p] = (g.by_provider[p] ?? 0) + 1;
  }
  return out;
}
