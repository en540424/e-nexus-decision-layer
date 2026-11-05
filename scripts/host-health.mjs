#!/usr/bin/env node
/**
 * Mac mini（Runtime Node）のホスト監視（2026-10-21・Vault MA-22・Mac Runtime 工程 3）。READ-ONLY・sudo 不要・課金なし・macOS のみ。
 *
 *   node scripts/host-health.mjs [--state-dir <abs>] [--data-dir <abs>]... [--hermes-user <name>] [--no-guard]
 *   node scripts/host-health.mjs --report [--days 7] [--state-dir <abs>]   記録の要約を出すだけ（観察用。何も書かない）
 *   node scripts/host-health.mjs --webhook-test --webhook <…> [--webhook-format discord]   配送試験を 1 通だけ送る（監視の状態は変えない）
 *   node scripts/host-health.mjs --quarterly-preview [--period 2026Q4] [--state-dir <abs>]   運用要約の本文を出すだけ（送らない・何も書かない）
 *        [--webhook credential:E-NEXUS/edl/<name> [--webhook-format json|slack|discord]] [--github-owner <owner> --github-credential credential:E-NEXUS/edl/<name>] [--json]
 *
 * 見るもの：ホストの資源（起動ディスクの空き・メモリ逼迫・swap・15 分 load・発熱・電源・再起動・既定経路）、
 *   Mac Runtime 自身の定期 job（com.e-nexus.<job> の LaunchAgent）、Mac Runtime のデータ量、（導入後）Hermes ユーザーの資源。
 *   既定で lib/runtime-guard.mjs の見張りも回す（2026-11-04。Hermes の常駐と隔離・repo の未 push・relay の未送信・Time Machine。--no-guard で外す）。
 *   --github-owner と --github-credential を付けた時だけ lib/github-guard.mjs の見張りも回す（GitHub の公開範囲・CI。GET だけ。Keychain に token が無ければ通信しない）。
 *   --hermes-user の時は 1 回分の最後に Hermes へ状態の要約を 1 ファイル書く（lib/runtime-status-summary.mjs。水準と件数だけ。2026-11-05 H4）。
 * 見ないもの：Trading Lab の process・VM・MT5・状態ファイル・Monitor。LIVE の状態は Trading Lab の Monitor の担当で、ここでは報告しない。
 *   process の一覧・command line・パス・IP・ホスト名は記録にも通知にも出さない（load・メモリはシステム全体の値だけ）。
 * することは 3 つだけ：記録（<state-dir>/state.json・YYYY-MM.jsonl）／状態が変わった時の通知／DEGRADED の印（起動ディスクかメモリが
 *   CRIT の間。Mac Runtime の他の job が見て休むための印）。kill・renice・再起動・設定変更はしない。
 * 通知：--webhook を付けた時だけ（usage-digest と同じ契約：URL は OS 資格情報ストアからだけ・https 必須。discord は宛先も discord.com の webhook に限る）。
 *   普段は静かに見て、本当に必要な時だけ知らせる（2026-11-05 Human 決定。基準は lib/alert-policy.mjs）。正常と軽微な異常は記録だけ。
 *   CRIT は即時（続けば 24 時間後から間隔を広げて再通知）、WARN は続いた時に 1 回、回復は CRIT を知らせた項目だけ 2 回続けて ok になってから 1 回、
 *   再起動・監視の空白・設定の変化は出来事として 1 回。電源・回線・再起動・監視の空白の繰り返しは「反復」にまとめる。送れなかった分は次の回にもう一度。四半期に 1 回だけ集計の要約を送る（lib/quarterly-report.mjs）。
 *   本文は固定の文と値だけで、値は項目ごとの形（VALUE_SHAPES）に合うものしか通さない。Discord の mention は全部無効。
 *   <state-dir>/PAUSE があれば記録だけして通知せず、状態も出来事の基準も進めない（保守窓。明けた後に変化として知らせる）。
 *   PAUSE は 72 時間で効かなくなる（消し忘れで全部の通知が黙らないように。monitor_pause=expired）。
 * 停止：3 回続けて失敗（全体の時間切れを含む）したら <state-dir>/DISABLED を作り、Human が消すまで調べない（exit 3）。全体 60 秒・コマンド 1 つ 5 秒で打ち切る。
 *   DISABLED の間も 24 時間ごとに知らせる（監視が止まったままにならないように）。ここで検知できない停止（job の解除・Mac の停止）は
 *   host-health-watchdog（別の job）と、再開した時の monitor_gap が受け持つ。watchdog の停止は monitor_watchdog でここから見る（相互に見る）。
 * コマンドは ALLOWED_BINS の絶対パスを固定の argv で shell なしに実行する（それ以外は起動しない）。
 * exit：0＝1 回分を記録した（WARN・CRIT があっても 0。異常は通知と記録で伝える）／1＝失敗／2＝引数・macOS 以外・時間超過／3＝DISABLED
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCredential, EDL_CREDENTIAL_PATTERN } from './lib/env-file.mjs';
import { BURST, COOLDOWN_MS, FLAP, RECOVER_RUNS, REMIND_MS, alertLine, remindInterval, ruleOf } from './lib/alert-policy.mjs';
import { QUARTERLY_RETRY, canAttempt, duePeriod, isPeriod, periodOf, previousPeriod, quarterlyText, summarizeQuarter } from './lib/quarterly-report.mjs';
import { JOBS } from './scheduled-job-service.mjs';
import { GUARD_BINS, HERMES_LABEL, collectGuard, defaultGuard, evaluateGuard, evaluateGuardEvents, nextGuardState, summarizeRecords } from './lib/runtime-guard.mjs';
import { STATUS_DIR, buildStatusSummary, writeStatusSummary } from './lib/runtime-status-summary.mjs';
import { GITHUB_OWNER, collectGithub, evaluateGithub, evaluateGithubEvents, nextGithubState } from './lib/github-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_DIR = path.join(REPO, 'data', 'host-health');
export const STATE_SCHEMA = 'host-health-state/v1';
export const ALLOWED_BINS = Object.freeze(['/bin/df', '/usr/sbin/sysctl', '/usr/bin/pmset', '/sbin/route', '/bin/launchctl', '/bin/ps', '/usr/bin/du', ...GUARD_BINS]);
/** 初期値（2026-10-21。Trading Lab の VM と同居する 32 GB の Mac mini を前提にした目安で、実測で見直す） */
export const THRESHOLDS = Object.freeze({
  disk_free_gib: { warn: 50, crit: 20 },
  swap_used_gib: { warn: 2 },
  data_gib: { warn: 30 },
  hermes_rss_gib: { warn: 3, crit: 4 },
  job_running_minutes: { warn: 30 },
});
/** DISABLED の間の通知の間隔 */
export const DISABLED_REMIND_MS = 24 * 3_600_000;
/** 回数を残せない時の通知の間隔。state が無いので時刻の枠で決める（6 時間ごとの最初の 1 時間。job が毎時のどの分でも枠に入る） */
export const UNWRITABLE_SLOT_MS = 6 * 3_600_000;
/** 毎時の watchdog の 3 回分 */
export const WATCHDOG_STALE_MS = 3 * 3_600_000;
export const WATCHDOG_LABEL = 'com.e-nexus.host-health-watchdog';
export { RECOVER_RUNS };
/** 30 分ごとの job の 3 回分。これより前の回から間があけば監視が止まっていた */
export const GAP_MS = 90 * 60_000;
/** 保守窓の上限（週末の休場より長い）。これより古い PAUSE は消し忘れとして効かせない */
export const PAUSE_MAX_MS = 72 * 3_600_000;
export const COMMAND_TIMEOUT_MS = 5000;
export const RUN_DEADLINE_MS = 60_000;
const MAX_FAILURES = 3;
/** Trading Lab の領域（見ない・引数に取らない） */
export const TRADING_LAB_PATH = /parallels|trading-?lab|mac-mini-migration-kit/i;
const WEBHOOK = /^credential:E-NEXUS\/edl\/[a-z0-9-]{1,64}$/;
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SCHEDULED_LABELS = JOBS.filter((j) => j !== 'host-health').map((j) => `com.e-nexus.${j}`);
const GiB = 1024 ** 3;

