/**
 * Nod（n8n Labs の研究プレビューの AI agent・公式 Mac デスクトップ版）の試験導入の道具（2026-11-18・MA-24）。docs/nod-trial.md。
 *
 * Nod は「必要な時だけ起動 → 仕事 → 完全終了」で使う（24 時間常駐させない）。ここが持つのは、Nod の外から安全にできることだけ：
 *   - 観測：Nod の app と Nod の runtime（Lima の VM）の process が動いているか・どれだけ動いているか（pgrep の固定の path だけ＝他の process の一覧を取らない）
 *   - 起動の前の関所：メモリ・swap・圧迫・ディスクに余裕が無ければ起動しない（同じ Mac で別の本番の VM が動いている）
 *   - 起動：公式の app を `open` で（解析の送信を切る環境変数つき）。初回の setup は Human が画面で行う（下の §事実）
 *   - 終了：公式の Quit（AppleScript の quit＝Nod の before-quit が VM を `limactl stop` で止める）→ app と VM が消えたかを待って確かめる。**強制の停止はしない**
 *
 * Nod の内部（local の engine の API・内部の DB・設定 file・Keychain の「nod Safe Storage」）には触れない。公式に外から仕事を渡す道具（CLI・公開の API）は
 * v0.8.4 に無い＝ここは仕事を渡さない（docs/nod-trial.md §5）。
 *
 * 事実（v0.8.4・tag nod-v0.8.4・source a461094・2026-11-18 に読んだ）：
 *   - bundle id dev.nod.desktop・Developer ID の Team GRHFXT3RL9（n8n GmbH）・公証済み。app は /Applications/Nod.app
 *   - データ：~/Library/Application Support/nod（profile・runtime の pack）・VM：~/.nod-desktop/<profile>（Lima・vz・Ubuntu）
 *   - VM の大きさ：memory = max(3, min(6, floor(物理メモリ GiB / 2))) GiB・cpus = max(2, min(4, CPU 数))・disk 24 GiB（使った分だけ増える）＝desktop/runtime/index.mjs
 *   - 初回の setup の画面を開くと、Human の選択の前に runtime（約 1.7 GB）の取得と VM の起動が始まる（desktop/ui/setup.tsx の warmup）。「使用状況の共有」の既定は ON
 *   - 解析：環境変数 NOD_ANALYTICS_ENABLED=false で切れる（desktop/main/analytics.mjs）。NOD_FEEDBACK_URL を空にすると不具合の報告の送信を切る
 *   - Quit Nod は VM を止める（limactl stop → Stopped を待つ）。止められない時は「Try again／Quit anyway」の画面＝Quit anyway は VM を残しうる
 *   - setup の完了で「ログイン時に開く」が ON になる（Settings → General で OFF）
 */
import { execFile } from 'node:child_process';
import { homedir, totalmem, cpus as hostCpus } from 'node:os';
import path from 'node:path';

export const NOD_APP = '/Applications/Nod.app';
export const NOD_BUNDLE_ID = 'dev.nod.desktop';
export const NOD_TEAM_ID = 'GRHFXT3RL9';
export const NOD_SHIPIT_LABEL = 'dev.nod.desktop.ShipIt';
/** 解析と不具合の報告の送信を切る（起動の時に渡す。Nod が自分で再起動した時は効かない＝画面の設定でも OFF にする） */
export const LAUNCH_ENV = Object.freeze(['NOD_ANALYTICS_ENABLED=false', 'NOD_FEEDBACK_URL=', 'NOD_ONBOARDING_EMAIL_URL=']);

export const dataPaths = (home = homedir()) => Object.freeze({
  support: path.join(home, 'Library', 'Application Support', 'nod'),
  vm: path.join(home, '.nod-desktop'),
});

/**
 * Nod の app の本体の process（bundle の実行 file だけ）。helper・更新の ShipIt（bundle の中の Squirrel.framework）は数えない：
 * ShipIt が残っただけで「動いている」と読むと、止まっている app へ quit を送り（起動しうる）、見張りが VM の残りを見落とす（2026-11-18 監査 M1）
 */
