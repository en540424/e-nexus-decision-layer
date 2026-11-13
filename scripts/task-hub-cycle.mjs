#!/usr/bin/env node
/**
 * Task Hub の 1 回の回し（2026-11-11・MA-24）。VPS から取る → 取り込む → 安全な queue を回す → Hermes の結果を取る → 結果を VPS へ返す。
 * 常駐しない。Human が手で、または 5 分ごとの LaunchAgent（com.e-nexus.task-hub・Human の承認で登録）が呼ぶ。host-health は最後の回の結果を読むだけ。AI／課金なし（hermes.task の受け渡しは承認の後だけ・休眠の時は何もしない）。
 *
 *   node scripts/task-hub-cycle.mjs [--store <dir>] [--max <N>]
 *
 * 休眠：<store>/config.json が無い時は何もしない（not_configured・exit 0）。Keychain に VPS の URL・鍵が無い時は pull・push が not_configured。
 * 出力は 1 行の JSON（段ごとの code と exit だけ。鍵・本文・params は出さない）。exit：0＝全部 ok か休眠／1＝どこかの段が問題あり
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STORE = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub');
const STEP_TIMEOUT_MS = 45_000;
/** run だけ長め：--max 5 件 × handler の timeout（最大 10 秒）＋余裕。途中で殺すと再開できない handler（hermes.task）が止まったままになる */
const RUN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX = 5;
/** 最後の回の結果（host-health が読み、続けて問題なら知らせる＝lib/task-hub/audit-watch.mjs の taskHubCycleItem）。コードと段の名前だけ */
export const CYCLE_LAST_FILE = 'cycle-last.json';
/** deploy/macos/hermes-work-run.sh が Hermes を動かしている間の印（store の中）。この間は collect-hermes を呼ばない（渡した 1 件以外の file を消す前に取り込まない） */
export const HERMES_RUN_MARK = 'hermes-run.active';
const HERMES_RUN_MAX_MS = 10 * 60_000; // 印が残っても 10 分で無視（script が強制終了された時）

function pauseCodeOf(store) {
  try { return readFileSync(path.join(store, 'PAUSE'), 'utf8').trim().slice(0, 40); } catch { return null; }
}
function hermesRunning(store, now = Date.now()) {
  try { return now - statSync(path.join(store, HERMES_RUN_MARK)).mtimeMs < HERMES_RUN_MAX_MS; } catch { return false; }
}

function lastJson(text) {
  const lines = String(text ?? '').trim().split('\n').reverse();
  for (const l of lines) { try { const j = JSON.parse(l); if (j && typeof j === 'object') return j; } catch { /* 次の行 */ } }
  return null;
}

/** 1 段を子 process で動かす（時間切れつき）。{ step, exit, code? } だけ返す */
export function step(name, script, args, { run = spawnSync, node = process.execPath, timeout = STEP_TIMEOUT_MS } = {}) {
  const r = run(node, [path.join(HERE, script), ...args], { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { step: name, exit: 1, code: r.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_failed' };
  const j = lastJson(r.stdout);
  const out = { step: name, exit: r.status ?? 1 };
  if (j?.code) out.code = String(j.code).slice(0, 40);
  for (const k of ['pulled', 'written', 'kept', 'sent', 'rejected', 'quarantined']) if (Number.isInteger(j?.[k]) && j[k]) out[k] = j[k];
  return out;
}

export function cycle({ store = DEFAULT_STORE, max = DEFAULT_MAX, run = spawnSync, node = process.execPath } = {}) {
  if (!existsSync(path.join(store, 'config.json'))) return { code: 'not_configured', exit: 0, steps: [] };
  const inbox = path.join(store, 'inbox', 'vps-intake');
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  const s = ['--store', store];
  const steps = [];
  const go = (name, script, args, timeout) => { const r = step(name, script, args, { run, node, timeout }); steps.push(r); return r; };
  const pull = go('pull', 'task-intake-sync.mjs', ['pull', '--inbox', inbox]);
  go('intake', 'task-hub.mjs', ['intake', '--inbox', inbox, ...s]);
  // PAUSE（Human が止めた）の間は run を呼ばない（run は PAUSE で exit 1＝失敗に見える）。取り込み・結果の返却は続ける
  const paused = existsSync(path.join(store, 'PAUSE'));
  // runner の回路遮断（circuit_open）は Human の PAUSE と分ける＝知らせる
  const breaker = paused && pauseCodeOf(store) === 'circuit_open';
  if (!paused) go('run', 'task-hub.mjs', ['run', '--max', String(max), ...s], RUN_TIMEOUT_MS);
  if (!hermesRunning(store)) go('collect_hermes', 'task-hub.mjs', ['collect-hermes', ...s]);
  if (pull.code !== 'not_configured') go('push', 'task-intake-sync.mjs', ['push', '--outbox', path.join(store, 'outbox'), '--sent', path.join(store, 'outbox-sent')]);
  const bad = steps.filter((x) => x.exit !== 0);
  // VPS の URL・鍵が Keychain に無い＝受け渡しは休眠（ok と区別して残す。定期の job がある時は host-health が warn にする）
  const code = bad.length ? 'problem' : breaker ? 'paused_breaker' : paused ? 'paused' : pull.code === 'not_configured' ? 'not_configured' : 'ok';
  const result = { code, exit: bad.length ? 1 : 0, steps };
  writeLast(store, { at: new Date().toISOString(), code: result.code, failed: bad.map((x) => x.step) });
  return result;
}

function writeLast(store, obj) {
  try {
    const file = path.join(store, CYCLE_LAST_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* 書けなくても回しは失敗にしない（host-health が stale として見る） */ }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const store = opt('--store') ? path.resolve(opt('--store')) : DEFAULT_STORE;
  const max = opt('--max') === undefined ? DEFAULT_MAX : Number(opt('--max'));
  if (!Number.isInteger(max) || max < 1 || max > 100) { console.error('usage: task-hub-cycle.mjs [--store <dir>] [--max 1..100]'); process.exit(2); }
  const { exit, ...rest } = cycle({ store, max });
  console.log(JSON.stringify({ component: 'edl-task-hub-cycle', ...rest }));
  process.exitCode = exit;
}
