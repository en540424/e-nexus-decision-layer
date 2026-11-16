/**
 * 見積書の AI 作業版（2026-11-13・Human 決定・docs/dropbox-business.md §3）：Human の原本は読むだけ。AI はその写し（AI 作業版）に AI の tab を足す・直す。
 *
 *   足す：新しい sheet の部品 1 つと、workbook.xml・workbook.xml.rels・[Content_Types].xml に「1 行ずつ足す」だけ。他の部品は圧縮された bytes のまま
 *   直す：AI の tab（名前が AI_ で始まり、台帳に AI が作ったと記録した tab）の部品だけを差し替える
 *   守る：保存の前に verifyPreserved が「Human の tab と他の部品が 1 byte も変わっていない・workbook 等は足した行を除けば元と同じ」を確かめる。
 *         違えば保存しない（xlsx_preserve_failed）。マクロ（vbaProject.bin）・画像・印影・外部リンク・書式・印刷設定・定義名・計算の設定は触らない
 *   数式：金額は =数量*単価、合計は =SUM(…)。計算した値も <v> に入れる（開いた時に再計算を待たずに見える）
 */
import { entryData, makeEntry, readZip, writeZip, XlsxError } from './zip.mjs';

export { XlsxError };
const WB = 'xl/workbook.xml';
const WB_RELS = 'xl/_rels/workbook.xml.rels';
const CT = '[Content_Types].xml';
const WS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const WS_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
export const AI_PREFIX = 'AI_';
const MAX_ROWS = 300;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (entries, name) => { const e = entries.find((x) => x.name === name); if (!e) throw new XlsxError('xlsx_part_missing'); return entryData(e).toString('utf8'); };

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unesc(m[2] ?? m[3]); // 一重引用符も（監査 nit 4）
  return out;
}

/** sheet の一覧：{ name, sheetId, rid, ridAttr, part } */
export function listSheets(entries) {
  const wb = text(entries, WB);
  const rels = text(entries, WB_RELS);
  const relMap = new Map([...rels.matchAll(/<Relationship\b[^>]*\/?>/g)].map((m) => attrs(m[0])).map((a) => [a.Id, a]));
  const sheetsBlock = wb.match(/<(?:\w+:)?sheets\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheets>/);
  if (!sheetsBlock) throw new XlsxError('xlsx_part_missing');
  return [...sheetsBlock[1].matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/g)].map((m) => {
    const a = attrs(m[0]);
    const ridAttr = Object.keys(a).find((k) => /:id$/.test(k)) ?? 'r:id';
    const rel = relMap.get(a[ridAttr]);
    const target = rel?.Target ?? '';
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    return { name: a.name, sheetId: Number(a.sheetId), rid: a[ridAttr], ridAttr, part, isWorksheet: rel?.Type === WS_TYPE };
  });
}

export function validSheetName(name, existing) {
  if (typeof name !== 'string' || !name.startsWith(AI_PREFIX) || name.length > 31 || /[[\]:*?/\\]/.test(name) || /[\u0000-\u001f]/.test(name) || /^'|'$/.test(name)) return false;
  return !existing.some((s) => s.name.toLowerCase() === name.toLowerCase());
}

/** 見積の行（{ item, spec?, qty, unit, price, note? }）→ sheet の XML（見出し・明細・合計）。金額と合計は数式と計算済みの値 */
export function estimateSheetXml({ title, rows, stamp }) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) throw new XlsxError('estimate_rows_invalid');
  // 文字は渡されたまま（NFC）。NFKC にすると「㎡」「①」「㈱」「Ａ邸」が別の文字に変わり、Human が承認した全文と違う見積になる（2026-11-16 監査）
  const str = (v, max = 200) => { const s = String(v ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim(); if (s.length > max) throw new XlsxError('estimate_text_too_long'); return s; };
  const num = (v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9) throw new XlsxError('estimate_number_invalid'); return Math.round(v * 1000) / 1000; };
  const cells = [];
  const sCell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const nCell = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
  const fCell = (ref, f, v) => `<c r="${ref}"><f>${esc(f)}</f><v>${v}</v></c>`;
  cells.push(`<row r="1">${sCell('A1', str(title, 120))}${sCell('G1', str(stamp, 120))}</row>`);
  cells.push(`<row r="3">${['項目', '仕様', '数量', '単位', '単価', '金額', '備考'].map((h, i) => sCell(`${'ABCDEFG'[i]}3`, h)).join('')}</row>`);
  let total = 0;
  rows.forEach((r, i) => {
    const n = 4 + i;
    const qty = num(r.qty);
    const price = num(r.price);
    const amount = Math.round(qty * price * 1000) / 1000;
    total += amount;
    cells.push(`<row r="${n}">${sCell(`A${n}`, str(r.item))}${sCell(`B${n}`, str(r.spec ?? ''))}${nCell(`C${n}`, qty)}${sCell(`D${n}`, str(r.unit ?? '', 20))}${nCell(`E${n}`, price)}${fCell(`F${n}`, `C${n}*E${n}`, amount)}${sCell(`G${n}`, str(r.note ?? ''))}</row>`);
  });
  const last = 3 + rows.length;
  const t = last + 2;
  cells.push(`<row r="${t}">${sCell(`E${t}`, '合計')}${fCell(`F${t}`, `SUM(F4:F${last})`, Math.round(total * 1000) / 1000)}</row>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="20" customWidth="1"/><col min="7" max="7" width="24" customWidth="1"/></cols><sheetData>${cells.join('')}</sheetData></worksheet>`;
}

