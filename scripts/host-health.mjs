#!/usr/bin/env node
/**
 * Mac mini（Runtime Node）のホスト監視（2026-10-21・Vault MA-22・Mac Runtime 工程 3）。READ-ONLY・sudo 不要・課金なし・macOS のみ。
 *
 *   node scripts/host-health.mjs [--state-dir <abs>] [--data-dir <abs>]... [--hermes-user <name>]
 *        [--webhook credential:E-NEXUS/edl/<name> [--webhook-format json|slack|discord]] [--json]
 *
 * 見るもの：ホストの資源（起動ディスクの空き・メモリ逼迫・swap・15 分 load・発熱・電源・再起動・既定経路）、
 *   Mac Runtime 自身の定期 job（com.e-nexus.<job> の LaunchAgent）、Mac Runtime のデータ量、（導入後）Hermes ユーザーの資源。
 * 見ないもの：Trading Lab の process・VM・MT5・状態ファイル・Monitor。LIVE の状態は Trading Lab の Monitor の担当で、ここでは報告しない。
 *   process の一覧・command line・パス・IP・ホスト名は記録にも通知にも出さない（load・メモリはシステム全体の値だけ）。
 * することは 3 つだけ：記録（<state-dir>/state.json・YYYY-MM.jsonl）／状態が変わった時の通知／DEGRADED の印（起動ディスクかメモリが
 *   CRIT の間。Mac Runtime の他の job が見て休むための印）。kill・renice・再起動・設定変更はしない。
 * 通知：--webhook を付けた時だけ（usage-digest と同じ契約：URL は OS 資格情報ストアからだけ・https 必須）。CRIT は即時（続けば 3 時間ごと）、
 *   WARN は 1 回（続けば 12 時間ごと）、回復は 1 回、再起動・回線の切替は出来事として 1 回。送れなかった分は次の回にもう一度。
 *   <state-dir>/PAUSE があれば記録だけして通知せず、状態も進めない（保守窓。明けた後に変化として知らせる）。
 * 停止：3 回続けて失敗したら <state-dir>/DISABLED を作り、Human が消すまで何もしない（exit 3）。全体 60 秒・コマンド 1 つ 5 秒で打ち切る。
 * コマンドは ALLOWED_BINS の絶対パスを固定の argv で shell なしに実行する（それ以外は起動しない）。
 * exit：0＝1 回分を記録した（WARN・CRIT があっても 0。異常は通知と記録で伝える）／1＝失敗／2＝引数・macOS 以外・時間超過／3＝DISABLED
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCredential, EDL_CREDENTIAL_PATTERN } from './lib/env-file.mjs';
import { JOBS } from './scheduled-job-service.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_DIR = path.join(REPO, 'data', 'host-health');
export const STATE_SCHEMA = 'host-health-state/v1';
export const ALLOWED_BINS = Object.freeze(['/bin/df', '/usr/sbin/sysctl', '/usr/bin/pmset', '/sbin/route', '/bin/launchctl', '/bin/ps', '/usr/bin/du']);
/** 初期値（2026-10-21。Trading Lab の VM と同居する 32 GB の Mac mini を前提にした目安で、実測で見直す） */
export const THRESHOLDS = Object.freeze({
  disk_free_gib: { warn: 50, crit: 20 },
  swap_used_gib: { warn: 2 },
  data_gib: { warn: 30 },
  hermes_rss_gib: { warn: 3, crit: 4 },
  job_running_minutes: { warn: 30 },
});
export const REMIND_MS = Object.freeze({ warn: 12 * 3_600_000, crit: 3 * 3_600_000 });
export const COMMAND_TIMEOUT_MS = 5000;
export const RUN_DEADLINE_MS = 60_000;
const MAX_FAILURES = 3;
/** Trading Lab の領域（見ない・引数に取らない） */
export const TRADING_LAB_PATH = /parallels|trading-?lab|mac-mini-migration-kit/i;
const WEBHOOK = /^credential:E-NEXUS\/edl\/[a-z0-9-]{1,64}$/;
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SCHEDULED_LABELS = JOBS.filter((j) => j !== 'host-health').map((j) => `com.e-nexus.${j}`);
const GiB = 1024 ** 3;

