/**
 * Mac Runtime の見張り（2026-11-04・MA-22・MA-24）。host-health の 1 回分の中で動く。READ-ONLY・ネットワークなし・AI／課金なし。
 *
 * 見るもの：Hermes の常駐と隔離（専用ユーザーの group・home の権限・固定の設定の変化）、Mac の repo の未 commit・未 push、
 *   devlog relay の未送信、Time Machine の状態。
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
export const GUARD_LIMITS = Object.freeze({ repo_hours: 24, outbox_hours: 24, backup_days: { warn: 3, crit: 7 } });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** repos.conf の <name>|<source>|<test> から名前だけ。relay は別の repo なので足す */
export function readRepoNames(confText) {
  const names = confText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('|')[0]);
  return [...names, RELAY_REPO];
}

export function defaultGuard(repoRoot) {
  return {
    base: path.resolve(repoRoot, '..'),
    repos: readRepoNames(readFileSync(path.join(repoRoot, 'deploy', 'macos', 'repos.conf'), 'utf8')),
    outbox: path.join(homedir(), '.enexus', 'devlog-relay', 'outbox'),
    operatorHome: homedir(),
  };
}

// ─── 出力の読み取り ───

/** git status --porcelain=v2 --branch */
export function parseGitStatus({ code, stdout, timedOut }) {
  if (timedOut || code !== 0) return null;
  const lines = stdout.split('\n').filter(Boolean);
  const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(stdout);
  return {
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

function sha256OfFile(file, fsi) {
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
  if (groups.some((g) => FORBIDDEN_GROUPS.includes(g))) codes.push('admin_group');
  for (const [code, p] of [['hermes_home_open', hermesHome], ['operator_home_open', operatorHome]]) {
    const s = stat(p);
    if (!s) return null;
    if (s.mode & 0o077) codes.push(code);
  }
  for (const [name, p] of Object.entries(HERMES_FILES)) {
    const s = stat(p);
    if (!s) return null;
    if (s.uid !== 0 || s.mode & 0o022) codes.push(`${name}_not_root_only`);
  }
  const share = stat(HERMES_SHARE);
  if (!share) return null;
  if (share.mode & 0o027) codes.push('share_open');
  return codes;
}

/** run は host-health の makeRunner（許可したコマンドだけ）。fsi は test で差し替える */
export async function collectGuard({ run, hermesUser = null, base, repos, outbox, operatorHome, fsi = { readFileSync, statSync, readdirSync, existsSync } }) {
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
    g.backup = { configured: true, latest: r.code === 0 ? parseLatestBackup(r.stdout) : null };
  }
  if (hermesUser) {
    const r = await run('/usr/bin/id', ['-Gn', hermesUser]);
    const groups = !r.timedOut && r.code === 0 ? r.stdout.trim().split(/\s+/) : null;
    g.isolation = isolationOf({ groups, hermesHome: `/Users/${hermesUser}`, operatorHome, fsi });
    g.drift = { vault_copy: treeSignature(path.join(HERMES_SHARE, 'vault'), fsi) };
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
  else if (!g.backup.latest) add('backup_time_machine', 'unknown', null);
  else {
    const days = Math.floor((t - Date.parse(g.backup.latest)) / DAY);
    const { warn, crit } = GUARD_LIMITS.backup_days;
    add('backup_time_machine', days >= crit ? 'crit' : days >= warn ? 'warn' : 'ok', `${days}d`);
  }
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
  if (!keepEvents) for (const [k, v] of Object.entries(g.drift ?? {})) if (v) drift[k] = v;
  return {
    repo_since: repoSince,
    drift,
    hermes_pid: keepEvents ? (prevGuard?.hermes_pid ?? null) : (g.service?.pid ?? prevGuard?.hermes_pid ?? null),
  };
}

// ─── 観察の集計（H8）───

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
  let gaps = 0;
  rows.forEach((r, i) => {
    if (i && Date.parse(r.at) - Date.parse(rows[i - 1].at) > intervalMinutes * 1.5 * 60_000) gaps += 1;
    for (const it of r.items ?? []) {
      if (['hermes_rss_gib', 'load_15m', 'swap_used_gib'].includes(it.id) && typeof it.value === 'number') peak[it.id] = Math.max(peak[it.id] ?? 0, it.value);
      if (['rebooted', 'network_interface_changed', 'hermes_restarted', 'hermes_files_changed'].includes(it.id)) events.push({ at: r.at, id: it.id, value: it.value ?? null });
      else if (it.level !== 'ok') {
        const n = (notOk[it.id] ??= { warn: 0, crit: 0, unknown: 0 });
        n[it.level] += 1;
      }
    }
  });
  return { records: rows.length, from: rows[0]?.at ?? null, to: rows.at(-1)?.at ?? null, gaps, peak, not_ok: notOk, events };
}
