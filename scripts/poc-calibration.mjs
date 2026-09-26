#!/usr/bin/env node
/**
 * MA-30 PoC Confidence Calibration runner（2026-09-19）。
 *
 * 目的：paid-generation-gate の代表ケース（docs/poc/calibration/*.cases.json）を本番と同じ Engine
 * （Rules First → real Jev → local → llm → human、metering は data/usage/usage.jsonl）に流し、
 * Jev の confidence 分布・question ごとの confidence・latency・tokens・cost を機械可読で保存する。
 *
 *   node scripts/poc-calibration.mjs dry-run [--questions improved|baseline] [--dump <case_id>]
 *       ネットワーク無し。Rules First で確定するケースと、Jev へ送られる questions（送信はしない）を確認する
 *   node scripts/poc-calibration.mjs run --questions improved|baseline [--only A3,B1] [--out <file>]
 *       real Jev。シェルに AI_GATEWAY_API_KEY / JEV_PROVIDER=vercel / EDL_ALLOW_NETWORK=true が export
 *       されているときだけ動く（無ければ exit 4 で止まり、キーの入力は求めない）。各ケース1回・逐次
 *   node scripts/poc-calibration.mjs run --questions improved --only D1-... --offline
 *       ネットワークゼロ。chain は rules → human だけで、Rules に当たらないケースは**実行せずスキップ**する
 *       （Jev を呼ばない・Human escalation も書かない）。Rules First 想定ケースの record をキー無しで揃えるため
 *   node scripts/poc-calibration.mjs analyze [<results.json | dir>...] [--compare <other-results.json>]
 *       引数無しなら docs/poc/calibration/results/ の *.json を全部読む（PowerShell はネイティブ実行ファイルに glob を
 *       展開しないので、Human は引数無しで実行する）。ディレクトリを渡せばその中の *.json。
 *       分布（min / max / median）・route別・ambiguity別・field-level の限界質問・閾値感度を Markdown で出す。
 *       複数ファイルを渡すと variant ごとに統合し（case_id 単位で「最新の成功 record」を採用、失敗 record は成功が無い
 *       case だけ残す）、improved と baseline が両方あれば比較表も出す。成功済み case を再課金せず結果を継ぎ足すための機構
 *
 * --questions:
 *   improved = 現行 schema（outcome field の description / x-enum-descriptions / outcome description = brief を送る）
 *   baseline = それらを外した「2026-09-19 初回実疎通時と同じ」汎用 instructions（A/B 比較用）
 *
 * 安全：API キー・Authorization・生 prompt は保存しない（保存前にキー値の混入を検査する）。Human Gate・閾値・
 * policy・chain は一切変更しない（本番 defaultAdapters と同じ構成で、jev adapter だけ結果を横で写す）。
 * 大量リクエスト禁止：1ケース1回、429 / 認証系エラー / 連続 unavailable で即停止。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecisionEngine } from '../src/core/decision-engine.mjs';
import { loadThresholds, tierFor } from '../src/core/confidence.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, buildJevRequest } from '../src/adapters/jev/jev-adapter.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createFileMeter, createMemoryMeter } from '../src/usage/metering.mjs';
import { loadDecisionType } from '../src/schemas/loader.mjs';
import { realJevUsable } from '../src/index.mjs';
import { resolveJevProvider } from '../src/adapters/jev/jev-provider-interface.mjs';
import { toGatewayModelId } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { checkOutcomeInvariants } from '../src/schemas/invariants.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CASES_PATH = join(ROOT, 'docs', 'poc', 'calibration', 'paid-generation-gate.cases.json');
export const RESULTS_DIR = join(ROOT, 'docs', 'poc', 'calibration', 'results');
const SECRET_ENV_NAMES = ['AI_GATEWAY_API_KEY', 'JEV_API_KEY'];
const STOP_REASONS = new Set(['JEV_RATE_LIMITED', 'JEV_AUTH_FAILED', 'JEV_FORBIDDEN', 'JEV_VERCEL_API_KEY_MISSING', 'JEV_API_KEY_MISSING', 'NETWORK_DISABLED']);

// ---------------------------------------------------------------- cases / question variants

export function loadCases(path = DEFAULT_CASES_PATH) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) throw new Error('cases[] is empty');
  const ids = new Set();
  for (const c of doc.cases) {
    if (!c.case_id || ids.has(c.case_id)) throw new Error(`duplicate or missing case_id: ${c.case_id}`);
    ids.add(c.case_id);
    if (!c.input || typeof c.input !== 'object') throw new Error(`case ${c.case_id}: input missing`);
    if (!c.expected || typeof c.expected !== 'object') throw new Error(`case ${c.case_id}: expected missing`);
  }
  return doc;
}

/** baseline = description / x-enum-descriptions を外した decision type（初回実疎通時と同じ汎用 instructions） */
export function stripQuestionDesign(dt) {
  const copy = structuredClone(dt);
  const outcome = copy?.schema?.properties?.outcome;
  if (outcome) {
    delete outcome.description;
    for (const prop of Object.values(outcome.properties ?? {})) {
      delete prop.description;
      delete prop['x-enum-descriptions'];
    }
  }
  return copy;
}

