#!/usr/bin/env node
/**
 * Hermes に承認済みの業務を 1 件だけ処理させる（2026-11-13・MA-24・docs/hermes-work.md §11）。**run・dismiss は Human が Mac の Terminal で実行**。
 *
 *   node scripts/hermes-work.mjs status                       Hermes の実行の記録の一覧（読むだけ・sudo なし）
 *   node scripts/hermes-work.mjs run [--paid-ok] [--task <id>] [--retry] [--no-approve]
 *        1. 承認待ちの hermes.task を 1 件ずつ全文で見せ、確認コードを打てば承認（task-hub の approve と同じ。端末だけ・空 Enter で飛ばす）
 *        2. Task Hub の queue を回して承認済みの依頼を Hermes の inbox へ渡す
 *        3. 渡す 1 件を選び、--paid-ok が無ければ課金の前で止まる。--paid-ok なら sudo の password（排他を取る前に）
 *           承認から 24 時間を過ぎた依頼は、sudo の前にもう一度全文を見せて確認コードを聞く（端末だけ。打たなければ approval_stale で止まる・2026-11-18）
 *        4. 課金なしの確かめ（メモリ・常駐・権限・sandbox の規則・無効な鍵での Hermes の起動＝Anthropic が 401 を返すところまで）
 *           --check-only（--paid-ok の代わり）はここまでで止める＝有料の実行はしない・記録は waiting のまま（2026-11-18）
 *        5. hermes として sandbox の中で Hermes の -z を 1 回（120 秒・道具は file だけ・鍵は環境変数だけ）→ 結果の取り込み → 依頼元（Grok）へ返す
 *           -z は sandbox の中の同じ process で動かす（v0.22.4 の `hermes -z` は常駐の gateway へ渡す client＝使わない。lib/hermes-sandbox.mjs の inProcessCommand・2026-11-18 夜）
 *        やり直し（時間切れ・結果なし・結果の拒否・中断）は --task <id> --retry（有料・最大 3 回）
 *   node scripts/hermes-work.mjs dismiss <task_id> --confirm <12hex>   実行せずに閉じる（waiting・やり直し待ち。端末だけ。確認コードは task-hub show と同じ）
 *   sh deploy/macos/hermes-work-run.sh --paid-ok  は run と同じ
 *
 * 変えないもの：Hermes の設定・権限・常駐・鍵の file。作るもの：hermes の home の profile のフォルダ（~/.hermes/profiles/work・初回だけ）と、
 * Hermes が起動で作る中の空のフォルダ（cron・hooks・memories・skills）と決まった SOUL.md（sandbox の中では書けない所・prepareWorkHome）。
 * 出すもの：段のコード・usage の数。依頼の本文・Hermes の出力の全文・鍵は画面に出さない（出力の末尾は鍵の形を伏せて store の hermes-work-logs/ に 0600。
 * 課金なしの確かめで止まった時は、その時刻の sandbox の拒否の行〈path だけ〉も同じ場所へ）。outbox の余計な file は store の hermes-quarantine/ へ移す。
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inProcessCommand, LOADER, productionParams, sandboxArgs, WORK_LOCKED_DIRS, WORK_PROFILE, WORK_SOUL_MD } from './lib/hermes-sandbox.mjs';
import { HANDLERS } from './lib/task-hub/handlers.mjs';
import { businessServices } from './lib/task-hub/business-services.mjs';
import { confirmCodeOf, currentDigest } from './lib/task-hub/approval.mjs';
import { dismissJob, jobStatus, pgrepAlive, selectNext } from './lib/task-hub/hermes-jobs.mjs';
import { approvalStale, runWork } from './lib/task-hub/hermes-work.mjs';
import { createPolicy, loadCatalog, loadLocalConfig } from './lib/task-hub/policy.mjs';
import { runOnce } from './lib/task-hub/runner.mjs';
import { readSmallFile } from './lib/task-hub/safe-read.mjs';
import { openStore, TASK_ID_RE } from './lib/task-hub/store.mjs';
import { fullParams, main as taskHub } from './task-hub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STORE = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub');
const HU = 'hermes';
const HH = `/Users/${HU}`;
const ROOT = `${HH}/.hermes`;
const WORK_HOME = `${ROOT}/profiles/${WORK_PROFILE}`;
const HERMES_BIN = `${HH}/.local/bin/hermes`;
const USAGE = `${HH}/work/work-run-usage.json`;
const PROBE_USAGE = `${HH}/work/work-probe-usage.json`;
const GATEWAY = 'gateway run --external-supervisor';
const RSS_LIMIT_MIB = 2048;
const PROBE_SECONDS = 60;
const OUTBOX_READ_MAX = 64 * 1024;
const SECRET_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|[0-9a-f]{64,}/g;
/** Anthropic が鍵を拒んだ印（\b401\b＝session_id 等の数字の中の 401 を拾わない。in-process の 401 は stdout の「rejected your API key」で出る：
 *  v0.22.4 agent/turn_failure_copy.py の _AUTH_COPY。監査 1・2） */
