/**
 * 現場カルテ（2026-11-13・Human 決定：AI が共通の書式を作り、Human が追記・編集する。docs/dropbox-business.md §2）。AI を使わない部分（書式・保存・履歴）。
 *
 *   置き場所：App folder の <output_root>/karte/<案件ID>.md（書く資格情報は App folder の外へ書けない）
 *   書式：決まった節（CARTE_SECTIONS）。値が無い項目は「未確認」（AI は事実を作らない＝渡された値だけを書く）
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
export const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_VALUE = 2000;

export class KarteError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** 値の検査（制御文字と、囲みの印をまねる文字列を拒否） */
function cleanValue(v) {
  if (typeof v !== 'string') throw new KarteError('karte_value_invalid');
  const s = v.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (!s || s.length > MAX_VALUE || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s) || /<!--|-->/.test(s) || /^\s*#{1,6}(\s|$)/m.test(s)) throw new KarteError('karte_value_invalid'); // 見出しをまねる行（空白の後の # も）は拒否・「#1 西側」は可（監査 F6・N2）
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
    if (v === undefined || v === null || v === '') lines.push(UNKNOWN);
    else lines.push(aiOpen(at, taskId), cleanValue(String(v)), AI_CLOSE);
    lines.push('');
  }
  return `${lines.join('\n')}`;
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
  // 節の末尾の空行の前に差し込む
  let pos = b.end;
  while (pos - 1 > b.start && b.lines[pos - 1].trim() === '') pos -= 1;
  const lines = [...b.lines.slice(0, pos), ...block, ...b.lines.slice(pos)];
  // 既存の文字を消していない：差し込んだ行を除けば元と同じ
  if ([...lines.slice(0, pos), ...lines.slice(pos + block.length)].join('\n') !== text) throw new KarteError('karte_insert_changed_text');
  const out = lines.join('\n');
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
  return b.lines.slice(b.start + 1, b.end).join('\n').replace(/<!-- \/?ai[^>]*-->/g, '').trim();
}

/**
 * Dropbox との読み書き（writer は role 'write' の client＝App folder の中だけ）。history(prevText) は上げる前の版を手元に残す関数
 * 差し込み：読む → 差し込む → rev つきで上げる。conflict（Human が同時に直した）は読み直して最大 2 回
 */
export async function appendToKarte({ writer, path, section, value, at, taskId, dated = null, history = () => {}, signal }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { bytes, meta } = await writer.download(path, { signal });
    const before = bytes.toString('utf8');
    const after = insertIntoSection(before, { section, value, at, taskId, dated });
    history(before, meta.rev);
    try {
      const up = await writer.upload(path, Buffer.from(after, 'utf8'), { rev: meta.rev, signal });
      return { rev: up.rev, previous_rev: meta.rev, ...provenance(after) };
    } catch (e) {
      if (e?.code !== 'dropbox_path_conflict') throw e; // 同時の編集（rev の不一致）だけ読み直す。空きが無い等はそのまま失敗
    }
  }
  throw new KarteError('karte_conflict');
}