export const APP_PATTERN = `^${NOD_APP.replace(/\./g, '\\.')}/Contents/MacOS/nod( |$)`;
/** 終了の時だけ送る AppleScript。`is running` は app を起動しない＝確かめと送る間に app が終わっても起動しない */
export const QUIT_SCRIPT = `if application id "${NOD_BUNDLE_ID}" is running then tell application id "${NOD_BUNDLE_ID}" to quit`;
/**
 * Nod の runtime（runtime の pack の limactl・hostagent・停止用の limactl の写しなど＝Nod のデータの場所の中の実行 file）。
 * 行の頭に固定する（その path を引数に書いただけの shell・du を数えない）。VM そのもの（Virtualization.framework の XPC の process）は名前で Nod と分けられないので数えない＝hostagent が残っていれば VM が残っている
 */
export const runtimePattern = (home = homedir()) => `^${escapeRe(dataPaths(home).support)}/|^${escapeRe(dataPaths(home).vm)}/`;
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Nod の VM の大きさ（v0.8.4 の式） */
export function vmSize({ memBytes = totalmem(), ncpu = hostCpus().length } = {}) {
  return { memory_gib: Math.max(3, Math.min(6, Math.floor(memBytes / 1024 ** 3 / 2))), cpus: Math.max(2, Math.min(4, ncpu)), disk_gib: 24 };
}

/** 起動の前の関所の基準。VM の分＋余裕（同じ Mac の別の本番の VM と常駐の分を残す） */
export const GATE = Object.freeze({
  margin_gib: 4, // VM の分に足す余裕
  swap_max_gib: 1,
  disk_min_gib: 40, // runtime の pack（約 1.7 GB）＋VM の disk（最大 24 GiB）＋余裕
  pressure_ok: 1, // kern.memorystatus_vm_pressure_level：1＝normal・2＝warn・4＝critical
});
/** 長く動いていると知らせる（24 時間常駐させない方針。仕事の長さは Human が決める＝見張りは 4 時間で 1 回知らせるだけ） */
export const RUNNING_LONG_SECONDS = 4 * 3600;
/** host-health の 1 回の中でこの項目に使ってよい時間（全体の締め切りの中で、他の項目を止めない） */
export const OBSERVE_BUDGET_MS = 15_000;
export const NOD_WATCH_ID = 'nod_desktop';

// ─── 出力の読み取り ───

/** vm_stat の出力 → 使える見込みのメモリ（free＋inactive＋speculative＋purgeable の page）。読めなければ null */
export function parseVmStatAvailable(stdout) {
  const s = String(stdout ?? '');
  const pageSize = Number(/page size of (\d+) bytes/.exec(s)?.[1]);
  if (!Number.isInteger(pageSize) || pageSize <= 0) return null;
  const pages = (name) => { const m = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(s); return m ? Number(m[1]) : null; };
  const parts = ['free', 'inactive', 'speculative', 'purgeable'].map(pages);
  if (parts.some((p) => p === null)) return null;
  return parts.reduce((a, b) => a + b, 0) * pageSize;
}
/** sysctl vm.swapusage → 使用中の byte */
export function parseSwapUsed(stdout) {
  const m = /used\s*=\s*([\d.]+)([MG])/.exec(String(stdout ?? ''));
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'G' ? 1024 ** 3 : 1024 ** 2);
}
/** df -k の最後の行の Avail（KiB）→ byte */
export function parseDfAvail(stdout) {
  const cols = (String(stdout ?? '').trim().split('\n').at(-1) ?? '').trim().split(/\s+/);
  const kib = Number(cols[3]);
  return Number.isFinite(kib) ? kib * 1024 : null;
}
/** ps の etime（[[dd-]hh:]mm:ss）→ 秒 */
export function parseEtime(s) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
}
/** pgrep の出力 → pid の列。pgrep は「無い」を exit 1 で返す（失敗ではない） */
export function pidsOf(r) {
  if (!r || r.timedOut) return null;
  if (r.code === 1 && !String(r.stdout ?? '').trim()) return [];
  if (r.code !== 0) return null;
  return String(r.stdout).trim().split('\n').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
}
/** ps -o etime=,rss= -p … の出力 → { oldest_seconds, rss_bytes, count } */
export function parsePsRows(stdout) {
  let oldest = 0;
  let rss = 0;
  let count = 0;
  for (const line of String(stdout ?? '').trim().split('\n')) {
    const [etime, kb] = line.trim().split(/\s+/);
    const sec = parseEtime(etime);
    if (sec === null || !Number.isFinite(Number(kb))) continue;
    oldest = Math.max(oldest, sec);
    rss += Number(kb) * 1024;
    count += 1;
  }
  return { oldest_seconds: oldest, rss_bytes: rss, count };
}