/** 許可したコマンドだけを shell なしで実行する。失敗しても reject しない（code・stdout・timedOut を返す）。allowed は network-baseline も使う */
export function makeRunner({ execFileImpl = execFile, timeoutMs = COMMAND_TIMEOUT_MS, allowed = ALLOWED_BINS, env = {} } = {}) {
  return (bin, args) => {
    if (!allowed.includes(bin)) return Promise.reject(new Error(`command not allowed: ${bin}`));
    return new Promise((resolve) => {
      execFileImpl(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', ...env } }, (err, stdout) => {
        if (!err) { resolve({ code: 0, stdout: String(stdout ?? ''), timedOut: false }); return; }
        resolve({ code: typeof err.code === 'number' ? err.code : -1, stdout: String(stdout ?? ''), timedOut: Boolean(err.killed) });
      });
    });
  };
}

// ─── 出力の読み取り（macOS の表示形式。fixture は 2026-10-21 の Mac mini の実出力）───

export function parseDfAvailableBytes(stdout) {
  const cols = (stdout.trim().split('\n').at(-1) ?? '').trim().split(/\s+/);
  const kib = Number(cols[3]);
  return cols.length >= 4 && Number.isFinite(kib) ? kib * 1024 : null;
}
export function parseSysctlInt(stdout) {
  const n = Number(String(stdout).trim());
  return String(stdout).trim() !== '' && Number.isInteger(n) ? n : null;
}
export function parseSwapUsedBytes(stdout) {
  const m = /used = ([\d.]+)([KMGT])/.exec(stdout);
  return m ? Number(m[1]) * 1024 ** { K: 1, M: 2, G: 3, T: 4 }[m[2]] : null;
}
export function parseLoadavg(stdout) {
  const m = /\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/.exec(stdout);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function parseBoottime(stdout) {
  const m = /sec = (\d+)/.exec(stdout);
  return m ? Number(m[1]) : null;
}
/** Apple silicon は記録が無ければ "No thermal warning level has been recorded"。Intel は CPU_Speed_Limit */
export function parseThermal(stdout) {
  const levels = [...stdout.matchAll(/(?:thermal|performance) warning level set to (\d+)/gi)].map((m) => Number(m[1]));
  const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(stdout);
  if (levels.some((n) => n > 0) || (speed && Number(speed[1]) < 100)) return 'warning';
  if (/No thermal warning level has been recorded/i.test(stdout) || levels.length || speed) return 'none';
  return null;
}
export function parsePowerSource(stdout) {
  const m = /Now drawing from '([^']+)'/.exec(stdout);
  if (!m) return null;
  const source = /AC Power/i.test(m[1]) ? 'ac' : /UPS/i.test(m[1]) ? 'ups' : /Battery/i.test(m[1]) ? 'battery' : 'other';
  const pct = /(\d{1,3})%/.exec(stdout);
  return { source, percent: pct ? Number(pct[1]) : null };
}
/** 既定経路が無いと route は 0 以外で終わる。時間切れは「分からない」（null） */
export function parseRoute({ code, stdout, timedOut }) {
  if (timedOut || code === -1) return null;
  const m = /^\s*interface:\s*(\S+)/m.exec(stdout);
  return code === 0 && m ? { default_route: true, interface: m[1] } : { default_route: false, interface: null };
}
/** launchctl print：読み込まれていなければ 113 */
export function parseLaunchctlPrint({ code, stdout, timedOut }) {
  if (timedOut) return null;
  if (code === 113) return { loaded: false };
  if (code !== 0) return null;
  const field = (k) => {
    const m = new RegExp(`^\\s*${k} = (.+)$`, 'm').exec(stdout);
    return m ? m[1].trim() : null;
  };
  const pid = field('pid');
  const exit = field('last exit code')?.split(':')[0]; // 版によって "78: EX_CONFIG" の形で出る
  return {
    loaded: true,
    state: field('state'),
    pid: pid && /^\d+$/.test(pid) ? Number(pid) : null,
    last_exit_code: exit && /^-?\d+$/.test(exit) ? Number(exit) : null,
    spawn_type: field('spawn type')?.split(' ')[0] ?? null,
  };
}
/** ps -o etime=：[[dd-]hh:]mm:ss */
export function parseEtimeSeconds(stdout) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(stdout);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}
export function parseDuBytes(stdout) {
  const m = /^(\d+)\s/.exec(`${String(stdout).trim()} `);
  return m ? Number(m[1]) * 1024 : null;
}
/** ps -U <user> -o rss=,pcpu=：その user の process が無ければ 0 */
export function parsePsUsage(stdout) {
  let rss = 0;
  let cpu = 0;
  let n = 0;
  for (const line of stdout.split('\n')) {
    const [r, c] = line.trim().split(/\s+/);
    if (!r) continue;
    if (!Number.isFinite(Number(r))) return null;
    rss += Number(r);
    cpu += Number.isFinite(Number(c)) ? Number(c) : 0;
    n += 1;
  }
  return { rss_bytes: rss * 1024, cpu_percent: Math.round(cpu * 10) / 10, processes: n };
}

// ─── 集める・判定する ───

