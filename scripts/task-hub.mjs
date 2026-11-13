#!/usr/bin/env node
/**
 * Task Hub の CLI（2026-11-09・MA-24）。依頼の取り込み・分類・承認待ちの一覧・安全な queue の実行。常駐しない（Human か定期の job が手で/定期に呼ぶ）。
 *
 *   node scripts/task-hub.mjs intake --inbox <dir>               inbox の封（*.json）を取り込む（channel の鍵は Keychain から読む。値は表示しない）
 *   node scripts/task-hub.mjs submit --file <json>               Human の依頼を取り込む（source = human-cli）
 *   node scripts/task-hub.mjs list [--state s] [--business b]    一覧
 *   node scripts/task-hub.mjs show <task_id>                     1 件と確認コード。承認待ちの task は params の全文（キー順を固定・見えない文字は \uXXXX で表示）。それ以外の state は値を 200 字まで
 *   node scripts/task-hub.mjs approve <task_id> --confirm <12hex>   承認（端末が要る。記録の直前に承認する params の全文を表示する）
 *   node scripts/task-hub.mjs reject <task_id> --confirm <12hex>    却下（端末が要る）
 *   node scripts/task-hub.mjs dismiss <task_id> --confirm <12hex>   止まった task（stopped）を確認して閉じる＝failed（dismissed_by_human）。端末が要る
 *   node scripts/task-hub.mjs run [--max N]                      queue を 1 回回す
 *   node scripts/task-hub.mjs verify-audit                       監査 log の鎖を検証
 *   node scripts/task-hub.mjs human                              承認待ちを 1 件 1 行（承認の前に show で全文を確認する）
 *   node scripts/task-hub.mjs collect-hermes                     Hermes の結果（config の hermes_outbox）を business の記録へ取り込む（休眠：フォルダが無ければ何もしない）
 *   node scripts/task-hub.mjs prune                              古い nonce・配達済みの outbox・保持を過ぎた記録・途中で止まった tmp を消す
 *        共通：[--store <dir>]（既定 ~/e-nexus-runtime/mac-runtime-state/task-hub）[--config <file>]（既定 <store>/config.json）
 *
 * 終了コード：0＝ok／1＝問題あり（拒否・失敗・鎖の不整合・PAUSE）／2＝使い方の誤り。
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, confirmCodeOf, dismiss, reject } from './lib/task-hub/approval.mjs';
import { keepEvent, keepMail } from './lib/task-hub/digest.mjs';
import { HANDLERS } from './lib/task-hub/handlers.mjs';
import { businessServices } from './lib/task-hub/business-services.mjs';
import { pgrepAlive, recoverInterrupted } from './lib/task-hub/hermes-jobs.mjs';
import { collectHermesResults } from './lib/task-hub/hermes-results.mjs';
import { ingestInbox, submitLocal } from './lib/task-hub/intake.mjs';
import { createPolicy, loadCatalog, loadLocalConfig } from './lib/task-hub/policy.mjs';
import { readSmallFile } from './lib/task-hub/safe-read.mjs';
import { runOnce } from './lib/task-hub/runner.mjs';
import { RUN_LOCK_MAX_AGE_MS, TASK_ID_RE, openStore } from './lib/task-hub/store.mjs';
import { ID_RE, STATES } from './lib/task-hub/wire.mjs';

export const DEFAULT_STORE = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub');
const KEYCHAIN_SERVICE_PREFIX = 'E-NEXUS/edl/task-intake-';
const KEYCHAIN_ACCOUNT = 'e-nexus'; // task-intake-sync.mjs・deploy/macos/keychain-edl.sh と同じ account
const COMMANDS = ['intake', 'submit', 'list', 'show', 'approve', 'reject', 'dismiss', 'run', 'verify-audit', 'human', 'prune', 'collect-hermes'];

const expand = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

export function parse(argv) {
  const a = { command: argv[0], positional: [] };
  const map = { '--store': 'store', '--config': 'config', '--inbox': 'inbox', '--file': 'file', '--state': 'state', '--business': 'business', '--confirm': 'confirm', '--max': 'max' };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    if (map[k]) {
      if (argv[i + 1] === undefined) throw new Error(`${k} needs a value`);
      a[map[k]] = argv[i + 1];
      i += 1;
    } else if (k.startsWith('--')) throw new Error(`unknown argument: ${k}`);
    else a.positional.push(k);
  }
  return a;
}
export function validate(a) {
  const e = [];
  if (!COMMANDS.includes(a.command)) e.push(`command must be ${COMMANDS.join('|')}`);
  if (['show', 'approve', 'reject', 'dismiss'].includes(a.command) && !TASK_ID_RE.test(a.positional[0] ?? '')) e.push(`${a.command} needs a task id`);
  if (['approve', 'reject', 'dismiss'].includes(a.command) && !/^[0-9a-f]{12}$/.test(a.confirm ?? '')) e.push('--confirm needs the 12 hex digits shown by show');
  if (a.command === 'intake' && !a.inbox) e.push('intake needs --inbox');
  if (a.command === 'submit' && !a.file) e.push('submit needs --file');
  if (a.state !== undefined && !STATES.includes(a.state)) e.push('--state is not a known state');
  if (a.business !== undefined && !ID_RE.test(a.business)) e.push('--business is not an id');
  if (a.max !== undefined && !/^[1-9]\d{0,2}$/.test(a.max)) e.push('--max must be 1-999');
  return e;
}

const keychainError = (code) => Object.assign(new Error(code), { code });
const KEY_CACHE = new Map();
/**
 * channel の鍵を Keychain から読む（値は返すだけで、表示・log・error に出さない）。process の中では channel ごとに 1 回だけ読む。
 * null を返すのは `security` が exit 44（その項目が無い）の時だけ＝知らない channel として拒否される。
 * それ以外の失敗（時間切れ・signal・ほかの exit code・値の形が悪い）は coded error を投げる＝取り込みは file を inbox に残し、次の回でやり直す（依頼を捨てない）。
 * 値は hex の 64 桁以上・偶数桁。
 */
