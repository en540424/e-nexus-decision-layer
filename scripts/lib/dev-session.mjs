/**
 * Cursor・Terminal に依存しない作業の session（2026-11-23・MA-24・docs/dev-session.md）。
 *
 * 2 つの道具を使い分ける（自前で同じ物を作らない）：
 *   - Claude Code の作業 → 公式の `claude --bg`（supervisor が launchd の子になって動く＝Cursor・Terminal を閉じても続く）。ここは一覧に「読むだけ」で出す
 *   - Claude 以外の長い処理（試験・script）→ macOS 同梱の /usr/bin/screen を薄く包む（このファイル）。足すのは：二重起動の防止・終了コード・履歴・消えた session の検出
 *
 * 常駐の process は足さない（screen の server は 1 つの job の間だけ・終われば消える）。LaunchAgent も作らない。
 * logout・再起動では screen も `claude --bg` も止まる（macOS の仕様）。再起動の後は `recover` が「消えた」job と、やり直しの command を出すだけ（自動で再実行しない）。
 *
 * 保存先（既定）：~/e-nexus-runtime/mac-runtime-state/dev-sessions/（0700）
 *   sessions/<name>/meta.json     起動の記録（名前・run・cwd・command・始めた時刻）
 *   sessions/<name>/run.json      runner が書く（pid・始まった時刻）
 *   sessions/<name>/exit.json     runner が書く（終了コード・終わった時刻）。無いのに screen が居ない＝消えた（kill・logout・再起動）
 *   sessions/<name>/screen.log    画面の記録（screen -L）
 *   archive/<name>-<run>/          同じ名前で次に起動した時に前の回を移す
 *   history.jsonl                 start・exit・stop・archive の 1 行ずつ
 *   .screen/                      screen の socket（SCREENDIR を固定＝Terminal・SSH のどちらから attach しても同じ所を見る）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCREEN = '/usr/bin/screen';
export const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-session-runner.sh');
export const DEFAULT_ROOT = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'dev-sessions');
export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const WATCH_ID = 'dev_sessions';
/** 子に渡さない環境変数（入れ子の Claude Code・Cursor の terminal だと誤って読ませない） */
export const SCRUB_ENV = /^(?:CLAUDECODE|CLAUDE_CODE_[A-Z0-9_]*|VSCODE_[A-Z0-9_]*|CURSOR_[A-Z0-9_]*|TERM_PROGRAM(?:_VERSION)?|STY|WINDOW)$/;

export function rootOf(env = process.env) { return env.EDL_DEV_SESSION_DIR ? path.resolve(env.EDL_DEV_SESSION_DIR) : DEFAULT_ROOT; }
/** screen の session 名。保存先ごとに別の名前（試験と本番が同じ名前でぶつからない） */
export function screenName(root, name) { return `edl${createHash('sha256').update(root).digest('hex').slice(0, 6)}-${name}`; }

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`not a directory: ${dir}`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) { const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(tmp, file); }
const history = (root, row) => appendFileSync(path.join(root, 'history.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
const runId = (now) => `${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(2).toString('hex')}`;

export function screenEnv(root, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SCRUB_ENV.test(k)) out[k] = v;
  out.SCREENDIR = path.join(root, '.screen');
  return out;
}

/** 今の screen の session 名の集まり（この保存先の物だけ） */
export function liveScreens(root, { run = spawnSync } = {}) {
  const dir = path.join(root, '.screen');
  if (!existsSync(dir)) return new Set();
  const r = run(SCREEN, ['-ls'], { env: screenEnv(root), encoding: 'utf8', timeout: 10_000 });
  if (r.error) throw r.error;
  const names = new Set();
  for (const m of String(r.stdout ?? '').matchAll(/^\s+\d+\.(\S+)\s/gm)) names.add(m[1]);
  return names;
}

/** 1 つの session の状態：running／exited（code）／vanished（exit が無いのに screen が居ない）／starting */
export function sessionState(root, name, live) {
  const dir = path.join(root, 'sessions', name);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) return null;
  const exit = readJson(path.join(dir, 'exit.json'));
  const run = readJson(path.join(dir, 'run.json'));
  const alive = live.has(screenName(root, name));
  let state;
  if (exit) state = alive ? 'finishing' : 'exited';
  else if (alive) state = 'running';
  else if (meta.stopped_at) state = 'stopped'; // stop で止めた（runner も SIGHUP で終わるので exit.json は無い）
  else state = run ? 'vanished' : (Date.now() - Date.parse(meta.started_at) < 30_000 ? 'starting' : 'vanished');
  let logBytes = null;
  try { logBytes = statSync(path.join(dir, 'screen.log')).size; } catch { /* まだ無い */ }
  return { name, run: meta.run, state, code: exit?.code ?? null, cwd: meta.cwd, command: meta.command, started_at: meta.started_at, ended_at: exit?.at ?? null, stopped: meta.stopped_at ?? null, log_bytes: logBytes };
}

