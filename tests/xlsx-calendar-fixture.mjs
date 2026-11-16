/**
 * 試験用の作り物の工程表（2026-11-16）。実の工程表と同じ「形」だけをまねる（名前・中身は作り物）：
 *   1 行目＝日付（Excel のシリアル値・1 日が 2 列・見出しは 2 列を結合）／2 行目＝曜日／A・B 列＝行の名前（2 行を結合）／交わる所＝現場の文字と数
 *   共有の文字（sharedStrings）はふりがな（rPh）つき・空の項目（<si/>）あり＝日本語の Excel が保存した形
 */
import { makeEntry, writeZip } from '../scripts/lib/xlsx/zip.mjs';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const colName = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
export const serialOf = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * sheets：[{ name, start: 'YYYY-MM-DD', days, labels: [{ r, a, b, rows }], items: [{ date, r, text, n, spanDays, spanRows }] }]
 *   labels：r 行目の A 列（a）・B 列（b）。rows（既定 2）行を結合
 *   items：その日・その行の cell（text＝現場の文字〈1 列目〉・n＝数〈2 列目〉）。spanDays・spanRows は結合
 * plain：true なら日付の見出しを持たない普通の表（行の読み方の確かめ用）。noWeekday：true なら 2 行目に曜日を書かない（2 行目から予定の表）
 */
export function calendarWorkbook({ sheets, furigana = true }) {
  const strings = ['']; // 0 番は空の項目（<si/>）
  const si = (s) => { let i = strings.indexOf(s, 1); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const parts = [];
  sheets.forEach((sh, idx) => {
    const rows = new Map();
    const put = (r, col, xml) => { if (!rows.has(r)) rows.set(r, new Map()); rows.get(r).set(col, xml); };
    const str = (r, col, s) => put(r, col, `<c r="${colName(col)}${r}" s="1" t="s"><v>${si(s)}</v></c>`);
    const num = (r, col, v) => put(r, col, `<c r="${colName(col)}${r}" s="2"><v>${v}</v></c>`);
    const merges = [];
    const dayCol = (d) => 3 + 2 * Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${sh.start}T00:00:00Z`)) / 86_400_000);
    if (!sh.plain) {
      str(1, 1, '班'); merges.push('A1:B2');
      for (let i = 0; i < sh.days; i += 1) {
        const d = addDays(sh.start, i);
        const c = dayCol(d);
        num(1, c, serialOf(d)); put(1, c + 1, `<c r="${colName(c + 1)}1" s="2"/>`);
        merges.push(`${colName(c)}1:${colName(c + 1)}1`);
        if (!sh.noWeekday) { str(2, c, WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]); merges.push(`${colName(c)}2:${colName(c + 1)}2`); }
      }
    }
    for (const l of sh.labels ?? []) {
      const n = l.rows ?? 2;
      if (l.a) { str(l.r, 1, l.a); if (n > 1) merges.push(`A${l.r}:A${l.r + n - 1}`); }
      if (l.b) { str(l.r, 2, l.b); if (n > 1) merges.push(`B${l.r}:B${l.r + n - 1}`); }
    }
    for (const it of sh.items ?? []) {
      const c = sh.plain ? it.col : dayCol(it.date);
      if (it.text !== undefined) str(it.r, c, it.text);
      if (it.n !== undefined) num(it.r, c + 1, it.n);
      if (it.spanDays || it.spanRows) merges.push(`${colName(c)}${it.r}:${colName(c + 2 * (it.spanDays ?? 1) - 1)}${it.r + (it.spanRows ?? 1) - 1}`);
    }
    const data = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cells]) => `<row r="${r}" spans="1:${3 + 2 * (sh.days ?? 1)}">${[...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x).join('')}</row>`).join('');
    parts.push({ name: sh.name, xml: `${HEAD}<worksheet ${NS}><dimension ref="A1:LA91"/><sheetData>${data}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}<phoneticPr fontId="1"/></worksheet>`, idx });
  });
  const sst = `${HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s, i) => (i === 0 ? '<si/>' : `<si><t>${esc(s)}</t>${furigana ? `<rPh sb="0" eb="${[...s].length}"><t>フリガナ</t></rPh><phoneticPr fontId="1"/>` : ''}</si>`)).join('')}</sst>`;
  const e = (name, s) => makeEntry(name, Buffer.from(s, 'utf8'));
  return writeZip([
    e('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${parts.map((p) => `<Override PartName="/xl/worksheets/sheet${p.idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`),
    e('_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    e('xl/workbook.xml', `${HEAD}<workbook ${NS}><sheets>${parts.map((p) => `<sheet name="${esc(p.name)}" sheetId="${p.idx + 1}" r:id="rId${p.idx + 1}"/>`).join('')}</sheets></workbook>`),
    e('xl/_rels/workbook.xml.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map((p) => `<Relationship Id="rId${p.idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${p.idx + 1}.xml"/>`).join('')}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    ...parts.map((p) => e(`xl/worksheets/sheet${p.idx + 1}.xml`, p.xml)),
    e('xl/sharedStrings.xml', sst),
  ]);
}

/** 実の工程表に近い大きさの作り物：sheet 2 枚（新しい期間が先・期間は 2 週間重なる）・班 18 行・1 日 10 項目ほど */
export function bigCalendar() {
  const crews = Array.from({ length: 18 }, (_, i) => ({ r: 3 + 2 * i, a: `第${i + 1}班`, b: `職長${String.fromCharCode(0x30a2 + 2 * i)}` }));
  const items = (start, days) => {
    const out = [];
    for (let d = 0; d < days; d += 1) for (let k = 0; k < 10; k += 1) out.push({ date: addDays(start, d), r: 3 + 2 * ((d + k) % 18) + (k % 2), text: `${['山田', '佐藤', '鈴木', '高橋'][(d + k) % 4]}邸　足場${k % 3 === 0 ? '架け' : '払い'}`, n: 2 + (k % 3) });
    return out;
  };
  return calendarWorkbook({ sheets: [
    { name: '工程2026 (3)', start: '2026-09-01', days: 137, labels: crews, items: items('2026-09-01', 137) },
    { name: '工程2026 (2)', start: '2026-05-01', days: 137, labels: crews, items: items('2026-05-01', 137) },
  ] });
}
