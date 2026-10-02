/**
 * scripts/watcher-triage.mjs（Vault MA-33-3・2026-10-02）：Watcher の request JSONL を Gateway に通して {change_id, envelope} を返す consumer。
 * process 境界だけ（Watcher を import しない）・Jev なし・ネットワークなし・承認を返さない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'watcher-triage.mjs');
// usage 計測は一時ファイルへ（test の判定を実運用の data/usage/usage.jsonl に書かない・2026-10-02 再監査で 26 件の混入を発見して修正）
const USAGE_TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edl-wt-usage-')), 'usage.jsonl');
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, windowsHide: true, env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EDL_USAGE_PATH: USAGE_TMP } });

test('test 自身が実運用の usage を汚さない（EDL_USAGE_PATH は一時ファイル）', () => {
  assert.ok(path.isAbsolute(USAGE_TMP) && USAGE_TMP.startsWith(os.tmpdir()));
});
const reqLine = (change_id, input) => JSON.stringify({ schema: 'enexus-watcher-triage-request-v1', id: 'trq_x', change_id, request: { contract_version: '1', decision_type: 'infra-change-triage', application_id: 'watcher', project_id: 'e-nexus-knowledge-layer', input } });

test('watcher-triage script：request ごとに envelope を返す・rules で決まる（Jev なし）・human_review_required は tier human・--out で JSONL を書く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-wt-'));
  const reqs = path.join(dir, 'requests.jsonl');
  const base = { subject_type: 'provider', subject_in_use: true, impact_reached: true, impact_projects: 1, availability_indicator: 'unknown', change_id: 'chg_000000000000000000000000', subject_id: 'provider:anthropic' };
  fs.writeFileSync(reqs, [reqLine('chg_000000000000000000000000', { ...base, change_type: 'deprecation_notice_changed' }), reqLine('chg_111111111111111111111111', { ...base, change_type: 'availability_changed', availability_indicator: 'none' }), reqLine('chg_222222222222222222222222', { ...base, subject_type: 'seed', subject_in_use: false, impact_reached: false, change_type: 'pricing_changed' })].join('\n') + '\n');
  const r = run(['--requests', reqs]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  const by = Object.fromEntries(lines.map((l) => [l.change_id, l.envelope]));
  assert.equal(by.chg_000000000000000000000000.ok, true);
  assert.equal(by.chg_000000000000000000000000.decision.outcome.triage, 'proposal_candidate');
  assert.equal(by.chg_000000000000000000000000.decision.tier, 'human');
  assert.equal(by.chg_000000000000000000000000.decision.resolved_by, 'rules');
  assert.equal(by.chg_111111111111111111111111.decision.outcome.triage, 'record_only');
  assert.equal(by.chg_111111111111111111111111.decision.tier, 'auto');
  assert.equal(by.chg_222222222222222222222222.decision.outcome.triage, 'record_only');
  for (const l of lines) for (const k of Object.keys(l.envelope.decision.outcome)) assert.ok(!/approv|apply|deploy|switch/.test(k));
  const outFile = path.join(dir, 'out', 'decisions.jsonl');
  const r2 = run(['--requests', reqs, '--out', outFile]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).decided, 3);
  assert.equal(fs.readFileSync(outFile, 'utf8').trim().split('\n').length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watcher-triage script：schema に通らない input は envelope.ok=false（failure policy 付き・exit 1）・request の形でない行は exit 2・引数無しは exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-wt-'));
  const reqs = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(reqs, reqLine('chg_000000000000000000000000', { change_type: 'page_changed', subject_type: 'provider', subject_in_use: true, impact_reached: true }) + '\n');
  const r = run(['--requests', reqs]);
  assert.equal(r.status, 1);
  const env = JSON.parse(r.stdout.trim()).envelope;
  assert.equal(env.ok, false);
  assert.equal(env.failure.proceed_automatically, false);
  fs.writeFileSync(reqs, JSON.stringify({ schema: 'other', change_id: 'x', request: { decision_type: 'model-route' } }) + '\n');
  assert.equal(run(['--requests', reqs]).status, 2);
  assert.equal(run([]).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watcher-triage script：Watcher（e-nexus-knowledge-layer）を import しない・ネットワーク・child_process を使わない', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.ok(!/knowledge-layer\/|watcher\/lib|\.\.\/\.\.\//.test(text.replace(/\/\*[\s\S]*?\*\//, '')));
  assert.ok(!/node:(http|https|net|child_process)|fetch\(/.test(text));
});