export function listSessions(root, opts = {}) {
  const dir = path.join(root, 'sessions');
  if (!existsSync(dir)) return [];
  const live = liveScreens(root, opts);
  return readdirSync(dir).filter((n) => NAME.test(n)).sort().map((n) => sessionState(root, n, live)).filter(Boolean);
}

function screenrc(root, dir) {
  const file = path.join(dir, 'screenrc');
  // ~/.screenrc は読まない（-c で置き換え）。画面の記録は 1 秒ごとに書き出す
  writeFileSync(file, [`logfile ${path.join(dir, 'screen.log')}`, 'logfile flush 1', 'deflog on', 'defutf8 on', 'defscrollback 5000', 'term screen-256color', 'startup_message off', ''].join('\n'), { mode: 0o600 });
  return file;
}

/**
 * job を screen の中で始める。同じ名前が動いている間は始めない（mkdir の lock＋screen の確かめ）。
 * 前の回の記録は archive/ へ移す（消さない）。
 */
export function startSession(root, name, command, { cwd = process.cwd(), env = process.env, run = spawnSync, now = Date.now() } = {}) {
  if (!NAME.test(name)) throw new Error('name must match [a-z0-9][a-z0-9-]{0,31}');
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== 'string')) throw new Error('command is required after --');
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  ensureDir(root); ensureDir(path.join(root, 'sessions')); ensureDir(path.join(root, '.screen'));
  const lock = path.join(root, 'sessions', `.${name}.lock`);
  try { mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 1 分より古い lock は前の start の途中の失敗の跡
    if (now - statSync(lock).mtimeMs < 60_000) return { ok: false, code: 'already_starting' };
    rmSync(lock, { recursive: true, force: true }); mkdirSync(lock);
  }
  try {
    const live = liveScreens(root, { run });
    const cur = sessionState(root, name, live);
    if (live.has(screenName(root, name)) || cur?.state === 'running' || cur?.state === 'starting') return { ok: false, code: 'already_running', session: cur };
    const dir = path.join(root, 'sessions', name);
    if (cur) {
      ensureDir(path.join(root, 'archive'));
      const to = path.join(root, 'archive', `${name}-${cur.run}`);
      renameSync(dir, to);
      history(root, { at: new Date(now).toISOString(), event: 'archive', name, run: cur.run, state: cur.state });
    } else if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); // meta の無い壊れた跡
    ensureDir(dir);
    const id = runId(now);
    const meta = { name, run: id, cwd: path.resolve(cwd), command, started_at: new Date(now).toISOString(), screen: screenName(root, name) };
    writeJson(path.join(dir, 'meta.json'), meta);
    const rc = screenrc(root, dir);
    const r = run(SCREEN, ['-U', '-c', rc, '-L', '-dmS', meta.screen, '/bin/sh', RUNNER, dir, path.join(root, 'history.jsonl'), name, id, ...command], { cwd: meta.cwd, env: screenEnv(root, env), encoding: 'utf8', timeout: 15_000 });
    if (r.error || r.status !== 0) {
      history(root, { at: new Date(now).toISOString(), event: 'start_failed', name, run: id });
      return { ok: false, code: 'screen_failed', detail: String(r.error?.message ?? r.stderr ?? '').slice(0, 200) };
    }
    history(root, { at: new Date(now).toISOString(), event: 'start', name, run: id, cwd: meta.cwd, command: command.slice(0, 8).map((c) => c.slice(0, 200)) });
    return { ok: true, code: 'started', session: meta };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** 止める：screen の quit（中の process に SIGHUP）。止めたことを記録する。この保存先の session だけ */
