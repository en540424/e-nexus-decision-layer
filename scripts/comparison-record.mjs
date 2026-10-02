#!/usr/bin/env node
/**
 * comparison record の生成（Vault MA-33-5・2026-10-02）。既存 runner `scripts/poc-calibration.mjs dry-run --questions <variant>` の
 * 出力 2 つ（Current＝現行 variant／Candidate＝比較 variant）を、Watcher の comparison record 書式
 * （e-nexus-knowledge-layer watcher/lib/comparison.mjs・enexus-watcher-comparison-record-v1）へ写す。**新しい runner・Benchmark Platform は作らない**。
 *
 *   node scripts/poc-calibration.mjs dry-run --questions improved > current.json
 *   node scripts/poc-calibration.mjs dry-run --questions baseline > candidate.json
 *   node scripts/comparison-record.mjs --current current.json --candidate candidate.json [--out record.json] [--now ISO]
 *
 * record は事実だけ（指標・失敗様式・Human 介入数・再現性）。winner／recommended 等の判断の語は入れない。dry-run は offline・課金なし。
 * 終了コード：0＝生成／2＝引数・入力エラー。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const read = (p) => { try { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const cur = opt('current') ? read(opt('current')) : null;
const cand = opt('candidate') ? read(opt('candidate')) : null;
const isDryRun = (d) => d && typeof d.variant === 'string' && Array.isArray(d.cases) && d.cases.every((c) => typeof c.case_id === 'string');
if (!isDryRun(cur) || !isDryRun(cand)) { process.stderr.write('usage: node scripts/comparison-record.mjs --current <dry-run.json> --candidate <dry-run.json> [--out <record.json>]（poc-calibration dry-run の出力）\n'); process.exit(2); }
if (cur.variant === cand.variant) { process.stderr.write('current と candidate の variant が同じ\n'); process.exit(2); }

const stableStringify = (v) => (Array.isArray(v) ? `[${v.map(stableStringify).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}` : JSON.stringify(v));
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sum = (d, k) => d.cases.reduce((a, c) => a + (Number(c[k]) || 0), 0);
const avg = (d, k) => (d.cases.length ? Math.round(sum(d, k) / d.cases.length) : 0);
const mismatches = (d) => d.cases.filter((c) => c.matches_expectation === false).map((c) => `expectation_mismatch:${c.case_id}`);
const caseIds = (d) => d.cases.map((c) => c.case_id).sort();
if (stableStringify(caseIds(cur)) !== stableStringify(caseIds(cand))) { process.stderr.write('同一タスクではない（case 集合が違う）\n'); process.exit(2); }

const now = (opt('now') ?? new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
const record = {
  schema: 'enexus-watcher-comparison-record-v1',
  id: null,
  created_at: now,
  task: { id: 'paid-generation-gate-calibration-cases', description: `decision-layer docs/poc/calibration の代表ケース ${cur.cases.length} 件を同じ Engine 構成（Rules First）に流す dry-run`, cases: caseIds(cur) },
  current: { id: `questions:${cur.variant}`, description: `poc-calibration --questions ${cur.variant}` },
  candidate: { id: `questions:${cand.variant}`, description: `poc-calibration --questions ${cand.variant}` },
  runner: { id: 'decision-layer/poc-calibration', mode: 'dry-run', offline: true, paid: false, invocation: 'node scripts/poc-calibration.mjs dry-run --questions <variant>' },
  metrics: [
    { name: 'rules_first_cases', current: cur.rules_first, candidate: cand.rules_first, unit: 'cases', direction: 'informational' },
    { name: 'jev_candidate_cases', current: cur.jev_candidates, candidate: cand.jev_candidates, unit: 'cases', direction: 'informational' },
    { name: 'would_send_questions_total', current: sum(cur, 'would_send_questions'), candidate: sum(cand, 'would_send_questions'), unit: 'questions', direction: 'informational' },
    { name: 'instruction_chars_avg', current: avg(cur, 'instruction_chars'), candidate: avg(cand, 'instruction_chars'), unit: 'chars', direction: 'lower_is_better' },
    { name: 'brief_chars_avg', current: avg(cur, 'brief_chars'), candidate: avg(cand, 'brief_chars'), unit: 'chars', direction: 'lower_is_better' },
    { name: 'expectation_mismatches', current: mismatches(cur).length, candidate: mismatches(cand).length, unit: 'cases', direction: 'lower_is_better' },
  ],
  failure_modes: { current: mismatches(cur), candidate: mismatches(cand) },
  human_interventions: { current: 0, candidate: 0 },
  reproducibility: { deterministic: true, repeats: 1, notes: 'dry-run は Rules と schema だけで決まる（ネットワーク・Jev 無し）。実 Jev の confidence 分布は poc-calibration run（Human がキーを設定した時だけ）' },
  maintenance_burden: { current: 'not_assessed', candidate: 'not_assessed' },
  evidence: [
    { kind: 'runner_output', side: 'current', sha256: sha(stableStringify(cur)) },
    { kind: 'runner_output', side: 'candidate', sha256: sha(stableStringify(cand)) },
  ],
  facts_only: true,
};
const { id, created_at, ...rest } = record;
record.id = `cmp_${sha(stableStringify(rest)).slice(0, 24)}`;
const text = `${JSON.stringify(record, null, 2)}\n`;
if (opt('out')) { fs.mkdirSync(path.dirname(path.resolve(opt('out'))), { recursive: true }); fs.writeFileSync(path.resolve(opt('out')), text, 'utf8'); process.stdout.write(`${JSON.stringify({ ok: true, id: record.id, out: opt('out') })}\n`); }
else process.stdout.write(text);