/** 観測。Trading Lab の領域・process 一覧は取らない（ps は Mac Runtime 自身の job の pid と Hermes ユーザーだけ） */
export async function collect({ run, uid, dataDirs = [], hermesUser = null, guard = null, github = null, nowIso = new Date().toISOString() }) {
  const ok = (r) => (!r.timedOut && r.code === 0 ? r.stdout : null);
  const sysctl = async (key) => {
    const s = ok(await run('/usr/sbin/sysctl', ['-n', key]));
    return s;
  };
  const o = {};
  const df = ok(await run('/bin/df', ['-k', '/']));
  o.disk_free_bytes = df == null ? null : parseDfAvailableBytes(df);
  const pressure = await sysctl('kern.memorystatus_vm_pressure_level');
  o.memory_pressure_level = pressure == null ? null : parseSysctlInt(pressure);
  const swap = await sysctl('vm.swapusage');
  o.swap_used_bytes = swap == null ? null : parseSwapUsedBytes(swap);
  const load = await sysctl('vm.loadavg');
  o.loadavg = load == null ? null : parseLoadavg(load);
  const ncpu = await sysctl('hw.ncpu');
  o.ncpu = ncpu == null ? null : parseSysctlInt(ncpu);
  const boot = await sysctl('kern.boottime');
  o.boottime = boot == null ? null : parseBoottime(boot);
  const therm = ok(await run('/usr/bin/pmset', ['-g', 'therm']));
  o.thermal = therm == null ? null : parseThermal(therm);
  const ps = ok(await run('/usr/bin/pmset', ['-g', 'ps']));
  o.power = ps == null ? null : parsePowerSource(ps);
  o.route = parseRoute(await run('/sbin/route', ['-n', 'get', 'default']));
  o.jobs = {};
  for (const label of SCHEDULED_LABELS) {
    const j = parseLaunchctlPrint(await run('/bin/launchctl', ['print', `gui/${uid}/${label}`]));
    if (j?.loaded && j.state === 'running' && j.pid) {
      const e = ok(await run('/bin/ps', ['-o', 'etime=', '-p', String(j.pid)]));
      j.running_seconds = e == null ? null : parseEtimeSeconds(e);
    }
    o.jobs[label] = j;
  }
  let data = 0;
  for (const dir of dataDirs) {
    if (!existsSync(dir)) continue;
    const du = ok(await run('/usr/bin/du', ['-sk', dir]));
    const b = du == null ? null : parseDuBytes(du);
    if (b == null) { data = null; break; }
    data += b;
  }
  o.data_bytes = data;
  if (hermesUser) {
    const r = await run('/bin/ps', ['-U', hermesUser, '-o', 'rss=,pcpu=']);
    o.hermes = r.timedOut ? null : parsePsUsage(r.code === 0 ? r.stdout : '');
  }
  if (guard) {
    o.guard = await collectGuard({ run, hermesUser, ...guard });
    if (hermesUser) o.guard.service = parseLaunchctlPrint(await run('/bin/launchctl', ['print', `system/${HERMES_LABEL}`]));
  }
  if (github) o.github = await collectGithub({ ...github, now: nowIso });
  return o;
}

const gib = (b) => (b == null ? null : Math.round((b / GiB) * 10) / 10);

/** 状態の項目（ok／warn／crit／unknown）。値はシステム全体か Mac Runtime 自身のものだけ */
export function evaluate(o, t = THRESHOLDS) {
  const items = [];
  const add = (id, level, value) => items.push({ id, level, value, kind: 'state' });
  const disk = gib(o.disk_free_bytes);
  add('disk_free_gib', disk == null ? 'unknown' : disk < t.disk_free_gib.crit ? 'crit' : disk < t.disk_free_gib.warn ? 'warn' : 'ok', disk);
  const p = o.memory_pressure_level;
  add('memory_pressure', p == null ? 'unknown' : p >= 4 ? 'crit' : p >= 2 ? 'warn' : 'ok', p);
  const swap = gib(o.swap_used_bytes);
  add('swap_used_gib', swap == null ? 'unknown' : swap > t.swap_used_gib.warn ? 'warn' : 'ok', swap);
  const l15 = o.loadavg?.[2] ?? null;
  add('load_15m', l15 == null || !o.ncpu ? 'unknown' : l15 > o.ncpu ? 'warn' : 'ok', l15);
  add('thermal', o.thermal == null ? 'unknown' : o.thermal === 'warning' ? 'warn' : 'ok', o.thermal);
  const power = o.power ? (o.power.percent == null ? o.power.source : `${o.power.source} ${o.power.percent}%`) : null;
  add('power', o.power == null ? 'unknown' : o.power.source === 'ac' ? 'ok' : 'crit', power);
  add('network_default_route', o.route == null ? 'unknown' : o.route.default_route ? 'ok' : 'crit', o.route == null ? null : o.route.default_route ? 'present' : 'absent');
  for (const [label, j] of Object.entries(o.jobs ?? {})) {
    const id = `job:${label.replace(/^com\.e-nexus\./, '')}`;
    if (j == null) add(id, 'unknown', null);
    else if (!j.loaded) add(id, 'ok', 'not_loaded'); // 登録は Human。未登録は異常ではない
    else if (j.running_seconds != null && j.running_seconds > t.job_running_minutes.warn * 60) add(id, 'warn', `running ${Math.round(j.running_seconds / 60)}m`); // launchd には時間上限が無い
    else if (j.last_exit_code != null && j.last_exit_code !== 0) add(id, 'warn', `exit ${j.last_exit_code}`);
    else add(id, 'ok', j.state ?? 'loaded');
  }
  const data = gib(o.data_bytes);
  add('data_gib', data == null ? 'unknown' : data > t.data_gib.warn ? 'warn' : 'ok', data);
  if (o.hermes !== undefined) {
    const rss = o.hermes ? gib(o.hermes.rss_bytes) : null;
    add('hermes_rss_gib', rss == null ? 'unknown' : rss > t.hermes_rss_gib.crit ? 'crit' : rss > t.hermes_rss_gib.warn ? 'warn' : 'ok', rss);
  }
  return items;
}

/** 出来事（前回からの変化。回復の通知は無い） */
export function evaluateEvents(o, prev) {
  const ev = [];
  if (prev?.boottime != null && o.boottime != null && o.boottime !== prev.boottime) ev.push({ id: 'rebooted', level: 'warn', value: new Date(o.boottime * 1000).toISOString(), kind: 'event' });
  if (prev?.interface && o.route?.interface && o.route.interface !== prev.interface) ev.push({ id: 'network_interface_changed', level: 'warn', value: `${prev.interface}->${o.route.interface}`, kind: 'event' });
  return ev;
}

/** 前の回から間があいた＝監視が止まっていた（再起動・job の解除・ハング）。送れなかった分は pending の値で持ち越す（送れない間の時間を足さない） */
export function monitorGapEvent(prev, nowIso) {
  const event = (value) => [{ id: 'monitor_gap', level: 'warn', value, kind: 'event' }];
  if (prev?.gap_pending) return event(prev.gap_pending);
  const ms = Date.parse(nowIso) - Date.parse(prev?.last_success_at ?? prev?.updated_at);
  if (!Number.isFinite(ms) || ms <= GAP_MS) return [];
  const minutes = Math.round(ms / 60_000);
  return event(`${Math.floor(minutes / 60)}h${minutes % 60}m`);
}

