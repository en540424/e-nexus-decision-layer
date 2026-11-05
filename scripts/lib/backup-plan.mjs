/**
 * バックアップの対象の選別（2026-11-05・H5）。allowlist：ここに書いたものだけが対象で、新しいフォルダは既定で入らない。
 *
 * 対象：Mac に保全先の無い Mac Runtime の記録だけ（backup-inventory の protection: none）。git に全部あるコードは入れない。
 * 除外：拡張子の外・文字列でないもの・大きすぎるファイル・Secret の形と名前・Trading Lab の名前と言及・deny のパターンにあたるもの。
 *   deny のパターンは公開 repo に置けない識別子を含むので、Mac のローカルのファイルから読む（無ければ動かない）。
 *   判定は Hermes の Vault の写しと同じ本物の grep（grep -E の書式をここで読み替えない）。
 * Keychain・Hermes の home（700。読めない）・再生成できるもの（Hermes の bundle と Vault の写し・REA）は対象にしない。
 * 検査した本文（body）をそのままアーカイブへ入れる（検査の後の差し替えを写さない）。記録には中身を出さない。除外の理由はコードだけ。
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BACKUP_LIMITS = Object.freeze({ file_bytes: 8 * 1024 ** 2, total_bytes: 64 * 1024 ** 2, min_deny_lines: 5 });
const TEXT = /\.(?:md|txt|json|jsonl|plist|ya?ml|sh)$/i;
const SKIP_NAME = /(?:^|\/)(?:\.env[^/]*|[^/]*\.tmp|[^/]*(?:id_rsa|id_ed25519|id_ecdsa|\.pem|\.key|\.p12|credential|secret|passw|token)[^/]*)$/i;
const TRADING_LAB = /trading[\s._-]?lab|parallels|mac-mini-migration-kit/i;
/** Secret の形。ファイルに 1 つでもあれば丸ごと除外する（暗号の中でも鍵を持ち出さない） */
export const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/, // Discord の bot token
  /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]{20,}/i,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/i,
  /["']?\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{16,}/i, // 名前＝値の形
]);

/** 対象の一覧。exclude は対象の中の相対パスの形（再生成できるもの） */
export function backupSources({ base, home, repoRoot }) {
  const memory = path.join(home, '.claude', 'projects', `${base.replaceAll('/', '-')}-e-nexus-decision-layer`, 'memory');
  return [
    { id: 'runtime_notes', dir: base, topLevelOnly: true },
    { id: 'runtime_rules', dir: path.join(base, '.claude', 'rules') },
    { id: 'mac_runtime_state', dir: path.join(base, 'mac-runtime-state'), exclude: /^hermes\/bundle-/ },
    { id: 'claude_memory', dir: memory },
    { id: 'relay_config', dir: path.join(home, '.enexus'), topLevelOnly: true },
    { id: 'relay_outbox', dir: path.join(home, '.enexus', 'devlog-relay', 'outbox') }, // 送信済みは relay の repo にある
    { id: 'host_health_records', dir: path.join(repoRoot, 'data', 'host-health') },
  ];
}