/**
 * AI の tab の要点（保存の前後の差分に使う・2026-11-16）：明細の行数と合計。この module が作った形（合計＝SUM(F4:F<最後>) の数式）だけを読む。
 * 形が違う（Human がその tab を作り変えた）時は null＝「読めなかった」と返し、数を作らない
 */
export function summarizeAiSheet(xml) {
  const m = String(xml).match(/<f>SUM\(F4:F(\d+)\)<\/f>\s*<v>([^<]+)<\/v>/); // 値が空（<v></v>）は読めない扱い＝0 と作らない
  if (!m) return null;
  const rows = Number(m[1]) - 3;
  const total = Number(m[2]);
  return Number.isInteger(rows) && rows >= 1 && Number.isFinite(total) ? { rows, total } : null;
}

/** 数式を持つ要素の中身（f・formula・formula1/2・definedName・グラフの c:f）。XML の escape を戻した文字 */
const formulasIn = (xml) => [...xml.matchAll(/<(?:\w+:)?(?:f|formula[12]?|definedName)\b[^>]*>([^<]*)</g)].map((m) => unesc(m[1]));
/** 複数の tab にまたがる範囲（'見積:内訳'!F7・Sheet1:Sheet3!A1）。間に挟まる tab は名前で探せないので、在れば「参照されているかもしれない」と扱う */
const RANGE_3D = /(?:'(?:[^']|'')*:(?:[^']|'')*'|[^\s'"!:,;()+\-*/=&^<>]+:[^\s'"!:,;()+\-*/=&^<>]+)!/;
/**
 * この tab を、他の部品（Human の tab の数式・定義名・条件つき書式・入力規則・グラフ・ピボットの元・リンク）が参照しているか（大文字小文字は区別しない）。
 * 探す形：「名前!」「'名前'!」（XML の中では &apos; のことも）・ピボットの元の sheet="名前"・複数の tab にまたがる範囲（どの tab でも）。
 * 疑わしい時は「参照されている」（止まる側）。例外：AI の tab 自身の印刷範囲・フィルターの定義名（_xlnm.*・localSheetId がその tab）は参照に数えない
 * ＝Human が AI の tab に印刷範囲を付けただけで、以後の直しが全部断られないように（2026-11-16 再検品）
 */
export function sheetReferenced(entries, name, ownPart) {
  const lower = name.toLowerCase();
  const quoted = lower.replace(/'/g, "''");
  const inFormula = (f) => { const t = f.toLowerCase(); return t.includes(`${lower}!`) || t.includes(`'${quoted}'!`) || RANGE_3D.test(f); };
  const rawNeedles = [`${esc(name)}!`, `'${esc(name.replace(/'/g, "''"))}'!`, `&apos;${esc(name).replace(/'/g, '&apos;&apos;')}&apos;!`, `sheet="${esc(name)}"`].map((x) => x.toLowerCase());
  const index = listSheets(entries).findIndex((x) => x.name === name);
  for (const e of entries) {
    if (e.name === ownPart || e.name === CALC || !/^xl\/.*\.xml$/.test(e.name)) continue;
    let xml = entryData(e).toString('utf8');
    if (e.name === WB) {
      // sheets の一覧（その tab 自身の宣言）と、その tab 自身の _xlnm.* の定義名は見ない
      xml = xml.replace(/<(?:\w+:)?sheets\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheets>/, '').replace(/<(?:\w+:)?definedName\b[^>]*>[^<]*<\/(?:\w+:)?definedName>/g, (tag) => {
        const a = attrs(tag.slice(0, tag.indexOf('>') + 1));
        return /^_xlnm\./.test(a.name ?? '') && a.localSheetId === String(index) ? '' : tag;
      });
    }
    if (rawNeedles.some((n) => xml.toLowerCase().includes(n))) return true;
    if (formulasIn(xml).some(inFormula)) return true;
  }
  return false;
}

/** AI の tab を足す。戻り値：{ bytes, sheet: { name, part }, preserved }。足した 3 行と新しい部品以外は元のまま（verifyPreserved で確かめてから返す） */
export function addAiSheet(buf, { name, xml }) {
  const entries = readZip(buf);
  const sheets = listSheets(entries);
  if (!validSheetName(name, sheets)) throw new XlsxError('xlsx_sheet_name_invalid');
  // Human が「ブックの構成を保護」した見積には tab を足さない（保護の意図に反する・2026-11-16 監査）
  const prot = text(entries, WB).match(/<(?:\w+:)?workbookProtection\b[^>]*>/);
  if (prot && ['1', 'true'].includes(attrs(prot[0]).lockStructure)) throw new XlsxError('estimate_workbook_structure_locked');
  const used = new Set(entries.map((e) => e.name));
  let n = sheets.length + 1;
  while (used.has(`xl/worksheets/sheet${n}.xml`)) n += 1;
  const part = `xl/worksheets/sheet${n}.xml`;
  const rels = text(entries, WB_RELS);
  const rids = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
  let k = rids.size + 1;
  while (rids.has(`rId${k}`)) k += 1;
  const rid = `rId${k}`;
  const sheetId = Math.max(0, ...sheets.map((s) => s.sheetId).filter(Number.isFinite)) + 1;
  const ridAttr = sheets[0]?.ridAttr ?? 'r:id';
  const wb = text(entries, WB);
  const closeSheets = wb.match(/<\/((?:\w+:)?)sheets>/);
  if (!closeSheets) throw new XlsxError('xlsx_part_missing');
  const sheetTag = `<${closeSheets[1]}sheet name="${esc(name)}" sheetId="${sheetId}" ${ridAttr}="${rid}"/>`;
  const wb2 = wb.replace(closeSheets[0], `${sheetTag}${closeSheets[0]}`);
  const relTag = `<Relationship Id="${rid}" Type="${WS_TYPE}" Target="worksheets/sheet${n}.xml"/>`;
  const rels2 = rels.replace('</Relationships>', `${relTag}</Relationships>`);
  const ct = text(entries, CT);
  const ctTag = `<Override PartName="/${part}" ContentType="${WS_CT}"/>`;
  const ct2 = ct.replace('</Types>', `${ctTag}</Types>`);
  if (wb2 === wb || rels2 === rels || ct2 === ct) throw new XlsxError('xlsx_part_missing');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const out = entries.map((e) => (e.name === WB ? makeEntry(WB, Buffer.from(wb2), e) : e.name === WB_RELS ? makeEntry(WB_RELS, Buffer.from(rels2), e) : e.name === CT ? makeEntry(CT, Buffer.from(ct2), e) : e));
  // 新しい sheet は最後の worksheet の後ろ（並びは zip の中の順番で意味を持たない）
  out.push(makeEntry(part, Buffer.from(xml), byName.get(sheets[0]?.part) ?? null));
  const bytes = writeZip(out);
  const { preserved } = verifyPreserved(buf, bytes, { added: { part, inserts: { [WB]: sheetTag, [WB_RELS]: relTag, [CT]: ctTag } } });
  return { bytes, sheet: { name, part, sheetId }, preserved, sheets_before: sheets.map((x) => x.name) };
}

const CALC = 'xl/calcChain.xml';
/** calcChain の項目（r と、省略を補った i）。i を省いた項目は前の項目の i を継ぐ */
function calcEntries(xml) {
  let cur = null;
  return [...xml.matchAll(/<c\b[^>]*?\/>/g)].map((m) => { const a = attrs(m[0]); if (a.i !== undefined) cur = a.i; return { r: a.r, i: cur ?? '0', tag: m[0], hasI: a.i !== undefined }; });
}
/** 数式の cell の位置（新しい AI の tab の calcChain の項目にする） */
const formulaRefs = (xml) => [...xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*><f>/g)].map((m) => m[1]);
function rewriteCalc(calcXml, sheetId, refs) {
  const root = calcXml.match(/^[\s\S]*?<calcChain\b[^>]*>/);
  if (!root) throw new XlsxError('xlsx_part_missing');
  const keep = calcEntries(calcXml).filter((e) => e.i !== String(sheetId));
  // 残す項目は元の tag のまま（l・s・t・a も残す）。i を省いていた項目は、前の項目を消すと継ぐ i が変わりうるので i を書き足す（監査 N3）
  const body = [...keep.map((e) => (e.hasI ? e.tag : e.tag.replace(/^<c\b/, `<c i="${e.i}"`))), ...refs.map((r) => `<c r="${r}" i="${sheetId}"/>`)].join('');
  return `${root[0]}${body}</calcChain>`;
}

/**
 * AI の tab の中身を差し替える（その部品だけ）。aiSheets・aiParts：台帳に AI が作ったと記録した tab の名前と部品（名前を付け替えた Human の tab を直さない・監査 nit 5）。
 * Excel で一度保存された写しは calcChain に AI の tab の数式の位置が残る：その tab の項目だけを新しい数式の位置に替える（古い位置のままだと Excel が修復を求める・監査 F9）
 */
export function replaceAiSheet(buf, { name, xml, aiSheets, aiIds = {} }) {
  const entries = readZip(buf);
  const s = listSheets(entries).find((x) => x.name === name);
  // 台帳の sheetId と同じ tab だけ（Excel は保存で sheetN.xml を付け直すが sheetId は保つ・名前を付け替えた Human の tab は sheetId が違う・監査 N4）
  if (!s || !name.startsWith(AI_PREFIX) || !aiSheets.includes(name) || (aiIds[name] !== undefined && aiIds[name] !== s.sheetId)) throw new XlsxError('estimate_not_ai_sheet');
  // 作り直すと行の位置（合計の cell など）が動く。Human の tab・定義名・グラフがこの tab を参照していたら、Human の部品は 1 byte も変わらないまま
  // 指す先だけが別の値になる＝直さない（Human が決める：新しい AI の tab を足す・参照を外す・2026-11-16 監査）
  if (sheetReferenced(entries, name, s.part)) throw new XlsxError('estimate_ai_sheet_referenced');
  const before = summarizeAiSheet(entryData(entries.find((e) => e.name === s.part)).toString('utf8'));
  const calcE = entries.find((e) => e.name === CALC);
  const newCalc = calcE ? rewriteCalc(entryData(calcE).toString('utf8'), s.sheetId, formulaRefs(xml)) : null;
  const out = entries.map((e) => (e.name === s.part ? makeEntry(s.part, Buffer.from(xml), e) : e.name === CALC && newCalc !== null ? makeEntry(CALC, Buffer.from(newCalc), e) : e));
  const bytes = writeZip(out);
  const { preserved } = verifyPreserved(buf, bytes, { replaced: s.part, calc: calcE ? { sheetId: String(s.sheetId), refs: formulaRefs(xml) } : null });
  return { bytes, sheet: { name, part: s.part }, preserved, before };
}

/**
 * 保存の前の確かめ。before と after を比べ、許した変化以外が 1 つでもあれば xlsx_preserve_failed：
 *   added：新しい部品 1 つと、3 つの部品にそれぞれ 1 か所だけ足した文字列（取り除けば元と同じ）
 *   replaced：その部品 1 つだけ違う
 * どちらでも、元の部品は全部残り・同じ順番・Human の sheet の部品と rels は 1 byte も同じ（圧縮された bytes で比べる）
 */
export function verifyPreserved(before, after, { added = null, replaced = null, calc = null }) {
  const a = readZip(before);
  const b = readZip(after);
  const bm = new Map(b.map((e) => [e.name, e]));
  const fail = () => { throw new XlsxError('xlsx_preserve_failed'); };
  let preserved = 0; // 圧縮された bytes のまま同じだった部品の数（差分の報告に使う）
  for (const e of a) {
    const f = bm.get(e.name);
    if (!f) fail();
    if (added && Object.hasOwn(added.inserts, e.name)) {
      const t1 = entryData(e).toString('utf8');
      const t2 = entryData(f).toString('utf8');
      const ins = added.inserts[e.name];
      const i = t2.indexOf(ins);
      if (i < 0 || t2.indexOf(ins, i + 1) >= 0 || `${t2.slice(0, i)}${t2.slice(i + ins.length)}` !== t1) fail();
      continue;
    }
    if (replaced && e.name === replaced) continue;
    if (calc && e.name === CALC) {
      // calcChain：その AI の tab の項目だけが新しい数式の位置に替わり、他の tab の項目は同じ順番で同じ（r と i で比べる）
      const want = [...calcEntries(entryData(e).toString('utf8')).filter((x) => x.i !== calc.sheetId).map((x) => `${x.r}|${x.i}`), ...calc.refs.map((r) => `${r}|${calc.sheetId}`)];
      const got = calcEntries(entryData(f).toString('utf8')).map((x) => `${x.r}|${x.i}`);
      if (want.join(',') !== got.join(',')) fail();
      continue;
    }
    if (e.crc !== f.crc || e.method !== f.method || !e.raw.equals(f.raw)) fail();
    preserved += 1;
  }
  const extra = b.filter((e) => !a.some((x) => x.name === e.name)).map((e) => e.name);
  if (added ? !(extra.length === 1 && extra[0] === added.part) : extra.length !== 0) fail();
  // 全部の部品が展開できる（壊れていない）
  for (const e of b) entryData(e);
  // sheet の並び：元の sheet は同じ名前・同じ順番で先頭に残る
  const s1 = listSheets(a).map((x) => x.name);
  const s2 = listSheets(b).map((x) => x.name);
  if (s1.some((n, i) => s2[i] !== n)) fail();
  return { preserved };
}

export { listSheets as sheetsOf };

/**
 * 文字の部品（<si>・<is> の中）を文字にする。**ふりがな（<rPh>）は捨てる**（2026-11-16：日本語の Excel は共有の文字にふりがなを持つ＝そのまま足すと
 * 「現場ゲンバ」のように読みが後ろに付く。実の工程表では共有の文字の 7 割がふりがなつきだった）
 */
const charRef = (s) => s.replace(/&#(x[0-9A-Fa-f]{1,6}|\d{1,7});/g, (m, n) => { const c = n[0] === 'x' ? parseInt(n.slice(1), 16) : Number(n); return c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : m; }).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const plainText = (inner) => [...String(inner).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((t) => unesc(charRef(t[1] ?? ''))).join('');
/** 共有の文字（番号の順）。空の項目（<si/>）も 1 つに数える＝後ろの番号がずれない */
function sharedStrings(entries) {
  if (!entries.some((e) => e.name === 'xl/sharedStrings.xml')) return [];
  return [...text(entries, 'xl/sharedStrings.xml').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => plainText(m[1] ?? ''));
}
/** sheet を名前で選ぶ：ぴったりの名前、無ければ NFKC で畳むと同じ名前（1 つだけの時。依頼の文字は Task Hub の受け口で NFKC に揃う＝全角を含む sheet 名） */
function findSheet(sheets, name) {
  const exact = sheets.find((s) => s.name === name);
  if (exact) return exact;
  const fold = (x) => String(x).normalize('NFKC').toLowerCase();
  const same = sheets.filter((s) => fold(s.name) === fold(name));
  return same.length === 1 ? same[0] : undefined;
}
const colNumber = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const refOf = (ref) => { const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref ?? ''); return m ? { col: colNumber(m[1]), row: Number(m[2]) } : null; };
/** シリアル値 → 日付。base1904：古い Mac の Excel の数え方（1904 年から＝1462 日ずれる）の workbook */
const serialDate = (n, base1904 = false) => new Date(Date.UTC(1899, 11, 30) + (n + (base1904 ? 1462 : 0)) * 86_400_000).toISOString().slice(0, 10);
const is1904 = (entries) => /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(text(entries, WB));
/** Excel の日付らしい数（シリアル値 35000〜60000 の整数＝1995〜2064 年。書式は見ない＝推定） */
const dateSerial = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 35000 && n <= 60000 ? n : null; };

/** sheet の cell を行ごとに：[{ r, cells: [{ ref, col, text（切らない）, serial（日付らしい数か null） }] }]。空の cell は入れない */
function sheetCells(xml, shared) {
  const rows = [];
  // 中身の無い行は <row …/> と書かれる（高さだけ決めた空の行）。閉じの無い形も 1 行として読む＝次の行を飲み込んで行の番号をずらさない（2026-11-16 監査）
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attrs(`<x ${rm[1]}>`).r);
    const cells = [];
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(`<x ${cm[1]}>`);
      const body = cm[2] ?? '';
      let v = null;
      const isText = a.t !== undefined && a.t !== 'n';
      if (a.t === 's') { const i = Number(body.match(/<v>([^<]*)<\/v>/)?.[1]); v = shared[i] ?? null; } else if (a.t === 'inlineStr') v = plainText(body);
      else { const m = body.match(/<v>([^<]*)<\/v>/); v = m ? unesc(m[1]) : null; }
      if (v === null || v === '') continue;
      cells.push({ ref: a.r, col: refOf(a.r)?.col ?? 0, text: String(v), serial: isText ? null : dateSerial(v) });
    }
    if (cells.length) rows.push({ r, cells });
  }
  return rows;
}

