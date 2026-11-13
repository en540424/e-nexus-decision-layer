/** 試験用の作り物の見積書（2026-11-13・/usr/bin/zip で作る＝この repo の zip の書き手と別の作り手）。実の見積書は使わない */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** 作り物の見積書（Human の tab 2 つ・sharedStrings・styles・定義名・印刷設定・画像・vbaProject.bin） */
export function fixtureWorkbook({ macro = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'xlsx-fix-'));
  const w = (p, s) => { mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); writeFileSync(path.join(root, p), s); };
  const wbCt = macro ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  w('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${macro ? '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' : ''}<Override PartName="/xl/workbook.xml" ContentType="${wbCt}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  w('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  w('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${NS}><sheets><sheet name="見積" sheetId="1" r:id="rId1"/><sheet name="内訳" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">見積!$A$1:$G$40</definedName></definedNames><calcPr calcId="191029"/></workbook>`);
  w('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${macro ? '<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>' : ''}</Relationships>`);
  w('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>現場A 足場工事</t></si><si><t>くさび緊結式足場</t></si><si><t>m2</t></si></sst>`);
  w('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0&quot;円&quot;"/></numFmts><fonts count="1"><font><sz val="11"/><name val="游ゴシック"/></font></fonts></styleSheet>`);
  w('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="4"><c r="A4" t="s"><v>1</v></c><c r="C4"><v>250</v></c><c r="D4" t="s"><v>2</v></c><c r="E4"><v>1200</v></c><c r="F4"><f>C4*E4</f><v>300000</v></c></row><row r="6"><c r="A6"><v>46000</v></c></row></sheetData><pageSetup paperSize="9" orientation="portrait"/><drawing r:id="rId1"/></worksheet>`);
  w('xl/worksheets/_rels/sheet1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  w('xl/drawings/drawing1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>');
  w('xl/media/image1.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  w('xl/worksheets/sheet2.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>内訳（Human）</t></is></c></row></sheetData></worksheet>`);
  if (macro) w('xl/vbaProject.bin', Buffer.from('d0cf11e0a1b11ae1macro-dummy-bytes', 'utf8'));
  const out = path.join(root, macro ? 'fix.xlsm' : 'fix.xlsx');
  const r = spawnSync('/usr/bin/zip', ['-X', '-r', '-q', out, '.', '-x', '*.xls*'], { cwd: root, timeout: 20_000 });
  assert.equal(r.status, 0);
  const bytes = readFileSync(out);
  rmSync(root, { recursive: true, force: true });
  return bytes;
}

