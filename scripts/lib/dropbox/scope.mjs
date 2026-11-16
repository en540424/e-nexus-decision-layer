/**
 * Dropbox の業務の範囲（2026-11-13・docs/dropbox-business.md）。local config（Task Hub の store の config.json の `dropbox`。repo に置かない＝
 * 会社のフォルダ名を公開しない）を検査し、path ごとに「読んでよいか」「どこへ書くか」を決める。**Human が承認したフォルダだけ**を書く場所。
 *
 *   "dropbox": { "businesses": { "<business>": {
 *       "read_roots":     ["/<読んでよいフォルダ>", …],      資料の検索・一覧・閲覧（読み取り専用の資格情報）
 *       "schedule_files": ["/<工程表の file>", …],          工程表（読むだけ・バックアップの対象。書く道は無い）
 *       "estimate_roots": ["/<見積書の原本のフォルダ>", …],  AI 作業版の元にする原本（読むだけ）
 *       "output_root":    "/<business>"                     AI の出力（App folder の中の相対 path：karte・estimates・reports・restore）
 *       "deny_roots":     ["/<読ませないフォルダ>", …]       任意（2026-11-16）：read_roots の中でも読ませない場所（給与・人事・個人など）。どの読み方でも拒否
 *   } } }
 * 承認なしの一覧・検索（browse）は「read_roots の中」かつ「estimate_roots・deny_roots の外」だけ（2026-11-16 監査：広い read_roots の中に見積〈L2〉の
 * フォルダがあっても、承認なしの一覧・検索に名前も中身も出さない）。読みの資格情報は Full Dropbox なので、この表が読みの範囲を決める唯一の場所。
 * business が無い＝その business の Dropbox は閉じている（dropbox_business_not_enabled）。E-STEP を e-nexus の権限から広げない（business ごとに別の表）。
 * Dropbox の path は大文字小文字を区別しない＝比べる時は小文字にする。
 */
export class ScopeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const BUSINESS_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/;
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** 絶対 path の正規化（/ で始まる・. と .. の部分・空の部分・末尾の / を拒否）。正しければその path、違えば null */
export function normPath(p0) {
  if (typeof p0 !== 'string') return null;
  const p = p0.normalize('NFC'); // macOS から貼った NFD の名前も同じに比べる（監査 nit 6）
  if (!p.startsWith('/') || p.length > 1024 || BAD_CHARS.test(p)) return null;
  // 見えない文字（零幅の空白・bidi の向きの指定・BOM）を含む名前は扱わない＝返した名前の見た目で騙さない（2026-11-16 監査）。
  // 絵文字をつなぐ U+200D・U+200C は名前の一部として通す（フォルダ名の絵文字 1 つで config 全体を無効にしない・再検品）
  if (INVISIBLE.test(p)) return null;
  // 小文字にすると ASCII に変わる非 ASCII（ケルビンの K など）は拒否（大文字小文字を畳んだ比較で別のフォルダに化けさせない）
  if ([...p].some((c) => c.charCodeAt(0) > 127 && /^[\x00-\x7f]+$/.test(c.toLowerCase()))) return null;
  if (p === '/') return null; // Dropbox 全体は範囲にしない
  const parts = p.slice(1).split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..' || x.trim() !== x)) return null;
  return `/${parts.join('/')}`;
}
const under = (path, root) => { const a = path.toLowerCase(); const b = root.toLowerCase(); return a === b || a.startsWith(`${b}/`); };
const denied = (scope, p) => (scope.deny_roots ?? []).some((r) => under(p, r));
/**
 * 承認なしの一覧・検索に出してよい path か（正規化できる・read_roots の中・見積と読ませない場所の外）。Dropbox が返した一覧・検索の結果も 1 件ずつこれで絞る
 * （広いフォルダを検索した時に、その下の見積〈L2〉・読ませない場所の file の名前を返さない）
 */
export function browsable(scope, path) {
  const p = normPath(path);
  return Boolean(p) && scope.read_roots.some((r) => under(p, r)) && !scope.estimate_roots.some((r) => under(p, r)) && !denied(scope, p);
}

