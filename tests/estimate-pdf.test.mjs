import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { entryData, makeEntry, readZip, writeZip } from '../scripts/lib/xlsx/zip.mjs';
import { fixtureWorkbook } from './xlsx-fixture.mjs';

const python = process.env.EDL_PDF_PYTHON;
const script = new URL('../scripts/lib/pdf/estimate-pages.py', import.meta.url).pathname;

test('real renderer preserves the workbook and combines selected printed pages in order', { skip: !python }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'estimate-pdf-test-'));
  try {
    const source = path.join(dir, 'input.xlsx');
    const selected = path.join(dir, 'selection.json');
    const output = path.join(dir, 'output.pdf');
    const entries = readZip(fixtureWorkbook());
    const sheet = 'xl/worksheets/sheet2.xml';
    const input = writeZip(entries.map((part) => {
      if (part.name === 'xl/workbook.xml') {
        const xml = entryData(part).toString('utf8').replace('</definedNames>',
          '<definedName name="_xlnm.Print_Area" localSheetId="1">内訳!$A$1:$A$61</definedName></definedNames>');
        return makeEntry(part.name, Buffer.from(xml), part);
      }
      if (part.name !== sheet) return part;
      const xml = entryData(part).toString('utf8')
        .replace('内訳（Human）', 'DETAIL-ONE')
        .replace('</sheetData>', '<row r="61"><c r="A61" t="inlineStr"><is><t>DETAIL-TWO</t></is></c></row></sheetData>')
        .replace('</worksheet>', '<pageSetup paperSize="9" orientation="portrait"/><rowBreaks count="1" manualBreakCount="1"><brk id="60" min="0" max="16383" man="1"/></rowBreaks></worksheet>');
      return makeEntry(sheet, Buffer.from(xml), part);
    }));
    writeFileSync(source, input);
    const selection = [{ sheet: '内訳', page: 2, expected_text: 'DETAIL-TWO' },
      { sheet: '見積', page: 1, expected_text: '現場A 足場工事' }, { sheet: '内訳', page: 1, expected_text: 'DETAIL-ONE' }];
    writeFileSync(selected, JSON.stringify(selection));
    const run = (target) => spawnSync(python, [script, source, selected, target], { encoding: 'utf8', timeout: 50_000 });
    const render = run(output);
    assert.equal(render.status, 0, render.stdout);
    assert.deepEqual(JSON.parse(render.stdout), { code: 'ok', pages: 3 });
    const content = spawnSync(python, ['-c', 'import json,sys;from pypdf import PdfReader;print(json.dumps([p.extract_text() for p in PdfReader(sys.argv[1]).pages]))', output], { encoding: 'utf8' });
    assert.equal(content.status, 0, content.stderr);
    const pages = JSON.parse(content.stdout);
    assert.match(pages[0], /DETAIL-TWO/, JSON.stringify(pages));
    assert.match(pages[1], /300000/);
    assert.match(pages[1], /現場A 足場工事/);
    assert.match(pages[2], /DETAIL-ONE/);
    assert.deepEqual(readFileSync(source), input);
    writeFileSync(selected, JSON.stringify([{ sheet: '内訳', page: 99, expected_text: 'DETAIL-TWO' }]));
    const invalid = path.join(dir, 'invalid.pdf');
    const rejected = run(invalid);
    assert.equal(rejected.status, 1);
    assert.deepEqual(JSON.parse(rejected.stdout), { code: 'page_not_found' });
    assert.equal(existsSync(invalid), false);
    writeFileSync(selected, JSON.stringify([{ sheet: '内訳', page: 1, expected_text: 'DETAIL-TWO' }]));
    const mismatch = run(invalid);
    assert.equal(mismatch.status, 1);
    assert.deepEqual(JSON.parse(mismatch.stdout), { code: 'page_content_mismatch' });
    assert.equal(existsSync(invalid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
