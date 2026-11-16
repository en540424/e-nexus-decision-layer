/**
 * 現場カルテ（2026-11-13・Human 決定：AI が共通の書式を作り、Human が追記・編集する。docs/dropbox-business.md §2）。AI を使わない部分（書式・保存・履歴）。
 *
 *   置き場所：App folder の <output_root>/karte/<案件ID>.md（書く資格情報は App folder の外へ書けない）
 *   書式：決まった節（CARTE_SECTIONS）。値が無い項目は「未確認」（AI は事実を作らない＝渡された値だけを書く）。
 *     「未確認」の行は書式の印（PLACEHOLDER_LINE）つきで書く：その節に AI が値を差し込む時、**書式の位置（見出しの下の最初の行）にある、印つきのまま変わっていない 1 行だけ**を外す
 *     （値が入ったのに「未確認」が残らない）。Human が自分で書いた「未確認」・直した行は Human の文＝触らない（2026-11-16）
 *   文字：UTF-8 だけ。Human が Shift_JIS・UTF-16 で保存し直した file は読まない・書かない（karte_not_utf8）＝読めない文字を化けさせて上げ直さない（2026-11-16 監査）
 *   出所：AI が書いた所は `<!-- ai:<日時> task=<id> -->` と `<!-- /ai -->` で囲む。囲みの外は Human（と最初の書式）
 *   Human の追記を消さない：AI は file の既存の文字を 1 文字も変えず、節の末尾に新しい囲みを「差し込む」だけ（insertIntoSection）。
 *     上げる時は Dropbox の rev つきの update＝Human が同時に直していたら conflict → 読み直して差し込み直す（最大 2 回）
 *   履歴：上げる前の版を手元（business-backups/<business>/karte-history/）に残す。Dropbox の版の履歴とあわせて戻せる
 */
export const CARTE_SECTIONS = Object.freeze([
  ['site_name', '現場名'], ['case_id', '案件ID'], ['address', '所在地'], ['survey_date', '現地調査日'], ['schedule', '作業予定'],
  ['work', '工事内容'], ['building', '建物形状'], ['floors_height', '階数・高さ'], ['perimeter', '外周寸法'], ['scaffold_area', '足場面積の概算'],
  ['materials', '使用材料'], ['carport', 'カーポート'], ['special', '下屋・妻面・寄棟などの特殊条件'], ['access', '搬入経路'], ['neighborhood', '近隣・道路条件'],
  ['safety', '安全上の注意事項'], ['photos', '写真・図面への参照'], ['estimates', '見積書への参照'], ['process', '工程表への参照'],
  ['survey_log', '現調履歴'], ['human_log', 'Humanの追記・修正履歴'], ['ai_notes', 'AIによる整理・提案'], ['unknowns', '未確認事項'],
]);
const KEYS = new Map(CARTE_SECTIONS);
export const UNKNOWN = '未確認';
/** 書式の「未確認」の行。印は HTML のコメント（Markdown の表示には出ない）。ai: で始めない＝AI の囲みの数え方に混ざらない */
export const PLACEHOLDER_LINE = `${UNKNOWN} <!-- placeholder -->`;

/** Dropbox から取った bytes を文字にする。UTF-8 として読めなければ karte_not_utf8（置き換え文字 U+FFFD に化けた文を上げ直さない） */
export function decodeKarte(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new KarteError('karte_not_utf8'); }
}
export const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_VALUE = 2000;

export class KarteError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** 値の検査（制御文字と、囲みの印をまねる文字列を拒否） */
function cleanValue(v) {
  if (typeof v !== 'string') throw new KarteError('karte_value_invalid');
  // 書くのは渡された文字のまま（NFC）。NFKC にすると「㎡」「①」「㈱」「Ａ邸」が別の文字に変わり、依頼した文と違う文が残る（2026-11-16 監査）。
  // 検査は NFKC にした形でも行う（全角の <!-- や ＃ で印・見出しをまねさせない）
  const s = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const bad = (x) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(x) || /<!--|-->/.test(x) || /^\s*#{1,6}(\s|$)/m.test(x); // 見出しをまねる行（空白の後の # も）は拒否・「#1 西側」は可（監査 F6・N2）
  if (!s || s.length > MAX_VALUE || bad(s) || bad(s.normalize('NFKC'))) throw new KarteError('karte_value_invalid');
  return s;
}
const aiOpen = (at, taskId) => `<!-- ai:${at} task=${taskId} -->`;
const AI_CLOSE = '<!-- /ai -->';

