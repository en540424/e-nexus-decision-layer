/**
 * 見積書の AI 作業版（2026-11-13・scripts/lib/xlsx）：Human の tab・マクロ・画像・書式・定義名・印刷設定を 1 byte も変えずに AI の tab を足す・直す。
 * 作り物の workbook（/usr/bin/zip で作る＝この repo の zip の書き手と別の作り手）。実の見積書は使わない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { addAiSheet, estimateSheetXml, listSheets, readSheetRows, replaceAiSheet, verifyPreserved, XlsxError } from '../scripts/lib/xlsx/workbook.mjs';
import { entryData, makeEntry, readZip, writeZip } from '../scripts/lib/xlsx/zip.mjs';
import { fixtureWorkbook } from './xlsx-fixture.mjs';

const hasZip = existsSync('/usr/bin/zip');
const rows = [{ item: 'くさび緊結式足場 架払', spec: 'H=7m', qty: 250, unit: 'm2', price: 1150 }, { item: 'メッシュシート', qty: 250, unit: 'm2', price: 180, note: '防炎' }];

test('AI の tab を足す：Human の tab・画像・マクロ・styles・定義名は 1 byte も同じ・workbook は 1 行足しただけ・値と数式', { skip: !hasZip }, () => {
  for (const macro of [false, true]) {
    const orig = fixtureWorkbook({ macro });
    const xml = estimateSheetXml({ title: '現場A 見積（AI 案）', rows, stamp: 'AI 作成 test' });
    const { bytes, sheet } = addAiSheet(orig, { name: 'AI_見積案1', xml });
    assert.equal(sheet.name, 'AI_見積案1');
    const a = new Map(readZip(orig).map((e) => [e.name, e]));
    const b = new Map(readZip(bytes).map((e) => [e.name, e]));
    for (const n of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/media/image1.png', 'xl/drawings/drawing1.xml', ...(macro ? ['xl/vbaProject.bin'] : [])]) {
      assert.ok(a.get(n).raw.equals(b.get(n).raw), `${n} は同じ bytes`);
    }
    const wb = entryData(b.get('xl/workbook.xml')).toString();
    assert.match(wb, /<definedName name="_xlnm.Print_Area" localSheetId="0">見積!\$A\$1:\$G\$40<\/definedName>/);
    assert.match(wb, /<calcPr calcId="191029"\/>/);
    assert.deepEqual(listSheets(readZip(bytes)).map((s) => s.name), ['見積', '内訳', 'AI_見積案1']);
    const r = readSheetRows(bytes, { sheet: 'AI_見積案1' });
    const cell = (ref) => r.rows.flatMap((x) => x.cells).find((c) => c.ref === ref)?.text;
    assert.deepEqual([cell('A4'), cell('F4'), cell('F5'), cell('F7')], ['くさび緊結式足場 架払', '287500', '45000', '332500']);
    assert.match(entryData(b.get(sheet.part)).toString(), /<f>C4\*E4<\/f><v>287500<\/v>/);
    assert.match(entryData(b.get(sheet.part)).toString(), /<f>SUM\(F4:F5\)<\/f>/);
  }
});

test('AI の tab だけを直せる：Human の tab・台帳に無い tab は直せない・名前の決まり（AI_・31 字・重複）', { skip: !hasZip }, () => {
  const orig = fixtureWorkbook();
  const { bytes } = addAiSheet(orig, { name: 'AI_案1', xml: estimateSheetXml({ title: 't', rows, stamp: 's' }) });
  const xml2 = estimateSheetXml({ title: 't2', rows: [{ item: 'x', qty: 1, price: 2 }], stamp: 's2' });
  const { bytes: b2 } = replaceAiSheet(bytes, { name: 'AI_案1', xml: xml2, aiSheets: ['AI_案1'] });
  assert.equal(readSheetRows(b2, { sheet: 'AI_案1' }).rows.find((x) => x.r === 4).cells[0].text, 'x');
  assert.ok(readZip(b2).find((e) => e.name === 'xl/worksheets/sheet1.xml').raw.equals(readZip(orig).find((e) => e.name === 'xl/worksheets/sheet1.xml').raw));
  assert.throws(() => replaceAiSheet(bytes, { name: '見積', xml: xml2, aiSheets: ['見積'] }), { code: 'estimate_not_ai_sheet' }, 'Human の tab は直せない');
  assert.throws(() => replaceAiSheet(bytes, { name: 'AI_案1', xml: xml2, aiSheets: [] }), { code: 'estimate_not_ai_sheet' }, '台帳に無い AI_ の tab（Human が AI_ の名前を付けた tab）は直せない');
  for (const bad of ['見積案', 'AI_案1', 'ai_案1', `AI_${'x'.repeat(30)}`, 'AI_a/b', 'AI_[x]']) assert.throws(() => addAiSheet(bytes, { name: bad, xml: xml2 }), { code: 'xlsx_sheet_name_invalid' }, bad);
});

test('verifyPreserved：Human の部品が 1 byte でも違う・部品が消えた・workbook に他の変更がある時は保存しない', { skip: !hasZip }, () => {
  const orig = fixtureWorkbook();
  const { bytes, sheet } = addAiSheet(orig, { name: 'AI_案1', xml: estimateSheetXml({ title: 't', rows, stamp: 's' }) });
  const tamper = (fn) => writeZip(readZip(bytes).flatMap(fn));
  const inserts = (b) => { const wb = entryData(readZip(b).find((e) => e.name === 'xl/workbook.xml')).toString(); return wb.match(/<sheet name="AI_案1"[^>]*\/>/)[0]; };
  const ins = inserts(bytes);
  const relIns = entryData(readZip(bytes).find((e) => e.name === 'xl/_rels/workbook.xml.rels')).toString().match(/<Relationship Id="rId\d+"[^>]*worksheets\/sheet3\.xml"\/>/)[0];
  const ctIns = `<Override PartName="/${sheet.part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  const opts = { added: { part: sheet.part, inserts: { 'xl/workbook.xml': ins, 'xl/_rels/workbook.xml.rels': relIns, '[Content_Types].xml': ctIns } } };
  assert.equal(verifyPreserved(orig, bytes, opts), true);
  const changed = tamper((e) => (e.name === 'xl/worksheets/sheet2.xml' ? [makeEntry(e.name, Buffer.from(entryData(e).toString().replace('内訳（Human）', '内訳（AI が変えた）')), e)] : [e]));
  assert.throws(() => verifyPreserved(orig, changed, opts), { code: 'xlsx_preserve_failed' });
  assert.throws(() => verifyPreserved(orig, tamper((e) => (e.name === 'xl/media/image1.png' ? [] : [e])), opts), { code: 'xlsx_preserve_failed' });
  const wbMore = tamper((e) => (e.name === 'xl/workbook.xml' ? [makeEntry(e.name, Buffer.from(entryData(e).toString().replace('calcId="191029"', 'calcId="1"')), e)] : [e]));
  assert.throws(() => verifyPreserved(orig, wbMore, opts), { code: 'xlsx_preserve_failed' });
  assert.throws(() => addAiSheet(Buffer.from('not a zip at all, an old .xls perhaps'), { name: 'AI_x', xml: '' }), { code: 'xlsx_not_zip' });
});

test('readSheetRows（工程表を読むだけ）：sharedStrings・数値・日付の推定・query で行を絞る', { skip: !hasZip }, () => {
  const r = readSheetRows(fixtureWorkbook(), { query: '足場' });
  assert.equal(r.sheet, '見積');
  assert.deepEqual(r.rows.map((x) => x.r), [1, 4]);
  const all = readSheetRows(fixtureWorkbook());
  assert.deepEqual(all.rows.find((x) => x.r === 6).cells[0], { ref: 'A6', text: '46000', date_guess: '2025-12-09' });
  assert.throws(() => readSheetRows(fixtureWorkbook(), { sheet: '無い' }), XlsxError);
});

test('estimateSheetXml：数は有限・0 以上、文字は長さの上限・制御文字を除く、行は 1〜300', () => {
  assert.throws(() => estimateSheetXml({ title: 't', rows: [], stamp: 's' }), { code: 'estimate_rows_invalid' });
  assert.throws(() => estimateSheetXml({ title: 't', rows: [{ item: 'a', qty: -1, price: 1 }], stamp: 's' }), { code: 'estimate_number_invalid' });
  assert.throws(() => estimateSheetXml({ title: 't', rows: [{ item: 'a', qty: 1, price: Infinity }], stamp: 's' }), { code: 'estimate_number_invalid' });
  assert.throws(() => estimateSheetXml({ title: 't', rows: [{ item: 'a'.repeat(201), qty: 1, price: 1 }], stamp: 's' }), { code: 'estimate_text_too_long' });
  assert.match(estimateSheetXml({ title: '<b>&', rows: [{ item: 'x\u0001y', qty: 1, price: 1 }], stamp: 's' }), /&lt;b&gt;&amp;.*xy/);
});

test('別の読み手（Python の zipfile と XML の解析）でも AI 作業版が壊れていない：全部の部品の CRC・XML として読める・sheet の数', { skip: !hasZip || !existsSync('/usr/bin/python3') }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const dir = mkdtempSync(path.join(tmpdir(), 'xlsx-py-'));
  try {
    const { bytes } = addAiSheet(fixtureWorkbook({ macro: true }), { name: 'AI_案1', xml: estimateSheetXml({ title: 't', rows, stamp: 's' }) });
    const { bytes: b2 } = replaceAiSheet(bytes, { name: 'AI_案1', xml: estimateSheetXml({ title: 't2', rows, stamp: 's2' }), aiSheets: ['AI_案1'] });
    const f = path.join(dir, 'out.xlsm');
    writeFileSync(f, b2);
    const py = 'import sys,zipfile\nfrom xml.dom import minidom\nz=zipfile.ZipFile(sys.argv[1])\nbad=z.testzip()\nassert bad is None, bad\nn=0\nfor i in z.infolist():\n    if i.filename.endswith(".xml") or i.filename.endswith(".rels"):\n        minidom.parseString(z.read(i.filename)); n+=1\nwb=minidom.parseString(z.read("xl/workbook.xml"))\nprint(n, len(wb.getElementsByTagName("sheet")))\n';
    const r = spawnSync('/usr/bin/python3', ['-I', '-c', py, f], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout.trim(), /^\d+ 3$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('監査の後：Excel で保存された写しの calcChain は AI の tab の項目だけを新しい数式の位置に替える（F9）・目録と見出しの名前が食い違う zip を拒否', { skip: !hasZip }, () => {
  const { bytes } = addAiSheet(fixtureWorkbook(), { name: 'AI_案1', xml: estimateSheetXml({ title: 't', rows, stamp: 's' }) });
  // Human が Excel で保存した＝calcChain ができた（見積の F4 と AI_案1 の F4〜F7）
  const ents = readZip(bytes);
  const calc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="F4" i="1" l="1"/><c r="F4" i="3"/><c r="F5"/><c r="F7"/></calcChain>';
  const saved = writeZip([...ents, makeEntry('xl/calcChain.xml', Buffer.from(calc))]);
  const { bytes: b2 } = replaceAiSheet(saved, { name: 'AI_案1', xml: estimateSheetXml({ title: 't2', rows: [{ item: 'x', qty: 1, price: 2 }], stamp: 's' }), aiSheets: ['AI_案1'], aiIds: { AI_案1: 3 } });
  const c2 = entryData(readZip(b2).find((e) => e.name === 'xl/calcChain.xml')).toString();
  assert.match(c2, /<c r="F4" i="1" l="1"\/><c r="F4" i="3"\/><c r="F6" i="3"\/><\/calcChain>$/, '見積（Human）の項目は元の tag のまま残り、AI の tab は新しい F4・合計 F6');
  assert.throws(() => replaceAiSheet(saved, { name: 'AI_案1', xml: '', aiSheets: ['AI_案1'], aiIds: { AI_案1: 9 } }), { code: 'estimate_not_ai_sheet' }, '台帳の sheetId と違う（名前を付け替えた Human の tab）は直さない');
  // 局所の見出しの名前を書き換えた zip
  const bad = Buffer.from(bytes);
  const i = bad.indexOf(Buffer.from('xl/styles.xml'));
  bad.write('xl/stylez.xml', i);
  assert.throws(() => readZip(bad), { code: 'xlsx_zip_corrupt' });
});
