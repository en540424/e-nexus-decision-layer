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
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BACKUP_LIMITS = Object.freeze({ file_bytes: 8 * 1024 ** 2, total_bytes: 16 * 1024 ** 2, min_deny_lines: 5, grep_timeout_ms: 120_000, scan_budget_ms: 90_000 });
/** 選別・検証の全体の時間切れ（1 行の長さの上限だけでは、ファイルの数で数分かかりうる）。超えたら止める＝送らない・違反なしと言わない */
export class ScanTimeout extends Error {
  constructor() {
    super('scan time budget exceeded');
    this.code = 'scan_timeout';
  }
}
const deadlineOf = (budgetMs, clock) => {
  const end = clock() + budgetMs;
  return () => { if (clock() > end) throw new ScanTimeout(); };
};
/** 単調な時計（NTP の時刻の飛びで偽の時間切れにしない） */
const monotonic = () => performance.now();
const TEXT = /\.(?:md|txt|json|jsonl|plist|ya?ml|sh)$/i;
const SKIP_NAME = /(?:^|\/)(?:\.env[^/]*|[^/]*\.tmp|[^/]*(?:id_rsa|id_ed25519|id_ecdsa|\.pem|\.key|\.p12|credential|secret|passw|passphrase|token)[^/]*)(?:\/|$)/i; // フォルダの名前も見る
const TRADING_LAB = /trading[\s._-]*lab|トレーディング\s*ラボ|parallels|mac-mini-migration-kit/i;
/** 正規表現の時間は 1 行の長さの 2 乗で増える。これより長い行のファイルは判定せず外す（1 回分を止めない） */
export const MAX_LINE_CHARS = 16 * 1024;
const hasLongLine = (text) => {
  let from = 0;
  for (let to = text.indexOf('\n'); to >= 0; to = text.indexOf('\n', from)) {
    if (to - from > MAX_LINE_CHARS) return true;
    from = to + 1;
  }
  return text.length - from > MAX_LINE_CHARS;
};
/** 見えない文字（書式の制御＝ゼロ幅・BOM・方向の制御、既定で無視される文字＝字形の選択子とその補助面・ハングルの埋め字など）。挟んで検出をすり抜けさせない */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const visible = (text) => text.replace(INVISIBLE, '');
/** 元の形と見えない文字を除いた形の両方で見る（除くと語の境界の \b が消える形もある） */
const forms = (text) => {
  const v = visible(text);
  return v === text ? [text] : [text, v];
};
const GLOBAL_PATTERNS = () => SECRET_PATTERNS.map((p) => new RegExp(p.source, `${p.flags}g`));
/**
 * Secret の形が text にあるか。head・tail は窓の切り口：\b で始まる形の窓の先頭の一致・\b で終わる形の窓の末尾の一致は、切り口が作った偽の語の境界なので数えない
 * （窓は十分に重なるので、本物の一致は隣の窓の中に丸ごと入る）。
 */