export function decisionTypeLoaderFor(variant) {
  if (variant === 'improved') return loadDecisionType;
  if (variant === 'baseline') return (id) => stripQuestionDesign(loadDecisionType(id));
  throw new Error(`unknown --questions variant: ${variant} (improved|baseline)`);
}

/** jev adapter を包み、decide() の生の結果（field_confidence・outcome）を横で写す。id / kind / provider / model は同じ */
export function wrapJevAdapter(inner, capture) {
  return {
    id: inner.id,
    kind: inner.kind,
    provider: inner.provider,
    model: inner.model,
    get route() { return inner.route; },
    supports: (dt) => inner.supports(dt),
    async decide(args) {
      capture.current = null;
      try {
        const r = await inner.decide(args);
        capture.current = { ok: true, outcome: r.outcome, confidence: r.confidence, field_confidence: r.field_confidence ?? null, rationale: r.rationale ?? null, invariant_violations: r.invariant_violations ?? null, derived_fields: r.derived_fields ?? null };
        return r;
      } catch (err) {
        const d = err?.details ?? {};
        // 診断は allowlist（数値・短い識別子のみ）。message / body / headers / キーは写さない
        const diagnostic = {};
        for (const k of ['status', 'retryable', 'retry_count', 'retry_reason', 'error_name', 'error_type', 'detail']) {
          if (typeof d[k] === 'number' || typeof d[k] === 'boolean' || (typeof d[k] === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(d[k]))) diagnostic[k] = d[k];
        }
        capture.current = { ok: false, reason: d.reason ?? `ERROR:${err?.name ?? 'unknown'}`, diagnostic };
        throw err;
      }
    },
  };
}

export function requestFor(doc, c) {
  return { decision_type: doc.decision_type, application_id: doc.application_id, project_id: doc.project_id, input: structuredClone(c.input) };
}

function limitingField(fieldConfidence) {
  if (!fieldConfidence) return null;
  const entries = Object.entries(fieldConfidence);
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0][0];
}

// ---------------------------------------------------------------- run

