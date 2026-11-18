#!/usr/bin/env node
/**
 * Nod の公式デスクトップ版の起動・完全終了・計測（2026-11-18・試験導入・docs/nod-trial.md）。Nod の内部（engine の API・DB・設定 file・Keychain）には触れない。
 *
 *   node scripts/nod-desktop.mjs status            入っているか・版・署名の Team・動いているか（app／VM）・更新の job（ShipIt）の有無
 *   node scripts/nod-desktop.mjs gate              起動してよいか（VM の分＋余裕のメモリ・swap・圧迫・ディスク）。起動はしない
 *   node scripts/nod-desktop.mjs measure [--label <名>]   今の計測を nod-lab/measurements/ に残す（メモリ・Nod の process・Nod のデータの大きさ）
 *   node scripts/nod-desktop.mjs stop [--wait <秒>]       公式の Quit で完全終了し、app と VM が消えたかを確かめる（強制の停止はしない）
 *   node scripts/nod-desktop.mjs start             関所を通れば Nod を起動する（**Terminal の Human だけ**：初回は 1.7 GB の取得と VM の起動が始まる）
 *   node scripts/nod-desktop.mjs session           Human の試験の 1 回：計測 → 起動 → Human が画面で作業 → Enter → 計測 → 完全終了 → 1 分待って計測 → 差を表示
 *
 * exit：0＝ok／1＝止めた（関所・終了しきれない・確かめられない）／2＝引数
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { NOD_APP, NOD_SHIPIT_LABEL, NOD_TEAM_ID, dataPaths, gateCheck, makeNodRunner, observeNod, startNod, stopNod } from './lib/nod/desktop.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MEASURE_DIR = path.join(REPO, '..', 'nod-lab', 'measurements');
const COMMANDS = ['status', 'gate', 'measure', 'stop', 'start', 'session'];

export function parse(argv) {
  const a = { command: argv[0], wait: 150, label: 'snapshot' };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--wait' && /^\d{1,4}$/.test(v ?? '')) { a.wait = Number(v); i += 1; } else if (k === '--label' && /^[a-z0-9-]{1,32}$/.test(v ?? '')) { a.label = v; i += 1; } else throw new Error(`unknown argument: ${k}`);
  }
  if (!COMMANDS.includes(a.command)) throw new Error(`command must be ${COMMANDS.join('|')}`);
  if (a.wait < 10 || a.wait > 900) throw new Error('--wait must be 10..900');
  return a;
}

const GiB = 1024 ** 3;
const g = (b) => (b == null ? null : Math.round((b / GiB) * 100) / 100);

async function installInfo(run) {
  if (!existsSync(NOD_APP)) return { installed: false };
  const v = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(NOD_APP, 'Contents', 'Info.plist')]);
  const cs = await run('/usr/bin/codesign', ['-dv', '--verbose=2', NOD_APP]);
  const team = /TeamIdentifier=([A-Z0-9]+)/.exec(cs.stderr ?? '')?.[1] ?? null;
  const shipit = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${NOD_SHIPIT_LABEL}`]);
  return { installed: true, version: v.code === 0 ? v.stdout.trim() : null, team_id: team, team_ok: team === NOD_TEAM_ID, shipit_job: shipit.code === 0 };
}

async function duGib(run, dir) {
  if (!existsSync(dir)) return null;
  const r = await run('/usr/bin/du', ['-sk', dir]);
  const kib = Number(r.stdout.trim().split(/\s+/)[0]);
  return r.code === 0 && Number.isFinite(kib) ? g(kib * 1024) : null;
}

const summarize = (o) => ({ ok: o.ok, app: o.app ? { processes: o.app.count, rss_gib: g(o.app.rss_bytes), oldest_seconds: o.app.oldest_seconds } : null, runtime: o.runtime ? { processes: o.runtime.count, rss_gib: g(o.runtime.rss_bytes) } : null });

export async function snapshot(run, label) {
  const paths = dataPaths();
  const gate = await gateCheck({ run });
  const nod = await observeNod({ run, installed: existsSync(NOD_APP) });
  return { at: new Date().toISOString(), label, gate: gate.facts, gate_codes: gate.codes, nod: summarize(nod), data_gib: { support: await duGib(run, paths.support), vm: await duGib(run, paths.vm) } };
}

function saveSnapshot(s) {
  mkdirSync(MEASURE_DIR, { recursive: true, mode: 0o700 });
  const st = lstatSync(MEASURE_DIR); // symlink の先の mode を変えない（監査 L9）
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new Error('measure_dir_unsafe');
  chmodSync(MEASURE_DIR, 0o700);
  const file = path.join(MEASURE_DIR, `${s.at.replace(/[:.]/g, '-')}-${s.label}.json`);
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

const out = (x) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
const tty = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function main(argv, run = makeNodRunner()) {
  let a;
  try { a = parse(argv); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const observe = () => observeNod({ run, installed: existsSync(NOD_APP) });
  if (a.command === 'status') {
    const info = await installInfo(run);
    const o = await observe();
    out({ ...info, data_dirs: Object.fromEntries(Object.entries(dataPaths()).map(([k, p]) => [k, existsSync(p)])), ...summarize(o) });
    return info.installed && !info.team_ok ? 1 : 0;
  }
  if (a.command === 'gate') { const r = await gateCheck({ run }); out(r); return r.ok ? 0 : 1; }
  if (a.command === 'measure') { const s = await snapshot(run, a.label); out({ file: saveSnapshot(s), ...s }); return 0; }
  if (a.command === 'stop') { const r = await stopNod({ run, observe, waitMs: a.wait * 1000 }); out(r); return ['stopped', 'already_stopped', 'not_installed'].includes(r.code) ? 0 : 1; }
  // start・session は Human が Terminal で（初回の取得・VM の起動・画面の操作を伴う）
  if (!tty()) { out({ code: 'needs_terminal' }); return 1; }
  const info = await installInfo(run);
  if (!info.installed) { out({ code: 'not_installed' }); return 1; }
  if (!info.team_ok) { out({ code: 'signature_team_mismatch', team_id: info.team_id }); return 1; }
  const gate = await gateCheck({ run });
  if (!gate.ok) { out({ code: 'gate_refused', ...gate }); return 1; }
  if (a.command === 'start') { const r = await startNod({ run, observe }); out(r); return r.code === 'started' ? 0 : 1; }
  // session：起動の後は、途中で止まっても（Ctrl-C・入力の終わり・記録の失敗）必ず公式の Quit まで行く（監査 L8）
  const before = await snapshot(run, 'before');
  saveSnapshot(before);
  const st = await startNod({ run, observe });
  out({ step: 'start', ...st });
  if (st.code !== 'started') return 1;
  let during = null;
  let stop = null;
  const quit = async () => { if (!stop) { stop = await stopNod({ run, observe, waitMs: a.wait * 1000 }); out({ step: 'stop', ...stop }); } };
  const onSignal = () => { quit().finally(() => process.exit(1)); };
  process.once('SIGINT', onSignal);
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { await rl.question('Nod が開きました。画面で試験を終えたら Enter（Nod の画面は閉じるだけ・Quit はこの道具がします）: '); } finally { rl.close(); }
    during = await snapshot(run, 'during');
    saveSnapshot(during);
  } finally {
    await quit();
    process.removeListener('SIGINT', onSignal);
  }
  await new Promise((r) => { setTimeout(r, 60_000); });
  const after = await snapshot(run, 'after');
  saveSnapshot(after);
  out({
    step: 'summary', stop: stop.code,
    available_gib: { before: before.gate.available_gib, during: during.gate.available_gib, after: after.gate.available_gib },
    nod_process_rss_gib: { during: (during.nod.app?.rss_gib ?? 0) + (during.nod.runtime?.rss_gib ?? 0), after: (after.nod.app?.rss_gib ?? 0) + (after.nod.runtime?.rss_gib ?? 0) },
    data_gib: after.data_gib,
    note: 'available は OS の cache を含む見込みの値（free＋inactive＋speculative＋purgeable）。VM の memory は Nod の process の RSS に入らない（Virtualization.framework の別の process）＝VM の分は available の before と during の差で見る',
  });
  return stop.code === 'stopped' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
}
