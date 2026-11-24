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
 *       "deny_names":     ["<名前の部品>", …]               任意（2026-11-18）：path のどの部分がこの語を含んでも読ませない（共通の下限 DENY_NAME_TERMS に足す。下限は config で外せない）
 *   } } }
 * 承認なしの一覧・検索（browse）は「read_roots の中」かつ「estimate_roots・deny_roots の外」だけ（2026-11-16 監査：広い read_roots の中に見積〈L2〉の
 * フォルダがあっても、承認なしの一覧・検索に名前も中身も出さない）。読みの資格情報は Full Dropbox なので、この表が読みの範囲を決める唯一の場所。
 * business が無い＝その business の Dropbox は閉じている（dropbox_business_not_enabled）。E-STEP を e-nexus の権限から広げない（business ごとに別の表）。
 * Dropbox の path は大文字小文字を区別しない＝比べる時は小文字にする。
 *
 * 全角と半角（2026-11-16・実の Dropbox での確かめ）：Dropbox は「（仮称）」と「(仮称)」、「工　事」と「工 事」を**別の名前**として扱う。一方 Task Hub の受け口（envelope）は
 * 依頼の文字を NFKC に揃える＝全角の名前のフォルダは、依頼の文字のままでは Dropbox に無い。そこで：
 *   許す側（read_roots・estimate_roots・schedule_files）は**実の名前**で比べる（config は Dropbox の名前のとおりに書く＝dropbox-preflight が確かめる）。
 *     依頼の path は matchRoot が NFKC で畳んで「どの許可フォルダの下か」を探し、resolve.mjs が許可フォルダの中の一覧から実の名前に直してから、実の名前で判定する
 *   断る側（deny_roots・一覧に出さない見積のフォルダ）は NFKC で畳んで比べる（広く断る＝config の書き方が全角半角だけ違っていても読ませない）
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
  // 小文字にすると長さが変わる文字（点つきの大文字 I など）も拒否：JS の小文字と Dropbox の比べ方が同じとは限らない文字で、許可フォルダの外を指させない（2026-11-16 監査）
  if ([...p].some((c) => c.toLowerCase().length !== c.length)) return null;
  if (p === '/') return null; // Dropbox 全体は範囲にしない
  const parts = p.slice(1).split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..' || x.trim() !== x)) return null;
  return `/${parts.join('/')}`;
}
const under = (path, root) => { const a = path.toLowerCase(); const b = root.toLowerCase(); return a === b || a.startsWith(`${b}/`); };
/** 見た目の同じ文字を同じにする比べ方（NFKC・小文字）。全角と半角・「㈱」と「(株)」を同じに見る */
export const foldPath = (p) => String(p).normalize('NFKC').toLowerCase();
const underFold = (path, root) => { const a = foldPath(path); const b = foldPath(root); return a === b || a.startsWith(`${b}/`); };
// 断る側は、前からの比べ方（小文字）と畳んだ比べ方（NFKC・小文字）のどちらかに当たれば断る（前より狭くならない）
const underWide = (path, root) => under(path, root) || underFold(path, root);

/**
 * 名前で読ませない（2026-11-18）：path のどの部分（フォルダ名・file 名）が下の語を含んでも、どの読み方でも断る。
 * 実の元請のフォルダに作業員名簿・保険証・給与の file が在った（名前だけでも一覧・検索に出さない）ことから、許可フォルダの書き方に頼らず
 * **個人の資料・給与・口座・Secret の名前を共通の下限として断る**。広げるだけの規則（読める範囲は広がらない）。比べ方は NFKC・小文字（全角半角・大文字小文字を畳む）。
 * business ごとの追加は config の `deny_names`。許可フォルダの名前そのものがこの語を含む設定は、全部が読めなくなるだけなので config の誤りとして断る
 */
export const DENY_NAME_TERMS = Object.freeze([
  '給与', '給料', '賃金', '賞与', '源泉徴収', '年末調整',
  '人事', '履歴書', '雇用契約', '労働条件', '労働者名簿', '従業員名簿', '作業員名簿', '名簿',
  '在留カード', '在留資格', '運転免許', '免許証', '保険証', '被保険者', '住民票', '年金', 'マイナンバー', '個人番号', '個人情報', '印鑑証明', '雇用保険', '社会保険', '健康診断', '健診', 'パスポート', '戸籍', '身分証', '資格確認書', '緊急連絡先',
  '通帳', '口座', '暗証', 'キャッシュカード',
  'パスワード', 'password', 'passwd', 'secret', 'シークレット', 'credential', '認証情報', '秘密鍵', 'apikey', 'api_key', 'api-key', 'access_token', 'refresh_token', 'private_key', 'id_rsa', 'id_ed25519', '.pem', '.p12', '.pfx', '.kdbx', '.env',
  'payroll', 'salary', 'passport', 'resume',
]);
/**
 * 比べる前に消す文字：空白類（全角の空白も）・見えない文字（Default_Ignorable＝零幅の接合子・異体字選択・結合の字形の制御など）・中黒。
 * 「履　歴　書」「給‍与」のように、字の間に挟んで下限をすり抜けさせない（2026-11-18 監査）。消すのは比べる時だけ＝名前そのものは変えない（広げるだけ）
 */