const AUTH_ERROR = /\b401\b|authentication_error|invalid[ _-]?x-?api[ _-]?key|rejected your API key|unauthori[sz]ed/i;
/** in-process の起動の差し替えが働かなかった（lib/hermes-sandbox.mjs の INPROC_ENTRY が出す） */
const INPROC_ERROR = /e-nexus: (?:hermes oneshot signature changed|in-process oneshot returned|resume is not allowed|-z prompt is required)/;
/** Hermes の gateway の client の止まり（gateway_client.connect_gateway・gateway_runtime）。「Gateway inaccessible: authorization」は鍵の 401 ではない */
const GATEWAY_ERROR = /Gateway (?:inaccessible|absent|starting|draining|incompatible|could not start|connection failed|bootstrap|protocol mismatch)|no local fallback/i;

/**
 * 課金なしの起動の確かめの結果を判定する（null＝通った）。text は Hermes の stdout・stderr と usage の file の failure・turn_exit_reason だけ
 * （session_id・token の数の中の数字を 401 と読まない。監査 1）。
 * gateway の止まりを先に見る（2026-11-18 夜：v0.22.4 の hermes -z が gateway に渡そうとして sandbox に拒まれた「authorization」を、鍵の 401 と読まない）
 */
export function classifyProbe(pr, usageText = '') {
  let u = null;
  try { u = JSON.parse(usageText || 'null'); } catch { u = null; }
  const usageWhy = u && typeof u === 'object' ? [u.failure, u.turn_exit_reason].filter((v) => typeof v === 'string').join('\n') : '';
  const text = `${pr?.stdout ?? ''}\n${pr?.stderr ?? ''}\n${usageWhy}`;
  if (pr?.status === 0) return 'probe_unexpected_success'; // 無効な鍵で成功＝別の資格情報が使われた（止める）
  if (INPROC_ERROR.test(text)) return 'probe_inproc_unexpected'; // Hermes の形が変わった（Hermes を上げた時）
  if (GATEWAY_ERROR.test(text)) return 'probe_gateway_transport'; // sandbox の外の常駐へ渡そうとした（in-process で動いていない）
  if (AUTH_ERROR.test(text)) return null;
  if (/Operation not permitted|PermissionError|EPERM|sandbox/i.test(text)) return 'probe_sandbox_breaks_hermes';
  return pr?.signal || pr?.error ? 'probe_timeout' : 'probe_no_auth_error';
}

export function parse(argv) {
  const a = { command: argv[0], paidOk: false, checkOnly: false, retry: false, approve: true, task: null, store: null, confirm: null, positional: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--paid-ok') a.paidOk = true;
    else if (k === '--check-only') a.checkOnly = true;
    else if (k === '--retry') a.retry = true;
    else if (k === '--no-approve') a.approve = false;
    else if (['--task', '--store', '--confirm'].includes(k)) { if (argv[i + 1] === undefined) throw new Error(`${k} needs a value`); a[k.slice(2)] = argv[i + 1]; i += 1; } else if (k.startsWith('--')) throw new Error(`unknown argument: ${k}`);
    else a.positional.push(k);
  }
  if (!['run', 'status', 'dismiss'].includes(a.command)) throw new Error('command must be run|status|dismiss');
  if (a.task !== null && !TASK_ID_RE.test(a.task)) throw new Error('--task needs a task id');
  if (a.retry && !a.task) throw new Error('--retry needs --task <id>（やり直す 1 件を指定する）');
  if (a.checkOnly && (a.paidOk || a.command !== 'run')) throw new Error('--check-only は run だけ・--paid-ok と一緒に使わない（課金なしの確かめで止める）');
  if (a.command === 'dismiss' && (!TASK_ID_RE.test(a.positional[0] ?? '') || !/^[0-9a-f]{12}$/.test(a.confirm ?? ''))) throw new Error('dismiss <task_id> --confirm <12hex>');
  return a;
}