/**
 * 読むだけ：sheet の行を文字にする（工程表の予定の確かめ用）。sharedStrings と inlineStr と数値。query があればその文字を含む行だけ。
 * Excel の日付（シリアル値 35000〜60000）には date（YYYY-MM-DD）も添える（書式は見ない＝推定の印 date_guess）
 */
export function readSheetRows(buf, { sheet = null, query = null, maxRows = 40, maxCell = 60 } = {}) {
  const entries = readZip(buf);
  const sheets = listSheets(entries).filter((s) => s.isWorksheet);
  const target = sheet === null ? sheets[0] : findSheet(sheets, sheet);
  if (!target) throw new XlsxError('xlsx_sheet_not_found');
  const q = query ? String(query).normalize('NFKC').toLowerCase() : null;
  const base1904 = is1904(entries);
  const rows = [];
  let matched = 0;
  for (const row of sheetCells(text(entries, target.part), sharedStrings(entries))) {
    const cells = row.cells.map((c) => ({ ref: c.ref, text: c.text.slice(0, maxCell), ...(c.serial !== null ? { date_guess: serialDate(c.serial, base1904) } : {}) }));
    if (q && !cells.some((c) => c.text.normalize('NFKC').toLowerCase().includes(q))) continue;
    matched += 1;
    if (rows.length < maxRows) rows.push({ r: row.r, cells });
  }
  return { sheet: target.name, sheets: sheets.map((s) => s.name), rows, matched, truncated: matched > rows.length };
}

