/**
 * scripts/watcher-cycle.mjs（Vault MA-33-6・2026-10-02）：Watcher の 1 サイクルを process 境界で組み立てる consumer。
 * --plan は実行せず工程を出す（定義の確認）。工程に本番書き換え・deploy・課金・外部送信は無い。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

test('工程の要約：CLI の整形 JSON（複数行）も読む・stub の Watcher で全工程が通る（2026-10-02：要約が常に null だった不具合の回帰 test）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-wc-'));
  fs.mkdirSync(path.join(dir, 'watcher'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sync'), { recursive: true });
  // stub：scan は整形 JSON、triage は requests を作らない、propose は line、handoff は --out に 1 行書く、observe は accepted
  fs.writeFileSync(path.join(dir, 'watcher', 'cli.mjs'), [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const [cmd, ...rest] = process.argv.slice(2);",
    "if (cmd === 'scan') console.log(JSON.stringify({ status: 'complete', counts: { fetched: 2, skipped_interval: 1 } }, null, 2));",
    "else if (cmd === 'triage') console.log(JSON.stringify({ ok: true, pending: 0 }, null, 2));",
    "else if (cmd === 'propose') console.log(JSON.stringify({ ok: true, written: [], line: null }, null, 2));",
    "else if (cmd === 'handoff') { const o = rest[rest.indexOf('--out') + 1]; fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, '{\"x\":1}\\n'); }",
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'sync', 'cli.mjs'), "let t=''; process.stdin.on('data', (d) => { t += d; }).on('end', () => console.log(JSON.stringify({ ok: true, accepted: t.trim().split('\\n').length }, null, 2)));");
  const r = run(['--watcher-dir', dir]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  const by = Object.fromEntries(out.results.map((x) => [x.id, x]));
  assert.deepEqual(by.scan.summary.counts, { fetched: 2, skipped_interval: 1 }, '整形 JSON の要約が取れる');
  assert.equal(by['triage-build'].summary.pending, 0);
  assert.equal(by['triage-decide'].status, 'skipped', 'request が無ければ Gateway を呼ばない');
  assert.equal(by.observe.summary.accepted, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
