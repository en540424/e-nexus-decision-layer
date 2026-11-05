/**
 * Mac Runtime の見張り（2026-11-04・MA-22・MA-24）。host-health の 1 回分の中で動く。READ-ONLY・ネットワークなし・AI／課金なし。
 *
 * 見るもの：Hermes の常駐と隔離（専用ユーザーの group・home の権限・固定の設定の変化）、Mac の repo の未 commit・未 push、
 *   devlog relay の未送信、Time Machine の状態、監視自身の定義と安全 policy の変化・com.e-nexus の常駐の増減・user 範囲の指示の混入（2026-11-04 追加）、
 *   バックアップの受領票（保存先が決まった後）。
 * 見ないもの：Trading Lab の領域（repo の一覧は deploy/macos/repos.conf と relay だけ）・Hermes の home の中身・ファイルの中身の持ち出し。
 *   記録に残すのは固定のコードと件数と ID だけ（ハッシュは state に保存するが通知には出さない）。
 * 何も直さない：権限を戻さない・常駐を起こさない・commit しない。異常を記録と通知で伝えるだけ。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const HERMES_LABEL = 'com.e-nexus.hermes';
export const HERMES_FILES = Object.freeze({
  config: '/etc/hermes/config.yaml',
  plist: `/Library/LaunchDaemons/${HERMES_LABEL}.plist`,
  wrapper: '/Library/Application Support/E-NEXUS/hermes/run.sh',
});
export const HERMES_SHARE = '/Users/Shared/e-nexus-hermes';
export const GUARD_BINS = Object.freeze(['/usr/bin/id', '/usr/bin/git', '/usr/bin/tmutil']);
export const RELAY_REPO = 'e-nexus-devlog-relay';
const FORBIDDEN_GROUPS = ['admin', 'wheel'];
/** 作業中の差分を異常にしないための猶予。続いた時だけ warn にする */
export const GUARD_LIMITS = Object.freeze({ repo_hours: 24, outbox_hours: 24, backup_days: { warn: 3, crit: 7 }, restore_days: { warn: 35 } });
/** 変わったら知らせる固定ファイル（repo 内の相対パス）。Human Gate を弱める変更は git の差分より先にここで出す */
export const WATCHED_POLICIES = Object.freeze({ human_only_policy: 'policies/safety/human-only.json', failure_policy: 'policies/gateway/failure-policy.json' });
export const MONITOR_LABEL = 'com.e-nexus.host-health';
const WATCHDOG_PLIST = 'com.e-nexus.host-health-watchdog.plist';
export const BACKUP_RECEIPT_SCHEMA = 'runtime-backup-receipt/v1';
const RESIDENT = /^(com\.e-nexus\.[a-z0-9.-]+)\.plist$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** repos.conf の <name>|<source>|<test> から名前だけ。relay は別の repo なので足す */
export function readRepoNames(confText) {
  const names = confText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('|')[0].trim());
  return [...names, RELAY_REPO];
}

export function defaultGuard(repoRoot) {
  return {
    base: path.resolve(repoRoot, '..'),
    repos: readRepoNames(readFileSync(path.join(repoRoot, 'deploy', 'macos', 'repos.conf'), 'utf8')),
    outbox: path.join(homedir(), '.enexus', 'devlog-relay', 'outbox'),
    operatorHome: homedir(),
    repoRoot,
    backupReceipt: path.join(homedir(), '.enexus', 'backup', 'last.json'),
  };
}

// ─── 出力の読み取り ───