/** deny のファイルの有効な行（# と空行を除く）。無い・少なすぎる時は投げる＝止まる（無害な 1 行で通さない） */
export function denyLines(text) {
  const lines = text.split('\n').filter((l) => !/^\s*(?:#|$)/.test(l));
  if (lines.length < BACKUP_LIMITS.min_deny_lines) throw new Error('deny patterns are too few');
  return lines;
}

/** grep の exit：0＝あたった・1＝無し・それ以外は読めない＝止まる（通さない） */
function grep(args, input = undefined) {
  const r = spawnSync('/usr/bin/grep', args, { input, encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: 30_000, maxBuffer: 16 * 1024 ** 2 });
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error('deny check failed');
  return r.stdout.split('\n').filter(Boolean);
}

/** 中身か名前が deny にあたる添字の集合。本物の grep で判定する（Hermes の vault-copy.sh と同じ -rlai -E -f） */
export function deniedIndexes(rows, denyText, tmpRoot) {
  const lines = denyLines(denyText);
  const work = mkdtempSync(path.join(tmpRoot, 'edl-deny-'));
  try {
    const deny = path.join(work, 'deny');
    const stage = path.join(work, 'stage');
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(deny, `${lines.join('\n')}\n`, { mode: 0o600 });
    rows.forEach((f, i) => writeFileSync(path.join(stage, String(i)), f.body, { mode: 0o600 }));
    const hit = new Set(grep(['-rlai', '-E', '-f', deny, stage]).map((p) => Number(path.basename(p))));
    const names = rows.map((f, i) => `${i}\t${f.rel}`);
    for (const l of grep(['-ai', '-E', '-f', deny], `${names.join('\n')}\n`)) hit.add(Number(l.split('\t')[0]));
    return hit;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function walk(dir, topLevelOnly, out, rel = '') {
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!topLevelOnly) walk(dir, false, out, r); } else if (e.isFile()) out.push(r); // symlink はたどらない
  }
}

/** symlink へ差し替えられていても開かない。大きすぎれば null */
function readPlain(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).size > BACKUP_LIMITS.file_bytes) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 選別。files は { id, rel, body, bytes }。excluded は理由ごとの件数。読めない対象は unreadable に数える */
export function planBackup({ sources, denyText, tmpRoot }) {
  const rows = [];
  const excluded = {};
  const count = (reason) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  for (const s of sources) {
    if (!existsSync(s.dir)) { count('source_missing'); continue; }
    const names = [];
    try {
      walk(s.dir, s.topLevelOnly, names);
    } catch {
      count('unreadable');
      continue;
    }
    for (const rel of names.sort()) {
      if (s.exclude?.test(rel)) { count('regenerable'); continue; }
      if (!TEXT.test(rel) || SKIP_NAME.test(rel)) { count('file_type'); continue; }
      if (TRADING_LAB.test(rel)) { count('trading_lab'); continue; }
      let body;
      try {
        body = readPlain(path.join(s.dir, rel));
      } catch {
        count('unreadable');
        continue;
      }
      if (body == null) { count('too_large'); continue; }
      let text;
      try {
        text = utf8.decode(body); // UTF-16・bplist は検査をすり抜けるので入れない
      } catch {
        count('binary');
        continue;
      }
      if (text.includes('\0')) { count('binary'); continue; }
      if (SECRET_PATTERNS.some((p) => p.test(text))) { count('secret'); continue; }
      if (TRADING_LAB.test(text)) { count('trading_lab'); continue; } // 言及だけのファイルも入れない（識別子の判定は deny に任せきりにしない）
      rows.push({ id: s.id, rel, body, bytes: body.length });
    }
  }
  const denied = deniedIndexes(rows, denyText, tmpRoot);
  if (denied.size) excluded.denied = denied.size;
  const files = rows.filter((_, i) => !denied.has(i));
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  if (bytes > BACKUP_LIMITS.total_bytes) throw new Error('backup is larger than the limit');
  return { files, excluded, bytes };
}

/** 世代：新しい 14 個と、月ごとの最新を 12 か月分。戻り値は消す名前。名前は YYYY-MM-DDTHHMMZ.edlbk（並びが時刻の順）。keep は必ず残す（今送ったもの） */
export function retentionPlan(names, { daily = 14, monthly = 12, keep: pinned = null } = {}) {
  const sorted = names.filter((n) => /^\d{4}-\d{2}-\d{2}T\d{4}Z\.edlbk$/.test(n)).sort().reverse();
  const keep = new Set(sorted.slice(0, daily));
  const months = new Set();
  for (const n of sorted) {
    const m = n.slice(0, 7);
    if (months.size < monthly && !months.has(m)) { months.add(m); keep.add(n); }
  }
  return sorted.filter((n) => !keep.has(n) && n !== pinned);
}