function assertNoSecrets(text, env) {
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.length >= 8 && text.includes(v)) {
      throw new Error(`refusing to write results: value of ${name} would be included`);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** @param {object} [opts.provider] テスト専用：Jev Provider を注入（実ネットワークを使わずに runner を検証する）。本番 run では省略 */
export async function runCases({ doc, variant, only = null, env = process.env, meter = createFileMeter(), delayMs = 300, pauseAfterRetryableMs = 5000, log = () => {}, provider = null, offline = false }) {
  const capture = {};
  const rules = createRulesAdapter();
  const jev = wrapJevAdapter(createJevAdapter({ env, provider, decisionTypeLoader: decisionTypeLoaderFor(variant) }), capture);
  // 本番 defaultAdapters() と同じ構成。realJevUsable() が真なので mock-jev は入らない（呼び出し側で保証する）。
  // offline は rules → human だけ（Rules に当たらないケースは下で実行前にスキップするので human にも到達しない）
  const engine = createDecisionEngine({ adapters: offline ? [rules, createHumanAdapter()] : [rules, jev, createLocalAdapterStub(), createLlmAdapterStub({ env }), createHumanAdapter()], meter });
  const thresholds = loadThresholds(doc.decision_type);
  const selected = only ? doc.cases.filter((c) => only.includes(c.case_id)) : doc.cases;
  const records = [];
  let consecutiveUnavailable = 0;
  let stopped = null;
  const skipped_offline = [];
  for (const c of selected) {
    const started = Date.now();
    if (offline) {
      // 実行前に rules だけで判定。当たらなければ何も呼ばず・何も書かずスキップ（Jev も Human escalation も発生させない）
      let hit = true;
      try { await rules.decide({ decisionType: doc.decision_type, input: c.input, candidates: [], context: {} }); } catch { hit = false; }
      if (!hit) { skipped_offline.push(c.case_id); log(`${c.case_id}: skipped (offline, no rule matched — would need Jev)`); continue; }
    }
    const result = await engine.decide(requestFor(doc, c));
    const jevAttempt = result.fallback.trace.find((a) => a.adapter === 'jev') ?? null;
    const rulesHit = result.resolved_by === 'rules';
    const jevCapture = capture.current;
    const rec = {
      case_id: c.case_id,
      category: c.category,
      variant,
      input: c.input,
      expected: c.expected,
      decision_id: result.decision_id,
      rules_first_hit: rulesHit,
      jev_called: Boolean(jevAttempt),
      final: {
        resolved_by: result.resolved_by,
        tier: result.tier,
        confidence: result.confidence,
        outcome: result.outcome,
        human_escalation: result.tier === 'human',
        human_gate: result.human_gate,
        rationale: result.rationale,
      },
      jev: jevAttempt ? {
        status: jevAttempt.status,
        provider: jevAttempt.provider,
        model: jevAttempt.model,
        route: jevAttempt.route,
        confidence: jevAttempt.confidence ?? null,
        tier: jevAttempt.tier ?? null,
        reason: jevAttempt.reason ?? null,
        latency_ms: jevAttempt.latency_ms,
        networked: jevAttempt.networked,
        usage_known: jevAttempt.usage_known,
        input_tokens: jevAttempt.input_tokens,
        output_tokens: jevAttempt.output_tokens,
        estimated_cost_usd_micros: jevAttempt.estimated_cost_usd_micros,
        retry_count: jevAttempt.retry_count,
        final: jevAttempt.final,
        continue_reason: jevAttempt.continue_reason ?? null,
        outcome: jevCapture?.ok ? jevCapture.outcome : null,
        field_confidence: jevCapture?.ok ? jevCapture.field_confidence : null,
        limiting_field: jevCapture?.ok ? limitingField(jevCapture.field_confidence) : null,
        adapter_invariant_violations: jevCapture?.ok ? jevCapture.invariant_violations : null,
        derived_fields: jevCapture?.ok ? jevCapture.derived_fields : null,
        diagnostic: jevCapture && !jevCapture.ok ? jevCapture.diagnostic : null,
      } : null,
      trace: result.fallback.trace,
      skipped: result.fallback.skipped,
      usage_record: result.usage,
      wall_ms: Date.now() - started,
    };
    records.push(rec);
    log(`${c.case_id}: resolved_by=${result.resolved_by} tier=${result.tier}${jevAttempt ? ` jev=${jevAttempt.status}${jevAttempt.status === 'ok' ? ` conf=${jevAttempt.confidence.toFixed(3)} limiting=${rec.jev.limiting_field}` : ` reason=${jevAttempt.reason} status=${rec.jev.diagnostic?.status ?? '-'} retry=${rec.jev.diagnostic?.retry_count ?? '-'} ${rec.jev.diagnostic?.error_name ?? ''}`} ${jevAttempt.latency_ms}ms` : ' (jev not called)'}`);
    if (jevAttempt && jevAttempt.status !== 'ok') {
      consecutiveUnavailable += 1;
      if (STOP_REASONS.has(jevAttempt.reason) || consecutiveUnavailable >= 2) {
        stopped = { after_case: c.case_id, reason: jevAttempt.reason, consecutive_unavailable: consecutiveUnavailable, diagnostic: rec.jev.diagnostic };
        break;
      }
      // retryable な失敗（5xx / timeout 等。SDK が既に 2s→4s で再試行済み）の直後は連打せず一呼吸置く（1 回だけ。固定 sleep の乱用はしない）
      if (rec.jev.diagnostic?.retryable === true && delayMs) await sleep(pauseAfterRetryableMs);
    } else consecutiveUnavailable = 0;
    if (delayMs) await sleep(delayMs);
  }
  return { thresholds, records, stopped, skipped_offline };
}

function providerSummary(env) {
  try {
    const p = resolveJevProvider(env);
    return { route: p.id, model_id: p.id === 'vercel' ? toGatewayModelId(env) : (env.JEV_MODEL || 'jev-latest'), zdr: env.JEV_ZDR === 'true' };
  } catch (err) {
    return { route: env.JEV_PROVIDER ?? null, error: err?.details?.reason ?? err?.message ?? 'unknown' };
  }
}

async function cmdRun(opts, env) {
  const variant = opts.questions ?? 'improved';
  decisionTypeLoaderFor(variant);
  const doc = loadCases(opts.cases ?? DEFAULT_CASES_PATH);
  const offline = opts.offline === true;
  if (!offline && !realJevUsable(env)) {
    process.stderr.write([
      'real Jev route is not usable in this shell (key / JEV_PROVIDER / EDL_ALLOW_NETWORK not exported).',
      'Human Required: run this command in your own shell where AI_GATEWAY_API_KEY, JEV_PROVIDER=vercel and',
      'EDL_ALLOW_NETWORK=true are exported. Do not paste the key anywhere. Nothing was sent.',
      '',
    ].join('\n'));
    process.exitCode = 4;
    return;
  }
  const only = opts.only ? String(opts.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const meter = createFileMeter();
  const startedAt = new Date();
  if (offline && !only) throw new Error('--offline requires --only <rules-first case ids>');
  const { thresholds, records, stopped, skipped_offline } = await runCases({ doc, variant, only, env, meter, offline, log: (m) => process.stderr.write(`${m}\n`) });
  const out = {
    schema: 'edl-poc-calibration-v1',
    decision_type: doc.decision_type,
    variant,
    label: opts.label ? String(opts.label) : null,
    cases_path: opts.cases ? String(opts.cases) : null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    node: process.version,
    provider: offline ? { route: 'offline', note: 'rules → human only; no network; non-rules cases skipped' } : providerSummary(env),
    thresholds,
    usage_path: meter.path,
    cases_total: records.length,
    stopped,
    ...(offline ? { offline: true, skipped_offline } : {}),
    records,
  };
  const text = JSON.stringify(out, null, 2);
  assertNoSecrets(text, env);
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const outPath = opts.out ? resolve(String(opts.out)) : join(RESULTS_DIR, `${stamp}-${opts.label ? String(opts.label).replace(/[^A-Za-z0-9_.-]/g, '_') : variant}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${text}\n`, 'utf8');
  process.stderr.write(`\nwrote ${outPath}\n`);
  process.stdout.write(`${analyzeToMarkdown(out)}\n`);
}

// ---------------------------------------------------------------- dry-run

export async function dryRun({ doc, variant, dump = null }) {
  const loader = decisionTypeLoaderFor(variant);
  const engine = createDecisionEngine({ adapters: [createRulesAdapter(), createHumanAdapter()], meter: createMemoryMeter() });
  const dt = loader(doc.decision_type);
  const lines = [];
  let rules = 0;
  for (const c of doc.cases) {
    const result = await engine.decide(requestFor(doc, c));
    const hit = result.resolved_by === 'rules';
    if (hit) rules += 1;
    const ruleId = hit ? (result.rationale ?? '').split(' — ')[0] : null;
    const { request } = buildJevRequest({ decisionType: doc.decision_type, outcomeSchema: dt.schema.properties.outcome, input: c.input, candidates: [] });
    lines.push({
      case_id: c.case_id,
      rules_first_hit: hit,
      rule: ruleId,
      expected_resolver: c.expected.resolver,
      matches_expectation: (hit ? 'rules' : 'jev') === c.expected.resolver,
      would_send_questions: hit ? 0 : Object.keys(request.questions).length,
      instruction_chars: Object.values(request.questions).reduce((n, q) => n + (q.instructions?.length ?? 0), 0),
      brief_chars: request.state.brief?.length ?? 0,
      request: dump === c.case_id ? request : undefined,
    });
  }
  return { variant, rules_first: rules, jev_candidates: doc.cases.length - rules, cases: lines };
}

// ---------------------------------------------------------------- merge（複数 results → variant ごとに最新成功 record）

/** results ファイル群を variant ごとに統合する。case_id 単位で「最新の成功（rules hit または jev ok）」を採用し、
 *  成功が無い case は最新の失敗 record を残す。返り値は { [variant]: out相当 }。新しい情報は作らない */
export function mergeResults(outs) {
  const byVariant = {};
  const sorted = [...outs].sort((a, b) => String(a.started_at ?? '').localeCompare(String(b.started_at ?? '')));
  for (const out of sorted) {
    const v = out.label ?? out.variant ?? '(none)';
    const g = (byVariant[v] ??= { variant: v, label: out.label ?? null, thresholds: out.thresholds, decision_type: out.decision_type, provider: out.provider, sources: [], records: new Map(), started_at: out.started_at, finished_at: out.finished_at, stopped: null });
    g.sources.push(out.started_at ?? '(unknown)');
    g.finished_at = out.finished_at ?? g.finished_at;
    g.thresholds = out.thresholds ?? g.thresholds;
    for (const r of out.records ?? []) {
      const ok = r.rules_first_hit || r.jev?.status === 'ok';
      const prev = g.records.get(r.case_id);
      const prevOk = prev && (prev.rules_first_hit || prev.jev?.status === 'ok');
      if (!prev || ok || !prevOk) g.records.set(r.case_id, { ...r, source_started_at: out.started_at ?? null });
    }
  }
  const result = {};
  for (const [v, g] of Object.entries(byVariant)) {
    result[v] = { ...g, merged: true, records: [...g.records.values()], cases_total: g.records.size };
  }
  return result;
}

/** analyze の入力解決：引数無し → RESULTS_DIR の *.json、ディレクトリ → その中の *.json、ファイルはそのまま。glob は展開しない */
export function resolveResultFiles(args = [], resultsDir = RESULTS_DIR) {
  const inputs = args.length ? args : [resultsDir];
  const files = [];
  for (const a of inputs) {
    const abs = resolve(String(a));
    if (!existsSync(abs)) throw new Error(`not found: ${a}`);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).filter((n) => n.endsWith('.json')).sort()) files.push(join(abs, name));
    } else files.push(abs);
  }
  if (!files.length) throw new Error('no results json found');
  return files;
}