const SQUASH = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\u30fb\uff65]/gu;
export const squash = (s) => foldPath(s).replace(SQUASH, '');
/** 語を含むが別の意味の言葉（個人事業主・工事保険証券）。比べる前に取り除く＝その語だけで断らない（残りの部分に別の語が在れば断る） */
const NAME_EXEMPT = ['個人事業', '保険証券'].map(squash);
const DENY_NAME_FOLDED = DENY_NAME_TERMS.map(squash);
/** p の部分（/ で区切った名前）のどれかが拒む語を含むか（extra：config の deny_names を squash した物） */
export function nameDenied(p, extra = []) {
  const ex = extra.map(squash); // 畳んでいない語（全角など）が渡されても効く
  return String(p).split('/').some((seg) => {
    if (seg === '') return false;
    let x = squash(seg);
    for (const e of NAME_EXEMPT) x = x.split(e).join('');
    return DENY_NAME_FOLDED.some((t) => x.includes(t)) || ex.some((t) => t !== '' && x.includes(t));
  });
}
const denied = (scope, p) => (scope.deny_roots ?? []).some((r) => underWide(p, r)) || nameDenied(p, scope.deny_names ?? []);
/**
 * 承認なしの一覧・検索に出してよい path か（正規化できる・read_roots の中・見積と読ませない場所の外）。Dropbox が返した一覧・検索の結果も 1 件ずつこれで絞る
 * （広いフォルダを検索した時に、その下の見積〈L2〉・読ませない場所の file の名前を返さない）
 */
export function browsable(scope, path) {
  const p = normPath(path);
  return Boolean(p) && scope.read_roots.some((r) => under(p, r)) && !scope.estimate_roots.some((r) => underWide(p, r)) && !denied(scope, p);
}

/**
 * 依頼の path が、どの許可フォルダの下かを探す：{ root（config の書き方＝実の名前）, rest（その下の部分） }／null（どの下でもない）／{ ambiguous: true }（決められない）。
 * kind：'browse'（read_roots）・'estimate'（estimate_roots）・'any'（両方）。ここは「どこから実の名前を探し始めるか」を決めるだけ＝読んでよいかは実の名前で assertReadable が決める
 *   1. 依頼の文字のまま（大文字小文字だけのちがい）で下に在る許可フォルダがあれば、そのいちばん深い物（ぴったりが先。rest は依頼の文字のまま）
 *   2. 無ければ NFKC で畳んで下になる許可フォルダ。いちばん深い物を選ぶが、他の候補がその上の階層（実の名前で）でなければ決めない
 *      （畳むと同じ名前になる別々の許可フォルダのどちらかを、黙って選ばない・2026-11-16 監査）
 */