const redact = (s) => String(s ?? '').replace(SECRET_SHAPE, '[redacted]');
/** Hermes の出力の末尾を、鍵の形を伏せて残す（Claude Code が原因を読むため。画面には出さない） */
function keepLog(store, name, text) {
  try {
    const dir = store.path('hermes-work-logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, `${name}.txt`), `${redact(text)}\n`, { mode: 0o600 });
  } catch { /* 残せなくても実行は続ける */ }
}
const outputTail = (r) => `exit=${r?.status} signal=${r?.signal ?? ''}\n${String(r?.stdout ?? '').slice(-3000)}\n--- stderr ---\n${String(r?.stderr ?? '').slice(-6000)}`;

/** 課金なしの確かめで止まった時：その時刻の sandbox の拒否の行（操作と path だけ）を残す＝Human にもう一度実行してもらわずに原因を読む */
function keepDenials(store, name, sinceMs) {
  const mins = Math.min(Math.max(Math.ceil((Date.now() - sinceMs) / 60_000) + 1, 2), 10);
  const r = spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/log', 'show', '--last', `${mins}m`, '--style', 'compact', '--predicate', 'sender == "Sandbox" AND eventMessage CONTAINS "deny"'], { encoding: 'utf8', timeout: 40_000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = String(r.stdout ?? '').split('\n').filter((l) => /deny/.test(l) && /(python|hermes|perl|sandbox-exec)/i.test(l)).map((l) => l.replace(/^.*?(deny\S*\s)/, '$1')).slice(-200);
  keepLog(store, name, lines.length ? lines.join('\n') : `（拒否の行を読めなかった：exit ${r.status ?? '-'}）`);
}

/** 自分の 0700 の本物のフォルダで、中が空（find は名前に改行が在っても path を出す・一覧を読めなければ失敗＝止める。2026-11-18 監査 M1・M2） */
const OWN_700_DIR = 'test -d "$1" && test ! -L "$1" && test "$(/usr/bin/stat -f "%Lp %u" "$1")" = "700 $(/usr/bin/id -u)"';
const EMPTY_OWN_DIR = `${OWN_700_DIR} && out=$(/usr/bin/find "$1" -mindepth 1 -maxdepth 1 -print -quit) && test -z "$out"`;
const ABSENT = 'test -e "$1" || test -L "$1"';
/**
 * 業務の profile の home を sandbox の外（hermes の権限・run＝asHermes）で整える。戻り値は止める code か null。
 * Hermes は起動で cron・hooks・memories・skills を作り SOUL.md を書くが、sandbox はそこへの書きを拒む（2026-11-18 の初回：probe_sandbox_breaks_hermes）。
 * だから空のフォルダと決まった SOUL.md を先に置き、毎回「空・link でない・文が同じ」を確かめる（中身が在れば止める。sandbox の規則は変えない）。
 * plugins は Hermes が起動で作らない＝在れば止める（前と同じ）。.env も在れば止める（鍵は環境変数だけ）。
 * cwd（AGENTS.md 等が読まれる）も空、config.yaml（plugin の選び・base_url）も無いこと（sandbox は中からの書きだけを止める＝外から置かれた物はここで見る）。
 * 既に在るフォルダは mkdir -m が mode を直さない＝chmod 700 してから mode・持ち主・中身を確かめる。課金なしの確かめの初めと、起動の確かめの後（実行の直前）の 2 回。
 */
export function prepareWorkHome(run, home = WORK_HOME) {
  const ok = (r) => r?.status === 0 && !r.error;
  const sh = (script, ...args) => run(['/bin/sh', '-c', script, 'sh', ...args]);
  const dirs = ['cwd', ...WORK_LOCKED_DIRS];
  if (!ok(run(['/bin/mkdir', '-p', '-m', '700', home, ...dirs.map((d) => `${home}/${d}`)]))) return 'work_home';
  if (!ok(sh('test -d "$1" && test ! -L "$1"', home))) return 'work_home_link';
  run(['/bin/chmod', '-h', '700', home, ...dirs.map((d) => `${home}/${d}`)]); // 失敗は下の確かめで止まる（link は chmod しても下で止まる）
  if (!ok(sh(OWN_700_DIR, home))) return 'work_home_link';
  for (const [f, code] of [['.env', 'env'], ['plugins', 'plugins'], ['config.yaml', 'config']]) if (ok(sh(ABSENT, `${home}/${f}`))) return `work_home_has_${code}`;
  for (const d of dirs) if (!ok(sh(EMPTY_OWN_DIR, `${home}/${d}`))) return `work_home_has_${d}`;
  const soul = `${home}/SOUL.md`;
  // 無い時だけ作る（set -C＝在れば上書きしない・link も辿らない）。在る時は下の比べで違えば止める
  if (!ok(sh(ABSENT, soul))) sh('umask 077; set -C; printf "%s\\n" "$2" > "$1"', soul, WORK_SOUL_MD);
  const r = sh('test -f "$1" && test ! -L "$1" && /bin/cat "$1"', soul);
  if (!ok(r) || r.stdout !== `${WORK_SOUL_MD}\n`) return 'work_home_soul_changed';
  return null;
}

/** macOS の実装（sudo・sandbox-exec・hermes）。test は lib/task-hub/hermes-work.mjs に模擬を渡す */
export function macSys({ store, log, outbox }) {
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const asHermes = (args, opts) => sh('/usr/bin/sudo', ['-n', '-u', HU, '-H', ...args], opts);
  const ok = (r) => r.status === 0 && !r.error;
  const envFor = (ctx, probe) => ['/usr/bin/env', '-i', `HOME=${HH}`, `HERMES_HOME=${WORK_HOME}`, `HERMES_WRITE_SAFE_ROOT=${ctx.outbox}`, 'HERMES_DISABLE_LAZY_INSTALLS=1',
    `PATH=${HH}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, 'LANG=en_US.UTF-8', ...(probe ? ['KEY_PROBE=invalid'] : [])];
  const params = (ctx, usage) => productionParams({ hermesUser: HU, request: ctx.inboxFile, brief: ctx.briefFile ?? '/nonexistent/brief.json', result: ctx.outboxFile, usage });
  const boxed = (ctx, seconds, cmd, { probe = true, usage = PROBE_USAGE } = {}) => [...envFor(ctx, probe), '/usr/bin/perl', '-e', LOADER, `${ROOT}/.env`, String(seconds), `${WORK_HOME}/cwd`,
    '/usr/bin/sandbox-exec', ...sandboxArgs(params(ctx, usage)), ...cmd];
  const readSafe = (n) => { try { return Buffer.from(readSmallFile(path.join(outbox, n), OUTBOX_READ_MAX), 'utf8'); } catch { return null; } };
  let launch = null; // Hermes の in-process の起動（preflight が sandbox の中で決める・exec はこれだけを使う）
  return {
    async preflight(task, ctx) {
      launch = null; // 途中で止まった確かめの後に前の起動を残さない（監査 5）
      if (sh('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).stdout.trim() !== '1') return { ok: false, code: 'memory_pressure' };
      if (!ok(sh('/usr/bin/pgrep', ['-U', HU, '-f', GATEWAY]))) return { ok: false, code: 'gateway_not_running' };
      const rss = sh('/bin/ps', ['-U', HU, '-o', 'rss=']).stdout.split('\n').reduce((s, x) => s + (Number(x.trim()) || 0), 0) / 1024;
      if (rss >= RSS_LIMIT_MIB) return { ok: false, code: 'hermes_rss_high' };
      if (!ok(sh('/usr/bin/sudo', ['-n', '-v']))) return { ok: false, code: 'sudo_failed' }; // password は run の初めに聞いた（排他を取る前）
      const t = (flag, p) => ok(asHermes(['/bin/test', flag, p]));
      if (!t('-r', ctx.inboxFile)) return { ok: false, code: 'request_unreadable' };
      if (!t('-w', ctx.outbox)) return { ok: false, code: 'outbox_unwritable' };
      if (!t('-w', path.dirname(USAGE))) return { ok: false, code: 'usage_dir_unwritable' };
      for (const p of [homedir(), path.join(homedir(), 'e-nexus-runtime'), path.join(homedir(), '.enexus')]) if (t('-x', p) && t('-r', p)) return { ok: false, code: 'boundary_broken' };
      const wh = prepareWorkHome(asHermes);
      if (wh) return { ok: false, code: wh };
      // 鍵が root の .env に在る（値は見ない：loader が長さだけ確かめる）
      if (!ok(asHermes([...envFor(ctx, false), '/usr/bin/perl', '-e', LOADER, `${ROOT}/.env`, '10', `${WORK_HOME}/cwd`, '/bin/sh', '-c', 'test "${#ANTHROPIC_API_KEY}" -ge 20']))) return { ok: false, code: 'key_missing' };
      // sandbox の規則（hermes の権限で・課金なし）
      const inBox = (cmd) => ok(asHermes(boxed(ctx, 15, cmd)));
      if (inBox(['/bin/cat', `${ROOT}/.env`])) return { ok: false, code: 'sandbox_env_readable' };
      if (inBox(['/bin/cat', `${ROOT}/state.db`])) return { ok: false, code: 'sandbox_gateway_state_readable' };
      if (!inBox(['/bin/cat', ctx.inboxFile])) return { ok: false, code: 'sandbox_request_unreadable' };
      if (inBox(['/usr/bin/touch', `${ROOT}/config.yaml`])) return { ok: false, code: 'sandbox_config_writable' };
      if (inBox(['/bin/mkdir', `${ROOT}/plugins/.probe-${ctx.runToken}`])) { asHermes(['/bin/rmdir', `${ROOT}/plugins/.probe-${ctx.runToken}`]); return { ok: false, code: 'sandbox_plugins_writable' }; }
      if (inBox(['/usr/bin/touch', `${ctx.outbox}/.probe-${ctx.runToken}`])) { try { unlinkSync(`${ctx.outbox}/.probe-${ctx.runToken}`); } catch { /* 無い */ } return { ok: false, code: 'sandbox_outbox_open' }; }
      if (!inBox(['/usr/bin/touch', PROBE_USAGE])) return { ok: false, code: 'sandbox_usage_unwritable' };
      // Hermes の launcher の runtime command を sandbox の中で読み、in-process の起動を作る（形が違えば止める）
      const rc = asHermes(boxed(ctx, 30, [HERMES_BIN, '--print-runtime-command']), { timeout: 50_000 });
      const cmd = ok(rc) ? inProcessCommand(rc.stdout, ROOT) : null;
      if (!cmd) { keepLog(store, `${task.task_id}-launcher`, outputTail(rc)); return { ok: false, code: 'hermes_launcher_unexpected' }; }
      // Hermes 本体を sandbox の中で起動（無効な鍵＝Anthropic は 401 を返し課金されない）。起動・依存・state の場所が sandbox で壊れないことを確かめる
      log('課金なしの起動の確かめ（無効な鍵で Hermes を sandbox の中で起動。最大 60 秒）');
      const since = Date.now();
      const pr = asHermes(boxed(ctx, PROBE_SECONDS, ['/usr/sbin/taskpolicy', '-b', ...cmd, '-z', `Reply with the single word OK. (probe ${ctx.runToken})`, '-t', 'file', '--usage-file', PROBE_USAGE]), { timeout: (PROBE_SECONDS + 20) * 1000 });
      if (pr.signal || pr.error) asHermes(['/usr/bin/pkill', '-KILL', '-f', `probe ${ctx.runToken}`]);
      const pu = asHermes(['/bin/cat', PROBE_USAGE]);
      const usageText = ok(pu) ? String(pu.stdout).slice(0, 4000) : '';
      keepLog(store, `${task.task_id}-probe`, `${outputTail(pr)}\n--- usage ---\n${usageText}`);
      asHermes(['/bin/rm', '-f', PROBE_USAGE]);
      const code = classifyProbe(pr, usageText);
      if (code) { keepDenials(store, `${task.task_id}-probe-denials`, since); return { ok: false, code }; }
      // 起動の確かめの間に sandbox の外（同じ uid の常駐など）から置かれた物が無いか、実行の直前にもう一度（監査 L3）
      const again = prepareWorkHome(asHermes);
      if (again) return { ok: false, code: again };
      launch = cmd;
      return { ok: true };
    },
    async exec(task, ctx) {
      if (!launch) { keepLog(store, task.task_id, 'no launch command (preflight did not pass in this process)'); return { exit: 70, signal: null, timedOut: false }; }
      const r = asHermes(boxed(ctx, ctx.seconds, ['/usr/sbin/taskpolicy', '-b', ...launch, '-z', ctx.prompt, '-t', 'file', '--usage-file', USAGE], { probe: false, usage: USAGE }), { timeout: (ctx.seconds + 30) * 1000 });
      keepLog(store, task.task_id, outputTail(r));
      return { exit: r.status, signal: r.signal, timedOut: r.signal === 'SIGALRM' || r.status === 142 || r.signal === 'SIGKILL' || r.error?.code === 'ETIMEDOUT' };
    },
    readUsage() {
      const r = asHermes(['/bin/cat', USAGE]);
      asHermes(['/bin/rm', '-f', USAGE]);
      try { return JSON.parse(r.stdout); } catch { return null; }
    },
    listOutbox: () => readdirSync(outbox),
    readOutbox: readSafe,
    /** outbox の file を store の hermes-quarantine/ へ移す（普通の小さい file は写してから消す。symlink・FIFO・大きすぎる file は写さずに消す） */
    quarantineOutbox: (n, why) => {
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(n)) return;
      try {
        const b = readSafe(n);
        if (b) {
          const dir = store.path('hermes-quarantine');
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '')}-${why}-${n}`), b, { mode: 0o600 });
        }
        if (lstatSync(path.join(outbox, n), { throwIfNoEntry: false })) unlinkSync(path.join(outbox, n));
      } catch { /* 消せない時は次の実行の前の一覧に残る（取り込まない） */ }
    },
    killStragglers: (ctx) => { asHermes(['/usr/bin/pkill', '-KILL', '-f', `run ${ctx.runToken}`]); },
    alive: (job) => pgrepAlive(job),
  };
}

