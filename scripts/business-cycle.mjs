#!/usr/bin/env node
/**
 * 業務の定期の回（2026-11-13・docs/dropbox-business.md §4）：工程表の自動バックアップ＝**週 1 回**（Human 決定）。AI を使わない。
 * scripts/task-hub-cycle.mjs の 1 段として 5 分ごとに呼ばれ、週の時刻が来た business だけを取る（ほかの回は何もしない＝常駐を増やさない）。
 *
 *   node scripts/business-cycle.mjs [--store <dir>]
 *
 * 休眠：config.json に dropbox が無い・schedule_files が無い＝not_configured（exit 0）。Keychain に読みの資格情報が無い＝not_configured。
 * 結果は <store>/business-last.json（件数とコードだけ・path は出さない）。host-health の business_backup が読む。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { weeklyBackup, weeklyDue } from './lib/business/schedule-backup.mjs';
import { loadScopes } from './lib/dropbox/scope.mjs';
import { businessServices } from './lib/task-hub/business-services.mjs';
import { validateConfig } from './lib/task-hub/policy.mjs';

export const DEFAULT_STORE = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub');
export const BUSINESS_LAST = 'business-last.json';

function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }

export async function businessCycle({ store = DEFAULT_STORE, now = Date.now(), services = businessServices } = {}) {
  const raw = readJson(path.join(store, 'config.json'));
  if (!raw) return { code: 'not_configured', exit: 0 };
  let cfg;
  // dropbox の節が壊れている＝config_invalid（休眠と区別して見張りに出す・監査 nit 8）。他の誤りは Task Hub の側が知らせる
  try { cfg = validateConfig(raw); } catch (e) { return /dropbox/.test(String(e?.message)) ? write(store, { code: 'config_invalid', exit: 1 }, now) : { code: 'not_configured', exit: 0 }; }
  const scopes = loadScopes(cfg.dropbox);
  const targets = [...scopes.values()].filter((s) => s.schedule_files.length);
  if (!targets.length) return { code: 'not_configured', exit: 0 };
  const svc = services(cfg);
  const prev = readJson(path.join(store, BUSINESS_LAST)) ?? {};
  const weekly = [];
  let ran = false;
  for (const s of targets) {
    if (!weeklyDue(svc.backupDir, s.business, now)) continue;
    ran = true;
    let reader;
    try { reader = svc.dropbox('read'); } catch { return write(store, { code: 'not_configured', exit: 0, last_weekly_ok_at: prev.last_weekly_ok_at ?? null }, now); }
    for (const r of await weeklyBackup({ reader, scopes, business: s.business, dir: svc.backupDir, now })) weekly.push({ business: s.business, ...r });
  }
  if (!ran) return { code: 'not_due', exit: 0 };
  const bad = weekly.some((x) => x.code);
  return write(store, { code: bad ? 'problem' : 'ok', exit: bad ? 1 : 0, weekly, last_weekly_ok_at: bad ? (prev.last_weekly_ok_at ?? null) : new Date(now).toISOString() }, now);
}

function write(store, r, now) {
  const f = path.join(store, BUSINESS_LAST);
  try { writeFileSync(`${f}.tmp`, `${JSON.stringify({ at: new Date(now).toISOString(), ...r })}\n`, { mode: 0o600 }); renameSync(`${f}.tmp`, f); } catch { /* 書けなくても回しは続ける */ }
  return r;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf('--store');
  const store = i > 0 ? path.resolve(process.argv[i + 1]) : DEFAULT_STORE;
  const { exit, ...rest } = await businessCycle({ store });
  console.log(JSON.stringify({ component: 'edl-business-cycle', code: rest.code, ...(rest.weekly ? { files: rest.weekly.length, problems: rest.weekly.filter((x) => x.code).length } : {}) }));
  process.exitCode = exit;
}
