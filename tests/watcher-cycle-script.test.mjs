/**
 * scripts/watcher-cycle.mjs（Vault MA-33-6・2026-10-02）：Watcher の 1 サイクルを process 境界で組み立てる consumer。
 * --plan は実行せず工程を出す（定義の確認）。工程に本番書き換え・deploy・課金・外部送信は無い。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'watcher-cycle.mjs');
const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, windowsHide: true, env });
const KL = process.platform === 'win32' ? 'C:\\x\\e-nexus-knowledge-layer' : '/opt/x/e-nexus-knowledge-layer';

test('--plan：scan → triage → gateway（watcher-triage）→ ingest → propose → handoff → observe の順・Watcher の CLI と Knowledge の observe だけ・deploy／paid の工程が無い', () => {
  const r = run(['--watcher-dir', KL, '--plan']);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.steps.map((s) => s.id), ['scan', 'triage-build', 'triage-decide', 'triage-ingest', 'propose', 'handoff', 'observe']);
  for (const s of plan.steps) {
    assert.equal(s.argv[0], process.execPath);
    assert.ok(/watcher[\\/]cli\.mjs$|watcher-triage\.mjs$|sync[\\/]cli\.mjs$/.test(s.argv[1]), s.argv[1]);
    assert.ok(!/deploy|publish|purchase|apply|migrate/.test(s.argv.slice(2).join(' ')), s.id);
  }
  assert.equal(plan.steps.find((s) => s.id === 'observe').stdin.endsWith(path.join('handoff', 'observations.jsonl')), true);
  assert.equal(plan.steps.find((s) => s.id === 'triage-decide').conditional, true, 'request が無ければ Gateway を呼ばない');
  const skip = JSON.parse(run(['--watcher-dir', KL, '--plan', '--skip-scan', '--skip-handoff']).stdout);
  assert.deepEqual(skip.steps.map((s) => s.id), ['triage-build', 'triage-decide', 'triage-ingest', 'propose']);
});

test('引数：--watcher-dir は絶対パス必須・危険な文字は拒否・無い dir は exit 2（実行しない）', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--watcher-dir', 'relative/dir', '--plan']).status, 2);
  assert.equal(run(['--watcher-dir', `${KL}; rm -rf /`, '--plan']).status, 2);
  const missing = run(['--watcher-dir', KL]);
  assert.equal(missing.status, 2);
  assert.ok(/見つからない/.test(missing.stderr));
});

test('境界：Watcher・Knowledge を import しない（process 境界だけ）・env は最低限（Secret を継がせない）', () => {
  const text = fs.readFileSync(script, 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/from ['"][^'"]*(knowledge-layer|watcher\/lib|sync\/)/.test(text));
  assert.ok(/ENV_NAMES/.test(text) && !/env:\s*process\.env\b/.test(text));
  assert.ok(!/fetch\(|node:https?/.test(text));
});