export function stopSession(root, name, { run = spawnSync, now = Date.now() } = {}) {
  if (!NAME.test(name)) throw new Error('bad name');
  const live = liveScreens(root, { run });
  const cur = sessionState(root, name, live);
  if (!cur) return { ok: false, code: 'not_found' };
  if (!live.has(screenName(root, name))) return { ok: false, code: 'not_running', session: cur };
  const metaFile = path.join(root, 'sessions', name, 'meta.json');
  writeJson(metaFile, { ...readJson(metaFile), stopped_at: new Date(now).toISOString() });
  const r = run(SCREEN, ['-S', screenName(root, name), '-X', 'quit'], { env: screenEnv(root), encoding: 'utf8', timeout: 10_000 });
  history(root, { at: new Date(now).toISOString(), event: 'stop', name, run: cur.run, ok: r.status === 0 });
  return { ok: r.status === 0, code: r.status === 0 ? 'stopped' : 'stop_failed' };
}

/** 終わった・消えた session の記録を archive/ へ移す（見張りの「消えた」を確認済みにする） */
export function forgetSession(root, name, { run = spawnSync, now = Date.now() } = {}) {
  const cur = sessionState(root, name, liveScreens(root, { run }));
  if (!cur) return { ok: false, code: 'not_found' };
  if (['running', 'starting', 'finishing'].includes(cur.state)) return { ok: false, code: 'still_running' };
  ensureDir(path.join(root, 'archive'));
  renameSync(path.join(root, 'sessions', name), path.join(root, 'archive', `${name}-${cur.run}`));
  history(root, { at: new Date(now).toISOString(), event: 'archive', name, run: cur.run, state: cur.state });
  return { ok: true, code: 'archived' };
}

/** 画面の記録の最後（制御の文字を除く） */
export function readLog(root, name, lines = 40) {
  const file = path.join(root, 'sessions', name, 'screen.log');
  if (!NAME.test(name) || !existsSync(file)) return null;
  const size = statSync(file).size;
  const len = Math.min(size, 256 * 1024); // 最後の 256 KiB だけ読む（Claude の画面の記録は大きくなる）
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const text = stripAnsi(buf.toString('utf8'));
  return text.split('\n').slice(-lines).join('\n');
}
export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b[=>78DEHMc]/g, '')
    .replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function readHistory(root, limit = 20) {
  const file = path.join(root, 'history.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { bad: true }; } });
}

/** 再起動・logout の後：消えた job と、やり直しの command（Human か Claude Code が確かめてから自分で打つ） */
export function recoverPlan(sessions) {
  return sessions.filter((s) => s.state === 'vanished').map((s) => ({ name: s.name, cwd: s.cwd, started_at: s.started_at, restart: ['node', 'scripts/dev-session.mjs', 'start', s.name, '--cwd', s.cwd, '--', ...s.command] }));
}

/**
 * 公式の `claude --bg` の session（読むだけ）。`claude agents --json` は対話の session も返すので、
 * cwd が allowRoots の下の物だけを出す（同じ OS user の Trading Lab の session を一覧に出さない・触らない）。
 */
export function claudeSessions({ allowRoots = [path.join(homedir(), 'e-nexus-runtime')], exec = execFileSync, claudeBin = 'claude' } = {}) {
  let rows;
  try {
    const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(?:CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/.test(k)) delete env[k];
    rows = JSON.parse(exec(claudeBin, ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 20_000, env, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return { ok: false, sessions: [] }; }
  if (!Array.isArray(rows)) return { ok: false, sessions: [] };
  const inside = (cwd) => typeof cwd === 'string' && allowRoots.some((r) => cwd === r || cwd.startsWith(`${r}${path.sep}`));
  return { ok: true, sessions: rows.filter((r) => r?.kind === 'background' && inside(r.cwd)).map((r) => ({ id: r.id, name: r.name, cwd: r.cwd, status: r.status, state: r.state, started_at: Number.isFinite(r.startedAt) ? new Date(r.startedAt).toISOString() : null })) };
}

/** host-health の項目：消えた job があれば warn（中身は件数だけ）。保存先が無ければ項目なし */
export function devSessionsItem(root, opts = {}) {
  if (!existsSync(path.join(root, 'sessions'))) return null;
  try {
    const vanished = listSessions(root, opts).filter((s) => s.state === 'vanished').length;
    return { id: WATCH_ID, level: vanished > 0 ? 'warn' : 'ok', value: vanished > 0 ? 'vanished' : 'ok', kind: 'state' };
  } catch { return { id: WATCH_ID, level: 'warn', value: 'check_failed', kind: 'state' }; }
}
