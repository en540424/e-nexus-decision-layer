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
  const str = (v, max = 200) => { const s = String(v ?? '').normalize('NFKC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim(); if (s.length > max) throw new XlsxError('estimate_text_too_long'); return s; };
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

/** AI の tab を足す。戻り値：{ bytes, sheet: { name, part } }。足した 3 行と新しい部品以外は元のまま（verifyPreserved で確かめてから返す） */
export function addAiSheet(buf, { name, xml }) {
  const entries = readZip(buf);
  const sheets = listSheets(entries);
  if (!validSheetName(name, sheets)) throw new XlsxError('xlsx_sheet_name_invalid');
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
  verifyPreserved(buf, bytes, { added: { part, inserts: { [WB]: sheetTag, [WB_RELS]: relTag, [CT]: ctTag } } });
  return { bytes, sheet: { name, part, sheetId } };
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
  const calcE = entries.find((e) => e.name === CALC);
  const newCalc = calcE ? rewriteCalc(entryData(calcE).toString('utf8'), s.sheetId, formulaRefs(xml)) : null;
  const out = entries.map((e) => (e.name === s.part ? makeEntry(s.part, Buffer.from(xml), e) : e.name === CALC && newCalc !== null ? makeEntry(CALC, Buffer.from(newCalc), e) : e));
  const bytes = writeZip(out);
  verifyPreserved(buf, bytes, { replaced: s.part, calc: calcE ? { sheetId: String(s.sheetId), refs: formulaRefs(xml) } : null });
  return { bytes, sheet: { name, part: s.part } };
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
  }
  const extra = b.filter((e) => !a.some((x) => x.name === e.name)).map((e) => e.name);
  if (added ? !(extra.length === 1 && extra[0] === added.part) : extra.length !== 0) fail();
  // 全部の部品が展開できる（壊れていない）
  for (const e of b) entryData(e);
  // sheet の並び：元の sheet は同じ名前・同じ順番で先頭に残る
  const s1 = listSheets(a).map((x) => x.name);
  const s2 = listSheets(b).map((x) => x.name);
  if (s1.some((n, i) => s2[i] !== n)) fail();
  return true;
}

export { listSheets as sheetsOf };

/**
 * 読むだけ：sheet の行を文字にする（工程表の予定の確かめ用）。sharedStrings と inlineStr と数値。query があればその文字を含む行だけ。
 * Excel の日付（シリアル値 35000〜60000）には date（YYYY-MM-DD）も添える（書式は見ない＝推定の印 date_guess）
 */
export function readSheetRows(buf, { sheet = null, query = null, maxRows = 40, maxCell = 60 } = {}) {
  const entries = readZip(buf);
  const sheets = listSheets(entries).filter((s) => s.isWorksheet);
  const target = sheet === null ? sheets[0] : sheets.find((s) => s.name === sheet);
  if (!target) throw new XlsxError('xlsx_sheet_not_found');
  let shared = [];
  if (entries.some((e) => e.name === 'xl/sharedStrings.xml')) {
    shared = [...text(entries, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(''));
  }
  const xml = text(entries, target.part);
  const q = query ? String(query).normalize('NFKC').toLowerCase() : null;
  const rows = [];
  let matched = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(attrs(`<x ${rm[1]}>`).r);
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(`<x ${cm[1]}>`);
      const body = cm[2] ?? '';
      let v = null;
      if (a.t === 's') { const i = Number(body.match(/<v>([^<]*)<\/v>/)?.[1]); v = shared[i] ?? null; } else if (a.t === 'inlineStr') v = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join('');
      else { const m = body.match(/<v>([^<]*)<\/v>/); v = m ? unesc(m[1]) : null; }
      if (v === null || v === '') continue;
      const cell = { ref: a.r, text: String(v).slice(0, maxCell) };
      const n = Number(v);
      if (a.t !== 's' && a.t !== 'inlineStr' && Number.isFinite(n) && n >= 35000 && n <= 60000 && Number.isInteger(n)) cell.date_guess = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
      cells.push(cell);
    }
    if (!cells.length) continue;
    if (q && !cells.some((c) => c.text.normalize('NFKC').toLowerCase().includes(q))) continue;
    matched += 1;
    if (rows.length < maxRows) rows.push({ r, cells });
  }
  return { sheet: target.name, sheets: sheets.map((s) => s.name), rows, matched, truncated: matched > rows.length };
}
