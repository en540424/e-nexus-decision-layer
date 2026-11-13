/**
 * 工程表のバックアップ（2026-11-13・Human 決定：自動は週 1 回・臨時は Grok Bot の指示で随時・docs/dropbox-business.md §4）。AI を使わない普通の program。
 *
 *   取る：読み取り専用の資格情報で Dropbox の版を 1 つ取る（Dropbox の content_hash で壊れていないことを確かめる）。原本には何もしない（書く資格情報を使わない）
 *   保存：Dropbox の同期の外の Mac の場所（既定 ~/e-nexus-runtime/business-backups・0700）。前の世代と同じ中身（sha256）なら新しい世代を作らない
 *         tmp に書いて fsync → rename → 読み直して sha256 を確かめてから index に足す＝「完了」と言えるのは保存と検証が済んだ時だけ
 *   世代：既定 10。超えた古い世代（この Mac の写しだけ）を消す。Dropbox 自身の版の履歴は別に残る（二重の保護）
 *   容量：空きが file の 3 倍と 1 GiB より少なければ保存しない（backup_disk_low）
 *   復元：選んだ世代を App folder の restore/ へ「別の file」として上げる（add＝在れば上書きしない）。原本への置き換えは Human がする
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { contentHash } from '../dropbox/content-hash.mjs';
import { assertReadable, outputPath, scopeOf } from '../dropbox/scope.mjs';

export const DEFAULT_KEEP = 10;
export const WEEK_MS = 7 * 86_400_000;
const MIN_FREE = 1024 ** 3;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

export class BackupError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** その file の世代の場所（path の sha256 の頭 16 桁＝会社の file 名をフォルダ名にしない） */
export function fileDir(dir, business, dropboxPath) {
  return path.join(dir, business, 'schedule', sha(dropboxPath.toLowerCase()).slice(0, 16));
}

export function listGenerations(dir, business, dropboxPath) {
  const idx = readJson(path.join(fileDir(dir, business, dropboxPath), 'index.json'), null);
  return Array.isArray(idx?.generations) ? idx.generations : [];
}

/**
 * 1 つの工程表の file を保存する。戻り値：{ status: 'saved'|'unchanged', generation, path }。失敗は BackupError（code）か DropboxError（code）
 * reason：'weekly'｜'manual'。reader は role 'read' の client。scopes は loadScopes の結果
 */
export async function backupSchedule({ reader, scopes, business, file, dir, reason = 'manual', keep = DEFAULT_KEEP, now = Date.now(), signal, freeBytes = defaultFree }) {
  const scope = scopeOf(scopes, business);
  const p = assertReadable(scope, file, 'schedule');
  const fdir = fileDir(dir, business, p);
  mkdirSync(fdir, { recursive: true, mode: 0o700 });
  return withFileLock(fdir, () => saveLocked({ reader, p, fdir, reason, keep, now, signal, freeBytes }));
}

async function saveLocked({ reader, p, fdir, reason, keep, now, signal, freeBytes }) {
  const { bytes, meta } = await reader.download(p, { signal });
  const digest = sha(bytes);
  const idxFile = path.join(fdir, 'index.json');
  const idx = readJson(idxFile, { path: p, generations: [] });
  const last = idx.generations.at(-1);
  // 同じ中身でも、保存してある世代の file が在って壊れていない時だけ unchanged（無い・壊れていれば新しく保存する・監査 F4）
  const lastOk = last && last.sha256 === digest && (() => { try { return sha(readFileSync(path.join(fdir, last.file))) === digest; } catch { return false; } })();
  if (lastOk) {
    idx.last_checked_at = iso(now);
    writeAtomic(idxFile, `${JSON.stringify(idx, null, 1)}\n`);
    return { status: 'unchanged', generation: last, path: p };
  }
  const free = freeBytes(fdir);
  if (Number.isFinite(free) && free < Math.max(bytes.length * 3, MIN_FREE)) throw new BackupError('backup_disk_low');
  const ext = path.extname(meta.name ?? p).replace(/[^.A-Za-z0-9]/g, '').slice(0, 8) || '.bin';
  const id = `${iso(now).replace(/[-:.]/g, '').slice(0, 15)}-${digest.slice(0, 8)}`;
  const gfile = path.join(fdir, `${id}${ext}`);
  writeAtomic(gfile, bytes);
  if (sha(readFileSync(gfile)) !== digest) { try { unlinkSync(gfile); } catch { /* 済 */ } throw new BackupError('backup_verify_failed'); }
  const gen = { id, saved_at: iso(now), reason, rev: meta.rev, server_modified: meta.server_modified, size: bytes.length, sha256: digest, content_hash: meta.content_hash, file: path.basename(gfile) };
  idx.path = p;
  idx.generations = [...idx.generations, gen];
  const drop = idx.generations.length > keep ? idx.generations.slice(0, idx.generations.length - keep) : [];
  idx.generations = idx.generations.slice(-keep);
  idx.last_checked_at = iso(now);
  writeAtomic(idxFile, `${JSON.stringify(idx, null, 1)}\n`);
  for (const g of drop) { try { unlinkSync(path.join(fdir, g.file)); } catch { /* 消えていた */ } }
  return { status: 'saved', generation: gen, path: p };
}

