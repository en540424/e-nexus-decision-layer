/**
 * バックアップの対象の選別（2026-11-05・H5）。allowlist：ここに書いたものだけが対象で、新しいフォルダは既定で入らない。
 *
 * 対象：Mac に保全先の無い Mac Runtime の記録だけ（backup-inventory の protection: none）。git に全部あるコードは入れない。
 * 除外：拡張子の外・大きすぎるファイル・Secret の形・Trading Lab の領域・deny のパターンにあたるもの。
 *   deny のパターンは公開 repo に置けない識別子を含むので、Mac のローカルのファイルから読む（無ければ動かない）。
 * Keychain・Hermes の home（700。読めない）・再生成できるもの（Hermes の bundle と Vault の写し・REA）は対象にしない。
 * 戻り値に中身は入れない。除外の理由はコードだけ。
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const BACKUP_LIMITS = Object.freeze({ file_bytes: 8 * 1024 ** 2, total_bytes: 64 * 1024 ** 2 });
const TEXT = /\.(?:md|txt|json|jsonl|plist|ya?ml|sh)$/i;
const SKIP_NAME = /(?:^|\/)(?:\.env[^/]*|.*\.tmp|id_[a-z0-9]+|.*\.pem|.*\.key)$/i;
const TRADING_LAB_NAME = /parallels|trading-?lab|mac-mini-migration-kit|mt5|oanda/i;
/** Secret の形。ファイルに 1 つでもあれば丸ごと除外する（暗号の中でも鍵を持ち出さない） */
export const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]{20,}/i,
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

const POSIX_CLASSES = Object.freeze({ space: '\\s', digit: '0-9', alnum: 'A-Za-z0-9', alpha: 'A-Za-z', upper: 'A-Z', lower: 'a-z' });
/** deny のファイル（1 行 1 つの grep -E の正規表現・# と空行は無視・大小文字を問わない）。読めない・壊れた行があれば投げる＝止まる */
export function loadDenyPatterns(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('deny patterns are empty');
  return lines.map((l) => {
    const js = l.replace(/\[:([a-z]+):\]/g, (m, name) => {
      if (!POSIX_CLASSES[name]) throw new Error('unknown class in deny patterns');
      return POSIX_CLASSES[name];
    });
    return new RegExp(js, 'i');
  });
}

function walk(dir, topLevelOnly, out, rel = '') {
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!topLevelOnly) walk(dir, false, out, r); } else if (e.isFile()) out.push(r); // symlink はたどらない
  }
}

/** 選別。files は { id, rel, src, bytes }。excluded は理由ごとの件数。読めない対象は unreadable に数える */
export function planBackup({ sources, deny }) {
  const files = [];
  const excluded = {};
  const count = (reason) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  let total = 0;
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
      if (TRADING_LAB_NAME.test(rel)) { count('trading_lab'); continue; }
      const src = path.join(s.dir, rel);
      let body;
      try {
        if (lstatSync(src).size > BACKUP_LIMITS.file_bytes) { count('too_large'); continue; }
        body = readFileSync(src, 'utf8');
      } catch {
        count('unreadable');
        continue;
      }
      if (SECRET_PATTERNS.some((p) => p.test(body))) { count('secret'); continue; }
      if (deny.some((p) => p.test(body) || p.test(rel))) { count('denied'); continue; }
      total += Buffer.byteLength(body);
      if (total > BACKUP_LIMITS.total_bytes) throw new Error('backup is larger than the limit');
      files.push({ id: s.id, rel, src, bytes: Buffer.byteLength(body) });
    }
  }
  return { files, excluded, bytes: total };
}

/** 世代：新しい 14 個と、月ごとの最新を 12 か月分。戻り値は消す名前。名前は YYYY-MM-DDTHHMMZ.edlbk（並びが時刻の順） */
export function retentionPlan(names, { daily = 14, monthly = 12 } = {}) {
  const sorted = names.filter((n) => /^\d{4}-\d{2}-\d{2}T\d{4}Z\.edlbk$/.test(n)).sort().reverse();
  const keep = new Set(sorted.slice(0, daily));
  const months = new Set();
  for (const n of sorted) {
    const m = n.slice(0, 7);
    if (months.size < monthly && !months.has(m)) { months.add(m); keep.add(n); }
  }
  return sorted.filter((n) => !keep.has(n));
}
