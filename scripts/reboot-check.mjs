#!/usr/bin/env node
/**
 * 再起動の後の復帰の確かめ（2026-11-23・読むだけ・docs/dev-session.md §8）。
 * launchd の登録・動いた記録と、各 job が書く記録の新しさを見て、Mac Runtime が戻ったかを判定する。何も起動しない・書かない・通信しない。
 *
 *   node scripts/reboot-check.mjs [--json] [--no-claude]
 *
 * 判定：ok＝戻った／waiting＝起動からまだ次の回の時間が経っていない（待てば戻るはず）／problem＝登録が無い・記録が古い・消えた job がある
 * exit：0＝ok か waiting だけ／1＝problem がある／2＝引数
 *
 * LaunchAgent（gui の domain）は GUI の login の後にしか動かない。login の有無はここで「console の user が自分か」だけを見る（名前は出さない）。
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSessions, devSessionsItem, rootOf } from './lib/dev-session.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60_000;

/** 見る物：label・domain・記録の file・その記録が新しいと言える時間（回の間隔＋余裕） */
export function targets(home = homedir()) {
  const state = path.join(home, 'e-nexus-runtime', 'mac-runtime-state');
  return [
    { id: 'task_hub', label: 'com.e-nexus.task-hub', domain: 'gui', record: path.join(state, 'task-hub', 'cycle-last.json'), fresh_ms: 15 * MIN },
    { id: 'host_health', label: 'com.e-nexus.host-health', domain: 'gui', record: path.join(REPO, 'data', 'host-health', 'state.json'), fresh_ms: 45 * MIN },
    { id: 'host_health_watchdog', label: 'com.e-nexus.host-health-watchdog', domain: 'gui', record: path.join(REPO, 'data', 'host-health', 'watchdog.json'), fresh_ms: 90 * MIN },
    { id: 'runtime_backup', label: 'com.e-nexus.runtime-backup', domain: 'gui', record: path.join(home, '.enexus', 'backup', 'last.json'), fresh_ms: 50 * 60 * MIN },
    { id: 'hermes', label: 'com.e-nexus.hermes', domain: 'system', record: null, fresh_ms: 0, running: true },
    { id: 'hermes_status', label: null, record: '/Users/Shared/e-nexus-hermes/status/runtime-brief.json', fresh_ms: 45 * MIN },
  ];
}

/** launchctl print の出力から必要な値だけ */
export function parseLaunchctl(text) {
  if (!text) return { loaded: false };
  const top = String(text).split('\n').filter((l) => /^\t[a-z]/.test(l)).join('\n'); // 1 段目の字下げだけ（中の endpoint の state を読まない）
  const get = (k) => top.match(new RegExp(`^\\t${k} = (.+)$`, 'm'))?.[1]?.trim() ?? null;
  return { loaded: true, state: get('state'), runs: Number(get('runs') ?? NaN), last_exit: get('last exit code') };
}

/** 1 行の判定（純粋な関数＝試験しやすい） */
export function judge(t, { launchd, recordMtime, now, bootAt }) {
  const sinceBoot = now - bootAt;
  if (t.label && !launchd?.loaded) return { id: t.id, verdict: 'problem', reason: 'not_loaded' };
  if (t.running && launchd?.state !== 'running') return { id: t.id, verdict: sinceBoot < 5 * MIN ? 'waiting' : 'problem', reason: 'not_running' };
  if (t.record) {
    if (recordMtime == null) return { id: t.id, verdict: sinceBoot < t.fresh_ms ? 'waiting' : 'problem', reason: 'no_record' };
    // 起動の前の記録＝起動の後にまだ 1 回も動いていない（新しさの範囲の中でも ok にしない）
    if (recordMtime < bootAt) return { id: t.id, verdict: sinceBoot < t.fresh_ms ? 'waiting' : 'problem', reason: 'not_run_since_boot' };
    const age = now - recordMtime;
    if (age > t.fresh_ms) return { id: t.id, verdict: 'problem', reason: `stale ${Math.round(age / MIN)}m` };
  }
  if (launchd?.last_exit && !/^0\b|^\(never exited\)/.test(launchd.last_exit) && !t.running) return { id: t.id, verdict: 'problem', reason: `last_exit ${launchd.last_exit.slice(0, 20)}` };
  return { id: t.id, verdict: 'ok', reason: null };
}

function launchctl(domain, label) {
  const target = domain === 'gui' ? `gui/${process.getuid()}/${label}` : `system/${label}`;
  try { return parseLaunchctl(execFileSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return { loaded: false }; }
}
function bootTime() {
  const s = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5000 });
  return Number(s.match(/sec = (\d+)/)[1]) * 1000;
}
const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return null; } };

export function collect({ now = Date.now(), claude = true } = {}) {
  const bootAt = bootTime();
  const rows = targets().map((t) => judge(t, { launchd: t.label ? launchctl(t.domain, t.label) : null, recordMtime: t.record ? mtime(t.record) : null, now, bootAt }));
  let consoleSelf = null;
  try { consoleSelf = statSync('/dev/console').uid === process.getuid(); } catch { /* 読めない */ }
  const dev = devSessionsItem(rootOf());
  if (dev) rows.push({ id: 'dev_sessions', verdict: dev.value === 'ok' ? 'ok' : 'problem', reason: dev.value === 'ok' ? null : `${dev.value}（node scripts/dev-session.mjs recover）` });
  if (claude) {
    const c = claudeSessions();
    if (c.ok) { const failed = c.sessions.filter((s) => s.status === 'failed').length; rows.push({ id: 'claude_bg', verdict: failed ? 'problem' : 'ok', reason: failed ? `failed ${failed}（claude agents → claude attach <id>）` : null }); }
  }
  return { at: new Date(now).toISOString(), boot_at: new Date(bootAt).toISOString(), minutes_since_boot: Math.round((now - bootAt) / MIN), console_is_self: consoleSelf, rows, verdict: rows.some((r) => r.verdict === 'problem') ? 'problem' : rows.some((r) => r.verdict === 'waiting') ? 'waiting' : 'ok' };
}

export function main(argv = process.argv.slice(2), { out = console.log } = {}) {
  const json = argv.includes('--json');
  const claude = !argv.includes('--no-claude');
  if (argv.some((a) => !['--json', '--no-claude'].includes(a))) { console.error('usage: reboot-check.mjs [--json] [--no-claude]'); return 2; }
  const r = collect({ claude });
  if (json) out(JSON.stringify(r));
  else {
    out(`起動から ${r.minutes_since_boot} 分・GUI の login：${r.console_is_self === true ? 'この user' : r.console_is_self === false ? '無い（LaunchAgent は login まで動かない）' : '不明'}`);
    for (const row of r.rows) out(`  ${row.verdict.padEnd(8)} ${row.id}${row.reason ? `  ${row.reason}` : ''}`);
    out(`判定：${r.verdict}`);
  }
  return r.verdict === 'problem' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