// ---------------------------------------------------------------- analyze

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
function stats(xs) {
  if (!xs.length) return { n: 0, min: null, max: null, median: null, mean: null };
  return { n: xs.length, min: r3(Math.min(...xs)), max: r3(Math.max(...xs)), median: r3(median(xs)), mean: r3(xs.reduce((a, b) => a + b, 0) / xs.length) };
}
function groupStats(records, keyFn) {
  const groups = {};
  for (const r of records) (groups[keyFn(r)] ??= []).push(r.jev.confidence);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, stats(v)]));
}

/**
 * 制約評価（2026-09-26 実JEV Calibration）。唯一の正解ではなく「満たすべき制約」で見る：
 *   acceptable_ok  = expected.acceptable の全 field で、outcome の値が許容集合に入っている
 *   unacceptable   = expected.unacceptable のどれかに当たった field（事実・方針と衝突する回答）
 *   invariants     = outcome schema の x-outcome-invariants のうち破られたもの（自己矛盾）
 * 評価対象は Jev の生 outcome（jev ok のとき）か rules の outcome。Jev が失敗したケースは null。
 */
export function evaluateConstraints(decisionType, outcome, expected = {}, input = {}) {
  if (!outcome) return null;
  const outcomeSchema = loadDecisionType(decisionType)?.schema?.properties?.outcome;
  const accMiss = Object.entries(expected.acceptable ?? {}).filter(([f, vals]) => !vals.includes(outcome[f])).map(([f]) => f);
  const unaccHit = Object.entries(expected.unacceptable ?? {}).filter(([f, vals]) => vals.includes(outcome[f])).map(([f]) => f);
  const violated = checkOutcomeInvariants(outcomeSchema, outcome, input);
  return { acceptable_ok: accMiss.length === 0, acceptable_missed: accMiss, unacceptable_hit: unaccHit, invariant_violations: violated, pass: accMiss.length === 0 && unaccHit.length === 0 && violated.length === 0 };
}

