/**
 * Hermes へ渡す状態の要約（2026-11-04・A2 の設計。2026-11-05 H4 の Human 承認で本番の共有を開始）。
 *
 * host-health の state.json から、許可した項目の「水準」だけを取り出す（allowlist。知らない項目は落ちる）。
 * 渡さない：値（空き容量・回線名・repo の差分）・パス・hash・pid、それと Hermes を見張る項目（隔離・固定ファイルの変化・常駐の増減・
 *   監視の定義）＝見張られる側に検知の中身を渡さない。Trading Lab の情報はそもそも state に無い。
 * Hermes の権限は増えない（読むだけの 1 ファイル）が、Hermes が見る情報は増える。
 * 本番の置き場は STATUS_DIR の固定 1 か所。host-health の 1 回分の最後に書く。フォルダは作らない（Human の承認の後に 1 回だけ作ったもの。消せば書くのが止まる）。
 * Hermes は generated_at を見る（監視が止まると更新されないので、古い要約は信じない）。
 */
import { chmodSync, lstatSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HERMES_SHARE } from './runtime-guard.mjs';

export const SUMMARY_SCHEMA = 'runtime-status-summary/v1';
export const STATUS_DIR = path.join(HERMES_SHARE, 'status');
export const STATUS_FILE = 'runtime-status.json';
/** 手で試す --out は macOS の一時フォルダだけ（引数でも環境変数でも開けない。だから tmpdir() は使わない＝TMPDIR で動く） */
export const MOCK_OUT_ROOTS = Object.freeze(['/private/tmp', '/private/var/folders']);
/** 項目の id が分かっても機密にならない群だけ attention に出す。repo・job・github は件数だけ */
const GROUPS = Object.freeze({
  host: { match: (id) => ['disk_free_gib', 'memory_pressure', 'swap_used_gib', 'load_15m', 'thermal', 'power', 'network_default_route', 'data_gib'].includes(id), named: true },
  hermes: { match: (id) => ['hermes_rss_gib', 'hermes_service'].includes(id), named: true },
  backup: { match: (id) => ['backup_time_machine', 'backup_archive'].includes(id), named: true },
  jobs: { match: (id) => id.startsWith('job:'), named: false },
  repos: { match: (id) => id.startsWith('repo:') || id === 'relay_outbox', named: false },
  github: { match: (id) => id === 'github_api' || id.startsWith('github:'), named: false },
});
const RANK = { ok: 0, warn: 1, crit: 2 };
const worst = (levels) => levels.reduce((a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a), 'ok');
/** 記録がこれより古ければ要約を信じない（30 分ごとの job の 3 回分） */
export const STALE_MS = 90 * 60_000;

export function buildStatusSummary(state, { now = new Date(), paused = false, disabled = false } = {}) {
  const updated = state?.last_success_at ?? state?.updated_at ?? null;
  const age = now.getTime() - Date.parse(updated);
  const stale = !Number.isFinite(age) || age > STALE_MS;
  const monitor = disabled ? 'disabled' : paused ? 'paused' : stale ? 'stale' : 'running';
  const running = monitor === 'running';
  // observed＝今の水準。items は通知の状態で、送れなかった異常は ok のままなので使わない（前の版の state だけの代わり）
  const levels = state?.observed ?? Object.fromEntries(Object.entries(state?.items ?? {}).map(([id, v]) => [id, v?.level]));
  const groups = {};
  const attention = [];
  for (const [group, def] of Object.entries(GROUPS)) {
    const rows = Object.entries(levels).filter(([id, level]) => def.match(id) && level in RANK);
    const bad = rows.filter(([, level]) => level !== 'ok');
    groups[group] = { level: running && rows.length ? worst(rows.map(([, level]) => level)) : 'unknown', not_ok: running ? bad.length : 0 };
    if (running && def.named) for (const [id, level] of bad) attention.push({ group, id, level });
  }
  const known = Object.values(groups).map((g) => g.level).filter((l) => l in RANK);
  return {
    schema: SUMMARY_SCHEMA,
    generated_at: now.toISOString(),
    source_updated_at: updated,
    monitor,
    overall: running && known.length ? worst(known) : 'unknown', // 動いていない監視の古い「正常」を出さない
    groups,
    attention,
  };
}

/**
 * 本番の 1 ファイルを置き換える。戻り値は記録用のコード：written／not_configured（フォルダが無い）／dir_unsafe（symlink・他人のもの・他人が書ける）／write_failed。
 * Hermes が読むので group の読み取りだけ（0640）。group はフォルダから継ぐ。途中の状態を読ませないよう rename で置き換える。
 */
export function writeStatusSummary(summary, { dir = STATUS_DIR, uid = process.getuid() } = {}) {
  let s;
  try {
    s = lstatSync(dir);
  } catch {
    return 'not_configured';
  }
  if (!s.isDirectory() || s.uid !== uid || s.mode & 0o027) return 'dir_unsafe';
  const file = path.join(dir, STATUS_FILE);
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o640 });
    chmodSync(tmp, 0o640);
    renameSync(tmp, file);
    return 'written';
  } catch {
    return 'write_failed';
  }
}

/** symlink で外へ出られないよう、親フォルダの実パスで確かめる。ファイルの symlink（切れたものも）は lstat で拒み、書く時は wx（既にあるものへ書かない） */
export function assertMockOut(out) {
  const p = path.resolve(out);
  const refused = new Error('--out writes only under the temp folder');
  const real = (x) => {
    try {
      return realpathSync(x);
    } catch {
      return null;
    }
  };
  const parent = real(path.dirname(p));
  if (!parent || !MOCK_OUT_ROOTS.map(real).some((r) => r && (parent === r || parent.startsWith(`${r}${path.sep}`)))) throw refused;
  let link = false;
  try {
    link = lstatSync(p).isSymbolicLink();
  } catch { /* まだ無い */ }
  if (link) throw refused;
  return path.join(parent, path.basename(p));
}
