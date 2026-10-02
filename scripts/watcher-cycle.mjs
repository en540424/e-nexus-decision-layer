#!/usr/bin/env node
/**
 * AI Infrastructure Watcher の 1 サイクル（Vault MA-33-6・2026-10-02）。定期 job（scheduled-job-service の watcher-cycle）と手動実行の共通入口。
 * Watcher（e-nexus-knowledge-layer/watcher）は child_process も Gateway 呼び出しも持たないので、工程をまたぐ組み立てはこの script（consumer 側）が行う。
 * 各工程は process 境界（CLI と JSON）だけで繋ぐ：Watcher を import しない・Knowledge の canonical を書かない（observe は Knowledge 側の入口）。
 *
 *   node scripts/watcher-cycle.mjs --watcher-dir <e-nexus-knowledge-layer の絶対パス> [--plan] [--skip-scan] [--skip-handoff] [--verification]
 *
 *   1. watcher scan                      公式一次情報の GET→観測→差分（Watcher）
 *   2. watcher triage                    決定の無い change から infra-change-triage の request（Watcher・事実だけ）
 *   3. scripts/watcher-triage.mjs        request → Common Decision Gateway → envelope（rules・Jev なし・課金なし）
 *   4. watcher triage --decisions        envelope を change に結ぶ（Watcher・forbidden keys 拒否）
 *   5. watcher propose                   proposal_candidate から proposal（承認ではない）・index.json
 *   6. watcher handoff → sync observe    State 契約（環境 external）の record を Knowledge の実測へ（Knowledge 側の入口・all-or-nothing）
 *
 * --plan は実行せず工程の一覧（コマンド）を JSON で出す（定義の確認・test 用）。終了コード：0＝complete／1＝partial（読めない情報源あり等）／2＝failed・引数エラー。
 * 本番基盤の書き換え・Provider 切替・deploy・課金・外部送信はどの工程にも無い（Watcher は観測→比較→記録→提案まで）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EDL_ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(`--${n}`);
const isAbs = (p) => typeof p === 'string' && (path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));
const dir = opt('watcher-dir');
if (!isAbs(dir ?? '') || /["'`$\n\r;&|<>]/.test(dir)) { process.stderr.write('usage: node scripts/watcher-cycle.mjs --watcher-dir <absolute path to e-nexus-knowledge-layer> [--plan] [--skip-scan] [--skip-handoff] [--verification]\n'); process.exit(2); }
const KL = path.resolve(dir);
const watcherCli = path.join(KL, 'watcher', 'cli.mjs');
const syncCli = path.join(KL, 'sync', 'cli.mjs');
const triageScript = path.join(EDL_ROOT, 'scripts', 'watcher-triage.mjs');
const requests = path.join(KL, 'watcher', 'data', 'triage', 'requests.jsonl');
const inbox = path.join(KL, 'watcher', 'data', 'triage', 'decisions.inbox.jsonl');
const handoff = path.join(KL, 'watcher', 'data', 'handoff', 'observations.jsonl');

const steps = [
  ...(flag('skip-scan') ? [] : [{ id: 'scan', cwd: KL, cmd: [watcherCli, 'scan'], okExit: [0, 1] }]),
  { id: 'triage-build', cwd: KL, cmd: [watcherCli, 'triage'], okExit: [0] },
  { id: 'triage-decide', cwd: EDL_ROOT, cmd: [triageScript, '--requests', requests, '--out', inbox, ...(flag('verification') ? ['--verification'] : [])], okExit: [0, 1], when: () => fs.existsSync(requests) && fs.readFileSync(requests, 'utf8').trim() !== '' },
  { id: 'triage-ingest', cwd: KL, cmd: [watcherCli, 'triage', '--decisions', inbox], okExit: [0], when: () => fs.existsSync(inbox) && fs.readFileSync(inbox, 'utf8').trim() !== '' },
  { id: 'propose', cwd: KL, cmd: [watcherCli, 'propose'], okExit: [0] },
  ...(flag('skip-handoff') ? [] : [
    { id: 'handoff', cwd: KL, cmd: [watcherCli, 'handoff', '--out', handoff], okExit: [0] },
    { id: 'observe', cwd: KL, cmd: [syncCli, 'observe'], okExit: [0], stdinFile: handoff, when: () => fs.existsSync(handoff) && fs.readFileSync(handoff, 'utf8').trim() !== '' },
  ]),
];

if (flag('plan')) {
  process.stdout.write(`${JSON.stringify({ ok: true, watcher_dir: KL, steps: steps.map((s) => ({ id: s.id, cwd: s.cwd, argv: [process.execPath, ...s.cmd], ...(s.stdinFile ? { stdin: s.stdinFile } : {}), conditional: Boolean(s.when) })) }, null, 2)}\n`);
  process.exit(0);
}
if (!fs.existsSync(watcherCli) || !fs.existsSync(syncCli)) { process.stderr.write(`watcher が見つからない: ${watcherCli}\n`); process.exit(2); }

// 各工程の stdout から要約を取る。CLI は整形 JSON（複数行）か JSONL（handoff は record の並び）を出すので、
// まず全体を 1 つの JSON として読み、だめなら最後の行を読む（2026-10-02：最終行だけを読んで整形 JSON の要約が常に null だった不具合を修正）
function summarize(stdout) {
  const text = String(stdout ?? '').trim();
  let j = null;
  try { j = JSON.parse(text); } catch { try { j = JSON.parse(text.split('\n').at(-1) ?? ''); } catch { j = null; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  return { ok: j.ok ?? null, status: j.status ?? null, counts: j.counts ?? null, pending: j.pending ?? null, written: j.written ?? null, accepted: j.accepted ?? null, line: j.line ?? null };
}

const ENV_NAMES = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'TZ'];
const env = Object.fromEntries(ENV_NAMES.filter((k) => typeof process.env[k] === 'string').map((k) => [k, process.env[k]]));
const results = [];
let status = 'complete';
for (const s of steps) {
  if (s.when && !s.when()) { results.push({ id: s.id, status: 'skipped' }); continue; }
  const r = spawnSync(process.execPath, s.cmd, { cwd: s.cwd, encoding: 'utf8', env, windowsHide: true, timeout: 600_000, ...(s.stdinFile ? { input: fs.readFileSync(s.stdinFile, 'utf8') } : {}) });
  const ok = !r.error && !r.signal && s.okExit.includes(r.status);
  const summary = summarize(r.stdout);
  results.push({ id: s.id, status: ok ? (r.status === 1 ? 'partial' : 'ok') : 'failed', exit: r.status ?? null, signal: r.signal ?? null, error: r.error?.code ?? null, summary });
  if (!ok) { status = 'failed'; break; }
  if (r.status === 1) status = 'partial';
}
process.stdout.write(`${JSON.stringify({ ok: status !== 'failed', status, watcher_dir: KL, finished_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), results }, null, 2)}\n`);
process.exit(status === 'complete' ? 0 : status === 'partial' ? 1 : 2);