async function approveHermesTasks({ store, out, isTTY }) {
  const waiting = store.listTasks({ state: 'awaiting_approval' }).filter((t) => t.intent === 'hermes.task');
  if (!waiting.length) return 0;
  if (!isTTY) { out(`承認待ちの hermes.task が ${waiting.length} 件（端末で実行すると承認できる）`); return 0; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let n = 0;
  try {
    for (const t of waiting) {
      out(`\n── 承認待ちの Hermes の依頼：${t.task_id}（依頼元 ${t.source}・${t.business}）`);
      await taskHub(['show', t.task_id, '--store', store.dir], { out });
      const code = (await rl.question('この内容で Hermes に渡すなら確認コード（content_digest の先頭 12 桁）を入力。渡さないなら空のまま Enter：')).trim();
      if (!code) { out('飛ばしました（承認待ちのまま）'); continue; }
      if (await taskHub(['approve', t.task_id, '--confirm', code, '--store', store.dir], { out }) === 0) n += 1;
    }
  } finally { rl.close(); }
  return n;
}

/**
 * 承認から 24 時間を過ぎた依頼を、有料の実行の前に確かめ直す（端末だけ・全文・確認コード）。戻り値 { ok: 確かめた task id の Set, declined }。
 * declined＝確かめ直しが要るのに通らなかった（端末でない・空・違うコード・inbox の file が承認の内容と違う）＝呼び出し側は sudo を聞かずに止める。
 * ここで選ぶ 1 件は runWork が排他の中で選び直す。選び直した 1 件が違えば、その 1 件は確かめていない＝approval_stale で止まる（黙って実行しない）
 * Hermes が読むのは inbox の file なので、見せる前にその file が承認した params・digest と同じかを確かめ、状況（context）の作った時刻も見せる（2026-11-18 監査 F4）
 */
export async function reconfirmStale({ store, config, taskId, retry, out, isTTY, ask, now = Date.now() }) {
  const ok = new Set();
  const sel = selectNext(store, { inbox: config.hermes_inbox, outbox: config.hermes_outbox, taskId, retry });
  // 記録しなかった結果の file が残る --retry は、runWork が隔離してから選び直す＝ここでは id で読む（監査 F5）
  const t = sel.task ?? (sel.code === 'rejected_result_present' && taskId ? store.readTask(taskId) : null);
  if (!t || !approvalStale(t, now)) return { ok, declined: false };
  const stop = (msg) => { out(msg); return { ok, declined: true }; };
  if (!isTTY) return stop(`承認から 24 時間を過ぎた依頼：${t.task_id}（端末で実行すると、全文を見て確かめ直せる。今回は実行しない）`);
  let doc = null;
  try { doc = JSON.parse(readSmallFile(path.join(config.hermes_inbox, `${t.task_id}.json`), 64 * 1024)); } catch { doc = null; }
  const same = doc && doc.task_id === t.task_id && doc.title === t.params.title && doc.body === t.params.body && doc.kind === t.params.kind
    && typeof t.approval?.digest === 'string' && doc.approval_record?.digest === t.approval.digest && currentDigest(t) === t.approval.digest && t.content_digest === t.approval.digest;
  if (!same) return stop(`inbox の file が承認した内容と違う・読めない：${t.task_id}（実行しない。Claude Code に伝える）`);
  out(`\n── 承認から 24 時間を過ぎた Hermes の依頼：${t.task_id}（承認 ${t.approval.at ?? '-'}・依頼元 ${t.source}・${t.business}）\n今の内容（params の全文）：\n${fullParams(t)}${doc.context?.generated_at ? `\n添えた状況（context）の作った時刻：${doc.context.generated_at}（渡した時の状況。今の状況ではない）` : ''}\n確認コード：${confirmCodeOf(t)}`);
  const code = String(await ask('この内容のまま Hermes に実行させる（有料）なら確認コードを入力。やめるなら空のまま Enter：')).trim();
  if (code && code === confirmCodeOf(t)) { ok.add(t.task_id); return { ok, declined: false }; }
  return stop(code ? '確認コードが違う（実行しない）' : '実行しない（閉じるなら dismiss）');
}

async function deliver({ store, configPath, out }) {
  const policy = createPolicy({ catalog: loadCatalog(), config: loadLocalConfig(configPath) });
  for (let i = 0; i < 6; i += 1) {
    const r = await runOnce({ store, policy, handlers: HANDLERS, config: { ...policy.config, services: businessServices(policy.config) }, maxTasks: 10 });
    if (r.skipped !== 'locked') { for (const x of r.ran) out(`queue：${x.task_id} → ${x.state}${x.code ? ` (${x.code})` : ''}`); return; }
    out('Task Hub の定期の回の最中。20 秒待つ');
    await new Promise((res) => { setTimeout(res, 20_000); });
  }
}

export async function main(argv, { out = (s) => console.log(s), err = (s) => console.error(s), isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), sudoValidate = () => spawnSync('/usr/bin/sudo', ['-v'], { stdio: 'inherit' }).status === 0, ask = null, makeSys = null } = {}) {
  let a;
  try { a = parse(argv); } catch (e) { err(e.message); return 2; }
  const dir = path.resolve(a.store ?? DEFAULT_STORE);
  const store = openStore(dir);
  const configPath = path.join(dir, 'config.json');
  let config;
  try { config = loadLocalConfig(configPath); } catch (e) { err(`config を読めない（${e.message}）`); return 1; }
  if (a.command === 'status') {
    const jobs = new Map(store.listHermesJobs().map((j) => [j.task_id, j]));
    const tasks = store.listTasks().filter((t) => t.intent === 'hermes.task');
    if (!tasks.length) { out('hermes.task はありません'); return 0; }
    for (const t of tasks) {
      const j = jobs.get(t.task_id);
      const hs = t.state === 'succeeded' ? jobStatus(store, t.task_id) : '-';
      out(`${t.task_id} task=${t.state.padEnd(17)} hermes=${hs.padEnd(15)} 試行 ${j?.attempts ?? 0}${j?.code ? ` ${j.code}` : ''}${j?.usage?.total_tokens ? ` token ${j.usage.total_tokens}` : ''} ${j?.updated_at ?? t.updated_at}`);
    }
    return 0;
  }
  if (a.command === 'dismiss') {
    // 実行せずに閉じる（Human だけ：端末と確認コード。task-hub の dismiss と同じ関所）
    if (!isTTY) { err('端末で実行してください（自動化からは閉じられない）'); return 1; }
    const t = store.readTask(a.positional[0]);
    if (!t || t.intent !== 'hermes.task' || t.state !== 'succeeded') { err('閉じられる Hermes の依頼ではない（承認して渡した hermes.task だけ）'); return 1; }
    if (t.content_digest.slice(0, 12) !== a.confirm) { err('確認コードが違う（task-hub show で確かめる）'); return 1; }
    const j = dismissJob(store, t, { at: Date.now() });
    out(j ? `閉じました：${t.task_id}（依頼元へ dismissed を返す）` : `閉じられない（今の状態：${jobStatus(store, t.task_id)}）`);
    return j ? 0 : 1;
  }
  if (process.getuid?.() === 0) { err('sudo を付けずに実行する（中で hermes の分だけ sudo する）'); return 2; }
  if (a.approve) { const n = await approveHermesTasks({ store, out, isTTY }); if (n) out(`承認 ${n} 件`); }
  await deliver({ store, configPath, out });
  // sudo の password は排他を取る前に（入力を待つ間に排他を長く持たない・2026-11-13 監査 F6）
  let reconfirmed = new Set();
  if (a.paidOk && typeof config.hermes_inbox === 'string' && typeof config.hermes_outbox === 'string') {
    const rc = await reconfirmStale({ store, config, taskId: a.task, retry: a.retry, out, isTTY, ask: ask ?? (async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } }) });
    if (rc.declined) { out('止めました：approval_stale（sudo は聞かない・記録は waiting のまま）'); return 1; }
    reconfirmed = rc.ok;
  }
  if (a.paidOk || a.checkOnly) { out('sudo の password を聞かれたら入力（hermes の権限で動かすため）'); if (!sudoValidate()) { out('止めました：sudo_failed'); return 1; } }
  const r = await runWork({ store, config, sys: (makeSys ?? macSys)({ store, log: out, outbox: config.hermes_outbox }), taskId: a.task, retry: a.retry, paidOk: a.paidOk, checkOnly: a.checkOnly, reconfirmed, log: out });
  const say = {
    not_connected: 'Hermes の inbox・outbox が config に無い（休眠）', busy: '別の Hermes の実行の最中（終わってから）', nothing: '渡す依頼がありません（承認済みで Hermes へ渡した依頼が無い）',
    paid_not_ok: `渡す依頼：${r.task_id}（中身は node scripts/task-hub.mjs show ${r.task_id}）。有料の実行の前で止めました。渡すなら --paid-ok を付けて実行${r.approval_stale ? '（承認から 24 時間を過ぎているので、実行の前にもう一度全文を見て確認コードを打つ）' : ''}`,
    approval_stale: `承認から 24 時間を過ぎた依頼：${r.task_id}（端末で --paid-ok を付けて実行し、全文を見て確認コードを打てば実行。やめるなら dismiss ${r.task_id} --confirm <12 桁>）`,
    check_ok: `課金なしの確かめは全部通った：${r.task_id}（有料の実行はしていない・記録は waiting のまま。実行するなら --paid-ok${r.approval_stale ? '。承認から 24 時間を過ぎているので、その時にもう一度全文を見て確認コードを打つ' : ''}）`,
    done: `完了：${r.task_id}（結果は記録と依頼元へ）`, failed: `Hermes が「できない」と返した：${r.task_id}（理由は記録の notes）`,
    timeout: `時間切れ：${r.task_id}（やり直すなら --task ${r.task_id} --retry --paid-ok）`, no_result: `結果の file が無い：${r.task_id}（Claude Code に伝える。やり直すなら --task ${r.task_id} --retry --paid-ok）`,
    result_rejected: `結果を記録しなかった（${r.reason}）：${r.task_id}（Claude Code に伝える。やり直すなら --task ${r.task_id} --retry --paid-ok）`,
    result_waiting: `結果の file がもう在る：${r.task_id}（次の 5 分の回が取り込む。もう一度は実行しない）`, already_final: `終わった依頼：${r.task_id}（やり直しは新しい依頼にする）`,
    not_retryable: `やり直しには --retry が要る：${a.task}`, retry_limit: `やり直しの上限（3 回）：${a.task}（閉じるなら dismiss）`,
  }[r.code] ?? `止めました：${r.code}${r.task_id ? `（${r.task_id}）` : ''}（課金の前の確かめで止まった時は Claude Code に伝える。記録は store の hermes-work-logs/）`;
  out(say);
  if (['done', 'failed', 'timeout', 'no_result', 'result_rejected'].includes(r.code)) {
    const p = spawnSync(process.execPath, [path.join(HERE, 'task-intake-sync.mjs'), 'push', '--outbox', store.path('outbox'), '--sent', store.path('outbox-sent')], { encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    out(`依頼元への返却：${p.status === 0 ? 'ok' : `次の 5 分の回で（exit ${p.status ?? '-'}）`}`);
  }
  return ['done', 'failed', 'nothing', 'paid_not_ok', 'check_ok', 'not_connected', 'result_waiting'].includes(r.code) ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
