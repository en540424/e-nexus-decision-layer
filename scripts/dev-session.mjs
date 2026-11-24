#!/usr/bin/env node
/**
 * Cursor・Terminal を閉じても続く作業の session（2026-11-23・docs/dev-session.md）。
 *
 *   node scripts/dev-session.mjs start <name> [--cwd <dir>] -- <command...>   screen の中で始める（同じ名前が動いていれば始めない）
 *   node scripts/dev-session.mjs status [--json]        job（screen）と Claude Code の --bg の session（~/e-nexus-runtime の下だけ）の一覧
 *   node scripts/dev-session.mjs log <name> [--lines N] 画面の記録の最後
 *   node scripts/dev-session.mjs attach <name>          画面へ戻る（Terminal だけ・離れる時は Ctrl-a d）
 *   node scripts/dev-session.mjs stop <name>            止める（screen の quit）
 *   node scripts/dev-session.mjs forget <name>          終わった・消えた job の記録を archive/ へ（見張りの「消えた」を確認済みにする）
 *   node scripts/dev-session.mjs history [--limit N]    履歴
 *   node scripts/dev-session.mjs recover                再起動・logout の後に消えた job と、やり直しの command を出す（自動で再実行しない）
 *
 * Claude Code の作業そのものは公式の `claude --bg` で始める（docs/dev-session.md §2）。
 * exit：0＝ok／1＝止めた（二重起動・見つからない・失敗）／2＝引数
 */
import { spawnSync } from 'node:child_process';
import { claudeSessions, forgetSession, listSessions, NAME, readHistory, readLog, recoverPlan, rootOf, SCREEN, screenEnv, screenName, startSession, stopSession } from './lib/dev-session.mjs';

const COMMANDS = ['start', 'status', 'log', 'attach', 'stop', 'forget', 'history', 'recover'];

export function parse(argv) {
  const a = { command: argv[0], json: false, lines: 40, limit: 20, cwd: process.cwd(), name: null, cmd: [] };
  if (!COMMANDS.includes(a.command)) throw new Error(`command must be ${COMMANDS.join('|')}`);
  let i = 1;
  if (['start', 'log', 'attach', 'stop', 'forget'].includes(a.command)) {
    a.name = argv[1];
    if (!NAME.test(a.name ?? '')) throw new Error('name must match [a-z0-9][a-z0-9-]{0,31}');
    i = 2;
  }
  for (; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--' && a.command === 'start') { a.cmd = argv.slice(i + 1); break; }
    if (k === '--json') a.json = true;
    else if (k === '--cwd' && a.command === 'start' && v) { a.cwd = v; i += 1; } else if (k === '--lines' && /^\d{1,4}$/.test(v ?? '')) { a.lines = Number(v); i += 1; } else if (k === '--limit' && /^\d{1,4}$/.test(v ?? '')) { a.limit = Number(v); i += 1; } else throw new Error(`unknown argument: ${k}`);
  }
  if (a.command === 'start' && a.cmd.length === 0) throw new Error('start needs -- <command...>');
  return a;
}

const dur = (from, to) => { const s = Math.max(0, Math.round((Date.parse(to ?? new Date().toISOString()) - Date.parse(from)) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };
const label = (s) => (s.state === 'exited' ? `exited ${s.code}` : s.state);

export async function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  let a;
  try { a = parse(argv); } catch (e) { err(String(e.message)); return 2; }
  const root = rootOf();
  if (a.command === 'start') {
    const r = startSession(root, a.name, a.cmd, { cwd: a.cwd });
    if (!r.ok) { err(`${r.code}${r.session ? ` (${label(r.session)} since ${r.session.started_at})` : ''}${r.detail ? `: ${r.detail}` : ''}`); return 1; }
    out(`started ${a.name} (run ${r.session.run})\n  戻る: node scripts/dev-session.mjs attach ${a.name}（離れる: Ctrl-a d）\n  記録: node scripts/dev-session.mjs log ${a.name}`);
    return 0;
  }
  if (a.command === 'status') {
    const jobs = listSessions(root);
    const claude = claudeSessions();
    if (a.json) { out(JSON.stringify({ jobs, claude_bg: claude.ok ? claude.sessions : null })); return 0; }
    out(jobs.length ? 'job（screen）:' : 'job（screen）: なし');
    for (const s of jobs) out(`  ${s.name.padEnd(20)} ${label(s).padEnd(10)} ${dur(s.started_at, s.ended_at ?? s.stopped)}  ${s.cwd}  ${s.command.join(' ').slice(0, 60)}`);
    if (!claude.ok) out('Claude Code --bg: 確かめられない（claude agents --json が失敗）');
    else {
      out(claude.sessions.length ? 'Claude Code --bg（~/e-nexus-runtime の下）:' : 'Claude Code --bg（~/e-nexus-runtime の下）: なし');
      for (const c of claude.sessions) out(`  ${c.id.padEnd(10)} ${String(c.status).padEnd(10)} ${c.name ?? ''}  ${c.cwd}`);
    }
    const lost = jobs.filter((s) => s.state === 'vanished').length;
    if (lost) out(`消えた job ${lost} 件（logout・再起動・強制終了）→ node scripts/dev-session.mjs recover`);
    return 0;
  }
  if (a.command === 'log') { const t = readLog(root, a.name, a.lines); if (t == null) { err('not_found'); return 1; } out(t); return 0; }
  if (a.command === 'attach') {
    if (!process.stdin.isTTY) { err('attach is for a terminal（Terminal.app・SSH）'); return 1; }
    const r = spawnSync(SCREEN, ['-r', screenName(root, a.name)], { stdio: 'inherit', env: screenEnv(root) });
    return r.status === 0 ? 0 : 1;
  }
  if (a.command === 'stop') { const r = stopSession(root, a.name); (r.ok ? out : err)(r.code); return r.ok ? 0 : 1; }
  if (a.command === 'forget') { const r = forgetSession(root, a.name); (r.ok ? out : err)(r.code); return r.ok ? 0 : 1; }
  if (a.command === 'history') { for (const h of readHistory(root, a.limit)) out(JSON.stringify(h)); return 0; }
  if (a.command === 'recover') {
    const plan = recoverPlan(listSessions(root));
    if (!plan.length) { out('消えた job はありません'); return 0; }
    for (const p of plan) out(`${p.name}（${p.started_at} に開始・${p.cwd}）\n  やり直す時: ${p.restart.map((x) => (/^[\w./:=@-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(' ')}\n  記録だけ片づける時: node scripts/dev-session.mjs forget ${p.name}`);
    const claude = claudeSessions();
    if (claude.ok && claude.sessions.some((c) => c.status === 'failed')) out('Claude Code --bg に failed（再起動で止まった）があります → claude attach <id> で会話から再開（claude respawn --all は使わない）');
    return 0;
  }
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((code) => { process.exitCode = code; });