const anySecret = (text, { head = false, tail = false } = {}) => {
  try {
    if (!head && !tail) return forms(text).some((t) => SECRET_PATTERNS.some((p) => p.test(t)));
    for (const t of forms(text)) {
      for (const re of GLOBAL_PATTERNS()) {
        for (let m = re.exec(t); m; m = re.exec(t)) {
          if (m[0].length === 0) re.lastIndex += 1;
          const fakeHead = head && m.index === 0 && re.source.startsWith('\\b');
          const fakeTail = tail && m.index + m[0].length === t.length && re.source.endsWith('\\b'); // 終わりの開いた形の途中切れは本物の一致（数える）
          if (fakeHead || fakeTail) { re.lastIndex = m.index + 1; continue; }
          return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
};
/** 1 回の正規表現に渡す長さの上限。行の境目で区切り、区切りごとに時間切れを確かめる（1 ファイルの中でも予算を守る）。前の区切りの末尾を前置きに付ける（名前＝値の形が改行をまたぐ時） */
const BATCH_CHARS = 64 * 1024;
const BATCH_CONTEXT = 256;
const secretInBatches = (text, tick) => {
  if (text.length <= BATCH_CHARS) return anySecret(text);
  for (let from = 0; from < text.length;) {
    tick();
    let to = Math.min(text.length, from + BATCH_CHARS);
    if (to < text.length) {
      const nl = text.lastIndexOf('\n', to);
      if (nl > from) to = nl + 1;
    }
    if (anySecret(text.slice(Math.max(0, from - BATCH_CONTEXT), to))) return true;
    from = to;
  }
  return false;
};
/** 判定できない本文（巨大な 1 行）は Secret と同じに扱う（丸ごと外す。1 回分を止めない） */
const hasSecret = (text, tick = () => {}) => hasLongLine(text) || secretInBatches(text, tick);
/** 長い行も窓に分けて全部を見る（保存済みの世代の検証用）。窓の重なりは JWT など終わりの開いた形の実際の長さより長く取る */
const SCAN_OVERLAP = 8 * 1024;
const hasSecretChunked = (text, tick = () => {}) => {
  if (!hasLongLine(text)) return secretInBatches(text, tick);
  for (let from = 0; from < text.length; from += MAX_LINE_CHARS - SCAN_OVERLAP) {
    tick();
    const to = from + MAX_LINE_CHARS;
    if (anySecret(text.slice(from, to), { head: from > 0, tail: to < text.length })) return true;
  }
  return false;
};
/** 全角と濁点の分かれた形も同じ語として見る。見えない文字を挟んだ形も（除いてから正規化する形も：挟むと濁点が合成されない） */
const mentionsTradingLab = (text) => {
  const n = text.normalize('NFKC');
  return [n, visible(n), visible(text).normalize('NFKC')].some((t) => TRADING_LAB.test(t));
};
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
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{10,}/, // JWT の頭（中身が長くて窓に収まらない時も見つける）
  /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/, // Discord の bot token
  /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]{20,}/i,
  /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/i,
  /(?:token|secret|password|passwd|passphrase|api[_-]?key)["']?\s*[:=：]\s*["']?[A-Za-z0-9_+/=-]{16,}/i, // 名前＝値の形
  /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /--(?:token|password|passphrase)[ =][A-Za-z0-9_+/=-]{16,}/i,
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
    { id: 'host_health_records', dir: path.join(repoRoot, 'data', 'host-health'), recentMonths: 2 }, // 毎月 約 2.5 MB 増えるので新しい 2 か月だけ
  ];
}

/** deny のファイルの有効な行（# と空行を除く）。無い・少なすぎる時は投げる＝止まる（無害な 1 行で通さない） */
export function denyLines(text) {
  if (text.includes('\r')) throw new Error('deny patterns have CR'); // 行末の CR であたらなくなる（vault-copy.sh と同じく止める）
  const lines = text.split('\n').filter((l) => !/^\s*(?:#|$)/.test(l));
  if (lines.length < BACKUP_LIMITS.min_deny_lines) throw new Error('deny patterns are too few');
  return lines;
}

/** grep の exit：0＝あたった・1＝無し・それ以外は読めない＝止まる（通さない） */
function grep(args, input = undefined) {
  const r = spawnSync('/usr/bin/grep', args, { input, encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: BACKUP_LIMITS.grep_timeout_ms, maxBuffer: 16 * 1024 ** 2 });
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
    // 見えない文字を除いた写しも同じ添字で並べる（<i>.v）。元の bytes に見えない文字が無ければ写さない
    rows.forEach((f, i) => {
      writeFileSync(path.join(stage, String(i)), f.body, { mode: 0o600 });
      const text = Buffer.isBuffer(f.body) ? f.body.toString('utf8') : String(f.body);
      const v = visible(text);
      if (v !== text) writeFileSync(path.join(stage, `${i}.v`), v, { mode: 0o600 });
    });
    const hit = new Set(grep(['-rlai', '-E', '-f', deny, stage]).map((p) => Number.parseInt(path.basename(p), 10)));
    const names = rows.flatMap((f, i) => forms(f.rel).map((n) => [i, n]));
    if (names.length) for (const l of grep(['-ain', '-E', '-f', deny], `${names.map(([, n]) => n).join('\n')}\n`)) hit.add(names[Number(l.split(':')[0]) - 1][0]); // 名前は改行を含まない（planBackup が落とす）
    return hit;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function walk(dir, topLevelOnly, out, rel = '', links = []) {
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!topLevelOnly) walk(dir, false, out, r, links); } else if (e.isFile()) out.push(r);
    else if (e.isSymbolicLink()) links.push(r); // symlink はたどらない（数だけ残す）
  }
  return links;
}

/** macOS の O_NOFOLLOW_ANY（途中のどの要素も symlink なら ELOOP。最後の要素も含む）。Node は定数を出さないので数で持つ。O_NOFOLLOW と重ねると EINVAL なので代わりに使う。他の OS は O_NOFOLLOW と dev・ino の確かめ */
const NOFOLLOW = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
const outside = (why) => Object.assign(new Error(why), { code: 'outside_source' });
/**
 * 対象の中の通常ファイルだけ開く。realpath が対象の外（途中のフォルダを symlink へ差し替えた）なら開かない。
 * realpath の形を O_NOFOLLOW_ANY で開く（確かめと開く間に途中のフォルダを差し替えても外を読まない）。開いた後に同じファイル（dev・ino）かも確かめる。
 * 通常ファイルでない（FIFO で開くのが止まる）・ハードリンク（realpath では外のファイルと見分けられない）は開かない。大きすぎれば null。
 */
export function readPlain(file, rootReal) {
  if (lstatSync(file).isSymbolicLink()) throw outside('symlink'); // 一覧の後に symlink へ差し替えられた
  const real = realpathSync(file);
  if (rootReal && !real.startsWith(`${rootReal}${path.sep}`)) throw outside('outside source');
  const seen = statSync(real);
  if (!seen.isFile()) throw outside('not a regular file');
  if (seen.nlink > 1) throw Object.assign(new Error('hard link'), { code: 'hard_link' });
  let fd;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW);
  } catch (err) {
    throw err?.code === 'ELOOP' ? outside('symlink in path') : err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== seen.dev || st.ino !== seen.ino) throw outside('replaced');
    if (st.nlink > 1) throw Object.assign(new Error('hard link'), { code: 'hard_link' });
    if (st.size > BACKUP_LIMITS.file_bytes) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 選別。files は { id, rel, body, bytes }。excluded は理由ごとの件数。読めない対象は unreadable に数える。
 * 対象のフォルダそのものが symlink なら丸ごと入れない（source_symlink。sources_missing に数える＝知らせる）。全体が budgetMs を超えたら ScanTimeout。
 */
export function planBackup({ sources, denyText, tmpRoot, budgetMs = BACKUP_LIMITS.scan_budget_ms, clock = monotonic }) {
  const tick = deadlineOf(budgetMs, clock);
  const rows = [];
  const excluded = {};
  const count = (reason) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  for (const s of sources) {
    if (!existsSync(s.dir)) { count('source_missing'); continue; }
    const names = [];
    let rootReal;
    try {
      if (lstatSync(s.dir).isSymbolicLink()) { count('source_symlink'); continue; }
      rootReal = realpathSync(s.dir);
      for (const _ of walk(s.dir, s.topLevelOnly, names)) count('symlink');
    } catch {
      count('unreadable');
      continue;
    }
    const months = names.filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort().reverse();
    const oldMonths = new Set(s.recentMonths ? months.slice(s.recentMonths) : []);
    for (const rel of names.sort()) {
      tick();
      if (s.exclude?.test(rel)) { count('regenerable'); continue; }
      if (oldMonths.has(rel)) { count('old_records'); continue; }
      if (!TEXT.test(rel) || forms(rel).some((n) => SKIP_NAME.test(n)) || /[\r\n]/.test(rel)) { count('file_type'); continue; }
      if (mentionsTradingLab(rel)) { count('trading_lab'); continue; }
      let body;
      try {
        body = readPlain(path.join(s.dir, rel), rootReal);
      } catch (err) {
        count(['outside_source', 'hard_link'].includes(err?.code) ? err.code : 'unreadable');
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
      if (hasLongLine(text)) { count('long_line'); continue; } // 判定できない＝入れない（Secret とは数え分ける）
      if (hasSecret(text, tick)) { count('secret'); continue; }
      if (mentionsTradingLab(text)) { count('trading_lab'); continue; } // 言及だけのファイルも入れない（識別子の判定は deny に任せきりにしない）
      rows.push({ id: s.id, rel, body, bytes: body.length });
    }
  }
  if (rows.reduce((n, f) => n + f.bytes, 0) > BACKUP_LIMITS.total_bytes) throw new Error('backup is larger than the limit');
  tick();
  const denied = deniedIndexes(rows, denyText, tmpRoot);
  tick();
  if (denied.size) excluded.denied = denied.size;
  const files = rows.filter((_, i) => !denied.has(i));
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return { files, excluded, bytes };
}

/**
 * 保存済みのファイルが除外の方針に反していないか（backup-run の verify）。rows は { rel, body }。反した件数だけ返す（どのファイルかは出さない）。
 * 保存物はファイルの名前だけ見る（フォルダの規則は後から足したので、前の世代を違反にしない）。長い行は窓に分けて全部を見る（前の世代の長い行も Secret を見逃さない）。
 * 全体が budgetMs を超えたら ScanTimeout（違反なしと言わない）。
 */
export function policyViolations(rows, denyText, tmpRoot, { budgetMs = BACKUP_LIMITS.scan_budget_ms, clock = monotonic } = {}) {
  const tick = deadlineOf(budgetMs, clock);
  const clean = (r) => {
    tick();
    const text = r.body.toString('utf8');
    return !forms(path.basename(r.rel)).some((n) => SKIP_NAME.test(n)) && !mentionsTradingLab(r.rel) && !hasSecretChunked(text, tick) && !mentionsTradingLab(text);
  };
  const bad = rows.filter((r) => !clean(r)).length;
  const denied = deniedIndexes(rows, denyText, tmpRoot).size;
  tick();
  return bad + denied;
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
