/**
 * 依頼の path を Dropbox の実の path に直す（2026-11-16・実の Dropbox での確かめ）。
 *
 * なぜ要るか：Task Hub の受け口は依頼の文字を NFKC に揃える（全角→半角・「㈱」→「(株)」）。Dropbox は全角と半角を別の名前として扱う＝
 * 「工　事」「Q＆A」「山田様邸（仮称）」のような全角を含む名前は、依頼の文字のままでは path_not_found になる（日本語の業務のフォルダでは普通の名前）。
 *
 * 直し方（読む範囲を広げない）：
 *   1. 依頼の path がどの許可フォルダの下かを探す（scope.matchRoot：依頼の文字のままが先・無ければ畳んだ形）。無ければ dropbox_path_not_allowed・決められなければ dropbox_path_ambiguous
 *   2. 許可フォルダ（config の書き方＝実の名前）＋残りをそのまま Dropbox に聞く。在れば、その実の名前で読んでよいかを判定して終わり
 *   3. 無ければ、許可フォルダから 1 段ずつ下りる。各段は「その名前のまま在るか」を先に聞き（ぴったりが先）、無ければ一覧から畳むと同じになる名前の子を選ぶ。
 *      **下りる前に毎回、実の名前で読んでよいかを判定する**（読ませない場所・一覧に出さない見積のフォルダの中の一覧は取らない）。
 *      畳むと同じ子が 2 つ以上・一覧が上限で切れていて他に同じ子が無いと言えない時は dropbox_path_ambiguous（黙って片方を選ばない）
 * Dropbox に聞く path は、いつも「実の名前の許可フォルダ」から始まる（依頼の書き方の許可フォルダの名前は送らない）。
 * 一覧を取るのは許可フォルダの中だけ。1 段の一覧は 2000 件まで。選んだ後は戻らない＝全角の斜線「／」を含む名前は、同じ始まりの別の名前が在ると指せないことがある（止まる側）
 */
import { assertReadable, foldPath, matchRoot, normPath, ScopeError } from './scope.mjs';

const isNotFound = (e) => /_not_found$/.test(String(e?.code ?? ''));
const LIST_LIMIT = 2000;

/** その path が在れば Dropbox の名前（畳むと同じ時だけ信じる）、無ければ null */
async function exists(reader, p, signal) {
  try { const meta = await reader.metadata(p, { signal }); return typeof meta.path === 'string' && foldPath(meta.path) === foldPath(p) ? meta.path : p; } catch (e) { if (!isNotFound(e)) throw e; return null; }
}

/**
 * reader：読みの client（list・metadata）。kind：'browse'｜'estimate'｜'any'（scope.assertReadable と同じ）。戻り値：実の path（Dropbox の名前）
 */
export async function resolveReal(reader, scope, requested, kind = 'any', { signal } = {}) {
  if (!normPath(requested)) throw new ScopeError('dropbox_path_invalid');
  const m = matchRoot(scope, requested, kind);
  if (!m) throw new ScopeError('dropbox_path_not_allowed');
  if (m.ambiguous) throw new ScopeError('dropbox_path_ambiguous');
  let cur = assertReadable(scope, m.root, kind);
  if (!m.rest.length) return cur;
  // 2. そのまま在るか（全角を含まない名前はここで終わる＝通信は 1 回）
  const direct = normPath(`${cur}/${m.rest.join('/')}`);
  if (!direct) throw new ScopeError('dropbox_path_invalid');
  assertReadable(scope, direct, kind);
  const hit = await exists(reader, direct, signal);
  if (hit) return assertReadable(scope, hit, kind);
  // 3. 1 段ずつ下りる
  for (let i = 0; i < m.rest.length;) {
    // ぴったりの名前が先（一覧の順・一覧の上限に左右されない）
    const plain = normPath(`${cur}/${m.rest[i]}`);
    if (!plain) throw new ScopeError('dropbox_path_invalid');
    assertReadable(scope, plain, kind);
    const same1 = await exists(reader, plain, signal);
    if (same1) { cur = assertReadable(scope, same1, kind); i += 1; continue; }
    const { entries, truncated } = await reader.list(cur, { limit: LIST_LIMIT, signal });
    let next = null;
    let used = 0;
    // 普通は 1 部分＝1 つの名前。全角の斜線「／」を含む名前は、畳むと 2 部分以上に割れる＝続く部分をつないだ形でも探す
    for (let k = 1; k <= Math.min(3, m.rest.length - i) && !next; k += 1) {
      const want = m.rest.slice(i, i + k).join('/');
      const same = entries.filter((x) => foldPath(x.name) === foldPath(want));
      if (!same.length) continue;
      if (same.length > 1 || truncated) throw new ScopeError('dropbox_path_ambiguous'); // 同じに畳まれる子が他にも在る（か、在らないと言えない）
      next = same[0];
      used = k;
    }
    if (!next) throw new ScopeError('dropbox_path_not_found');
    cur = assertReadable(scope, next.path, kind); // 実の名前で判定してから下りる
    i += used;
  }
  return cur;
}

/**
 * Dropbox の file の ID（`id:…`）から実の path を引き、その path で読んでよいかを判定する（2026-11-24・E-STEP LINK の files.dropbox_id への準備）。
 * まだどの intent にもつないでいない（LINK の sites/ を許可フォルダに足すのは Human の承認）。
 *
 * - ID の形は `id:` ＋ 英数字・`_`・`-`（Dropbox の ID の形）。それ以外は dropbox_id_invalid（Dropbox に聞かない）
 * - Dropbox が返した ID が依頼の ID と違う・path が無い（共有の外など）・許可フォルダの外・読ませない名前・一覧に出さない見積のフォルダ（kind に依る）は、
 *   **どれも dropbox_id_not_readable**（無い ID と区別しない＝範囲の外に file が在ることを教えない）
 * - 戻り値は実の path と rev。**読む時は ID ではなく、この path と rev で読む**（判定の後に file が範囲の外へ動かされても、ID で読んで外の file を返さない）
 */
const ID_RE = /^id:[A-Za-z0-9_-]{1,128}$/;
export async function resolveById(reader, scope, id, kind = 'any', { signal } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ScopeError('dropbox_id_invalid');
  let meta;
  try { meta = await reader.metadata(id, { ids: true, signal }); } catch (e) { if (isNotFound(e)) throw new ScopeError('dropbox_id_not_readable'); throw e; }
  const p = meta?.id === id && typeof meta.path === 'string' ? normPath(meta.path) : null;
  if (!p) throw new ScopeError('dropbox_id_not_readable');
  try { return { path: assertReadable(scope, p, kind), tag: meta.tag, ...(meta.rev ? { rev: meta.rev } : {}) }; } catch (e) { if (e instanceof ScopeError) throw new ScopeError('dropbox_id_not_readable'); throw e; }
}