/**
 * 通知するものと次の状態（基準は lib/alert-policy.mjs）。unknown は前の状態を保つ（読めなかった回で悪化も回復も作らない）。
 * paused（保守窓）の間は何も知らせず、状態も進めない。state の notified は知らせた水準で、続いている間の重複を止める。
 */
export function decide(items, prev, { now, paused = false }) {
  const prevItems = prev?.items ?? {};
  const next = { ...prevItems };
  const bursts = { ...(prev?.bursts ?? {}) };
  const notify = [];
  const t = Date.parse(now);
  const elapsed = (at) => t - Date.parse(at);
  const codesOf = (v) => String(v ?? '').split(',');
  const recent = (hits) => (hits ?? []).filter((h) => elapsed(h) < FLAP.window_ms);
  const quietEnd = new Date(t + FLAP.window_ms).toISOString();
  const quiet = (until) => Boolean(until) && t < Date.parse(until);
  for (const it of items) {
    if (paused) continue;
    const rule = ruleOf(it.id);
    if (it.kind === 'event') {
      if (rule.flap) {
        const b = bursts[it.id];
        const hits = [...recent(b?.hits), now];
        const hushed = quiet(b?.quiet_until);
        const repeat = !hushed && hits.length >= FLAP.count ? hits.length : null;
        bursts[it.id] = { hits, quiet_until: repeat ? quietEnd : (b?.quiet_until ?? null) };
        if (!hushed) notify.push({ id: it.id, level: it.level, value: it.value, change: 'event', ...(repeat ? { repeat } : {}) });
        continue;
      }
      if (!rule.burst) { notify.push({ id: it.id, level: it.level, value: it.value, change: 'event' }); continue; }
      const b = bursts[it.id];
      const hits = [...(b?.hits ?? []).filter((h) => elapsed(h) < BURST.window_ms), now];
      const fire = hits.length >= BURST.count && (!b?.last_notified_at || elapsed(b.last_notified_at) >= BURST.window_ms);
      bursts[it.id] = { hits, last_notified_at: fire ? now : (b?.last_notified_at ?? null) };
      if (fire) notify.push({ id: it.id, level: it.level, value: hits.length, change: 'event' });
      continue;
    }
    if (it.level === 'unknown') continue;
    const p = prevItems[it.id] ?? { level: 'ok', since: now, last_notified_at: null };
    const hushed = rule.flap && quiet(p.flap_quiet_until);
    if (it.level === 'ok') {
      if (p.level !== 'ok') {
        const okRuns = (p.ok_runs ?? 0) + 1;
        if (okRuns < RECOVER_RUNS || hushed) { next[it.id] = { ...p, ok_runs: okRuns }; continue; }
      } else if (!p.missed_at) { next[it.id] = p; continue; }
      let change = p.notified === 'crit' ? 'recovered' : p.missed_at ? 'recovered_missed' : null;
      // 回線断は送信も失敗するので、行き来は「知らせられなかった」の回数でも数える
      const hits = rule.flap ? [...recent(p.flap_hits), ...(change === 'recovered_missed' ? [now] : [])] : null;
      if (change === 'recovered_missed' && hushed) change = null;
      const repeat = change === 'recovered_missed' && rule.flap && hits.length >= FLAP.count ? hits.length : null;
      next[it.id] = {
        level: 'ok',
        since: now,
        last_notified_at: change ? now : p.last_notified_at,
        recovered_at: change === 'recovered' ? now : (p.recovered_at ?? null), // 「知らせられなかった」の後の戻りは待たせない
        ...(rule.flap ? { flap_hits: hits, flap_quiet_until: repeat ? quietEnd : (p.flap_quiet_until ?? null) } : {}),
      };
      if (change) notify.push({ id: it.id, level: 'ok', value: it.value, change, ...(repeat ? { repeat } : {}) });
      continue;
    }
    const since = p.level === 'ok' ? now : p.since;
    const held = elapsed(since) >= rule.hold;
    const level = it.level === 'crit' || (rule.promote && held) ? 'crit' : 'warn';
    const grew = rule.codes && p.notified && codesOf(it.value).some((c) => !codesOf(p.notified_value).includes(c));
    let change = null;
    if (grew) change = 'new';
    else if (level === 'crit' && p.notified === 'crit') {
      // 長く WARN へ下がった後に重大へ戻った時は、広がった間隔を待たない（境で行き来するだけなら広げたまま）
      const longLow = it.level === 'crit' && p.lowered_at && elapsed(p.lowered_at) >= REMIND_MS.first;
      change = elapsed(p.last_notified_at) >= (longLow ? REMIND_MS.first : remindInterval(p.reminders)) ? 'reminder' : null;
    } else if (level === 'crit') change = !rule.noCooldown && p.recovered_at && elapsed(p.recovered_at) < COOLDOWN_MS ? null : 'new';
    else if (!p.notified && held) change = 'new';
    const onset = rule.flap && (p.level === 'ok' || (p.ok_runs ?? 0) > 0); // 回復を待っている間の戻りも 1 回の行き来
    const hits = rule.flap ? [...recent(p.flap_hits), ...(onset ? [now] : [])] : null;
    if (change === 'new' && hushed) change = null;
    const repeat = change === 'new' && rule.flap && hits.length >= FLAP.count ? hits.length : null;
    next[it.id] = {
      level: it.level,
      since,
      last_notified_at: change ? now : p.last_notified_at,
      notified: change ? level : (p.notified ?? null),
      notified_value: change ? it.value : (p.notified_value ?? null),
      reminders: change === 'reminder' ? (p.reminders ?? 0) + 1 : change ? 0 : (p.reminders ?? 0),
      recovered_at: p.recovered_at ?? null,
      missed_at: change && level === 'crit' ? null : (p.missed_at ?? null),
      lowered_at: it.level === 'crit' ? null : (p.lowered_at ?? now),
      ...(rule.flap ? { flap_hits: hits, flap_quiet_until: repeat ? quietEnd : (p.flap_quiet_until ?? null) } : {}),
    };
    if (change) notify.push({ id: it.id, level, value: it.value, change, ...(repeat ? { repeat } : {}) });
  }
  return { notify, items: next, bursts };
}

/**
 * 送れなかった項目を前の状態へ戻し、次の回にもう一度判定させる。重大は「知らせられなかった」印を残す（送れない間に解消しても、回線断の後に 1 回知らせる）。
 * watchdog も使う。
 */
export function rollbackUnsent(notify, prevItems, nextItems, at) {
  const items = { ...nextItems };
  for (const n of notify) {
    const p = prevItems?.[n.id];
    if (n.level === 'crit' && n.change === 'new') items[n.id] = { ...(p ?? { level: 'ok', since: at, last_notified_at: null }), missed_at: p?.missed_at ?? at };
    else if (p) items[n.id] = p;
    else delete items[n.id];
  }
  return items;
}

// ─── 通知（usage-digest と同じ契約。共通通知 package は作らない＝MA-30）───