export function matchRoot(scope, path, kind = 'any') {
  const p = normPath(path);
  if (!p) return null;
  const roots = kind === 'browse' ? scope.read_roots : kind === 'estimate' ? scope.estimate_roots : kind === 'pdf' ? scope.pdf_roots ?? [] : [...scope.read_roots, ...scope.estimate_roots];
  const literal = roots.filter((r) => under(p, r)).sort((x, y) => y.length - x.length)[0];
  if (literal) return { root: literal, rest: p.split('/').slice(literal.split('/').length) };
  const f = foldPath(p);
  const cands = roots.filter((r) => { const fr = foldPath(r); return f === fr || f.startsWith(`${fr}/`); }).sort((x, y) => foldPath(y).length - foldPath(x).length);
  if (!cands.length) return null;
  const best = cands[0];
  if (cands.slice(1).some((c) => c.toLowerCase() !== best.toLowerCase() && !under(best, c))) return { ambiguous: true };
  // 残りは畳んだ形の部分の数で数える（全角の斜線「／」を含む名前は、畳むと部分が増える）
  return { root: best, rest: f === foldPath(best) ? [] : p.normalize('NFKC').split('/').slice(foldPath(best).split('/').length) };
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
    if (s.read_only !== undefined && typeof s.read_only !== 'boolean') throw new ScopeError('dropbox_config_invalid');
    const out_ = normPath(s.output_root);
    if (!out_) throw new ScopeError('dropbox_config_invalid');
    // 名前で読ませない語の追加（任意）。畳んだ形で持つ。空・長すぎる・制御文字・多すぎるは誤り（広げるだけの設定なので、誤りは閉じる側）
    const rawNames = s.deny_names ?? [];
    if (!Array.isArray(rawNames) || rawNames.length > 50 || rawNames.some((x) => typeof x !== 'string' || x.trim() === '' || x.length > 40 || BAD_CHARS.test(x) || INVISIBLE.test(x) || x.includes('/'))) throw new ScopeError('dropbox_config_invalid');
    const deny_names = rawNames.map((x) => squash(x));
    // 空白・見えない文字だけの語・1 字の語（「.」など）は、ほぼ全部の名前に当たる。畳んで「/」になる語（全角の斜線）は名前の 1 部分に当たらない＝効かない規則なので誤り
    if (deny_names.some((x) => [...x].length < 2 || x.includes('/'))) throw new ScopeError('dropbox_config_invalid');
    const scope = { business: b, read_roots: list('read_roots'), schedule_files: list('schedule_files'), estimate_roots: list('estimate_roots'), deny_roots: list('deny_roots'), deny_names, output_root: out_ };
    // 読ませない場所の中に工程表・見積の原本を置く設定は矛盾（どちらを意図したか決められない）＝読み込まない
    if ([...scope.schedule_files, ...scope.estimate_roots].some((p) => scope.deny_roots.some((d) => underWide(p, d)))) throw new ScopeError('dropbox_config_invalid');
    // 許可フォルダ・工程表・見積の原本の名前そのものが拒む語を含む設定も矛盾（下は全部が読めなくなる）。何が原因かを config の誤りと分けて示す
    if ([...scope.read_roots, ...scope.schedule_files, ...scope.estimate_roots].some((p) => nameDenied(p, deny_names))) throw new ScopeError('dropbox_config_denied_name');
    if (s.pdf_roots !== undefined) {
      scope.pdf_roots = list('pdf_roots');
      if (scope.pdf_roots.some((p) => denied(scope, p))) throw new ScopeError('dropbox_config_invalid');
    }
    if (s.read_only === true) scope.read_only = true;
    // 外へ返す範囲（2026-11-24・Human 決定 B）：Mac で読める範囲と、外のサービス（Grok など human-cli 以外の依頼元）へ名前・中身を返してよい範囲を分ける。
    // 狭めるだけ（allow_roots は read_roots の中・deny は足すだけ）。無ければ今までどおり（外へも browse の範囲）
    if (s.external !== undefined) {
      const e = s.external;
      if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => !['allow_roots', 'deny_roots', 'deny_names'].includes(k))) throw new ScopeError('dropbox_config_invalid');
      const sub = (k) => { const v = e[k] ?? []; if (!Array.isArray(v) || v.length > 50) throw new ScopeError('dropbox_config_invalid'); return v.map((x) => { const n = normPath(x); if (!n) throw new ScopeError('dropbox_config_invalid'); return n; }); };
      const allow = e.allow_roots === undefined ? null : sub('allow_roots');
      if (allow && allow.some((p) => !scope.read_roots.some((r) => under(p, r)))) throw new ScopeError('dropbox_config_invalid'); // 外へは Mac の範囲より広くしない
      const names = e.deny_names ?? [];
      if (!Array.isArray(names) || names.length > 50 || names.some((x) => typeof x !== 'string' || x.trim() === '' || x.length > 40 || BAD_CHARS.test(x) || INVISIBLE.test(x) || x.includes('/'))) throw new ScopeError('dropbox_config_invalid');
      const folded = names.map((x) => squash(x));
      if (folded.some((x) => [...x].length < 2 || x.includes('/'))) throw new ScopeError('dropbox_config_invalid');
      scope.external = Object.freeze({ allow_roots: allow, deny_roots: sub('deny_roots'), deny_names: folded });
    }
    out.set(b, Object.freeze(scope));
  }
  // 出力の場所は business ごとに分ける（重なれば他の business の karte を書き換えうる）
  const roots = [...out.values()].map((x) => x.output_root);
  // 同じ場所・重なる場所は拒否（index で比べる＝同じ文字列の 2 つも拒否・監査 F1）
  roots.forEach((a, i) => roots.forEach((b, j) => { if (i !== j && (under(a, b) || under(b, a))) throw new ScopeError('dropbox_config_invalid'); }));
  return out;
}

/**
 * 外のサービス（human-cli 以外の依頼元＝Grok など）へ、この path の名前・中身を返してよいか（2026-11-24・Human 決定 B）。
 * Mac で読めること（browsable・assertReadable）の上に重ねて使う。external が無ければ true（今までどおり）
 */
export function externalVisible(scope, path) {
  const p = normPath(path);
  if (!p) return false;
  const e = scope.external;
  if (!e) return true;
  if (e.allow_roots && !e.allow_roots.some((r) => under(p, r))) return false;
  return !e.deny_roots.some((r) => underWide(p, r)) && !nameDenied(p, e.deny_names);
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
    pdf: () => (scope.pdf_roots ?? []).some((r) => under(p, r)),
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