/** file ごとの排他（週の回と臨時の依頼が同時に index を書かない・監査 nit 1）。10 分より古い印は止まった持ち主として外す */
function withFileLock(fdir, fn) {
  const lock = path.join(fdir, '.lock');
  for (let i = 0; i < 2; i += 1) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* 消えた */ }
      if (i === 0 && age > 10 * 60_000) { rmSync(lock, { recursive: true, force: true }); continue; }
      throw new BackupError('backup_busy');
    }
  }
  const done = () => rmSync(lock, { recursive: true, force: true });
  return Promise.resolve().then(fn).finally(done);
}

function defaultFree(dir) {
  try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

/** 週 1 回の自動の時刻が来たか（成功した週の回から 7 日。失敗した時は retry_at＝1 時間後から倍で最大 1 日・監査 F10） */
export function weeklyDue(dir, business, now = Date.now()) {
  const st = readJson(path.join(dir, business, 'schedule', 'state.json'), {});
  const r = Date.parse(st.retry_at);
  if (Number.isFinite(r)) return now >= r;
  const t = Date.parse(st.last_weekly_at);
  return !(Number.isFinite(t) && now - t < WEEK_MS && t <= now + 3_600_000);
}
export function markWeekly(dir, business, now = Date.now(), result = 'ok') {
  const d = path.join(dir, business, 'schedule');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const prev = readJson(path.join(d, 'state.json'), {});
  const next = result === 'ok'
    ? { last_weekly_at: iso(now), result: 'ok' }
    : { last_weekly_at: prev.last_weekly_at ?? null, result: String(result).slice(0, 40), failures: (prev.failures ?? 0) + 1, retry_at: iso(now + Math.min(3_600_000 * 2 ** (prev.failures ?? 0), 86_400_000)) };
  writeAtomic(path.join(d, 'state.json'), `${JSON.stringify(next)}\n`);
}

/** 週 1 回の回（全部の schedule_files）。結果は file ごとの { path の番号, status|code }（path は出さない） */
export async function weeklyBackup({ reader, scopes, business, dir, keep, now = Date.now(), signal }) {
  const scope = scopeOf(scopes, business);
  const out = [];
  for (const [i, f] of scope.schedule_files.entries()) {
    try { const r = await backupSchedule({ reader, scopes, business, file: f, dir, reason: 'weekly', keep, now, signal }); out.push({ n: i + 1, status: r.status }); } catch (e) { out.push({ n: i + 1, code: String(e?.code ?? 'error').slice(0, 40) }); }
  }
  markWeekly(dir, business, now, out.some((x) => x.code) ? 'problem' : 'ok');
  return out;
}

/**
 * 世代を App folder の restore/ へ別の file として上げる（原本には何もしない）。generation を省けば最新。at（ISO の日付）を渡せばその日以前で最新
 */
/** at の解釈：日付だけ（YYYY-MM-DD）は「その日の終わり」（offsetMin＝config の utc_offset_minutes の地方時）。時刻つきは ISO（時刻帯が無ければ地方時として扱う）・監査 F11 */
export function atToMs(at, offsetMin = 0) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return Date.parse(`${at}T23:59:59.999Z`) - offsetMin * 60_000;
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(at)) return Date.parse(`${at}Z`) - offsetMin * 60_000;
  return Date.parse(at);
}

export async function restoreGeneration({ writer, scopes, business, file, dir, generation = null, at = null, offsetMin = 0, now = Date.now(), signal }) {
  const scope = scopeOf(scopes, business);
  const p = assertReadable(scope, file, 'schedule');
  const gens = listGenerations(dir, business, p);
  let g = null;
  if (generation) g = gens.find((x) => x.id === generation) ?? null;
  else if (at) { const t = atToMs(at, offsetMin); g = Number.isFinite(t) ? [...gens].reverse().find((x) => Date.parse(x.saved_at) <= t) ?? null : null; } else g = gens.at(-1) ?? null;
  if (!g) throw new BackupError('backup_generation_not_found');
  let bytes;
  try { bytes = readFileSync(path.join(fileDir(dir, business, p), g.file)); } catch { throw new BackupError('backup_generation_missing'); }
  if (sha(bytes) !== g.sha256) throw new BackupError('backup_generation_corrupt');
  const base = path.basename(p).replace(/\.[^.]*$/, '');
  const ext = path.extname(p) || '';
  const name = `${[...base].slice(0, 60).join('').trim()}_復元_${g.id}${ext}`; // サロゲートを割らない（監査 nit 10）
  const target = outputPath(scope, 'restore', name);
  try {
    const up = await writer.upload(target, bytes, { signal });
    return { generation: g, restored_to: up.path, rev: up.rev };
  } catch (e) {
    // 同じ名前が在る：中身が同じ世代なら済み（やり直し）。違えば上書きしない。空きが無い等は失敗のまま（監査 F3）
    if (e?.code !== 'dropbox_path_conflict') throw e;
    const m = await writer.metadata(target, { signal });
    if (m.content_hash !== contentHash(bytes)) throw new BackupError('restore_name_taken');
    return { generation: g, restored_to: m.path, rev: m.rev, already: true };
  }
}