const DISCORD_LIMIT = 1900;
const LEVEL_ORDER = { crit: 0, warn: 1, ok: 2 };
const SAFE_ID = /^[a-z0-9_]{1,40}(?::[A-Za-z0-9._-]{1,100})?$/;
const codes = (...c) => new RegExp(`^(?:${c.join('|')})(?:,(?:${c.join('|')}))*$`);
const VISIBILITY = '(?:PUBLIC|PRIVATE|INTERNAL)';
const BRANCH = '[A-Za-z0-9._-]{1,60}(?:/[A-Za-z0-9._-]{1,60}){0,3}';
/**
 * 通知の最後の関所（allowlist）。項目ごとに値の形を決め、ここに無い項目の文字列は出さない（数だけ通す）。
 * IP・ホスト名・ユーザー名は形では見分けられないので、知らない値は全部落とす。項目を足す時はここへも足す。
 */
const VALUE_SHAPES = Object.freeze([
  [/^thermal$/, /^(?:none|warning)$/],
  [/^power$/, /^(?:ac|ups|battery|other)(?: \d{1,3}%)?$/],
  [/^network_default_route$/, /^(?:present|absent)$/],
  [/^rebooted$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/],
  [/^network_interface_changed$/, /^[a-z]{1,10}\d{0,3}->[a-z]{1,10}\d{0,3}$/],
  [/^job:/, /^(?:not_loaded|loaded|running|not running|waiting|spawn scheduled|xpcproxy|exited|exit -?\d+|running \d+m)$/],
  [/^repo:/, /^(?:clean|(?:dirty \d+)?(?: ?ahead \d+)?(?: ?no_upstream)?)$/],
  [/^backup_/, /^(?:not_configured|latest_unreadable|-?\d+d(?: restore (?:never|\d+d))?)$/],
  [/^hermes_service$/, /^(?:running|not_loaded|stopped exit (?:-?\d+|-))$/],
  [/^hermes_isolation$/, codes('ok', 'admin_group', 'hermes_home_open', 'operator_home_open', 'hermes_home_missing', 'operator_home_missing', '(?:config|plist|wrapper)_(?:not_root_only|missing)', 'share_open', 'share_missing')],
  [/^hermes_files_changed$/, codes('vault_copy', 'config', 'plist', 'wrapper')],
  [/^monitor_config_changed$/, codes('monitor_plist', 'watchdog_plist', 'human_only_policy', 'failure_policy')],
  [/^agent_scope$/, codes('ok', 'user_claude_md', 'user_rules')],
  [/^residents_changed$/, /^[+-][a-z0-9.-]{1,60}(?:,[+-][a-z0-9.-]{1,60})*$/],
  [/^github_api$/, /^(?:ok|unreachable|auth_failed|token_expiring)$/],
  [/^github:/, /^(?:ok|ci_failure|ci_stuck|archived|disabled|not_found|differs_from_mac)$/],
  [/^github_visibility_changed$/, new RegExp(`^[A-Za-z0-9._-]{1,100}:${VISIBILITY}->${VISIBILITY}$`)],
  [/^github_default_branch_changed$/, new RegExp(`^[A-Za-z0-9._-]{1,100}:${BRANCH}->${BRANCH}$`)],
  [/^monitor_gap$/, /^\d+h\d+m$/],
  [/^monitor_pause$/, /^(?:none|active|expired)$/],
  [/^monitor_alive$/, /^(?:ok|disabled|not_loaded|no_state|stale \d+m)$/],
  [/^monitor_watchdog$/, /^(?:ok|not_installed|not_loaded|no_state|stale \d+m)$/],
  [/^host_health$/, /^(?:disabled|state_unwritable)$/],
  [/^status_summary$/, /^(?:written|not_configured|dir_unsafe|write_failed)$/],
  [/^delivery_test$/, /^配送試験 異常ではありません$/],
]);
export function safeValue(id, v) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  return VALUE_SHAPES.find(([key]) => key.test(id))?.[1].test(String(v)) ? String(v) : '[redacted]';
}
const cleanNotify = (notify) => notify.map(({ id, level, value, change, repeat }) => ({ id: SAFE_ID.test(id) ? id : '[redacted]', level, value: safeValue(id, value), change, ...(Number.isInteger(repeat) ? { repeat } : {}) }));