export function analyze(out) {
  const thresholds = out.thresholds;
  const records = out.records ?? [];
  const rulesFirst = records.filter((r) => r.rules_first_hit);
  const jevOk = records.filter((r) => r.jev?.status === 'ok');
  const jevFailed = records.filter((r) => r.jev && r.jev.status !== 'ok');
  const confidences = jevOk.map((r) => r.jev.confidence);
  const tierDist = { auto: 0, review: 0, human: 0 };
  for (const r of jevOk) tierDist[tierFor(r.jev.confidence, thresholds)] += 1;

  // field-level
  const fieldNames = new Set();
  for (const r of jevOk) for (const k of Object.keys(r.jev.field_confidence ?? {})) fieldNames.add(k);
  const perField = {};
  for (const f of fieldNames) perField[f] = stats(jevOk.map((r) => r.jev.field_confidence?.[f]).filter((v) => typeof v === 'number'));
  const limiting = {};
  for (const r of jevOk) if (r.jev.limiting_field) limiting[r.jev.limiting_field] = (limiting[r.jev.limiting_field] ?? 0) + 1;

  // 閾値感度（解釈用。閾値変更の根拠にはしない）：min 以外の合成を使ったら tier がどうなるか
  const altAggregates = { mean: { auto: 0, review: 0, human: 0 }, second_min: { auto: 0, review: 0, human: 0 }, without_human_review_required: { auto: 0, review: 0, human: 0 } };
  for (const r of jevOk) {
    const fc = r.jev.field_confidence ?? {};
    const vals = Object.values(fc);
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sorted = [...vals].sort((a, b) => a - b);
    const secondMin = sorted[Math.min(1, sorted.length - 1)];
    const without = Object.entries(fc).filter(([k]) => k !== 'human_review_required').map(([, v]) => v);
    altAggregates.mean[tierFor(mean, thresholds)] += 1;
    altAggregates.second_min[tierFor(secondMin, thresholds)] += 1;
    altAggregates.without_human_review_required[tierFor(without.length ? Math.min(...without) : 1, thresholds)] += 1;
  }

  // expectation comparison
  const comparison = records.map((r) => {
    const exp = r.expected ?? {};
    const outcome = r.jev?.status === 'ok' ? r.jev.outcome : (r.rules_first_hit ? r.final.outcome : null);
    const route = outcome?.recommended_route ?? null;
    const expRoute = String(exp.route ?? '');
    const routeMatch = route == null ? null : expRoute.startsWith('either:') ? expRoute.slice(7).split('|').includes(route) : expRoute === route;
    const resolverActual = r.rules_first_hit ? 'rules' : (r.jev ? 'jev' : r.final.resolved_by);
    const constraints = evaluateConstraints(out.decision_type, outcome, exp, r.input);
    return {
      constraints,
      jev_outcome: r.jev?.status === 'ok' ? r.jev.outcome : null,
      field_confidence: r.jev?.field_confidence ?? null,
      case_id: r.case_id,
      ambiguity: exp.ambiguity ?? null,
      resolver_expected: exp.resolver ?? null,
      resolver_actual: resolverActual,
      route_expected: exp.route ?? null,
      route_actual: route,
      route_match: routeMatch,
      human_review_expected: exp.human_review ?? null,
      human_review_actual: outcome?.human_review_required ?? null,
      paid_expected: exp.paid_generation ?? null,
      paid_actual: outcome?.paid_generation_required ?? null,
      jev_confidence: r.jev?.confidence ?? null,
      jev_tier: r.jev?.status === 'ok' ? tierFor(r.jev.confidence, thresholds) : null,
      limiting_field: r.jev?.limiting_field ?? null,
      final_tier: r.final.tier,
      final_resolved_by: r.final.resolved_by,
    };
  });

  const latency = stats(jevOk.map((r) => r.jev.latency_ms));
  const inputTokens = jevOk.reduce((n, r) => n + (r.jev.input_tokens ?? 0), 0);
  const outputTokens = jevOk.reduce((n, r) => n + (r.jev.output_tokens ?? 0), 0);
  const cost = jevOk.reduce((n, r) => n + (r.jev.estimated_cost_usd_micros ?? 0), 0);

  // metering check（§19）：final=human でも jev attempt が usage_record.attempts[] に残るか
  const metering = records.map((r) => {
    const attempts = r.usage_record?.attempts ?? [];
    const jevInUsage = attempts.find((a) => a.adapter === 'jev') ?? null;
    return {
      case_id: r.case_id,
      final_resolved_by: r.usage_record?.resolved_by ?? null,
      top_level_cost: r.usage_record?.estimated_cost_usd_micros ?? null,
      attempts: attempts.length,
      jev_attempt_recorded: Boolean(jevInUsage),
      jev_attempt_networked: jevInUsage?.networked ?? null,
      jev_attempt_usage_known: jevInUsage?.usage_known ?? null,
      jev_attempt_model: jevInUsage?.model ?? null,
      usage_total_cost: r.usage_record?.usage_total?.estimated_cost_usd_micros ?? null,
      networked_attempts: r.usage_record?.usage_total?.networked_attempts ?? null,
      unknown_usage_attempts: r.usage_record?.usage_total?.unknown_usage_attempts ?? null,
    };
  });

  const jevCmp = comparison.filter((c) => c.resolver_actual === 'jev' && c.constraints);
  const constraintSummary = {
    jev_evaluated: jevCmp.length,
    jev_pass: jevCmp.filter((c) => c.constraints.pass).length,
    jev_acceptable_ok: jevCmp.filter((c) => c.constraints.acceptable_ok).length,
    jev_unacceptable_hits: jevCmp.filter((c) => c.constraints.unacceptable_hit.length).length,
    jev_contradictions: jevCmp.filter((c) => c.constraints.invariant_violations.length).length,
    jev_human_final: jevCmp.filter((c) => c.final_tier === 'human').length,
    rules_evaluated: comparison.filter((c) => c.resolver_actual === 'rules' && c.constraints).length,
    rules_pass: comparison.filter((c) => c.resolver_actual === 'rules' && c.constraints?.pass).length,
    invariant_violation_counts: jevCmp.flatMap((c) => c.constraints.invariant_violations).reduce((m, id) => ({ ...m, [id]: (m[id] ?? 0) + 1 }), {}),
  };
  return {
    variant: out.variant,
    label: out.label ?? null,
    decision_type: out.decision_type,
    constraints: constraintSummary,
    thresholds,
    counts: { cases: records.length, rules_first: rulesFirst.length, jev_ok: jevOk.length, jev_failed: jevFailed.length, stopped: out.stopped ?? null },
    confidence: stats(confidences),
    tier_distribution_at_current_thresholds: tierDist,
    by_expected_route: groupStats(jevOk, (r) => r.expected?.route ?? '(none)'),
    by_ambiguity: groupStats(jevOk, (r) => r.expected?.ambiguity ?? '(none)'),
    by_jev_route: groupStats(jevOk, (r) => r.jev.outcome?.recommended_route ?? '(none)'),
    per_field: perField,
    limiting_field_counts: limiting,
    alt_aggregate_tiers_interpretation_only: altAggregates,
    latency_ms: latency,
    tokens: { input: inputTokens, output: outputTokens, estimated_cost_usd_micros: cost },
    comparison,
    metering,
    failed: jevFailed.map((r) => ({ case_id: r.case_id, reason: r.jev.reason, networked: r.jev.networked, diagnostic: r.jev.diagnostic ?? null, latency_ms: r.jev.latency_ms })),
  };
}