// ─── 観測 ───

/**
 * Nod の process の観測（読むだけ・強制の停止はしない）。run は (bin, args) → { code, stdout, timedOut }。
 * 戻り値：{ installed, app: { pids, oldest_seconds, rss_bytes } | null, runtime: {…} | null, ok }。pgrep が読めなければ ok:false
 */
export async function observeNod({ run, home = homedir(), installed }) {
  if (!installed) return { installed: false, ok: true, app: null, runtime: null };
  const part = async (pattern) => {
    const pids = pidsOf(await run('/usr/bin/pgrep', ['-f', pattern]));
    if (pids === null) return undefined;
    if (pids.length === 0) return null;
    const ps = await run('/bin/ps', ['-o', 'etime=,rss=', '-p', pids.join(',')]);
    if (ps.timedOut) return undefined; // 読めない＝check_failed（長さの見張りを黙って外さない・監査 L4）
    const rows = parsePsRows(ps.stdout);
    if (rows.count === 0) return ps.code === 1 || ps.code === 0 ? null : undefined; // pgrep と ps の間に終わった＝無い
    return { pids, ...rows };
  };
  const app = await part(APP_PATTERN);
  const runtime = await part(runtimePattern(home));
  if (app === undefined || runtime === undefined) return { installed: true, ok: false, app: app ?? null, runtime: runtime ?? null };
  return { installed: true, ok: true, app, runtime };
}

/** host-health の項目（値はコードだけ）。入っていなければ null（項目なし＝休眠） */
export function nodDesktopItem(o) {
  if (!o || !o.installed) return null;
  const item = (level, value) => ({ id: NOD_WATCH_ID, level, value, kind: 'state' });
  if (!o.ok) return item('warn', 'check_failed');
  if (!o.app && o.runtime) return item('warn', 'vm_left'); // app は終わったのに VM（Lima）が残った＝Quit anyway か終了の失敗
  if (o.app && (o.app.oldest_seconds ?? 0) >= RUNNING_LONG_SECONDS) return item('warn', 'running_long');
  if (o.app) return item('ok', 'running');
  return item('ok', 'not_running');
}

// ─── 起動の前の関所 ───

/**
 * 起動してよいか（Nod の VM の分と余裕が在るか）。戻り値 { ok, codes: [...], facts }。読めない値は止める側（unknown_*）
 */
export async function gateCheck({ run, memBytes = totalmem(), ncpu = hostCpus().length }) {
  const ok = (r) => (!r.timedOut && r.code === 0 ? r.stdout : null);
  const size = vmSize({ memBytes, ncpu });
  const available = parseVmStatAvailable(ok(await run('/usr/bin/vm_stat', [])));
  const swap = parseSwapUsed(ok(await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])));
  const pressureOut = ok(await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
  const pressure = pressureOut === null ? null : Number(pressureOut.trim());
  const disk = parseDfAvail(ok(await run('/bin/df', ['-k', '/System/Volumes/Data'])));
  const GiB = 1024 ** 3;
  const codes = [];
  const need = (size.memory_gib + GATE.margin_gib) * GiB;
  if (available === null) codes.push('unknown_memory'); else if (available < need) codes.push('memory_low');
  if (swap === null) codes.push('unknown_swap'); else if (swap > GATE.swap_max_gib * GiB) codes.push('swap_in_use');
  if (!Number.isInteger(pressure)) codes.push('unknown_pressure'); else if (pressure > GATE.pressure_ok) codes.push('memory_pressure');
  if (disk === null) codes.push('unknown_disk'); else if (disk < GATE.disk_min_gib * GiB) codes.push('disk_low');
  const g = (b) => (b === null ? null : Math.round((b / GiB) * 10) / 10);
  return { ok: codes.length === 0, codes, facts: { vm: size, available_gib: g(available), need_gib: g(need), swap_used_gib: g(swap), pressure_level: pressure, disk_free_gib: g(disk) } };
}