export function alertText(notify, limit = Infinity) {
  const rows = cleanNotify(notify).sort((a, b) => (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3));
  const lines = ['[E-NEXUS Mac Runtime host]'];
  let used = lines[0].length;
  for (const [i, n] of rows.entries()) {
    const line = alertLine(n);
    if (used + line.length + 1 > limit - 40) { lines.push(`…ほか ${rows.length - i} 件（内部の記録で確認）`); break; }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
/** text があれば運用要約（集計の数だけの本文）。無ければ通知の項目から本文を作る */
export function webhookBodyOf(notify, format, at, text = null) {
  if (format === 'slack') return { text: text ?? alertText(notify) };
  if (format === 'discord') return { content: text ?? alertText(notify, DISCORD_LIMIT), allowed_mentions: { parse: [] } };
  return { component: 'e-nexus-mac-runtime-host', at, ...(text ? { summary: text } : { alerts: cleanNotify(notify) }) };
}
/** 取り違えた資格情報で別の宛先へ送らない（Discord の webhook の形だけ） */
export function isDiscordWebhook(url) {
  return /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(url.hostname) && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname);
}
/** URL は credential:E-NEXUS/edl/<name> からだけ。https 必須。失敗しても記録は成功 */
export async function postAlerts(notify, { spec, format = 'json', at, text = null, readCredentialImpl = readCredential, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (typeof spec !== 'string' || !spec.startsWith('credential:')) return { sent: false, code: 'WEBHOOK_MUST_BE_CREDENTIAL' };
  const target = spec.slice('credential:'.length);
  if (!EDL_CREDENTIAL_PATTERN.test(target)) return { sent: false, code: 'WEBHOOK_CREDENTIAL_TARGET_INVALID' };
  if (!['json', 'slack', 'discord'].includes(format)) return { sent: false, code: 'WEBHOOK_FORMAT_INVALID' };
  let url;
  try {
    const v = await readCredentialImpl(target);
    if (!v) return { sent: false, code: 'WEBHOOK_CREDENTIAL_MISSING' };
    url = new URL(v);
  } catch {
    return { sent: false, code: 'WEBHOOK_CREDENTIAL_UNREADABLE' };
  }
  if (url.protocol !== 'https:') return { sent: false, code: 'WEBHOOK_URL_INSECURE' };
  if (format === 'discord' && !isDiscordWebhook(url)) return { sent: false, code: 'WEBHOOK_URL_NOT_DISCORD' };
  const bodyFormat = isDiscordWebhook(url) ? 'discord' : format; // Discord は json を受け取らない。引数の付け忘れで永久に送れない形にしない
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookBodyOf(notify, bodyFormat, at, text)), redirect: 'error', signal: controller.signal });
    return res.ok ? { sent: true, code: 'SENT' } : { sent: false, code: `WEBHOOK_HTTP_${res.status}` };
  } catch (err) {
    return { sent: false, code: err?.name === 'AbortError' ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 記録 ───

function readState(dir) {
  const f = path.join(dir, 'state.json');
  if (!existsSync(f)) return null;
  try {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return s?.schema === STATE_SCHEMA ? s : null;
  } catch {
    return null; // 壊れていれば最初から（同じ通知がもう一度出ることはあるが、止まりはしない）
  }
}
function writeState(dir, s) {
  const f = path.join(dir, 'state.json');
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, f);
}
function setFlag(dir, name, on, text) {
  const f = path.join(dir, name);
  if (on) writeFileSync(f, `${text}\n`, { mode: 0o600 });
  else if (existsSync(f)) rmSync(f);
}

/** 保守窓か。古い PAUSE は効かせない（時計より新しい mtime は保守窓のまま） */
export function pauseState(stateDir, at) {
  const f = path.join(stateDir, 'PAUSE');
  if (!existsSync(f)) return { paused: false, expired: false };
  const expired = Date.parse(at) - statSync(f).mtimeMs > PAUSE_MAX_MS;
  return { paused: !expired, expired };
}

/** 監視が止まっていることの通知（DISABLED の間も 24 時間ごと）。送れた時刻を state に残す。state を書けない時は時刻の枠で間引いて送る */
async function noticeDisabled({ stateDir, state, webhook, webhookFormat, at, post, value = 'disabled' }) {
  const last = state?.disabled_notified_at;
  if (!webhook || pauseState(stateDir, at).paused) return null;
  if (last && Date.parse(at) - Date.parse(last) < DISABLED_REMIND_MS) return null;
  if (value === 'state_unwritable' && Date.parse(at) % UNWRITABLE_SLOT_MS >= 3_600_000) return null;
  const r = await post([{ id: 'host_health', level: 'crit', value, change: last ? 'reminder' : 'event' }], { spec: webhook, format: webhookFormat, at }).catch(() => ({ sent: false, code: 'WEBHOOK_UNREACHABLE' }));
  if (r.sent) {
    try {
      writeState(stateDir, { ...(state ?? { schema: STATE_SCHEMA, items: {} }), disabled_notified_at: at });
    } catch { /* 書けなければ次の回にもう一度知らせる */ }
  }
  return r.code;
}

/** 失敗の 1 回分（例外と全体の時間切れ）。続けば DISABLED にして知らせる */
export async function recordFailure({ stateDir, at, webhook = null, webhookFormat = 'json', post = postAlerts }) {
  const prev = readState(stateDir);
  const failures = (prev?.consecutive_failures ?? 0) + 1;
  const gap = monitorGapEvent(prev, at)[0]?.value;
  const state = { ...(prev ?? { schema: STATE_SCHEMA, items: {} }), updated_at: at, consecutive_failures: failures, ...(gap ? { gap_pending: gap } : {}) };
  try {
    writeState(stateDir, state);
  } catch {
    // 回数を残せない＝数えられないので、黙らないよう知らせ続ける（時刻の枠。6 時間ごとの最初の 1 時間）。残っていない回数で DISABLED にはしない（一瞬の書き込み失敗で監視を止めない）
    await noticeDisabled({ stateDir, state, webhook, webhookFormat, at, post, value: 'state_unwritable' });
    return failures;
  }
  if (failures >= MAX_FAILURES) {
    try {
      setFlag(stateDir, 'DISABLED', true, `${at} ${failures} consecutive failures（原因を確かめてから Human が消す）`);
      state.disabled_at = state.disabled_at ?? at;
      writeState(stateDir, state);
    } catch { /* 印を置けなくても知らせる */ }
    await noticeDisabled({ stateDir, state, webhook, webhookFormat, at, post });
  }
  return failures;
}

/** Hermes へ渡す要約を書く（statusDir の時だけ）。監視の本体を止めない。戻り値はコード */
function publishStatus({ statusDir, stateDir, state, at, uid }) {
  if (!statusDir) return null;
  try {
    const summary = buildStatusSummary(state, { now: new Date(at), paused: pauseState(stateDir, at).paused, disabled: existsSync(path.join(stateDir, 'DISABLED')) });
    return writeStatusSummary(summary, { dir: statusDir, uid });
  } catch {
    return 'write_failed';
  }
}

/** watchdog は host-health を見て、host-health は watchdog を見る（片方が止まればもう片方が知らせる。同時の停止はどちらからも見えない）。未登録は異常にしない */
export function watchdogItem({ installed, job, updatedAt, now, gap = false }) {
  const item = (level, value) => ({ id: 'monitor_watchdog', level, value, kind: 'state' });
  if (installed == null || job == null || gap) return item('unknown', null); // 監視の空白・起動の直後は watchdog もまだ回っていない（Mac の停止の後の偽の CRIT を出さない）
  if (!installed) return item('ok', 'not_installed');
  if (!job.loaded) return item('crit', 'not_loaded');
  const ms = Date.parse(now) - Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return item('warn', 'no_state'); // 登録した直後は記録がまだ無い。続いた時だけ知らせる
  return ms > WATCHDOG_STALE_MS ? item('crit', `stale ${Math.round(ms / 60_000)}m`) : item('ok', 'ok');
}
function watchdogUpdatedAt(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'watchdog.json'), 'utf8')).updated_at ?? null;
  } catch {
    return null;
  }
}

/** 記録の行（新しい月のファイルも全部）。state-dir の YYYY-MM.jsonl を読むだけ */
function recordLines(stateDir) {
  const files = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)) : [];
  return files.flatMap((f) => readFileSync(path.join(stateDir, f), 'utf8').split('\n').filter(Boolean));
}

/**
 * 四半期の運用要約。送るのは 1 回の run に 1 通まで・間隔をあけて回数も限る。送る前に試みを state へ残す（送れた後の書き込みに失敗しても 6 時間は重ねない）。
 * PAUSE の間・webhook が無い時は試みに数えない。戻り値の state を次の state へ入れる。
 */
export async function runQuarterly({ stateDir, prev, at, paused, webhook, webhookFormat, post }) {
  const q = prev?.quarterly ?? { last_period: previousPeriod(periodOf(Date.parse(at))), attempts: 0, last_attempt_at: null };
  const period = duePeriod(q, at);
  if (!period || paused || !webhook || !canAttempt(q, at)) return { state: q, code: null };
  const attempts = (q.attempts ?? 0) + 1;
  const tried = { ...q, attempts, last_attempt_at: at };
  writeState(stateDir, { ...(prev ?? { schema: STATE_SCHEMA, items: {} }), quarterly: tried });
  let r;
  try {
    const text = quarterlyText(period, summarizeQuarter(recordLines(stateDir), period));
    r = await post([], { spec: webhook, format: webhookFormat, at, text });
  } catch {
    r = { sent: false, code: 'QUARTERLY_FAILED' }; // 要約の失敗で 1 回分の監視を失敗にしない
  }
  if (r.sent) return { state: { last_period: period, attempts: 0, last_attempt_at: null }, period, code: r.code };
  if (attempts >= QUARTERLY_RETRY.max_attempts) return { state: { last_period: period, attempts: 0, last_attempt_at: null }, period, code: 'QUARTERLY_GAVE_UP' };
  return { state: tried, period, code: r.code };
}