function fmtStats(s) { return s.n ? `n=${s.n} min=${s.min} median=${s.median} mean=${s.mean} max=${s.max}` : 'n=0'; }

export function analyzeToMarkdown(out, compare = null) {
  const a = analyze(out);
  const L = [];
  L.push(`# Calibration analysis — ${a.decision_type ?? ''} ${a.label ? `label=${a.label}` : `variant=${a.variant}`} (${out.merged ? `merged from ${out.sources.length} run(s): ${out.sources.join(', ')}` : (out.started_at ?? '')})`);
  L.push('');
  L.push(`- thresholds: auto_min=${a.thresholds.auto_min} review_min=${a.thresholds.review_min}`);
  L.push(`- cases=${a.counts.cases} rules_first=${a.counts.rules_first} jev_ok=${a.counts.jev_ok} jev_failed=${a.counts.jev_failed}${a.counts.stopped ? ` STOPPED after ${a.counts.stopped.after_case} (${a.counts.stopped.reason})` : ''}`);
  L.push(`- jev confidence: ${fmtStats(a.confidence)}`);
  L.push(`- tier at current thresholds (jev ok only): auto=${a.tier_distribution_at_current_thresholds.auto} review=${a.tier_distribution_at_current_thresholds.review} human=${a.tier_distribution_at_current_thresholds.human}`);
  L.push(`- latency_ms: ${fmtStats(a.latency_ms)}; tokens in=${a.tokens.input} out=${a.tokens.output}; est. cost=${a.tokens.estimated_cost_usd_micros} USD micros`);
  const cs = a.constraints;
  L.push(`- constraints (jev): pass=${cs.jev_pass}/${cs.jev_evaluated} acceptable_ok=${cs.jev_acceptable_ok} unacceptable_hits=${cs.jev_unacceptable_hits} contradictions=${cs.jev_contradictions} final_human=${cs.jev_human_final}; rules pass=${cs.rules_pass}/${cs.rules_evaluated}`);
  if (Object.keys(cs.invariant_violation_counts).length) L.push(`- invariant violations: ${JSON.stringify(cs.invariant_violation_counts)}`);
  L.push('');
  L.push('## Constraints per case');
  L.push('');
  L.push('| case | resolver | outcome | field confidence | pass | acceptable missed | unacceptable hit | invariant violations | final |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of a.comparison) {
    const o = c.jev_outcome ?? null;
    const oc = o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') : (c.resolver_actual === 'rules' ? '(rules)' : '-');
    const fc = c.field_confidence ? Object.entries(c.field_confidence).map(([k, v]) => `${k}=${r3(v)}`).join(', ') : '-';
    const k = c.constraints;
    L.push(`| ${c.case_id} | ${c.resolver_actual} | ${oc} | ${fc} | ${k ? (k.pass ? 'yes' : 'NO') : '-'} | ${k?.acceptable_missed?.join(' ') || '-'} | ${k?.unacceptable_hit?.join(' ') || '-'} | ${k?.invariant_violations?.join(' ') || '-'} | ${c.final_resolved_by}/${c.final_tier} |`);
  }
  L.push('');
  L.push('## Per case');
  L.push('');
  L.push('| case | ambiguity | resolver exp/act | route exp → act | match | human_review exp/act | paid exp/act | jev conf | jev tier | limiting field | final |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of a.comparison) {
    L.push(`| ${c.case_id} | ${c.ambiguity} | ${c.resolver_expected}/${c.resolver_actual} | ${c.route_expected} → ${c.route_actual} | ${c.route_match === null ? '-' : c.route_match ? 'yes' : 'NO'} | ${c.human_review_expected}/${c.human_review_actual} | ${c.paid_expected}/${c.paid_actual} | ${c.jev_confidence == null ? '-' : r3(c.jev_confidence)} | ${c.jev_tier ?? '-'} | ${c.limiting_field ?? '-'} | ${c.final_resolved_by}/${c.final_tier} |`);
  }
  L.push('');
  L.push('## Field-level confidence (jev ok only)');
  L.push('');
  for (const [f, s] of Object.entries(a.per_field)) L.push(`- ${f}: ${fmtStats(s)}`);
  L.push(`- limiting field counts: ${JSON.stringify(a.limiting_field_counts)}`);
  L.push('');
  L.push('## Grouped');
  L.push('');
  for (const [k, s] of Object.entries(a.by_expected_route)) L.push(`- expected route ${k}: ${fmtStats(s)}`);
  for (const [k, s] of Object.entries(a.by_ambiguity)) L.push(`- ambiguity ${k}: ${fmtStats(s)}`);
  for (const [k, s] of Object.entries(a.by_jev_route)) L.push(`- jev route ${k}: ${fmtStats(s)}`);
  L.push('');
  L.push('## Alternative aggregates (interpretation only — NOT a threshold proposal)');
  L.push('');
  for (const [k, v] of Object.entries(a.alt_aggregate_tiers_interpretation_only)) L.push(`- ${k}: auto=${v.auto} review=${v.review} human=${v.human}`);
  L.push('');
  L.push('## Metering check (usage.jsonl record per decision)');
  L.push('');
  L.push('| case | final resolved_by | top-level cost | attempts | jev attempt in attempts[] | networked | usage_known | model | usage_total cost | networked_attempts | unknown |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of a.metering) L.push(`| ${m.case_id} | ${m.final_resolved_by} | ${m.top_level_cost} | ${m.attempts} | ${m.jev_attempt_recorded} | ${m.jev_attempt_networked} | ${m.jev_attempt_usage_known} | ${m.jev_attempt_model} | ${m.usage_total_cost} | ${m.networked_attempts} | ${m.unknown_usage_attempts} |`);
  if (a.failed.length) {
    L.push('');
    L.push('## Failed jev attempts');
    for (const f of a.failed) L.push(`- ${f.case_id}: ${f.reason} (networked=${f.networked}, ${f.latency_ms}ms${f.diagnostic ? `, ${JSON.stringify(f.diagnostic)}` : ''})`);
  }
  if (compare) {
    const b = analyze(compare);
    L.push('');
    L.push(`## Compare: ${a.label ?? a.variant} vs ${b.label ?? b.variant}`);
    L.push('');
    L.push(`- constraints ${a.label ?? a.variant}: ${JSON.stringify(a.constraints)}`);
    L.push(`- constraints ${b.label ?? b.variant}: ${JSON.stringify(b.constraints)}`);
    L.push('');
    L.push(`- confidence ${a.variant}: ${fmtStats(a.confidence)}`);
    L.push(`- confidence ${b.variant}: ${fmtStats(b.confidence)}`);
    L.push('');
    L.push(`| case | conf ${a.variant} | conf ${b.variant} | Δ | route ${a.variant} | route ${b.variant} | limiting ${a.variant} | limiting ${b.variant} |`);
    L.push('|---|---|---|---|---|---|---|---|');
    for (const ca of a.comparison) {
      const cb = b.comparison.find((x) => x.case_id === ca.case_id);
      if (!cb) continue;
      const d = ca.jev_confidence != null && cb.jev_confidence != null ? r3(ca.jev_confidence - cb.jev_confidence) : '-';
      L.push(`| ${ca.case_id} | ${ca.jev_confidence == null ? '-' : r3(ca.jev_confidence)} | ${cb.jev_confidence == null ? '-' : r3(cb.jev_confidence)} | ${d} | ${ca.route_actual} | ${cb.route_actual} | ${ca.limiting_field ?? '-'} | ${cb.limiting_field ?? '-'} |`);
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- CLI

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

async function main() {
  const { cmd, opts, positional } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'dry-run': {
      const doc = loadCases(opts.cases ?? DEFAULT_CASES_PATH);
      const res = await dryRun({ doc, variant: opts.questions ?? 'improved', dump: opts.dump ?? null });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return;
    }
    case 'run':
      await cmdRun(opts, process.env);
      return;
    case 'analyze': {
      if (opts.compare && positional.length) {
        // --compare <before.json> と after（位置引数・複数可）を別々に統合して比較する（label が同じでも混ぜない）
        const load = (fs) => Object.values(mergeResults(resolveResultFiles(fs).map((f) => JSON.parse(readFileSync(f, 'utf8')))))[0];
        const after = load(positional);
        const before = load([String(opts.compare)]);
        process.stdout.write(`${analyzeToMarkdown(after, before)}

---

${analyzeToMarkdown(before)}
`);
        return;
      }
      const files = resolveResultFiles([...positional, ...(opts.compare ? [String(opts.compare)] : [])]);
      const outs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
      if (outs.length === 1) { process.stdout.write(`${analyzeToMarkdown(outs[0])}\n`); return; }
      const merged = mergeResults(outs);
      const primary = merged.improved ?? Object.values(merged)[0];
      const compare = merged.baseline && primary !== merged.baseline ? merged.baseline : (Object.values(merged).find((m) => m !== primary) ?? null);
      process.stdout.write(`${analyzeToMarkdown(primary, compare)}\n`);
      if (compare) process.stdout.write(`\n---\n\n${analyzeToMarkdown(compare)}\n`);
      return;
    }
    default:
      process.stderr.write('usage: poc-calibration.mjs dry-run [--questions improved|baseline] [--dump <case_id>] | run --questions improved|baseline [--cases file] [--label name] [--only a,b] [--out file] [--offline] | analyze [<results.json|dir>...] [--compare other.json]\n');
      process.exitCode = 2;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err?.name ?? 'Error'}: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}