// ─── 工程表の「日付が横に並ぶ表」（2026-11-16）───
const mergesOf = (xml) => [...xml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]{1,3})(\d{1,7}):([A-Z]{1,3})(\d{1,7})"/g)].map((m) => ({ c1: colNumber(m[1]), r1: Number(m[2]), c2: colNumber(m[3]), r2: Number(m[4]) }));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/**
 * 日付の見出しの行を探す：中身のある最初の 12 行のうち、日付らしい数が 5 つ以上・左から右へ 1 日ずつ進む並びが 8 割以上の行（いちばん日付の多い行）。
 * 見つかれば { headerRow, cols: [{ date, c1, c2 }]（その日の列の幅＝見出しの結合か、次の日付の手前まで）, labelMax（日付より左の列＝行の名前）, from, to, sub }。無ければ null
 */
function calendarLayout(rows, merges, base1904 = false) {
  let best = null;
  for (const row of rows.slice(0, 12)) {
    const ds = row.cells.filter((c) => c.serial !== null && c.col > 0);
    if (ds.length < 5) continue;
    let step = 0;
    for (let i = 1; i < ds.length; i += 1) if (ds[i].serial - ds[i - 1].serial === 1) step += 1;
    if (step < (ds.length - 1) * 0.8) continue;
    if (!best || ds.length > best.ds.length) best = { row, ds };
  }
  if (!best) return null;
  const { row, ds } = best;
  const span = new Map(merges.filter((m) => m.r1 <= row.r && row.r <= m.r2).map((m) => [m.c1, m.c2]));
  const width = Math.max(1, median(ds.slice(1).map((d, i) => d.col - ds[i].col)));
  const cols = ds.map((d, i) => {
    const next = i + 1 < ds.length ? ds[i + 1].col - 1 : d.col + width - 1;
    return { date: serialDate(d.serial, base1904), c1: d.col, c2: Math.max(d.col, Math.min(span.get(d.col) ?? next, next)) };
  });
  // 見出しのすぐ下の行が曜日の行か：日付の列の 8 割以上に 4 字までの文字があり、文字の種類が 10 まで・ほかの cell は日付の数の 2 割までの時だけ（予定の行を曜日と取り違えて落とさない）
  const below = rows.find((x) => x.r === row.r + 1);
  const starts = new Set(cols.map((c) => c.c1));
  const subCells = below ? below.cells.filter((c) => starts.has(c.col) && c.serial === null && [...c.text].length <= 4) : [];
  const others = below ? below.cells.filter((c) => c.col >= cols[0].c1).length - subCells.length : 0;
  const isSub = subCells.length >= cols.length * 0.8 && new Set(subCells.map((c) => c.text)).size <= 10 && others <= cols.length * 0.2;
  const sub = isSub ? new Map(subCells.map((c) => [c.col, c.text])) : null;
  const dates = cols.map((c) => c.date).sort();
  return { headerRow: row.r, bodyFrom: row.r + (sub ? 2 : 1), cols, labelMax: cols[0].c1 - 1, from: dates[0], to: dates.at(-1), sub };
}