export function keychainKeyFor(channel, { run = spawnSync, cache = KEY_CACHE } = {}) {
  if (!ID_RE.test(channel)) return null;
  if (cache.has(channel)) return cache.get(channel);
  let r;
  try {
    r = run('/usr/bin/security', ['find-generic-password', '-s', `${KEYCHAIN_SERVICE_PREFIX}${channel}`, '-a', KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 });
  } catch { throw keychainError('keychain_unavailable'); }
  if (!r || r.error || r.signal) throw keychainError('keychain_unavailable'); // 時間切れ・起動の失敗・signal
  if (r.status === 44) return null; // errSecItemNotFound：知らない channel
  if (r.status !== 0) throw keychainError('keychain_failed'); // 鍵のかかった Keychain・権限・ほか
  const hex = String(r.stdout).trim();
  if (!(/^[0-9a-fA-F]{64,}$/.test(hex) && hex.length % 2 === 0)) throw keychainError('keychain_value_invalid');
  const key = Buffer.from(hex, 'hex');
  cache.set(channel, key);
  return key;
}

/** show 用（承認待ち以外）：文字列は 200 字まで・配列は 20 件まで */
export function brief(v, depth = 0) {
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…(${v.length} chars)` : v;
  if (Array.isArray(v)) return depth > 4 ? '[…]' : [...v.slice(0, 20).map((x) => brief(x, depth + 1)), ...(v.length > 20 ? [`…(+${v.length - 20})`] : [])];
  if (v && typeof v === 'object') return depth > 4 ? '{…}' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, brief(x, depth + 1)]));
  return v;
}
/** キーの順を固定した複製（確認コードの対象と同じ並びで全文を見せる） */
export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
// 見えない・紛らわしい文字：制御・書式（bidi・零幅）・未割り当て・私用・サロゲート・行／段落区切り・空白類（U+0020 と構造の改行は除く）・既定で無視される文字・点字の空白
const HIDDEN = /(?![ \n])[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}\u2800]/gu;
const units = (ch) => [...ch].map((c) => c.codePointAt(0)).flatMap((cp) => (cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp]));
/** JSON 文字列の見えない文字を \uXXXX にして、画面に隠れる物を残さない */
export const escapeHidden = (text) => text.replace(HIDDEN, (ch) => units(ch).map((u) => `\\u${u.toString(16).padStart(4, '0')}`).join(''));
/** 承認の対象（params）の全文。キー順固定・見えない文字は escape 済み */
export const fullParams = (t) => escapeHidden(JSON.stringify(sortKeys(t.params), null, 2));

export const showView = (t) => ({
  task_id: t.task_id, state: t.state, class: t.class, handler: t.handler, source: t.source, channel: t.channel, business: t.business, intent: t.intent,
  summary: brief(t.summary), params: t.state === 'awaiting_approval' ? sortKeys(t.params) : brief(t.params), decision: t.decision, attempts: `${t.attempts}/${t.max_attempts}`, next_try_at: t.next_try_at, error: t.error,
  result: brief(t.result), approval: t.approval,
  ...(t.state === 'awaiting_approval' ? { params_note: 'params は全文（承認の対象）', confirm_code: confirmCodeOf(t), confirm_hint: `approve ${t.task_id} --confirm ${confirmCodeOf(t)}` } : {}),
  ...(t.state === 'stopped' ? { confirm_code: confirmCodeOf(t), confirm_hint: `dismiss ${t.task_id} --confirm ${confirmCodeOf(t)}` } : {}),
  history: t.history.slice(-10), created_at: t.created_at, updated_at: t.updated_at,
});
export const humanLine = (t, now) => `[承認待ち] ${t.business} ${t.intent} ${t.task_id} （${Math.max(0, Math.floor((now - Date.parse(t.created_at)) / 3_600_000))} 時間前・承認の前に show ${t.task_id} で params の全文を確認）`;

export async function main(argv, { out = (s) => console.log(s), err = (s) => console.error(s), keyFor = keychainKeyFor, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), now: nowArg } = {}) {
  const now = nowArg ?? Date.now();
  const clock = nowArg === undefined ? () => Date.now() : () => nowArg; // run は実時間で測る（lease を起動時の時刻で固定しない）。試験は時刻を固定して渡す
  let a;
  try { a = parse(argv); } catch (e) { err(e.message); return 2; }
  const errors = validate(a);
  if (errors.length) { err(errors.join('\n')); return 2; }
  const dir = path.resolve(expand(a.store ?? DEFAULT_STORE));
  const store = openStore(dir, { now: () => now });
  const config = path.resolve(expand(a.config ?? path.join(dir, 'config.json')));
  const policy = () => createPolicy({ catalog: loadCatalog(), config: loadLocalConfig(config) });
  const needPolicy = () => { try { return policy(); } catch (e) { err(`config を読めない（${e.message}）`); return null; } };
  switch (a.command) {
    case 'intake': {
      const p = needPolicy();
      if (!p) return 1;
      // run と同じ単独実行の lock（2026-11-10 再検証）：2 つの intake が同じ inbox の file を同時に読むと、片方の失敗の後にもう片方が replay として捨て、依頼が消える
      let release;
      try { release = store.acquireRunLock(now); } catch (e) { if (e?.code === 'lock_conflict') { err('lock の競合（lock_conflict）'); return 1; } throw e; }
      if (!release) {
        const age = store.runLockAgeMs(now);
        out('取り込まない（別の intake か run の最中。次の回に回す）');
        return Number.isFinite(age) && age > RUN_LOCK_MAX_AGE_MS ? 1 : 0;
      }
      let rows;
      try { rows = await ingestInbox(path.resolve(expand(a.inbox)), { keyFor, now, store, policy: p }); } finally { release(); }
      for (const r of rows) out(`${r.ok ? 'OK ' : 'NG '} ${r.file} ${r.ok ? `${r.task_id} ${r.state}${r.duplicate ? ' (duplicate)' : ''}` : r.code}`);
      out(`取り込み ${rows.filter((r) => r.ok).length} 件・拒否 ${rows.filter((r) => !r.ok).length} 件`);
      return rows.some((r) => !r.ok) ? 1 : 0;
    }
    case 'submit': {
      const p = needPolicy();
      if (!p) return 1;
      let input;
      try { input = JSON.parse(readSmallFile(path.resolve(expand(a.file)), 1_048_576)); } catch { err('--file を JSON として読めない'); return 2; }
      const r = await submitLocal(input, { store, policy: p, now });
      out(r.ok ? `${r.task_id} ${r.state}${r.duplicate ? ' (duplicate)' : ''}` : `拒否 ${r.code}`);
      return r.ok ? 0 : 1;
    }
    case 'list': {
      for (const t of store.listTasks({ state: a.state ?? null, business: a.business ?? null })) out(`${t.task_id} ${t.state.padEnd(17)} ${t.class.padEnd(14)} ${t.business} ${t.intent} ${t.updated_at}`);
      return 0;
    }
    case 'show': {
      const t = store.readTask(a.positional[0]);
      if (!t) { err('見つからない'); return 1; }
      out(escapeHidden(JSON.stringify(showView(t), null, 2)));
      return 0;
    }
    case 'approve':
    case 'reject':
    case 'dismiss': {
      // approve は記録の直前に承認する params の全文を見せる（端末と確認コードが通った時だけ）
      const shown = (t) => out(`承認する内容（params の全文）：${t.business} ${t.intent} ${t.task_id}\n${fullParams(t)}`);
      const r = a.command === 'approve' ? approve(store, a.positional[0], { confirm: a.confirm, isTTY, now, beforeRecord: shown }) : (a.command === 'reject' ? reject : dismiss)(store, a.positional[0], { confirm: a.confirm, isTTY, now });
      out(r.ok ? `${{ approve: '承認しました', reject: '却下しました', dismiss: '確認して閉じました' }[a.command]} ${r.task.task_id} → ${r.task.state}` : `できません（${r.code}）`);
      return r.ok ? 0 : 1;
    }
    case 'run': {
      const p = needPolicy();
      if (!p) return 1;
      const r = await runOnce({ store, policy: p, handlers: HANDLERS, config: { ...p.config, services: businessServices(p.config) }, now: clock, maxTasks: Number(a.max ?? 10) });
      if (r.skipped) out(`実行しない（${r.skipped}${r.skipped === 'paused' ? `：${store.pauseCode() ?? ''}` : ''}）`);
      for (const x of r.recovered) out(`復旧 ${x.task_id} → ${x.state}`);
      for (const x of r.ran) out(`${x.task_id} → ${x.state}${x.code ? ` (${x.code})` : ''}`);
      if (r.paused) out(`PAUSE：${store.pauseCode() ?? ''}（原因を確かめてから PAUSE を消す）`);
      // 別の runner が RUN_LOCK_MAX_AGE_MS より長く持っている lock（本物の持ち主はそんなに持たない）と lock の競合は、黙って 0 にしない
      const stuck = r.skipped === 'lock_conflict' || r.skipped === 'lock_lost' || (r.skipped === 'locked' && Number.isFinite(r.lock_age_ms) && r.lock_age_ms > RUN_LOCK_MAX_AGE_MS);
      return stuck || r.paused || r.skipped === 'paused' || r.ran.some((x) => x.state === 'failed' || x.state === 'stopped') ? 1 : 0;
    }
    case 'verify-audit': {
      const r = store.verifyAudit();
      out(r.ok ? `OK ${r.lines} 行` : `NG ${r.code}（${r.line} 行目）`);
      return r.ok ? 0 : 1;
    }
    case 'human': {
      const rows = store.listTasks({ state: 'awaiting_approval' });
      for (const t of rows) out(humanLine(t, now));
      if (rows.length) out('※ 承認の前に必ず show <task_id> で params の全文を読む（approve は記録の前にもう一度全文を表示する）');
      else out('承認待ちはありません');
      return 0;
    }
    case 'collect-hermes': {
      let cfg;
      try { cfg = loadLocalConfig(config); } catch (e) { err(`config を読めない（${e.message}）`); return 1; }
      let release;
      try { release = store.acquireRunLock(now); } catch (e) { if (e?.code === 'lock_conflict') { err('lock の競合（lock_conflict）'); return 1; } throw e; }
      if (!release) { out('取り込まない（別の intake か run の最中。次の回に回す）'); return 0; }
      let r;
      try {
        // Hermes の 1 件実行（scripts/hermes-work.mjs）が running のまま居なくなった記録を interrupted にする（強制終了・再起動の後。2026-11-13）
        for (const id of recoverInterrupted(store, { at: now, alive: (j) => pgrepAlive(j) })) out(`途中で止まった Hermes の実行 ${id} → interrupted（やり直しは Human：hermes-work.mjs run --task ${id} --retry --paid-ok）`);
        r = collectHermesResults({ store, config: cfg, now });
      } finally { release(); }
      if (r.code === 'not_connected') { out('Hermes の結果の場所（hermes_outbox）は未接続（休眠）'); return 0; }
      for (const x of r.rejected) out(`NG  ${x.file} ${x.code}`);
      out(`Hermes の結果：記録 ${r.recorded} 件・取り込み済み ${r.already} 件・拒否 ${r.rejected.length} 件${r.overflow ? `・上限で次の回へ ${r.overflow} 件` : ''}`);
      return r.rejected.length ? 1 : 0;
    }
    case 'prune': {
      let off = 0;
      try { off = loadLocalConfig(config).utc_offset_minutes ?? 0; } catch { /* config が無くても掃除はできる（UTC で数える） */ }
      let rec = 0;
      for (const b of store.recordBusinesses()) {
        rec += store.compactRecords(b, 'mail', (r) => keepMail(r, now, off));
        rec += store.compactRecords(b, 'calendar', (r) => keepEvent(r, now, off));
        rec += store.compactRecords(b, 'notes');
      }
      out(`nonce ${store.pruneNonces(now)} 件・配達済みの outbox ${store.pruneOutboxSent(now)} 件・保持を過ぎた記録 ${rec} 行・途中で止まった tmp ${store.pruneTmp(now)} 件を消した`);
      return 0;
    }
    default:
      return 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
