#!/usr/bin/env node
/**
 * 実運用の usage.jsonl から再 Calibration の判断材料を作る（2026-09-29・Full Autonomous Build FB-09）。READ-ONLY・課金なし。
 *
 *   node scripts/recalibration-report.mjs --decision-type content-publish-gate [--application en-sns-hub] [--since 2026-09-26T00:00:00Z]
 *        [--labels labels.jsonl] [--grid] [--usage <path>] [--json]
 *
 * 方針（MA-30 正本 §18-8：「次回 Calibration の材料は usage.jsonl。新しい計測機構は作らない」）に従い、既存の usage.jsonl だけを読む：
 *   - 件数・final tier の分布・resolved_by・Jev 到達率（Jev の ok attempt）・Jev confidence の分布
 *   - 閾値の試算：記録された Jev confidence に別の閾値（auto_min / review_min）を当てると tier がどう分かれるか。
 *     usage 行は outcome（human_review_required 等の強制フラグ）を持たないので、これは「confidence だけで決まる上限」。
 *     実際の final tier は強制フラグ・invariants でさらに human 側へ寄る（report に明記）
 *   - Human のラベル（任意）：labels.jsonl の 1 行 = {"request_id" または "decision_id", "label": "auto"|"review"|"human"}（その判定が
 *     本来どの tier であるべきだったか）。実際の tier と閾値ごとの試算の一致率・false escalation（本来 auto/review なのに human）・
 *     false auto（本来 human なのに auto）を出す
 * 閾値の変更（policies/routing/confidence-thresholds.json）と、実 Jev での Calibration run（課金）は Human の go の後。
 * aborted=true の行（timeout・切断で中断・consumer に判定が届いていない）は数えない。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultUsagePath, attemptsOf } from '../src/usage/metering.mjs';
import { loadThresholds, tierFor } from '../src/core/confidence.mjs';

export const DEFAULT_GRID = Object.freeze([
  { auto_min: 0.9, review_min: 0.7 },
  { auto_min: 0.85, review_min: 0.6 },
  { auto_min: 0.8, review_min: 0.55 },
  { auto_min: 0.75, review_min: 0.5 },
]);

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return Math.round(sorted[i] * 1000) / 1000;
}

/** Jev の ok attempt（実応答の confidence を持つもの）。mock・rules は含めない */
export function jevAttemptOf(row) {
  return attemptsOf(row).find((a) => a?.adapter === 'jev' && a.status === 'ok' && typeof a.confidence === 'number') ?? null;
}

export function selectRows(rows, { decisionType, application = null, since = null }) {
  const sinceMs = since ? Date.parse(since) : null;
  return rows.filter((r) => r && r.decision_type === decisionType
    && r.aborted !== true
    && (application === null || r.application_id === application)
    && (sinceMs === null || Date.parse(r.timestamp) >= sinceMs));
}

function count(list, key) {
  const out = {};
  for (const x of list) { const k = x ?? '(none)'; out[k] = (out[k] ?? 0) + 1; }
  return key ? out[key] ?? 0 : out;
}

function labelKey(r) {
  return [r.request_id, r.decision_id].filter(Boolean);
}

/**
 * @param {object[]} rows selectRows 後の行
 * @param {object} o
 * @param {{auto_min:number, review_min:number}} o.current 現在の閾値
 * @param {object[]} [o.grid] 試算する閾値
 * @param {Map<string,string>} [o.labels] request_id / decision_id → 'auto'|'review'|'human'
 */