/** git status --porcelain=v2 --branch */
export function parseGitStatus({ code, stdout, timedOut }) {
  if (timedOut || code !== 0) return null;
  const lines = stdout.split('\n').filter(Boolean);
  const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(stdout);
  return {
    oid: /^# branch\.oid (\S+)$/m.exec(stdout)?.[1] ?? null,
    upstream: /^# branch\.upstream /m.test(stdout),
    ahead: ab ? Number(ab[1]) : 0,
    dirty: lines.filter((l) => !l.startsWith('# ')).length,
  };
}
/** tmutil destinationinfo：保存先が無くても exit 0（文言は stderr に出る版がある） */
export function parseTimeMachineDestination({ code, stdout, timedOut }) {
  if (timedOut || code !== 0) return null;
  return { configured: /^\s*Name\s*:/m.test(stdout) };
}
/** tmutil latestbackup：…/YYYY-MM-DD-HHMMSS(.backup) */
export function parseLatestBackup(stdout) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stdout);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

// ─── 集める ───

const MISSING = 'missing';
function sha256OfFile(file, fsi) {
  if (!fsi.existsSync(file)) return MISSING; // 消されたのも変化として知らせる
  try {
    return createHash('sha256').update(fsi.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}
/** 写しの一覧の署名（相対パス・大きさ・更新時刻）。ファイルの中身は読まない */
export function treeSignature(dir, fsi = { readdirSync, statSync }) {
  const rows = [];
  const walk = (d) => {
    for (const e of fsi.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = fsi.statSync(p);
        rows.push(`${path.relative(dir, p)}|${s.size}|${Math.trunc(s.mtimeMs)}`);
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex');
}

function isolationOf({ groups, hermesHome, operatorHome, fsi }) {
  const codes = [];
  const stat = (p) => {
    try {
      return fsi.statSync(p);
    } catch {
      return null;
    }
  };
  if (groups == null) return null;
  // 1 つ読めなくても分かった違反を捨てない（ファイルを消して admin 所属を隠せないように）
  if (groups.some((g) => FORBIDDEN_GROUPS.includes(g))) codes.push('admin_group');
  for (const [code, name, p] of [['hermes_home_open', 'hermes_home', hermesHome], ['operator_home_open', 'operator_home', operatorHome]]) {
    const s = stat(p);
    if (!s) codes.push(`${name}_missing`);
    else if (s.mode & 0o077) codes.push(code);
  }
  for (const [name, p] of Object.entries(HERMES_FILES)) {
    const s = stat(p);
    if (!s) codes.push(`${name}_missing`);
    else if (s.uid !== 0 || s.mode & 0o022) codes.push(`${name}_not_root_only`);
  }
  const share = stat(HERMES_SHARE);
  if (!share) codes.push('share_missing');
  else if (share.mode & 0o027) codes.push('share_open');
  return codes;
}

/** com.e-nexus.* の常駐の一覧（名前の先頭で絞る。他の常駐の名前は読まない・記録しない） */
function residentsOf(operatorHome, fsi) {
  const names = [];
  for (const dir of [path.join(operatorHome, 'Library', 'LaunchAgents'), '/Library/LaunchDaemons']) {
    try {
      for (const f of fsi.readdirSync(dir)) {
        const m = RESIDENT.exec(String(f));
        if (m) names.push(m[1]);
      }
    } catch {
      return null;
    }
  }
  return [...new Set(names)].sort();
}
/** Claude Code の user 範囲は同じ OS ユーザーの Trading Lab にも届く。E-NEXUS の指示はそこへ置かない（有無だけ見る。中身は読まない） */
function scopeOf(operatorHome, fsi) {
  return [['user_claude_md', ['.claude', 'CLAUDE.md']], ['user_rules', ['.claude', 'rules']]].filter(([, p]) => fsi.existsSync(path.join(operatorHome, ...p))).map(([code]) => code);
}
/** バックアップの受領票（保存先の決定の後に backup の道具が書く）。無ければ not_configured */
function backupReceiptOf(file, fsi) {
  if (!file || !fsi.existsSync(file)) return { configured: false };
  try {
    const r = JSON.parse(fsi.readFileSync(file, 'utf8'));
    if (r?.schema !== BACKUP_RECEIPT_SCHEMA || Number.isNaN(Date.parse(r.finished_at))) return null;
    return { configured: true, finished_at: r.finished_at, restore_verified_at: r.restore_verified_at ?? null };
  } catch {
    return null;
  }
}

/** run は host-health の makeRunner（許可したコマンドだけ）。fsi は test で差し替える */
export async function collectGuard({ run, hermesUser = null, base, repos, outbox, operatorHome, repoRoot = null, backupReceipt = null, fsi = { readFileSync, statSync, readdirSync, existsSync } }) {
  const g = { repos: {} };
  for (const name of repos) {
    const dir = path.join(base, name);
    if (!fsi.existsSync(path.join(dir, '.git'))) continue; // 置いていない repo は見ない
    g.repos[name] = parseGitStatus(await run('/usr/bin/git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v2', '--branch']));
  }
  try {
    const files = fsi.readdirSync(outbox).filter((f) => f.endsWith('.md'));
    const times = files.map((f) => fsi.statSync(path.join(outbox, f)).mtimeMs);
    g.outbox = { count: files.length, oldest_ms: times.length ? Math.min(...times) : null };
  } catch {
    g.outbox = null;
  }
  const dest = parseTimeMachineDestination(await run('/usr/bin/tmutil', ['destinationinfo']));
  g.backup = dest;
  if (dest?.configured) {
    const r = await run('/usr/bin/tmutil', ['latestbackup']);
    g.backup = { configured: true, latest: r.code === 0 ? parseLatestBackup(r.stdout) : null, timed_out: Boolean(r.timedOut) };
  }
  g.backup_receipt = backupReceiptOf(backupReceipt, fsi);
  g.residents = residentsOf(operatorHome, fsi);
  g.scope = scopeOf(operatorHome, fsi);
  const agents = path.join(operatorHome, 'Library', 'LaunchAgents');
  g.config = { monitor_plist: sha256OfFile(path.join(agents, `${MONITOR_LABEL}.plist`), fsi), watchdog_plist: sha256OfFile(path.join(agents, WATCHDOG_PLIST), fsi) };
  if (repoRoot) for (const [name, p] of Object.entries(WATCHED_POLICIES)) g.config[name] = sha256OfFile(path.join(repoRoot, p), fsi);
  if (hermesUser) {
    const r = await run('/usr/bin/id', ['-Gn', hermesUser]);
    const groups = !r.timedOut && r.code === 0 ? r.stdout.trim().split(/\s+/) : null;
    g.isolation = isolationOf({ groups, hermesHome: `/Users/${hermesUser}`, operatorHome, fsi });
    const vault = path.join(HERMES_SHARE, 'vault');
    g.drift = { vault_copy: fsi.existsSync(vault) ? treeSignature(vault, fsi) : MISSING };
    for (const [name, p] of Object.entries(HERMES_FILES)) g.drift[name] = sha256OfFile(p, fsi);
  }
  return g;
}

// ─── 判定する ───

/** 状態の項目。repo は差分が続いた時間で warn にする（prevGuard.repo_since） */
export function evaluateGuard(g, prevGuard, now) {
  const items = [];
  const add = (id, level, value) => items.push({ id, level, value, kind: 'state' });
  const t = Date.parse(now);
  const since = prevGuard?.repo_since ?? {};
  for (const [name, r] of Object.entries(g.repos)) {
    const id = `repo:${name}`;
    if (r == null) { add(id, 'unknown', null); continue; }
    const parts = [r.dirty ? `dirty ${r.dirty}` : null, r.ahead ? `ahead ${r.ahead}` : null, r.upstream ? null : 'no_upstream'].filter(Boolean);
    if (parts.length === 0) { add(id, 'ok', 'clean'); continue; }
    const old = since[name] && t - Date.parse(since[name]) >= GUARD_LIMITS.repo_hours * HOUR;
    add(id, old ? 'warn' : 'ok', parts.join(' '));
  }
  if (g.outbox == null) add('relay_outbox', 'unknown', null);
  else {
    const old = g.outbox.oldest_ms != null && t - g.outbox.oldest_ms >= GUARD_LIMITS.outbox_hours * HOUR;
    add('relay_outbox', old ? 'warn' : 'ok', g.outbox.count);
  }
  if (g.backup == null) add('backup_time_machine', 'unknown', null);
  else if (!g.backup.configured) add('backup_time_machine', 'ok', 'not_configured'); // 保存先の決定は Human。未設定は異常にしない
  else if (!g.backup.latest && g.backup.timed_out) add('backup_time_machine', 'unknown', null); // 1 回の遅れで知らせない
  else if (!g.backup.latest) add('backup_time_machine', 'warn', 'latest_unreadable'); // 保存先を外したままなら、ずっと unknown で黙らないように
  else {
    const days = Math.floor((t - Date.parse(g.backup.latest)) / DAY);
    const { warn, crit } = GUARD_LIMITS.backup_days;
    add('backup_time_machine', days >= crit ? 'crit' : days >= warn ? 'warn' : 'ok', `${days}d`);
  }
  if (g.backup_receipt !== undefined) {
    const b = g.backup_receipt;
    if (b == null) add('backup_archive', 'unknown', null);
    else if (!b.configured) add('backup_archive', 'ok', 'not_configured'); // 保存先の決定は Human
    else {
      const ageDays = (x) => {
        const ms = t - Date.parse(x);
        return ms >= 0 ? Math.floor(ms / DAY) : null; // 読めない日付・未来の日付は確かめていないのと同じ（NaN も落ちる）
      };
      const days = ageDays(b.finished_at);
      const { warn, crit } = GUARD_LIMITS.backup_days;
      const restoreDays = ageDays(b.restore_verified_at);
      const staleRestore = restoreDays == null || restoreDays >= GUARD_LIMITS.restore_days.warn;
      if (days == null) add('backup_archive', 'unknown', null);
      else add('backup_archive', days >= crit ? 'crit' : days >= warn || staleRestore ? 'warn' : 'ok', `${days}d restore ${restoreDays == null ? 'never' : `${restoreDays}d`}`);
    }
  }
  if (g.scope !== undefined) add('agent_scope', g.scope.length ? 'warn' : 'ok', g.scope.length ? g.scope.join(',') : 'ok');
  if (g.service !== undefined) {
    const s = g.service;
    if (s == null) add('hermes_service', 'unknown', null);
    else if (!s.loaded) add('hermes_service', 'warn', 'not_loaded');
    else if (s.state === 'running' && s.pid) add('hermes_service', 'ok', 'running');
    else add('hermes_service', 'warn', `stopped exit ${s.last_exit_code ?? '-'}`);
  }
  if (g.isolation !== undefined) {
    if (g.isolation == null) add('hermes_isolation', 'unknown', null);
    else add('hermes_isolation', g.isolation.length ? 'crit' : 'ok', g.isolation.length ? g.isolation.join(',') : 'ok');
  }
  return items;
}

/** 出来事（前回からの変化）。最初の回は基準を取るだけで知らせない */
export function evaluateGuardEvents(g, prevGuard) {
  const ev = [];
  const prevPid = prevGuard?.hermes_pid;
  if (prevPid && g.service?.pid && g.service.pid !== prevPid) ev.push({ id: 'hermes_restarted', level: 'warn', value: null, kind: 'event' });
  const changed = Object.entries(g.drift ?? {}).filter(([k, v]) => v && prevGuard?.drift?.[k] && prevGuard.drift[k] !== v).map(([k]) => k);
  if (changed.length) ev.push({ id: 'hermes_files_changed', level: 'warn', value: changed.sort().join(','), kind: 'event' });
  const config = Object.entries(g.config ?? {}).filter(([k, v]) => v && prevGuard?.config?.[k] && prevGuard.config[k] !== v).map(([k]) => k);
  if (config.length) ev.push({ id: 'monitor_config_changed', level: 'warn', value: config.sort().join(','), kind: 'event' });
  if (g.residents && prevGuard?.residents) {
    const short = (x) => x.replace(/^com\.e-nexus\./, '');
    const diff = [...g.residents.filter((x) => !prevGuard.residents.includes(x)).map((x) => `+${short(x)}`), ...prevGuard.residents.filter((x) => !g.residents.includes(x)).map((x) => `-${short(x)}`)];
    if (diff.length) ev.push({ id: 'residents_changed', level: 'warn', value: diff.join(','), kind: 'event' });
  }
  return ev;
}

/** 次の state。keepEvents＝出来事を送れなかった回は前の値を残し、次の回にもう一度判定させる */
export function nextGuardState(g, prevGuard, now, { keepEvents = false } = {}) {
  const repoSince = {};
  for (const [name, r] of Object.entries(g.repos)) {
    if (r == null) { if (prevGuard?.repo_since?.[name]) repoSince[name] = prevGuard.repo_since[name]; continue; }
    if (r.dirty || r.ahead || !r.upstream) repoSince[name] = prevGuard?.repo_since?.[name] ?? now;
  }
  const drift = { ...(prevGuard?.drift ?? {}) };
  const config = { ...(prevGuard?.config ?? {}) };
  if (!keepEvents) {
    for (const [k, v] of Object.entries(g.drift ?? {})) if (v) drift[k] = v;
    for (const [k, v] of Object.entries(g.config ?? {})) if (v) config[k] = v;
  }
  return {
    repo_since: repoSince,
    drift,
    config,
    residents: keepEvents ? (prevGuard?.residents ?? null) : (g.residents ?? prevGuard?.residents ?? null),
    hermes_pid: keepEvents ? (prevGuard?.hermes_pid ?? null) : (g.service?.pid ?? prevGuard?.hermes_pid ?? null),
  };
}

// ─── 観察の集計（H8）───

export const EVENT_IDS = ['rebooted', 'network_interface_changed', 'hermes_restarted', 'hermes_files_changed', 'monitor_config_changed', 'residents_changed', 'monitor_gap', 'github_visibility_changed', 'github_default_branch_changed'];

/** host-health の YYYY-MM.jsonl の行から、期間の要約。値は記録にあるものだけ */
export function summarizeRecords(lines, { since = null, intervalMinutes = 30 } = {}) {
  const rows = [];
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      if (r?.at && (!since || r.at >= since)) rows.push(r);
    } catch { /* 壊れた行は数えない */ }
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const peak = {};
  const notOk = {};
  const events = [];
  const notifyCodes = {};
  let gaps = 0;
  rows.forEach((r, i) => {
    if (i && Date.parse(r.at) - Date.parse(rows[i - 1].at) > intervalMinutes * 1.5 * 60_000) gaps += 1;
    if (r.notify_code && r.notify_code !== 'NOTHING_TO_SEND') notifyCodes[r.notify_code] = (notifyCodes[r.notify_code] ?? 0) + 1;
    for (const it of r.items ?? []) {
      if (['hermes_rss_gib', 'load_15m', 'swap_used_gib'].includes(it.id) && typeof it.value === 'number') peak[it.id] = Math.max(peak[it.id] ?? 0, it.value);
      if (EVENT_IDS.includes(it.id)) events.push({ at: r.at, id: it.id, value: it.value ?? null });
      else if (it.level !== 'ok') {
        const n = (notOk[it.id] ??= { warn: 0, crit: 0, unknown: 0 });
        n[it.level] += 1;
      }
    }
  });
  return { records: rows.length, from: rows[0]?.at ?? null, to: rows.at(-1)?.at ?? null, gaps, peak, not_ok: notOk, events, notify_codes: notifyCodes };
}