/** 新しいカルテの本文。fields に無い項目は「未確認」（AI が埋めた値は囲みの中） */
export function newKarte({ caseId, siteName, fields = {}, at, taskId }) {
  if (!CASE_ID_RE.test(caseId ?? '')) throw new KarteError('karte_case_id_invalid');
  const values = { ...fields, case_id: caseId, site_name: siteName };
  for (const k of Object.keys(values)) if (!KEYS.has(k)) throw new KarteError('karte_field_unknown');
  const lines = [`# 現場カルテ：${cleanValue(siteName)}`, '', `> AI が作った共通の書式。Human はどこに書き足しても・直してもよい（AI は Human の文を書き換えない）。AI が書いた所は「ai:」の印で囲む。`, ''];
  for (const [k, label] of CARTE_SECTIONS) {
    lines.push(`## ${label}`, '');
    const v = values[k];
    if (v === undefined || v === null || v === '') lines.push(PLACEHOLDER_LINE);
    else lines.push(aiOpen(at, taskId), cleanValue(String(v)), AI_CLOSE);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

const bare = (l) => l.replace(/\r$/, ''); // CRLF で保存された file の行末
/** 書式の位置（見出しの下の最初の空でない行）にある、印つきのまま変わっていない「未確認」の行の番号。無ければ -1 */
function templatePlaceholder(lines, start, end) {
  for (let i = start + 1; i < end; i += 1) {
    if (lines[i].trim() === '') continue;
    return bare(lines[i]) === PLACEHOLDER_LINE ? i : -1;
  }
  return -1;
}

/** 節の見出しの行の位置（## <label>）。AI の囲みの中の行は見出しとして数えない（監査 F6）。無ければ null */
function sectionBounds(text, label) {
  const lines = text.split('\n');
  const heading = lines.map(() => false);
  let inAi = false;
  lines.forEach((l, i) => {
    // 閉じていない ai の印（Human が /ai の行を消した）でも、次の見出しで AI の囲みは終わる（AI の値は見出しを含めない＝囲みの中に見出しは無い・監査 N1）
    if (/^<!-- ai:[^>]*-->$/.test(l.trim())) inAi = true;
    else if (l.trim() === AI_CLOSE) inAi = false;
    else if (/^## /.test(l)) { heading[i] = true; inAi = false; }
  });
  const start = lines.findIndex((l, i) => heading[i] && l.trim() === `## ${label}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (heading[i]) { end = i; break; }
  return { lines, start, end };
}

/**
 * 節の末尾に AI の囲みを差し込む。既存の文字は変えない（差し込む前と後で、差し込んだ所以外が同じことを確かめる）。
 * 節が無ければ（Human が見出しを消した）file の末尾に節ごと足す。dated：日付つきの追記（現調履歴など）
 */
export function insertIntoSection(text, { section, value, at, taskId, dated = null }) {
  const label = KEYS.get(section);
  if (!label) throw new KarteError('karte_field_unknown');
  const v = cleanValue(value);
  const block = [aiOpen(at, taskId), dated ? `- ${dated}：${v}` : v, AI_CLOSE];
  const b = sectionBounds(text, label);
  if (!b) {
    // 見出しが無い（Human が消した）：末尾に節ごと足す（既存の文字はそのまま前に残る）
    const base = text.endsWith('\n') ? text : `${text}\n`;
    return `${base}\n## ${label}\n\n${block.join('\n')}\n`;
  }
  // 書式の「未確認」の行を外す：値が入る節に「未確認」を残さない。外すのは書式の位置（見出しの下の最初の行）にある、印つきのまま変わっていない 1 行だけ。
  // 同じ文字の行でも、Human が項目の下に写した行・他の位置の行は Human の文＝触らない（2026-11-16 再検品）。それ以外の行は 1 文字も変えない
  const dropAt = templatePlaceholder(b.lines, b.start, b.end);
  const kept = b.lines.map((l, i) => ({ l, i })).filter((x) => x.i !== dropAt);
  // 節の末尾の空行の前に差し込む
  let pos = kept.findIndex((x) => x.i >= b.end);
  if (pos < 0) pos = kept.length;
  while (pos - 1 >= 0 && kept[pos - 1].i > b.start && kept[pos - 1].l.trim() === '') pos -= 1;
  // 節が空（書式の行を外した後）なら、見出しの下の空行を 1 つ残してから差し込む
  if (kept[pos - 1]?.i === b.start && kept[pos] && kept[pos].i < b.end && kept[pos].l.trim() === '') pos += 1;
  const lines = [...kept.slice(0, pos).map((x) => x.l), ...block, ...kept.slice(pos).map((x) => x.l)];
  // 既存の文字を消していない：出来上がりから差し込んだ行を除いた物が、元の文から書式の 1 行だけを除いた物と同じ
  const expected = text.split('\n');
  if (dropAt >= 0) { if (bare(expected[dropAt]) !== PLACEHOLDER_LINE) throw new KarteError('karte_insert_changed_text'); expected.splice(dropAt, 1); }
  const out = lines.join('\n');
  const got = out.split('\n');
  got.splice(pos, block.length);
  if (got.join('\n') !== expected.join('\n') || out.split('\n').slice(pos, pos + block.length).join('\n') !== block.join('\n')) throw new KarteError('karte_insert_changed_text');
  return out;
}

/** AI の囲みの数と、囲みの外（Human と書式）の文字数（出所の記録・要約用） */
export function provenance(text) {
  const ai = text.match(/<!-- ai:[^>]*-->[\s\S]*?<!-- \/ai -->/g) ?? [];
  const outside = text.replace(/<!-- ai:[^>]*-->[\s\S]*?<!-- \/ai -->/g, '');
  return { ai_blocks: ai.length, human_chars: outside.replace(/\s+/g, '').length };
}

/** 節の中身（囲みの印を外した文）。注意事項・未確認事項の報告に使う */
export function sectionText(text, section) {
  const label = KEYS.get(section);
  const b = label ? sectionBounds(text, label) : null;
  if (!b) return null;
  const body = b.lines.slice(b.start + 1, b.end);
  // 書式の位置の「未確認」の行は、他に何か書いてあれば出さない（Human が印の行を残したまま下に書いた時）。何も無ければ「未確認」。他の位置の同じ行は Human の文としてそのまま出す
  const at = templatePlaceholder(b.lines, b.start, b.end);
  const rest = body.filter((_, i) => b.start + 1 + i !== at);
  const shown = at >= 0 && rest.some((l) => l.replace(/<!-- \/?ai[^>]*-->/g, '').trim() !== '') ? rest : body;
  return shown.join('\n').replace(/<!-- \/?ai[^>]*-->/g, '').replace(/ <!-- placeholder -->/g, '').trim();
}

/** まだ書式の「未確認」のままの項目（何も書かれていない節）の名前。報告の「未確認の項目」に使う */
export function unknownSections(text) {
  return CARTE_SECTIONS.filter(([k]) => sectionText(text, k) === UNKNOWN).map(([, label]) => label);
}

/**
 * Dropbox との読み書き（writer は role 'write' の client＝App folder の中だけ）。history(prevText) は上げる前の版を手元に残す関数
 * 差し込み：読む → 差し込む → rev つきで上げる。conflict（Human が同時に直した）は読み直して最大 2 回
 */
export async function appendToKarte({ writer, path, section, value, at, taskId, dated = null, history = () => {}, signal }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { bytes, meta } = await writer.download(path, { signal });
    const before = decodeKarte(bytes);
    // 同じ task がもう差し込んでいる（時間切れの後の古い試行・読み直しの間に別の試行が書いた）＝二重に書かない（2026-11-16 監査）
    if (before.includes(`task=${taskId} -->`)) return { already: true, rev: meta.rev, previous_rev: meta.rev, ...provenance(before) };
    const after = insertIntoSection(before, { section, value, at, taskId, dated });
    history(bytes, meta.rev); // 上げる前の版は取った bytes のまま残す
    try {
      const up = await writer.upload(path, Buffer.from(after, 'utf8'), { rev: meta.rev, signal });
      return { rev: up.rev, previous_rev: meta.rev, ...provenance(after) };
    } catch (e) {
      if (e?.code !== 'dropbox_path_conflict') throw e; // 同時の編集（rev の不一致）だけ読み直す。空きが無い等はそのまま失敗
    }
  }
  throw new KarteError('karte_conflict');
}