// ─── 起動・終了 ───

/** 起動（公式の app を open で）。動いていれば何もしない。関所は呼ぶ側が先に通す */
export async function startNod({ run, observe }) {
  const before = await observe();
  if (!before.installed) return { code: 'not_installed' };
  if (!before.ok) return { code: 'check_failed' };
  if (before.app) return { code: 'already_running' };
  if (before.runtime) return { code: 'vm_left' }; // 前の VM が残っている＝先に原因を見る（重ねて起動しない）
  const args = ['-g', '-a', NOD_APP, ...LAUNCH_ENV.flatMap((e) => ['--env', e])];
  const r = await run('/usr/bin/open', args);
  return { code: r.code === 0 && !r.timedOut ? 'started' : 'open_failed' };
}

/**
 * 完全終了（公式の Quit）。動いていない時は quit を送らない（AppleScript は止まっている app を起動しうる）。
 * waitMs の間、app と VM が消えるのを待つ。消えなければ止めた所までのコードを返す（強制の停止はしない）
 */
export async function stopNod({ run, observe, waitMs = 150_000, pollMs = 3000, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), now = () => Date.now() }) {
  const first = await observe();
  if (!first.installed) return { code: 'not_installed' };
  if (!first.ok) return { code: 'check_failed' };
  if (!first.app && !first.runtime) return { code: 'already_stopped' };
  if (!first.app && first.runtime) return { code: 'vm_left' };
  const q = await run('/usr/bin/osascript', ['-e', QUIT_SCRIPT]);
  // 返事が失敗・時間切れ（「自動化」の許可の確認が出た等）でも、Nod は終わりかけていることがある＝待つ窓の間は見続ける（監査 L1）
  const replied = !q.timedOut && q.code === 0;
  const until = now() + waitMs;
  let last = first;
  while (now() < until) {
    await sleep(pollMs);
    last = await observe();
    if (last.ok && !last.app && !last.runtime) return { code: 'stopped' };
  }
  if (!last.ok) return { code: 'check_failed' };
  if (last.app) return { code: replied ? 'app_still_running' : 'quit_unconfirmed' }; // 「Try again／Quit anyway」の画面か、作業中の確認
  return { code: 'vm_left' };
}

// ─── 実行 ───

export const CLI_BINS = Object.freeze(['/usr/bin/pgrep', '/bin/ps', '/usr/bin/vm_stat', '/usr/sbin/sysctl', '/bin/df', '/usr/bin/open', '/usr/bin/osascript', '/usr/bin/codesign', '/usr/bin/plutil', '/usr/bin/du', '/bin/launchctl']);
/** 許可した command だけを shell なしで（stderr も返す：codesign -dv は stderr に出す） */
export function makeNodRunner({ execFileImpl = execFile, timeoutMs = 30_000, allowed = CLI_BINS } = {}) {
  return (bin, args) => {
    if (!allowed.includes(bin)) return Promise.reject(new Error(`command not allowed: ${bin}`));
    return new Promise((resolve) => {
      execFileImpl(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 512 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', HOME: homedir() } }, (err, stdout, stderr) => {
        if (!err) { resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: false }); return; }
        resolve({ code: typeof err.code === 'number' ? err.code : -1, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: Boolean(err.killed) });
      });
    });
  };
}