/** 1 つの sheet を「日 × 行」の項目にする：[{ date, r, label, text }]（日付の順・行の順）。label は日付より左の列の文字（結合された名前は下の行にも付く） */
function calendarItems(rows, merges, lay, maxCell) {
  const colIdx = new Map();
  lay.cols.forEach((c, i) => { for (let k = c.c1; k <= c.c2; k += 1) if (!colIdx.has(k)) colIdx.set(k, i); });
  const at = new Map(rows.flatMap((x) => x.cells.map((c) => [`${x.r}:${c.col}`, c])));
  const labelMerges = merges.filter((m) => m.c1 <= lay.labelMax && m.r2 > m.r1);
  const bodyMerge = new Map(merges.filter((m) => m.c1 > lay.labelMax && m.r1 >= lay.bodyFrom).map((m) => [`${m.r1}:${m.c1}`, m]));
  const labelOf = (r) => {
    const parts = [];
    for (let c = 1; c <= lay.labelMax; c += 1) {
      let cell = at.get(`${r}:${c}`);
      if (!cell) { const m = labelMerges.find((x) => x.c1 <= c && c <= x.c2 && x.r1 < r && r <= x.r2); if (m) cell = at.get(`${m.r1}:${m.c1}`); }
      if (cell && !parts.includes(cell.text)) parts.push(cell.text);
    }
    return parts.join(' ').slice(0, maxCell);
  };
  const byKey = new Map();
  for (const row of rows) {
    if (row.r < lay.bodyFrom) continue;
    let label = null;
    for (const c of row.cells) {
      if (c.col <= lay.labelMax) continue;
      const first = colIdx.get(c.col);
      if (first === undefined) continue;
      // 何日かにまたがって結合された cell は、またがる日のすべてに出す
      const m = bodyMerge.get(`${row.r}:${c.col}`);
      let last = first;
      if (m) while (last + 1 < lay.cols.length && lay.cols[last + 1].c1 <= m.c2) last += 1;
      if (label === null) label = labelOf(row.r);
      for (let i = first; i <= last; i += 1) {
        const key = `${lay.cols[i].date}|${row.r}`;
        if (!byKey.has(key)) byKey.set(key, { date: lay.cols[i].date, r: row.r, label, parts: [] });
        byKey.get(key).parts.push(c.text.slice(0, maxCell));
      }
    }
  }
  return [...byKey.values()].map((x) => ({ date: x.date, r: x.r, ...(x.label ? { label: x.label } : {}), text: x.parts.join(' ') })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.r - b.r));
}

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const jsonBytes = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');

