#!/usr/bin/env node
/**
 * 実 Jev 利用の証跡を usage.jsonl から consumer 別に集計する（2026-09-26・MA-30 実JEV第1段）。
 *
 *   node scripts/real-jev-evidence.mjs --since 2026-09-26T00:00:00Z [--expect claude-code,en-generate-hub] [--json]
 *
 * 「実 Jev を使った」の判定は resolved_by ではなく attempts[] で行う（実 Jev が正常応答しても confidence が低ければ
 * tier=human・resolved_by=human になり得るため）。1 行が実 Jev 証跡になる条件：
 *   attempts[] に adapter=jev・status=ok・networked=true・route が実経路（mock / null でない）・input_tokens>0 がある
 * 読むのは usage.jsonl だけ。env・キーは読まない。ネットワークは使わない。
 * --expect を付けると、列挙した application_id それぞれに証跡が 1 件以上なければ exit 1。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultUsagePath } from '../src/usage/metering.mjs';

export function isRealJevAttempt(a) {
  return a?.adapter === 'jev' && a.status === 'ok' && a.networked === true
    && typeof a.route === 'string' && a.route !== 'mock' && Number(a.input_tokens) > 0;
}

export function collectEvidence(rows, { since = null } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  const groups = {};
  for (const r of rows) {
    if (sinceMs !== null && !(Date.parse(r.timestamp) >= sinceMs)) continue;
    const key = `${r.application_id ?? '(none)'}|${r.via ?? '(none)'}|${r.decision_type}`;
    const g = (groups[key] ??= { application_id: r.application_id ?? null, via: r.via ?? null, decision_type: r.decision_type, requests: 0, real_jev: 0, samples: [] });
    g.requests += 1;
    const jev = (r.attempts ?? []).find(isRealJevAttempt);
    const jevUnavailable = (r.attempts ?? []).find((a) => a?.adapter === 'jev' && a.status !== 'ok');
    if (jev) g.real_jev += 1;
    g.samples.push({
      timestamp: r.timestamp,
      request_id: r.request_id ?? null,
      real_jev: !!jev,
      jev_route: jev?.route ?? null,
      jev_confidence: jev?.confidence ?? null,
      jev_latency_ms: jev?.latency_ms ?? null,
      jev_tokens: jev ? { input: jev.input_tokens, output: jev.output_tokens } : null,
      jev_unavailable_reason: jevUnavailable?.reason ?? null,
      resolved_by: r.resolved_by,
      tier: r.tier,
      human_escalation: r.human_escalation,
      fallback_occurred: r.fallback_occurred,
    });
  }
  return Object.values(groups);
}

function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const path = defaultUsagePath();
  const groups = collectEvidence(readRows(path), { since: arg('--since') });
  const expect = (arg('--expect') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const missing = expect.filter((app) => !groups.some((g) => g.application_id === app && g.real_jev > 0));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ path, since: arg('--since'), groups, expect, missing }, null, 2));
  } else {
    console.log(`usage: ${path}${arg('--since') ? `  since ${arg('--since')}` : ''}`);
    for (const g of groups) {
      console.log(`- ${g.application_id} via=${g.via} ${g.decision_type}: real_jev ${g.real_jev}/${g.requests}`);
      for (const s of g.samples) {
        console.log(`    ${s.timestamp} ${s.request_id ?? ''} real_jev=${s.real_jev} route=${s.jev_route} conf=${s.jev_confidence} jev_ms=${s.jev_latency_ms} resolved_by=${s.resolved_by} tier=${s.tier}${s.jev_unavailable_reason ? ` jev_unavailable=${s.jev_unavailable_reason}` : ''}`);
      }
    }
    if (expect.length) console.log(missing.length ? `MISSING real Jev evidence: ${missing.join(', ')}` : `OK: real Jev evidence for ${expect.join(', ')}`);
  }
  process.exitCode = missing.length ? 1 : 0;
}