/** config の dropbox の節を検査して Map(business → scope) にする。形の誤りは投げる（config を読めない＝Dropbox は閉じたまま） */
export function loadScopes(cfg) {
  const out = new Map();
  if (cfg === undefined || cfg === null) return out;
  if (typeof cfg !== 'object' || typeof cfg.businesses !== 'object' || cfg.businesses === null) throw new ScopeError('dropbox_config_invalid');
  for (const [b, s] of Object.entries(cfg.businesses)) {
    if (!BUSINESS_RE.test(b) || typeof s !== 'object' || s === null) throw new ScopeError('dropbox_config_invalid');
    const list = (k) => {
      const v = s[k] ?? [];
      if (!Array.isArray(v) || v.length > 50) throw new ScopeError('dropbox_config_invalid');
      return v.map((x) => { const n = normPath(x); if (!n) throw new ScopeError('dropbox_config_invalid'); return n; });
    };
    const out_ = normPath(s.output_root);
    if (!out_) throw new ScopeError('dropbox_config_invalid');
    const scope = { business: b, read_roots: list('read_roots'), schedule_files: list('schedule_files'), estimate_roots: list('estimate_roots'), deny_roots: list('deny_roots'), output_root: out_ };
    // 読ませない場所の中に工程表・見積の原本を置く設定は矛盾（どちらを意図したか決められない）＝読み込まない
    if ([...scope.schedule_files, ...scope.estimate_roots].some((p) => scope.deny_roots.some((d) => under(p, d)))) throw new ScopeError('dropbox_config_invalid');
    out.set(b, Object.freeze(scope));
  }
  // 出力の場所は business ごとに分ける（重なれば他の business の karte を書き換えうる）
  const roots = [...out.values()].map((x) => x.output_root);
  // 同じ場所・重なる場所は拒否（index で比べる＝同じ文字列の 2 つも拒否・監査 F1）
  roots.forEach((a, i) => roots.forEach((b, j) => { if (i !== j && (under(a, b) || under(b, a))) throw new ScopeError('dropbox_config_invalid'); }));
  return out;
}

export function scopeOf(scopes, business) {
  const s = scopes.get(business);
  if (!s) throw new ScopeError('dropbox_business_not_enabled');
  return s;
}

/** 読んでよい path か。kind：'browse'（read_roots だけ＝承認なしの一覧・検索。見積〈L2〉のフォルダは入れない・監査 F7）・'schedule'・'estimate'・'any' */
export function assertReadable(scope, path, kind = 'any') {
  const p = normPath(path);
  if (!p) throw new ScopeError('dropbox_path_invalid');
  if (denied(scope, p)) throw new ScopeError('dropbox_path_not_allowed');
  const ok = {
    any: () => scope.read_roots.some((r) => under(p, r)) || scope.estimate_roots.some((r) => under(p, r)) || scope.schedule_files.some((f) => f.toLowerCase() === p.toLowerCase()),
    schedule: () => scope.schedule_files.some((f) => f.toLowerCase() === p.toLowerCase()),
    estimate: () => scope.estimate_roots.some((r) => under(p, r)),
    browse: () => browsable(scope, p),
  }[kind]?.();
  if (!ok) throw new ScopeError('dropbox_path_not_allowed');
  return p;
}

/** 検索の範囲（read_roots の 1 つ。指定が無ければ最初の 1 つ） */
export function searchRoot(scope, path = null) {
  if (path === null || path === undefined) {
    // 指定が無ければ、一覧・検索に出してよい最初の read_root（見積・読ませない場所の中の read_root は選ばない＝browsable と同じ判定・再検品）
    const first = scope.read_roots.find((r) => browsable(scope, r));
    if (!first) throw new ScopeError('dropbox_path_not_allowed');
    return first;
  }
  const p = normPath(path);
  if (!p || !browsable(scope, p)) throw new ScopeError('dropbox_path_not_allowed');
  return p;
}

const SAFE_NAME = /^[^\u0000-\u001f\u007f/\\:*?"<>|]{1,120}$/;
/** App folder の中の書く path（output_root/kind/name）。name は 1 つの名前だけ（/ を含まない） */
export function outputPath(scope, kind, name) {
  if (!['karte', 'estimates', 'reports', 'restore'].includes(kind)) throw new ScopeError('dropbox_output_kind');
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || name.trim() !== name || name === '.' || name === '..') throw new ScopeError('dropbox_name_invalid');
  return `${scope.output_root}/${kind}/${name}`;
}

/** 検索の結果を範囲の中だけに絞り直す（Dropbox の search の path の指定に頼りきらない・監査 nit 7） */
export function withinRoot(root, p) { const n = normPath(p); return Boolean(n) && under(n, root); }