export function buildReport(rows, { current, grid = [], labels = new Map() }) {
  const jev = rows.map(jevAttemptOf);
  const confs = jev.filter(Boolean).map((a) => a.confidence).sort((a, b) => a - b);
  const labelOf = (r) => { for (const k of labelKey(r)) if (labels.has(k)) return labels.get(k); return null; };
  const labeled = rows.map((r, i) => ({ r, jev: jev[i], label: labelOf(r) })).filter((x) => x.label);

  const simulate = (t) => {
    const tiers = jev.map((a) => (a ? tierFor(a.confidence, t) : null)).filter(Boolean);
    const out = { thresholds: t, jev_decided: tiers.length, auto: count(tiers, 'auto'), review: count(tiers, 'review'), human: count(tiers, 'human') };
    const lab = labeled.filter((x) => x.jev);
    if (lab.length) {
      const sim = lab.map((x) => ({ label: x.label, tier: tierFor(x.jev.confidence, t) }));
      out.labeled = sim.length;
      out.agreement = Math.round((sim.filter((s) => s.tier === s.label).length / sim.length) * 1000) / 1000;
      out.false_auto = sim.filter((s) => s.tier === 'auto' && s.label === 'human').length;
      out.false_escalation = sim.filter((s) => s.tier === 'human' && s.label !== 'human').length;
    }
    return out;
  };

  const actualVsLabel = labeled.length
    ? {
      labeled: labeled.length,
      agreement: Math.round((labeled.filter((x) => x.r.tier === x.label).length / labeled.length) * 1000) / 1000,
      false_auto: labeled.filter((x) => x.r.tier === 'auto' && x.label === 'human').length,
      false_escalation: labeled.filter((x) => x.r.tier === 'human' && x.label !== 'human').length,
    }
    : null;

  return {
    requests: rows.length,
    final_tier: count(rows.map((r) => r.tier)),
    resolved_by: count(rows.map((r) => r.resolved_by)),
    human_rate: rows.length ? Math.round((rows.filter((r) => r.tier === 'human').length / rows.length) * 1000) / 1000 : null,
    jev_reached: confs.length,
    jev_confidence: { min: quantile(confs, 0), median: quantile(confs, 0.5), p90: quantile(confs, 0.9), max: quantile(confs, 1) },
    current_thresholds: current,
    simulation: [simulate(current), ...grid.filter((t) => t.auto_min !== current.auto_min || t.review_min !== current.review_min).map(simulate)],
    actual_vs_label: actualVsLabel,
    notes: [
      'simulation は Jev confidence だけで決まる tier（上限）。実際は outcome の強制フラグ（human_review_required 等）・invariants でさらに human 側へ寄る',
      'aborted 行（consumer に判定が届いていない）は除外',
      '閾値の変更・実 Jev での Calibration run（課金）は Human の go の後（policies/routing/confidence-thresholds.json）',
    ],
  };
}

export function formatReport(rep, { decisionType, application, since }) {
  const L = [];
  L.push(`# 再 Calibration 材料：${decisionType}${application ? `（${application}）` : ''}${since ? ` since ${since}` : ''}`);
  L.push('');
  L.push(`- 判定数 ${rep.requests}・Human 率 ${rep.human_rate ?? '-'}・final tier ${JSON.stringify(rep.final_tier)}・resolved_by ${JSON.stringify(rep.resolved_by)}`);
  L.push(`- Jev 到達 ${rep.jev_reached} 件・confidence min ${rep.jev_confidence.min ?? '-'} / median ${rep.jev_confidence.median ?? '-'} / p90 ${rep.jev_confidence.p90 ?? '-'} / max ${rep.jev_confidence.max ?? '-'}`);
  if (rep.actual_vs_label) L.push(`- Human ラベル ${rep.actual_vs_label.labeled} 件：実際の tier の一致率 ${rep.actual_vs_label.agreement}・false auto ${rep.actual_vs_label.false_auto}・false escalation ${rep.actual_vs_label.false_escalation}`);
  L.push('');
  L.push('| auto_min | review_min | Jev 判定 | auto | review | human | 一致率 | false auto | false escalation |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of rep.simulation) {
    L.push(`| ${s.thresholds.auto_min} | ${s.thresholds.review_min} | ${s.jev_decided} | ${s.auto} | ${s.review} | ${s.human} | ${s.agreement ?? '-'} | ${s.false_auto ?? '-'} | ${s.false_escalation ?? '-'} |`);
  }
  L.push('');
  for (const n of rep.notes) L.push(`- ${n}`);
  return L.join('\n');
}

export function parseLabels(text) {
  const labels = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!['auto', 'review', 'human'].includes(o?.label)) continue;
    for (const k of [o.request_id, o.decision_id]) if (typeof k === 'string' && k) labels.set(k, o.label);
  }
  return labels;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function main(argv) {
  const decisionType = arg(argv, '--decision-type');
  if (!decisionType) {
    console.error('usage: recalibration-report.mjs --decision-type <type> [--application <id>] [--since <ISO>] [--labels <file>] [--grid] [--usage <path>] [--json]');
    return 2;
  }
  const usagePath = arg(argv, '--usage') ?? defaultUsagePath();
  const rows = existsSync(usagePath) ? readFileSync(usagePath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : [];
  const application = arg(argv, '--application');
  const since = arg(argv, '--since');
  const selected = selectRows(rows, { decisionType, application, since });
  const labelsFile = arg(argv, '--labels');
  const rep = buildReport(selected, {
    current: loadThresholds(decisionType),
    grid: argv.includes('--grid') ? DEFAULT_GRID : [],
    labels: labelsFile ? parseLabels(readFileSync(labelsFile, 'utf8')) : new Map(),
  });
  if (argv.includes('--json')) console.log(JSON.stringify({ usage: usagePath, decision_type: decisionType, application, since, ...rep }, null, 2));
  else console.log(formatReport(rep, { decisionType, application, since }));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