/** 許可したコマンドだけを shell なしで実行する。失敗しても reject しない（code・stdout・timedOut を返す） */
export function makeRunner({ execFileImpl = execFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return (bin, args) => {
    if (!ALLOWED_BINS.includes(bin)) return Promise.reject(new Error(`command not allowed: ${bin}`));
    return new Promise((resolve) => {
      execFileImpl(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (err, stdout) => {
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
  const exit = field('last exit code');
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
export async function collect({ run, uid, dataDirs = [], hermesUser = null }) {
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

/**
 * 通知するものと次の状態。状態が変わった時だけ・続けば間隔をあけて・回復は 1 回。unknown は前の状態を保つ（読めなかった回で悪化も回復も作らない）。
 * paused（保守窓）の間は何も知らせず、状態も進めない。
 */
export function decide(items, prev, { now, paused = false }) {
  const prevItems = prev?.items ?? {};
  const next = { ...prevItems };
  const notify = [];
  for (const it of items) {
    if (paused) continue;
    if (it.kind === 'event') {
      notify.push({ id: it.id, level: it.level, value: it.value, change: 'event' });
      continue;
    }
    if (it.level === 'unknown') continue;
    const p = prevItems[it.id] ?? { level: 'ok', since: now, last_notified_at: null };
    let change = null;
    if (it.level !== 'ok' && it.level !== p.level) change = 'new';
    else if (it.level !== 'ok' && (p.last_notified_at == null || Date.parse(now) - Date.parse(p.last_notified_at) >= REMIND_MS[it.level])) change = 'reminder';
    else if (it.level === 'ok' && p.level !== 'ok') change = 'recovered';
    next[it.id] = { level: it.level, since: it.level === p.level ? p.since : now, last_notified_at: change ? now : p.last_notified_at };
    if (change) notify.push({ id: it.id, level: it.level, value: it.value, change });
  }
  return { notify, items: next };
}

// ─── 通知（usage-digest と同じ契約。共通通知 package は作らない＝MA-30）───

const CHANGE_LABEL = { new: '発生', reminder: '継続', recovered: '回復', event: '出来事' };
export function alertText(notify) {
  return ['[E-NEXUS Mac Runtime host]', ...notify.map((n) => `${n.level.toUpperCase()} ${n.id}=${n.value ?? '-'}（${CHANGE_LABEL[n.change] ?? n.change}）`)].join('\n');
}
export function webhookBodyOf(notify, format, at) {
  const text = alertText(notify);
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text.slice(0, 1900) };
  return { component: 'e-nexus-mac-runtime-host', at, alerts: notify.map(({ id, level, value, change }) => ({ id, level, value, change })) };
}
/** URL は credential:E-NEXUS/edl/<name> からだけ。https 必須。失敗しても記録は成功 */
export async function postAlerts(notify, { spec, format = 'json', at, readCredentialImpl = readCredential, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookBodyOf(notify, format, at)), signal: controller.signal });
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

/** 1 回分。run・uid・post・now を差し替えて test する */
export async function runHostHealth({ stateDir = DEFAULT_STATE_DIR, dataDirs = [path.join(REPO, 'data')], hermesUser = null, webhook = null, webhookFormat = 'json', run, uid, now = () => new Date(), post = postAlerts }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(path.join(stateDir, 'DISABLED'))) return { code: 3, status: 'disabled' };
  const prev = readState(stateDir);
  const at = now().toISOString();
  const paused = existsSync(path.join(stateDir, 'PAUSE'));
  try {
    const o = await collect({ run, uid, dataDirs, hermesUser });
    const items = [...evaluate(o), ...evaluateEvents(o, prev)];
    const d = decide(items, prev, { now: at, paused });
    let nextItems = d.items;
    let notifyCode = d.notify.length === 0 ? 'NOTHING_TO_SEND' : webhook ? null : 'NO_WEBHOOK';
    if (d.notify.length && webhook) {
      const r = await post(d.notify, { spec: webhook, format: webhookFormat, at });
      notifyCode = r.code;
      if (!r.sent) {
        // 送れなかった項目は前の状態に戻し、次の回にもう一度判定させる
        nextItems = { ...d.items };
        for (const n of d.notify) {
          if (prev?.items?.[n.id]) nextItems[n.id] = prev.items[n.id];
          else delete nextItems[n.id];
        }
      }
    }
    const degraded = items.some((x) => (x.id === 'disk_free_gib' || x.id === 'memory_pressure') && x.level === 'crit');
    setFlag(stateDir, 'DEGRADED', degraded, at);
    const eventsUnsent = notifyCode !== 'SENT' && notifyCode !== 'NO_WEBHOOK' && d.notify.some((n) => n.change === 'event');
    writeState(stateDir, {
      schema: STATE_SCHEMA,
      updated_at: at,
      // 出来事を送れなかった時は前の値を残し、次の回にもう一度出来事として判定させる
      boottime: eventsUnsent ? (prev?.boottime ?? null) : (o.boottime ?? prev?.boottime ?? null),
      interface: eventsUnsent ? (prev?.interface ?? null) : (o.route?.interface ?? prev?.interface ?? null),
      consecutive_failures: 0,
      items: nextItems,
    });
    const levels = { ok: 0, warn: 0, crit: 0, unknown: 0 };
    for (const x of items) levels[x.level] += 1;
    appendFileSync(path.join(stateDir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ at, paused, degraded, levels, items: items.map(({ id, level, value }) => ({ id, level, value })), notify: d.notify.map(({ id, level, change }) => ({ id, level, change })), notify_code: notifyCode })}\n`, { mode: 0o600 });
    return { code: 0, status: 'ok', items, notify: d.notify, notifyCode, paused, degraded, levels };
  } catch (err) {
    const failures = (prev?.consecutive_failures ?? 0) + 1;
    try {
      writeState(stateDir, { ...(prev ?? { schema: STATE_SCHEMA, items: {} }), updated_at: at, consecutive_failures: failures });
    } catch { /* 記録できなくても下の判定は続ける */ }
    if (failures >= MAX_FAILURES) {
      setFlag(stateDir, 'DISABLED', true, `${at} ${failures} consecutive failures（原因を確かめてから Human が消す）`);
      if (webhook && !paused) await post([{ id: 'host_health', level: 'warn', value: 'disabled_by_errors', change: 'event' }], { spec: webhook, format: webhookFormat, at }).catch(() => {});
    }
    return { code: 1, status: 'failed', failures, error: String(err?.message ?? err) };
  }
}

// ─── CLI ───

export function parseArgs(argv) {
  const a = { dataDirs: [], json: false };
  const map = { '--state-dir': 'stateDir', '--hermes-user': 'hermesUser', '--webhook': 'webhook', '--webhook-format': 'webhookFormat' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--json') { a.json = true; continue; }
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
  if (a.hermesUser !== undefined && !USER_NAME.test(a.hermesUser)) errors.push('--hermes-user must be a local user name');
  if (a.webhook !== undefined && !WEBHOOK.test(a.webhook)) errors.push('--webhook must be credential:E-NEXUS/edl/<name>（URL を引数に置かない）');
  if (a.webhookFormat !== undefined && !['json', 'slack', 'discord'].includes(a.webhookFormat)) errors.push('--webhook-format must be json|slack|discord');
  return errors;
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validateArgs(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  if (process.platform !== 'darwin') { console.error('host-health is for the Mac mini (macOS) only'); return 2; }
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ component: 'edl-host-health', status: 'timeout' }));
    process.exit(2);
  }, RUN_DEADLINE_MS);
  deadline.unref();
  const r = await runHostHealth({
    stateDir: a.stateDir ?? DEFAULT_STATE_DIR,
    dataDirs: a.dataDirs.length ? a.dataDirs : [path.join(REPO, 'data')],
    hermesUser: a.hermesUser ?? null,
    webhook: a.webhook ?? null,
    webhookFormat: a.webhookFormat ?? 'json',
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
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
