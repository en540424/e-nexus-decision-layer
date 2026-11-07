#!/usr/bin/env node
/**
 * Mac Runtime の運用の道具（2026-11-05・Batch C）。監視の記録を読むだけ。通信なし・Keychain なし・AI／課金なし・何も書かない。常駐しない（Human か Claude Code が手で実行する）。
 *
 *   node scripts/runtime-ops.mjs acceptance [--days 7] [--json]     H2〜H6 の検収を記録から判定する（定期の回の結果を後から確かめる）
 *   node scripts/runtime-ops.mjs why <項目の id> [--days 14]        項目の経過・誰が動くか・確かめ方（原因調査の入口）
 *   node scripts/runtime-ops.mjs human [--ledger <abs>] [--json]    Human が要ることを優先度の順に集める（台帳＋今の異常＋token の期限）
 *   node scripts/runtime-ops.mjs brief [--external] [--file <abs>]  Hermes が読む要約を、読む側の手順で読んで答えの形にする（Hermes の API は使わない）
 *   node scripts/runtime-ops.mjs timeline [--days 7] [--json]       全項目の変わり目・出来事・通知を時刻の順に（同じ出来事の連続は 1 行にまとめる）
 *   node scripts/runtime-ops.mjs overview [--days 7]                検収・今の状態・Human が要ること・Hermes の読み取りの検証を 1 画面に
 *        共通：[--state-dir <abs>]
 *
 * 台帳（--ledger）は公開 repo に置かない（既定 <repo の親>/mac-runtime-state/human-required.json）。
 * 判定：pass＝記録で確かめた／pending＝定期の回がまだ足りない／fail＝記録に異常がある。exit は 0（fail があれば 1）・2＝引数。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_DIR, TRADING_LAB_PATH, WATCHDOG_LABEL, WATCHDOG_STALE_MS, makeRunner, parseLaunchctlPrint, safeValue } from './host-health.mjs';
import { READ_CHECK_DIR, readCheckState } from './lib/hermes-read-check.mjs';
import { classify } from './lib/ops-classify.mjs';
import { BRIEF_FILE, externalView, readBriefFile, renderReply } from './lib/runtime-brief.mjs';
import { EVENT_IDS, GUARD_LIMITS, MONITOR_LABEL } from './lib/runtime-guard.mjs';
import { STATUS_DIR } from './lib/runtime-status-summary.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_LABEL = 'com.e-nexus.runtime-backup';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const TOKEN_NOTICE_DAYS = 30;
const OBSERVE_DAYS = 7;
const OBSERVE_RSS_LIMIT_GIB = 3;
/** 観察の窓。--days と別に読む（窓が 7 日ちょうどだと記録の幅は 7 日に届かず、いつまでも pending になる） */
export const OBSERVE_WINDOW_DAYS = OBSERVE_DAYS + 1;
/** 記録の間隔がこれを超えたら空白（host-health の report と同じ。30 分の 1.5 倍） */
const GAP_MS = 45 * 60_000;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
/** 記録の行。壊れた行は飛ばす */
export function readRecords(stateDir, { since = null } = {}) {
  const files = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort() : [];
  const rows = [];
  for (const f of files) {
    for (const line of readFileSync(path.join(stateDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r?.at && (!since || r.at >= since)) rows.push(r);
      } catch { /* 壊れた行は数えない */ }
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

const itemOf = (r, id) => r?.items?.find((x) => x.id === id);
const hoursAgo = (at, now) => (now - Date.parse(at)) / HOUR;
const check = (id, title, verdict, facts) => ({ id, title, verdict, facts });

/** 記録だけから判定する（Keychain も通信も使わない）。jobs は launchctl の読み取りの結果 */
export function acceptanceOf({ state, watchdog, receipt, records, observation = records, jobs, briefAge = null, now }) {
  const last = records.at(-1);
  const out = [];
  const sent = {};
  for (const r of records) if (r.notify_code === 'SENT') for (const n of r.notify ?? []) sent[`${n.id}/${n.change}`] = (sent[`${n.id}/${n.change}`] ?? 0) + 1;
  // H2：相互の見張りと、正常時に送っていないこと（送ったのは出来事か異常だけ）
  const wdAge = hoursAgo(watchdog?.updated_at, now);
  const wdItem = itemOf(last, 'monitor_watchdog');
  // 正常の項目を送っていないこと（送ってよいのは異常・出来事・回復だけ）
  const noisy = records.filter((r) => r.notify_code === 'SENT').flatMap((r) => r.notify ?? []).filter((n) => n.level === 'ok' && !['recovered', 'recovered_missed'].includes(n.change)).length;
  const wdOk = jobs[WATCHDOG_LABEL]?.loaded === true && wdAge <= WATCHDOG_STALE_MS / HOUR && wdItem?.level === 'ok';
  out.push(check('H2', 'watchdog と host-health の相互の見張り', !last ? 'pending' : wdOk && noisy === 0 ? 'pass' : 'fail', { records: records.length, watchdog_age_hours: Number.isFinite(wdAge) ? Math.round(wdAge * 10) / 10 : null, monitor_watchdog: wdItem?.level ?? null, monitor_alive: watchdog?.items?.monitor_alive?.level ?? null, discord_sent: sent }));
  // H3：launchd の回で GitHub を読めていること
  const gh = records.filter((r) => itemOf(r, 'github_api'));
  const ghLast = itemOf(last, 'github_api');
  const repos = (last?.items ?? []).filter((x) => x.id.startsWith('github:'));
  const tokenDays = state?.github_token_expires_at ? Math.floor((Date.parse(state.github_token_expires_at) - now) / DAY) : null;
  out.push(check('H3', 'GitHub の無人の見張り', !ghLast ? 'pending' : ghLast.value !== 'ok' && ghLast.value !== 'token_expiring' ? 'fail' : gh.length >= 2 ? 'pass' : 'pending', { runs: gh.length, repos: repos.length, not_ok: repos.filter((x) => x.level !== 'ok').length, api: ghLast?.value ?? null, token_days_left: tokenDays }));
  // H4：要約が書かれていること
  const summary = state?.status_summary ?? null;
  out.push(check('H4', 'Hermes へ渡す要約', summary === 'written' && briefAge != null && briefAge <= 1.5 ? 'pass' : summary === 'written' ? 'pending' : summary == null ? 'pending' : 'fail', { code: summary, brief_age_hours: briefAge }));
  // H5：受領票と定期の回
  const backup = jobs[BACKUP_LABEL];
  const finished = receipt?.finished_at ? hoursAgo(receipt.finished_at, now) : null;
  const backupBad = !receipt || (receipt.consecutive_failures ?? 0) > 0 || receipt.history_failure;
  const scheduled = (backup?.runs ?? 0) >= 1 && (backup?.last_exit_code ?? 0) === 0;
  out.push(check('H5', '暗号化バックアップ', !receipt ? 'pending' : backupBad ? 'fail' : scheduled && finished != null && finished <= 30 ? 'pass' : 'pending', { job_runs: backup?.runs ?? null, job_exit: backup?.last_exit_code ?? null, finished_hours_ago: finished == null ? null : Math.round(finished * 10) / 10, failures: receipt?.consecutive_failures ?? null, failure_code: receipt?.last_failure_code ?? null, history_verified: Boolean(receipt?.history_verified_at), history_failure: receipt?.history_failure ?? null }));
  // H6：送れた回の数（受け側の 204 が確かめになる）
  const code = state?.heartbeat?.code ?? null;
  const beats = records.filter((r) => itemOf(r, 'heartbeat')?.value === 'sent').length;
  out.push(check('H6', '外部の死活監視への生存信号', ['failed', 'rejected', 'config_invalid'].includes(code) ? (state?.heartbeat?.fail_since && hoursAgo(state.heartbeat.fail_since, now) >= 1 ? 'fail' : 'pending') : code === 'sent' && beats >= 2 ? 'pass' : 'pending', { code, beats, note: code === 'off' ? 'Keychain を読めていないか、まだ定期の回が来ていない' : null }));
  // Hermes の観察。幅は Hermes の常駐を ok と見た最初の回から測る（記録だけ古くても合格にしない）。
  // 合格の目安：常駐の異常なし・再起動なし（Human の操作の分は Human が見る）・固定ファイルの変化なし・RSS のピークが上限の未満・メモリと swap の警告なし・記録の空白なし（Mac の再起動の分は除く）
  const startAt = observation.findIndex((r) => itemOf(r, 'hermes_service')?.level === 'ok');
  const watched = startAt < 0 ? [] : observation.slice(startAt);
  const span = watched.length ? (Date.parse(watched.at(-1).at) - Date.parse(watched[0].at)) / DAY : 0;
  const bad = (id) => watched.filter((r) => ['warn', 'crit'].includes(itemOf(r, id)?.level)).length;
  const seen = (id) => watched.filter((r) => itemOf(r, id)).length;
  const peak = Math.max(0, ...watched.map((r) => (typeof itemOf(r, 'hermes_rss_gib')?.value === 'number' ? itemOf(r, 'hermes_rss_gib').value : 0)));
  const gaps = watched.filter((r, i) => i && Date.parse(r.at) - Date.parse(watched[i - 1].at) > GAP_MS && !itemOf(r, 'rebooted')).length;
  const unseen = watched.filter((r) => !['ok', 'warn', 'crit'].includes(itemOf(r, 'hermes_service')?.level)).length; // 見えなかった回は「異常なし」に数えない
  const facts = { days_observed: Math.round(span * 10) / 10, hermes_service_not_ok: bad('hermes_service'), hermes_service_unseen: unseen, hermes_restarted: seen('hermes_restarted'), hermes_files_changed: seen('hermes_files_changed'), rss_peak_gib: peak, memory_not_ok: bad('memory_pressure') + bad('swap_used_gib'), gaps };
  const observeBad = facts.hermes_service_not_ok || facts.hermes_restarted || facts.hermes_files_changed || peak >= OBSERVE_RSS_LIMIT_GIB || facts.memory_not_ok || gaps;
  out.push(check('H8', 'Hermes の稼働の観察', observeBad ? 'fail' : span >= OBSERVE_DAYS && !unseen ? 'pass' : 'pending', facts));
  return out;
}

/** 項目の経過。水準か値が変わった時だけ行にする。値は通知と同じ関所を通す */
export function whyOf(id, records) {
  const rows = [];
  let prev = null;
  for (const r of records) {
    const it = itemOf(r, id);
    if (!it) continue;
    const key = `${it.level}|${it.value}`;
    const notified = (r.notify ?? []).find((n) => n.id === id);
    if (key !== prev || notified) rows.push({ at: r.at, level: it.level, value: safeValue(id, it.value), ...(notified ? { notified: notified.change, code: r.notify_code } : {}) });
    prev = key;
  }
  const rule = classify(id);
  return { id, class: rule.class, cause: rule.cause, next: rule.next, checks: rule.checks, seen: records.filter((r) => itemOf(r, id)).length, timeline: rows.slice(-40) };
}

/** 全項目の変わり目と出来事と通知を時刻の順に。最初に見えた ok は行にしない（最初から異常なら from は null＝窓の前から続いている）。同じ出来事の連続は 1 行にして回数を付ける。値は通知と同じ関所を通す */
export function timelineOf(records) {
  const prev = new Map();
  const rows = [];
  for (const r of records) {
    for (const it of Array.isArray(r.items) ? r.items : []) {
      if (!it?.id) continue;
      const notified = (Array.isArray(r.notify) ? r.notify : []).find((n) => n?.id === it.id);
      const sent = notified && r.notify_code === 'SENT' ? notified.change : null;
      const value = safeValue(it.id, it.value);
      if (EVENT_IDS.includes(it.id)) {
        const last = rows.at(-1);
        if (last?.kind === 'event' && last.id === it.id && last.value === value && !sent) {
          last.count += 1;
          last.until = r.at;
        } else rows.push({ at: r.at, kind: 'event', id: it.id, level: it.level, value, count: 1, ...(sent ? { sent } : {}) });
        continue;
      }
      const known = prev.has(it.id);
      const before = known ? prev.get(it.id) : null;
      prev.set(it.id, it.level);
      if ((known ? before !== it.level : it.level !== 'ok') || sent) rows.push({ at: r.at, kind: 'level', id: it.id, from: before, level: it.level, value, ...(sent ? { sent } : {}) });
    }
  }
  return rows;
}
const atLocal = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export function renderTimeline(rows) {
  if (!rows.length) return '変わり目はありません';
  return rows.map((x) => {
    const what = x.kind === 'event' ? `${x.id}${x.count > 1 ? ` ×${x.count}（〜${atLocal(x.until)}）` : ''}` : `${x.id} ${x.from ?? '（窓の前から）'}→${x.level}`;
    return `${atLocal(x.at)} ${what}${x.value == null ? '' : ` ${x.value}`}${x.sent ? ` ［通知：${x.sent}］` : ''}`;
  }).join('\n');
}

/** 1 画面の形。各部は既存の道具の結果をそのまま並べる（判定を足さない） */
export function renderOverview({ rows, reply, human, readCheck }) {
  const lines = ['【検収】', ...rows.map((r) => `${r.verdict.toUpperCase().padEnd(7)} ${r.id} ${r.title}`), '', '【今の状態】', reply, '', '【Human が要ること】'];
  lines.push(...(human.length ? human.map((r) => `[${PRIORITY[r.priority] ?? r.priority}]${r.overdue ? '【期限切れ】' : ''}${r.due ? ` 〜${r.due}` : ''} ${r.title}`) : ['ありません']));
  lines.push('', '【Hermes の読み取りの検証】', readCheck.state === 'not_run' ? '未実施' : `${readCheck.state}${readCheck.failed?.length ? `（${readCheck.failed.join('・')}）` : ''}${readCheck.api_calls == null ? '' : `・API ${readCheck.api_calls} 回`}${readCheck.total_tokens == null ? '' : `・${readCheck.total_tokens} token`}`);
  return lines.join('\n');
}

const PRIORITY = { 1: '高', 2: '中', 3: '低' };
/** Human が要ることの一覧。台帳（手で足した判断待ち）＋今の異常のうち human のもの＋期限の近い token。優先度と期限の順 */
export function humanRequired({ ledger = [], last = null, state = null, receipt = null, monitor = {}, now }) {
  const rows = (Array.isArray(ledger) ? ledger : []).filter((x) => !x.done).map((x) => ({ id: String(x.id), priority: x.priority ?? 2, title: String(x.title), due: x.due ?? null, source: 'ledger' }));
  // 監視が動いていなければ「対応なし」と言えない
  if (monitor.disabled) rows.push({ id: 'monitor:disabled', priority: 1, title: '監視が止まっている（DISABLED）→ docs/runtime-monitoring.md §3 の手順で原因を確かめて再開する', due: null, source: 'monitor' });
  else if (monitor.stale) rows.push({ id: 'monitor:stale', priority: 1, title: '監視の記録が 24 時間以上ない → node scripts/runtime-ops.mjs acceptance', due: null, source: 'monitor' });
  for (const it of last?.items ?? []) {
    if (it.level !== 'warn' && it.level !== 'crit') continue;
    const rule = classify(it.id);
    if (rule.class === 'human') rows.push({ id: `item:${it.id}`, priority: it.level === 'crit' ? 1 : 2, title: `${rule.cause} → ${rule.next}`, due: null, source: 'monitor' });
  }
  for (const [name, at] of [['GitHub の見張りの token', state?.github_token_expires_at], ['バックアップの token', receipt?.token_expires_at]]) {
    if (!at) continue;
    const days = Math.floor((Date.parse(at) - now) / DAY);
    if (days < TOKEN_NOTICE_DAYS) rows.push({ id: `token:${name}`, priority: days < GUARD_LIMITS.token_expiry_days ? 1 : 2, title: `${name}の期限まで ${days} 日 → 更新の手順は docs/runtime-monitoring.md §10`, due: at.slice(0, 10), source: 'expiry' });
  }
  return rows.map((r) => ({ ...r, overdue: Boolean(r.due) && Date.parse(r.due) + DAY < now })).sort((a, b) => a.priority - b.priority || String(a.due ?? '9').localeCompare(String(b.due ?? '9')));
}

export function parse(argv) {
  const a = { command: argv[0], json: false, external: false, positional: [] };
  const map = { '--days': 'days', '--state-dir': 'stateDir', '--ledger': 'ledger', '--file': 'file' };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--external') a.external = true;
    else if (map[k]) {
      if (argv[i + 1] === undefined) throw new Error(`${k} needs a value`);
      a[map[k]] = argv[i + 1];
      i += 1;
    } else if (k.startsWith('--')) throw new Error(`unknown argument: ${k}`);
    else a.positional.push(k);
  }
  return a;
}
export function validate(a) {
  const errors = [];
  if (!['acceptance', 'why', 'human', 'brief', 'timeline', 'overview'].includes(a.command)) errors.push('command must be acceptance|why|human|brief|timeline|overview');
  if (a.command === 'why' && !/^[a-z0-9_]{1,40}(?::[A-Za-z0-9._-]{1,100})?$/.test(a.positional[0] ?? '')) errors.push('why needs an item id');
  if (a.days !== undefined && !/^[1-9]\d{0,2}$/.test(a.days)) errors.push('--days must be 1-999');
  for (const [k, v] of [['--state-dir', a.stateDir], ['--ledger', a.ledger], ['--file', a.file]]) {
    if (v === undefined) continue;
    if (!path.isAbsolute(v)) errors.push(`${k} must be an absolute path`);
    else if (TRADING_LAB_PATH.test(v)) errors.push(`${k}: Trading Lab の領域は見ない`);
  }
  return errors;
}

async function readJobs(run, uid) {
  const jobs = {};
  for (const label of [MONITOR_LABEL, WATCHDOG_LABEL, BACKUP_LABEL]) jobs[label] = parseLaunchctlPrint(await run('/bin/launchctl', ['print', `gui/${uid}/${label}`])) ?? {};
  return jobs;
}

async function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validate(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  const stateDir = a.stateDir ?? DEFAULT_STATE_DIR;
  const now = Date.now();
  const since = (days) => new Date(now - days * DAY).toISOString();
  const receipt = readJson(path.join(homedir(), '.enexus', 'backup', 'last.json'));
  const state = readJson(path.join(stateDir, 'state.json'));
  const accept = async () => {
    const records = readRecords(stateDir, { since: since(Number(a.days ?? 7)) });
    const observation = readRecords(stateDir, { since: since(OBSERVE_WINDOW_DAYS) });
    const jobs = await readJobs(makeRunner({ allowed: ['/bin/launchctl'] }), process.getuid());
    let briefAge = null;
    try {
      briefAge = Math.round(((now - statSync(path.join(STATUS_DIR, BRIEF_FILE)).mtimeMs) / HOUR) * 10) / 10;
    } catch { /* まだ書いていない */ }
    return acceptanceOf({ state, watchdog: readJson(path.join(stateDir, 'watchdog.json')), receipt, records, observation, jobs, briefAge, now });
  };
  const humanRows = () => {
    const last = readRecords(stateDir, { since: since(1) }).at(-1);
    return humanRequired({ ledger: readJson(a.ledger ?? path.join(REPO, '..', 'mac-runtime-state', 'human-required.json')), last, state, receipt, monitor: { disabled: existsSync(path.join(stateDir, 'DISABLED')), stale: !last }, now });
  };
  if (a.command === 'acceptance') {
    const rows = await accept();
    if (a.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.verdict.toUpperCase().padEnd(7)} ${r.id} ${r.title}  ${JSON.stringify(r.facts)}`);
    return rows.some((r) => r.verdict === 'fail') ? 1 : 0;
  }
  if (a.command === 'timeline') {
    const rows = timelineOf(readRecords(stateDir, { since: since(Number(a.days ?? 7)) }));
    console.log(a.json ? JSON.stringify(rows, null, 2) : renderTimeline(rows));
    return 0;
  }
  if (a.command === 'overview') {
    const rows = await accept();
    const b = readBriefFile(a.file ?? path.join(STATUS_DIR, BRIEF_FILE));
    console.log(renderOverview({ rows, reply: b.ok ? renderReply(b.brief) : `要約を信じられない（${b.reason}）`, human: humanRows(), readCheck: readCheckState(path.join(REPO, '..', READ_CHECK_DIR, 'result.json')) }));
    return rows.some((r) => r.verdict === 'fail') ? 1 : 0;
  }
  if (a.command === 'why') {
    const r = whyOf(a.positional[0], readRecords(stateDir, { since: since(Number(a.days ?? 14)) }));
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (a.command === 'human') {
    const rows = humanRows();
    if (a.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`[${PRIORITY[r.priority] ?? r.priority}]${r.overdue ? '【期限切れ】' : ''}${r.due ? ` 〜${r.due}` : ''} ${r.title}`);
    if (!rows.length) console.log('Human の対応が要るものはありません');
    return 0;
  }
  const r = readBriefFile(a.file ?? path.join(STATUS_DIR, BRIEF_FILE));
  if (!r.ok) { console.log(`要約を信じられない（${r.reason}）`); return 1; }
  console.log(a.external ? JSON.stringify(externalView(r.brief), null, 2) : renderReply(r.brief));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
