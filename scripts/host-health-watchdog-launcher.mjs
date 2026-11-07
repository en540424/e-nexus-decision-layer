#!/usr/bin/env node
/**
 * watchdog の入口（2026-11-05・MA-22）。host-health と watchdog は同じコードを import するので、編集の失敗 1 つで両方が同時に止まる（job は作業ツリーから動く）。
 * そこで**ここだけは repo の他のファイルに依存しない**。本体の読み込みに失敗したら、固定の文を 1 通送る（24 時間ごと）。値・パス・例外の文は送らない。
 *
 *   引数は host-health-watchdog.mjs と同じ。
 * exit：本体の exit／1＝本体を読み込めない
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROKEN_TEXT = '[E-NEXUS Mac Runtime host]\n【重大】監視：プログラムを読み込めず、監視と見張りが両方止まっている → 要対応';
export const REMIND_MS = 24 * 3_600_000;
/** host-health の PAUSE の上限と同じ（未来の mtime は 10 分先まで。依存を持たないので値を写す） */
const PAUSE_MAX_MS = 72 * 3_600_000;
const PAUSE_FUTURE_MS = 10 * 60_000;
/** 印を残せない時の間引き：6 時間ごとの最初の 1 時間（毎時の job がちょうど 1 回入る） */
const SLOT_MS = 6 * 3_600_000;
const SLOT_WINDOW_MS = 3_600_000;
const SPEC = /^credential:(E-NEXUS\/edl\/[a-z0-9-]{1,64})$/;
const DISCORD = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/;

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readKeychain(target) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', target, '-a', 'e-nexus', '-w'], { timeout: 15_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** 読み込めなかった時の 1 回分。印のファイルで 24 時間に 1 通へ間引く。送れなければ印を残さず次の回にもう一度 */
export async function reportBroken({ argv, stateDir, read = readKeychain, fetchImpl = globalThis.fetch, now = Date.now }) {
  const mark = path.join(stateDir, 'watchdog-broken.json');
  let last = 0;
  try {
    last = JSON.parse(readFileSync(mark, 'utf8')).notified_at ?? 0;
  } catch { /* 初回 */ }
  const since = now() - last;
  if (since >= 0 && since < REMIND_MS) return 'held'; // 未来の時刻の印では黙らない
  let paused = false;
  try {
    const age = now() - statSync(path.join(stateDir, 'PAUSE')).mtimeMs;
    paused = age <= PAUSE_MAX_MS && age >= -PAUSE_FUTURE_MS; // 未来の mtime で期限より長く黙らない
  } catch { /* PAUSE なし */ }
  if (paused) return 'held';
  const target = SPEC.exec(argOf(argv, '--webhook') ?? '')?.[1];
  if (!target) return 'no_webhook';
  const url = await read(target);
  if (!url || !DISCORD.test(url)) return 'no_webhook';
  // 印を残せない時は時刻の枠で間引いて送る（毎時重ねない・黙らない）。送れなければ印を戻して次の回にもう一度
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(mark, `${JSON.stringify({ notified_at: now() })}\n`, { mode: 0o600 });
  } catch {
    if (now() % SLOT_MS >= SLOT_WINDOW_MS) return 'held';
  }
  const undo = () => {
    try {
      writeFileSync(mark, `${JSON.stringify({ notified_at: last })}\n`, { mode: 0o600 });
    } catch { /* 書けなければ枠で間引かれる */ }
  };
  try {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: BROKEN_TEXT, allowed_mentions: { parse: [] } }) });
    if (!res.ok) { undo(); return 'failed'; }
  } catch {
    undo();
    return 'failed';
  }
  return 'sent';
}

export async function launch(argv, { load = () => import('./host-health-watchdog.mjs'), stateDir = argOf(argv, '--state-dir') ?? path.join(REPO, 'data', 'host-health'), report = reportBroken } = {}) {
  let body;
  try {
    body = await load();
  } catch {
    const code = await report({ argv, stateDir }).catch(() => 'failed');
    console.error(JSON.stringify({ component: 'edl-host-health-watchdog', error: 'load_failed', notify_code: code }));
    return 1;
  }
  rmSync(path.join(stateDir, 'watchdog-broken.json'), { force: true });
  return body.main(argv);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) launch(process.argv.slice(2)).then((c) => { process.exitCode = c; });