/**
 * 工程表を「日付で」読む（2026-11-16・読むだけ）。日付が横に並び、行が班・人、交わる所が現場の表（実の工程表の形）から、日ごとの項目を抜き出す。
 *   期間：from〜to（無ければ today から 7 日。from だけなら from から 7 日）。長さは maxDays まで＝越えたら truncated と next_from
 *   query：その文字を含む項目（現場の文字か行の名前）だけ。期間の指定が無ければ today 以後（today がどの sheet にも無ければ全部）
 *   sheet：指定が無ければ**日ごとに**、その日を含む最初の sheet（並びの順＝期間が重なる日は先に並ぶ sheet。新しい sheet を先に置く形に合う）。指定すればその sheet だけ
 *   大きさ：結果は budget bytes まで（Task Hub の結果の上限 16 KiB の内側）。日の境で切って truncated と next_from（まだ 1 つも返していない最初の日）を返す。
 *           1 日ぶんだけで越える時は、その日を途中まで返す（partial・omitted＝落とした数）
 * 戻り値：日付の見出しを持つ sheet が 1 つも無ければ null（呼ぶ側は行の読み方へ）。どの sheet にも無い期間は out_of_range: true と ranges（sheet ごとの期間）
 */
export function readCalendar(buf, { sheet = null, from = null, to = null, query = null, today = new Date().toISOString().slice(0, 10), maxDays = 31, budget = 10_000, maxCell = 60 } = {}) {
  const entries = readZip(buf);
  const sheets = listSheets(entries).filter((s) => s.isWorksheet);
  const shared = sharedStrings(entries);
  const base1904 = is1904(entries);
  const open = (s) => { const xml = text(entries, s.part); const rows = sheetCells(xml, shared); const merges = mergesOf(xml); const lay = calendarLayout(rows, merges, base1904); return lay ? { name: s.name, rows, merges, lay, items: null } : null; };
  let cals;
  if (sheet !== null) {
    const t = findSheet(sheets, sheet);
    if (!t) throw new XlsxError('xlsx_sheet_not_found');
    const c = open(t);
    if (!c) return null;
    cals = [c];
  } else {
    cals = sheets.map(open).filter(Boolean);
    if (!cals.length) return null;
  }
  const names = sheets.map((s) => s.name).slice(0, 40);
  const gFrom = cals.map((c) => c.lay.from).sort()[0];
  const gTo = cals.map((c) => c.lay.to).sort().at(-1);
  /** その日を読む sheet（並びの順で最初にその日を含む物）。どの sheet にも無い日は null */
  const owner = (d) => cals.find((c) => c.lay.from <= d && d <= c.lay.to) ?? null;
  const q = query ? String(query).normalize('NFKC').toLowerCase() : null;
  let lo = from ?? (q ? (gFrom <= today && today <= gTo ? today : gFrom) : today);
  let hi = to ?? (q ? gTo : addDays(lo, 6));
  const head = { mode: 'calendar', sheets: names, ...(sheets.length > names.length ? { sheet_count: sheets.length } : {}), range: { from: gFrom, to: gTo } };
  const outOfRange = () => ({ ...head, out_of_range: true, from: lo, to: hi, ranges: cals.slice(0, 12).map((c) => ({ sheet: c.name, from: c.lay.from, to: c.lay.to })) });
  if (hi < gFrom || lo > gTo) return outOfRange();
  // 先に在る期間へ寄せてから、長さの上限をかける（遠い過去からの期間で、空の結果と進まない next_from を返さない）
  if (lo < gFrom) lo = gFrom;
  if (hi > gTo) hi = gTo;
  const last = hi; // 頼まれた期間の終わり（在る期間に寄せた後）。next_from はこれを越えない
  let nextFrom = null;
  let truncated = false;
  const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
  if (!q && dayMs(hi) - dayMs(lo) > (maxDays - 1) * 86_400_000) { hi = addDays(lo, maxDays - 1); nextFrom = addDays(hi, 1); truncated = true; }
  const has = (x) => String(x ?? '').normalize('NFKC').toLowerCase().includes(q);
  const items = [];
  const usedSheets = [];
  for (const c of cals) {
    if (c.lay.to < lo || c.lay.from > hi) continue;
    c.items ??= calendarItems(c.rows, c.merges, c.lay, maxCell);
    const mine = c.items.filter((x) => lo <= x.date && x.date <= hi && owner(x.date) === c && (!q || has(x.text) || has(x.label)));
    for (let d = c.lay.from > lo ? c.lay.from : lo; d <= hi && d <= c.lay.to; d = addDays(d, 1)) if (owner(d) === c) { usedSheets.push(c.name); break; }
    items.push(...mine);
  }
  if (!usedSheets.length) return outOfRange(); // 期間の全部が sheet と sheet のすき間
  items.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.r - y.r));
  head.sheet = owner(lo)?.name ?? usedSheets[0]; // 期間の最初の日を読んだ sheet
  if (usedSheets.length > 1) head.sheets_used = usedSheets;
  const after = (d) => { const n = addDays(d, 1); return n <= last ? n : null; }; // 続きの日（頼まれた期間の中に残りが在る時だけ）
  let used = jsonBytes(head) + 260;
  if (q) {
    let hits = [];
    let partial = null;
    for (const x of items) {
      const n = jsonBytes(x) + 1;
      if (used + n > budget) {
        truncated = true;
        // 日の境で切る（その日の途中まで返すと、next_from から聞き直した時に同じ項目が 2 度出る）。1 日ぶんだけで上限を越える時は、その日は途中まで（partial_date）で次の日から
        const whole = hits.filter((h) => h.date !== x.date);
        if (whole.length) { hits = whole; nextFrom = x.date; } else { partial = x.date; nextFrom = after(x.date); }
        break;
      }
      used += n;
      hits.push(x);
    }
    const omitted = partial ? items.filter((x) => x.date === partial).length - hits.length : 0;
    return { ...head, from: lo, to: hi, query: String(query).slice(0, 100), matched: items.length, hits, truncated, ...(partial ? { partial_date: partial, omitted } : {}), ...(nextFrom ? { next_from: nextFrom } : {}) };
  }
  const days = [];
  for (let d = lo; d <= hi; d = addDays(d, 1)) {
    const c = owner(d);
    const col = c?.lay.sub ? c.lay.cols.find((x) => x.date === d) : null;
    const sub = col ? c.lay.sub.get(col.c1) : undefined;
    const day = { date: d, ...(sub ? { weekday: [...sub].slice(0, 4).join('') } : {}), items: items.filter((x) => x.date === d).map(({ date, ...rest }) => rest), ...(c ? {} : { no_sheet: true }) };
    const n = jsonBytes(day) + 1;
    if (used + n > budget) {
      truncated = true;
      nextFrom = d;
      // 最初の 1 日だけで上限を越える：その日を途中まで返して次の日へ進める（同じ日を聞き直し続けない）。落とした数は omitted
      if (!days.length) {
        const kept = [];
        let room = budget - used - jsonBytes({ ...day, items: [], partial: true, omitted: 9999 });
        for (const it of day.items) { const b = jsonBytes(it) + 1; if (b > room) break; room -= b; kept.push(it); }
        days.push({ ...day, items: kept, partial: true, omitted: day.items.length - kept.length });
        nextFrom = after(d);
      }
      break;
    }
    used += n;
    days.push(day);
  }
  return { ...head, from: lo, to: days.length ? days.at(-1).date : lo, days, truncated, ...(nextFrom ? { next_from: nextFrom } : {}) };
}
