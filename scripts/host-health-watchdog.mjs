#!/usr/bin/env node
/**
 * host-health の見張りの見張り（2026-11-04・MA-22）。host-health とは別の job で動く。READ-ONLY・課金なし・AI なし・macOS のみ。
 *
 *   node scripts/host-health-watchdog.mjs [--state-dir <abs>] [--webhook credential:E-NEXUS/edl/<name> [--webhook-format discord]] [--json]
 *
 * 見るもの：host-health の記録の更新時刻・DISABLED の印・launchd の登録。監視が止まった時（本体が自分では知らせられない形）を知らせる。
 * 限界：同じ Mac の上で動くので、Mac 自身の停止は見えない（再開した時に host-health の monitor_gap が知らせる。外からの見張りは Human の判断）。
 *   この job の停止は host-health の monitor_watchdog が見る。両方が同時に止まるとどちらからも見えない。
 * 通知の抑止は host-health の decide と同じ（変化した時だけ・続けば 24 時間後から間隔を広げて再通知・回復は 2 回続いてから 1 回）。PAUSE の間は知らせない（72 時間で切れる）。
 * DISABLED の通知は host-health 本体の担当（24 時間ごと）なので、ここからは重ねない。
 * Mac の停止・スリープの直後は host-health がまだ回っていないので判定しない（自分の前の回から間があいた・起動から GAP_MS 以内は unknown。偽の CRIT を出さない）。
 * 記録：<state-dir>/watchdog.json だけ。host-health の state は書かない。
 * exit：0＝1 回分を終えた（異常があっても 0）／1＝失敗／2＝引数・macOS 以外
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_DIR, GAP_MS, decide, makeRunner, parseArgs, parseBoottime, parseLaunchctlPrint, pauseState, postAlerts, rollbackUnsent, validateArgs } from './host-health.mjs';
import { MONITOR_LABEL } from './lib/runtime-guard.mjs';

const WATCHDOG_SCHEMA = 'host-health-watchdog/v1';
const ID = 'monitor_alive';
/** この job は毎時 1 回。前の回からこれより間があけば Mac か launchd が止まっていた */
const OWN_GAP_MS = GAP_MS;

/** 止まっている理由を 1 つ返す（ok なら 'ok'）。launchctl が読めない・DISABLED は unknown（前の状態を保つ。DISABLED は本体が知らせる） */
export function monitorState({ state, disabled, job, now, resumed = false }) {
  if (job == null) return { level: 'unknown', value: null };
  if (!job.loaded) return { level: 'crit', value: 'not_loaded' };
  if (disabled) return { level: 'unknown', value: 'disabled' };
  if (resumed) return { level: 'unknown', value: null };
  const minutes = Math.round((Date.parse(now) - Date.parse(state?.updated_at)) / 60_000);
  if (!Number.isFinite(minutes)) return { level: 'crit', value: 'no_state' }; // 登録されているのに記録が読めない
  return minutes * 60_000 > GAP_MS ? { level: 'crit', value: `stale ${minutes}m` } : { level: 'ok', value: 'ok' };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 1 回分。run・uid・post・now を差し替えて test する */
export async function runWatchdog({ stateDir = DEFAULT_STATE_DIR, webhook = null, webhookFormat = 'json', run, uid, now = () => new Date(), post = postAlerts }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const at = now().toISOString();
  const file = path.join(stateDir, 'watchdog.json');
  const prev = readJson(file);
  const prevItems = prev?.schema === WATCHDOG_SCHEMA ? (prev.items ?? {}) : {};
  const job = parseLaunchctlPrint(await run('/bin/launchctl', ['print', `gui/${uid}/${MONITOR_LABEL}`]));
  const boot = await run('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const bootSec = boot.code === 0 ? parseBoottime(boot.stdout) : null;
  const nowMs = Date.parse(at);
  const resumed = (bootSec != null && nowMs - bootSec * 1000 < GAP_MS) || nowMs - Date.parse(prev?.updated_at) > OWN_GAP_MS;
  const seen = monitorState({ state: readJson(path.join(stateDir, 'state.json')), disabled: existsSync(path.join(stateDir, 'DISABLED')), job, now: at, resumed });
  const { paused } = pauseState(stateDir, at);
  const d = decide([{ id: ID, ...seen, kind: 'state' }], prev?.schema === WATCHDOG_SCHEMA ? prev : null, { now: at, paused });
  let notifyCode = d.notify.length === 0 ? 'NOTHING_TO_SEND' : webhook ? null : 'NO_WEBHOOK';
  const save = (items) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema: WATCHDOG_SCHEMA, updated_at: at, items }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };
  let items = d.items;
  if (d.notify.length && webhook) {
    save(prevItems); // 送れた印を残せないなら送らない（書けない間に同じ通知を毎回重ねない）
    const r = await post(d.notify, { spec: webhook, format: webhookFormat, at });
    notifyCode = r.code;
    if (!r.sent) items = rollbackUnsent(d.notify, prevItems, d.items, at); // 送れなかった分は次の回にもう一度
  }
  save(items);
  return { code: 0, status: 'ok', level: seen.level, value: seen.value, notify: d.notify, notifyCode, paused };
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validateArgs(a);
  if (a.report || a.webhookTest || a.githubOwner || a.githubCredential || a.hermesUser || a.days || a.period || a.quarterlyPreview || a.dataDirs.length) errors.push('host-health-watchdog takes only --state-dir, --webhook, --webhook-format');
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  if (process.platform !== 'darwin') { console.error('host-health-watchdog is for the Mac mini (macOS) only'); return 2; }
  try {
    const r = await runWatchdog({ stateDir: a.stateDir ?? DEFAULT_STATE_DIR, webhook: a.webhook ?? null, webhookFormat: a.webhookFormat ?? 'json', run: makeRunner({ allowed: ['/bin/launchctl', '/usr/sbin/sysctl'] }), uid: process.getuid() });
    console.log(JSON.stringify({ component: 'edl-host-health-watchdog', status: r.status, level: r.level, notify: r.notify.length, notify_code: r.notifyCode, paused: r.paused }));
    return r.code;
  } catch (err) {
    console.error(JSON.stringify({ component: 'edl-host-health-watchdog', error: String(err?.code ?? err?.name ?? 'error') })); // message にはパスが入る
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
