/**
 * scripts/comparison-record.mjs（Vault MA-33-5・2026-10-02）：poc-calibration dry-run の出力 2 つ（Current／Candidate）を
 * Watcher の comparison record 書式へ写す。新しい runner を作らない・判断の語を入れない・offline・課金なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'comparison-record.mjs');
const calibration = path.join(root, 'scripts', 'poc-calibration.mjs');
const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const run = (file, args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', cwd: root, windowsHide: true, env });

test('既存 runner（poc-calibration dry-run）の improved／baseline から record が生成される・事実だけ・offline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-cmp-'));
  const cur = run(calibration, ['dry-run', '--questions', 'improved']);
  const cand = run(calibration, ['dry-run', '--questions', 'baseline']);
  assert.equal(cur.status, 0, cur.stderr);
  assert.equal(cand.status, 0, cand.stderr);
  fs.writeFileSync(path.join(dir, 'cur.json'), cur.stdout);
  fs.writeFileSync(path.join(dir, 'cand.json'), cand.stdout);
  const r = run(script, ['--current', path.join(dir, 'cur.json'), '--candidate', path.join(dir, 'cand.json'), '--now', '2026-10-02T12:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.schema, 'enexus-watcher-comparison-record-v1');
  assert.match(rec.id, /^cmp_[0-9a-f]{24}$/);
  assert.equal(rec.runner.id, 'decision-layer/poc-calibration');
  assert.equal(rec.runner.offline, true);
  assert.equal(rec.runner.paid, false);
  assert.equal(rec.current.id, 'questions:improved');
  assert.equal(rec.candidate.id, 'questions:baseline');
  assert.ok(rec.metrics.length >= 5);
  const m = Object.fromEntries(rec.metrics.map((x) => [x.name, x]));
  assert.equal(m.rules_first_cases.current, JSON.parse(cur.stdout).rules_first);
  assert.ok(m.instruction_chars_avg.current > m.instruction_chars_avg.candidate, 'improved は instructions が長い（事実）');
  assert.ok(!/"(winner|recommended|verdict|adopt)"/.test(r.stdout), '判断の語を入れない');
  assert.equal(rec.human_interventions.current, 0);
  // 決定的：同じ入力・同じ now なら同じ id
  const r2 = run(script, ['--current', path.join(dir, 'cur.json'), '--candidate', path.join(dir, 'cand.json'), '--now', '2026-10-02T12:00:00Z']);
  assert.equal(JSON.parse(r2.stdout).id, rec.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('入力検査：dry-run の形でない・同じ variant・case 集合が違うものは exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-cmp-'));
  const a = path.join(dir, 'a.json'); const b = path.join(dir, 'b.json');
  fs.writeFileSync(a, JSON.stringify({ variant: 'improved', rules_first: 1, jev_candidates: 0, cases: [{ case_id: 'x', would_send_questions: 0, instruction_chars: 1, brief_chars: 1, matches_expectation: true }] }));
  fs.writeFileSync(b, JSON.stringify({ variant: 'improved', rules_first: 1, jev_candidates: 0, cases: [{ case_id: 'x' }] }));
  assert.equal(run(script, ['--current', a, '--candidate', b]).status, 2, '同じ variant');
  fs.writeFileSync(b, JSON.stringify({ variant: 'baseline', rules_first: 1, jev_candidates: 0, cases: [{ case_id: 'y' }] }));
  assert.equal(run(script, ['--current', a, '--candidate', b]).status, 2, 'case 集合が違う');
  fs.writeFileSync(b, '{"not":"dry-run"}');
  assert.equal(run(script, ['--current', a, '--candidate', b]).status, 2);
  assert.equal(run(script, []).status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