/** 1 回分。run・uid・post・now を差し替えて test する */
export async function runHostHealth({ stateDir = DEFAULT_STATE_DIR, dataDirs = [path.join(REPO, 'data')], hermesUser = null, guard = null, github = null, statusDir = null, webhook = null, webhookFormat = 'json', run, uid, now = () => new Date(), post = postAlerts }) {
  const at = now().toISOString();
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch { /* 作れなければ下の記録で失敗し、recordFailure が知らせる */ }
  let prev = readState(stateDir);
  if (existsSync(path.join(stateDir, 'DISABLED'))) {
    const notifyCode = await noticeDisabled({ stateDir, state: prev, webhook, webhookFormat, at, post });
    publishStatus({ statusDir, stateDir, state: prev, at, uid });
    return { code: 3, status: 'disabled', notifyCode };
  }
  try {
    if (prev?.disabled_at || prev?.disabled_notified_at || (prev?.consecutive_failures ?? 0) >= MAX_FAILURES) {
      // Human が DISABLED を消した：数え直す（1 回の失敗で黙って止まり直さない。前の版が作った DISABLED には disabled_at が無い）
      const { disabled_at: _a, disabled_notified_at: _b, ...rest } = prev;
      prev = { ...rest, consecutive_failures: 0 };
      writeState(stateDir, prev);
    }
    const { paused, expired } = pauseState(stateDir, at);
    const o = await collect({ run, uid, dataDirs, hermesUser, guard, github, nowIso: at });
    const gap = monitorGapEvent(prev, at);
    const items = [...evaluate(o), ...evaluateEvents(o, prev), ...gap, { id: 'monitor_pause', level: expired ? 'warn' : 'ok', value: expired ? 'expired' : paused ? 'active' : 'none', kind: 'state' }];
    if (o.guard) items.push(...evaluateGuard(o.guard, prev?.guard, at), ...evaluateGuardEvents(o.guard, prev?.guard), watchdogItem({ installed: o.guard.residents?.includes(WATCHDOG_LABEL), job: o.jobs?.[WATCHDOG_LABEL], updatedAt: watchdogUpdatedAt(stateDir), now: at, gap: gap.length > 0 || Date.parse(at) - (o.boottime ?? 0) * 1000 < GAP_MS }));
    if (statusDir) items.push({ id: 'status_summary', level: ['dir_unsafe', 'write_failed'].includes(prev?.status_summary) ? 'warn' : 'ok', value: prev?.status_summary ?? 'not_configured', kind: 'state' });
    const githubOn = Boolean(github) && o.github?.status !== 'off'; // token が入るまでは何も足さない
    const githubRepos = o.github?.status === 'ok' ? o.github.repos : null;
    if (githubOn) items.push(...evaluateGithub(githubRepos, o.guard?.repos, prev?.github, at, { failure: o.github.status, expiresAt: o.github.expires_at ?? null }), ...evaluateGithubEvents(githubRepos, prev?.github));
    const d = decide(items, prev, { now: at, paused });
    // 今回見なかった項目は消す（外した repo・Hermes の水準が残り続けない）。GitHub が読めなかった回は残す
    const seen = new Set(items.map((x) => x.id));
    const keep = (id) => seen.has(id) || paused || !guard || (id.startsWith('github:') && githubOn && githubRepos == null);
    let nextItems = Object.fromEntries(Object.entries(d.items).filter(([id]) => keep(id)));
    let notifyCode = d.notify.length === 0 ? 'NOTHING_TO_SEND' : webhook ? null : 'NO_WEBHOOK';
    if (d.notify.length && webhook) {
      // 送れた印を残せないなら送らない（書けない間に同じ通知を毎回重ねない）。書けないことは recordFailure が知らせる
      writeState(stateDir, prev ?? { schema: STATE_SCHEMA, items: {} });
      const r = await post(d.notify, { spec: webhook, format: webhookFormat, at });
      notifyCode = r.code;
      if (!r.sent) {
        nextItems = rollbackUnsent(d.notify, prev?.items, nextItems, at);
      }
    }
    const degraded = items.some((x) => (x.id === 'disk_free_gib' || x.id === 'memory_pressure') && x.level === 'crit');
    setFlag(stateDir, 'DEGRADED', degraded, at);
    // 送れなかった回と保守窓の間は、出来事の基準を進めない（次の回・明けた後に知らせる）
    const eventsUnsent = paused || (notifyCode !== 'SENT' && notifyCode !== 'NO_WEBHOOK' && d.notify.some((n) => n.change === 'event'));
    // 基準を進めない回は同じ出来事が次の回にまた出るので、繰り返しの回数に足さない
    const bursts = eventsUnsent ? (prev?.bursts ?? {}) : d.bursts;
    const quarterly = await runQuarterly({ stateDir, prev, at, paused, webhook, webhookFormat, post });
    const nextState = {
      schema: STATE_SCHEMA,
      updated_at: at,
      last_success_at: at,
      // 通知の状態（items）は送れなければ戻す。今の水準はこちら（要約が「送れていない異常」を ok と言わないように）
      observed: Object.fromEntries(items.filter((x) => x.kind === 'state').map((x) => [x.id, x.level])),
      // 出来事を送れなかった時は前の値を残し、次の回にもう一度出来事として判定させる
      boottime: eventsUnsent ? (prev?.boottime ?? null) : (o.boottime ?? prev?.boottime ?? null),
      interface: eventsUnsent ? (prev?.interface ?? null) : (o.route?.interface ?? prev?.interface ?? null),
      consecutive_failures: 0,
      items: nextItems,
      bursts,
      quarterly: quarterly.state,
      ...(o.guard ? { guard: nextGuardState(o.guard, prev?.guard, at, { keepEvents: eventsUnsent }) } : prev?.guard ? { guard: prev.guard } : {}),
      ...(githubOn ? { github: nextGithubState(githubRepos, prev?.github, at, { keepEvents: eventsUnsent, localRepos: o.guard?.repos }) } : prev?.github ? { github: prev.github } : {}),
      ...(eventsUnsent && gap.length ? { gap_pending: gap[0].value } : {}),
    };
    const statusCode = publishStatus({ statusDir, stateDir, state: nextState, at, uid });
    writeState(stateDir, { ...nextState, ...(statusCode ? { status_summary: statusCode } : {}) });
    const levels = { ok: 0, warn: 0, crit: 0, unknown: 0 };
    for (const x of items) levels[x.level] += 1;
    appendFileSync(path.join(stateDir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ at, paused, degraded, levels, items: items.map(({ id, level, value }) => ({ id, level, value })), notify: d.notify.map(({ id, level, change }) => ({ id, level, change })), notify_code: notifyCode, ...(quarterly.code ? { quarterly: { period: quarterly.period, code: quarterly.code } } : {}) })}\n`, { mode: 0o600 });
    return { code: 0, status: 'ok', items, notify: d.notify, notifyCode, paused, degraded, levels };
  } catch (err) {
    const failures = await recordFailure({ stateDir, at, webhook, webhookFormat, post });
    return { code: 1, status: 'failed', failures, error: String(err?.code ?? err?.name ?? 'error') }; // message にはパスが入る。ログへ出さない
  }
}

// ─── CLI ───

export function parseArgs(argv) {
  const a = { dataDirs: [], json: false, guard: true, report: false, webhookTest: false, quarterlyPreview: false };
  const map = { '--state-dir': 'stateDir', '--hermes-user': 'hermesUser', '--webhook': 'webhook', '--webhook-format': 'webhookFormat', '--days': 'days', '--github-owner': 'githubOwner', '--github-credential': 'githubCredential', '--period': 'period' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--json') { a.json = true; continue; }
    if (k === '--no-guard') { a.guard = false; continue; }
    if (k === '--report') { a.report = true; continue; }
    if (k === '--webhook-test') { a.webhookTest = true; continue; }
    if (k === '--quarterly-preview') { a.quarterlyPreview = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
    if (k === '--data-dir') a.dataDirs.push(argv[i + 1]);
    else if (map[k]) a[map[k]] = argv[i + 1];
    else throw new Error(`unknown argument: ${k}`);
    i += 1;
  }
  return a;
}

export function validateArgs(a) {
  const errors = [];
  for (const [k, v] of [['--state-dir', a.stateDir], ...a.dataDirs.map((d) => ['--data-dir', d])]) {
    if (v === undefined) continue;
    if (!path.posix.isAbsolute(v)) errors.push(`${k} must be an absolute path`);
    else if (TRADING_LAB_PATH.test(v)) errors.push(`${k}: Trading Lab の領域は見ない`);
  }
  if (a.days !== undefined && !/^[1-9]\d{0,2}$/.test(a.days)) errors.push('--days must be 1-999');
  if (a.hermesUser !== undefined && !USER_NAME.test(a.hermesUser)) errors.push('--hermes-user must be a local user name');
  if (a.webhook !== undefined && !WEBHOOK.test(a.webhook)) errors.push('--webhook must be credential:E-NEXUS/edl/<name>（URL を引数に置かない）');
  if (a.webhookFormat !== undefined && !['json', 'slack', 'discord'].includes(a.webhookFormat)) errors.push('--webhook-format must be json|slack|discord');
  if (a.webhookTest && !a.webhook) errors.push('--webhook-test needs --webhook');
  if (a.githubOwner !== undefined && !GITHUB_OWNER.test(a.githubOwner)) errors.push('--github-owner must be a GitHub owner name');
  if (a.githubCredential !== undefined && !WEBHOOK.test(a.githubCredential)) errors.push('--github-credential must be credential:E-NEXUS/edl/<name>');
  if ((a.githubOwner === undefined) !== (a.githubCredential === undefined)) errors.push('--github-owner と --github-credential は両方必要（無人 job は gh のログインを使わない）');
  if (a.period !== undefined && !isPeriod(a.period)) errors.push('--period must look like 2026Q4');
  return errors;
}

/** 記録の要約（観察用）。state-dir の YYYY-MM.jsonl を読むだけ */
export function reportOf(stateDir, { days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  return { component: 'edl-host-health', days, ...summarizeRecords(recordLines(stateDir), { since }) };
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validateArgs(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  if (a.report) { console.log(JSON.stringify(reportOf(a.stateDir ?? DEFAULT_STATE_DIR, { days: Number(a.days ?? 7) }), null, 2)); return 0; }
  if (a.quarterlyPreview) {
    const period = a.period ?? previousPeriod(periodOf(Date.now()));
    console.log(quarterlyText(period, summarizeQuarter(recordLines(a.stateDir ?? DEFAULT_STATE_DIR), period, { now: Date.now() })));
    return 0;
  }
  if (a.webhookTest) {
    const r = await postAlerts([{ id: 'delivery_test', level: 'ok', value: '配送試験 異常ではありません', change: 'event' }], { spec: a.webhook, format: a.webhookFormat ?? 'json', at: new Date().toISOString() });
    console.log(JSON.stringify({ component: 'edl-host-health', webhook_test: r.code }));
    return r.sent ? 0 : 1;
  }
  if (process.platform !== 'darwin') { console.error('host-health is for the Mac mini (macOS) only'); return 2; }
  const stateDir = a.stateDir ?? DEFAULT_STATE_DIR;
  const webhook = a.webhook ?? null;
  const webhookFormat = a.webhookFormat ?? 'json';
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ component: 'edl-host-health', status: 'timeout' }));
    // 時間切れが続いても黙らないよう失敗に数える（資格情報の読み取り 15 秒＋送信 10 秒。それでも終わらない時の保険が下の timer）
    setTimeout(() => process.exit(2), 30_000).unref();
    recordFailure({ stateDir, at: new Date().toISOString(), webhook, webhookFormat }).catch(() => {}).finally(() => process.exit(2));
  }, RUN_DEADLINE_MS);
  deadline.unref();
  let guard = null;
  try {
    guard = a.guard ? defaultGuard(REPO) : null;
  } catch (err) {
    await recordFailure({ stateDir, at: new Date().toISOString(), webhook, webhookFormat });
    console.error(JSON.stringify({ component: 'edl-host-health', error: String(err?.code ?? 'guard_setup_failed') }));
    return 1;
  }
  const r = await runHostHealth({
    stateDir,
    dataDirs: a.dataDirs.length ? a.dataDirs : [path.join(REPO, 'data')],
    hermesUser: a.hermesUser ?? null,
    guard,
    github: a.githubOwner ? { credential: a.githubCredential.slice('credential:'.length), owner: a.githubOwner, repos: guard?.repos ?? [] } : null,
    statusDir: a.hermesUser ? STATUS_DIR : null,
    webhook,
    webhookFormat,
    run: makeRunner(),
    uid: process.getuid(),
  });
  clearTimeout(deadline);
  if (a.json && r.items) console.log(JSON.stringify({ component: 'edl-host-health', ...r }, null, 2));
  else console.log(JSON.stringify({ component: 'edl-host-health', status: r.status, levels: r.levels ?? null, notify: r.notify?.length ?? 0, notify_code: r.notifyCode ?? null, paused: r.paused ?? null, degraded: r.degraded ?? null, ...(r.failures ? { failures: r.failures } : {}) }));
  if (r.error) console.error(JSON.stringify({ component: 'edl-host-health', error: r.error }));
  return r.code;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => {
    console.error(JSON.stringify({ component: 'edl-host-health', error: String(err?.code ?? err?.name ?? 'error') }));
    process.exitCode = 1;
  });
}
