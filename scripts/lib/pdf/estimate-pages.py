"""Render selected XLSX print pages to a new PDF using isolated LibreOffice profiles."""

import argparse
import io
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
import sys
import unicodedata
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from lxml import etree
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError

BOOK = 'xl/workbook.xml'
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
MAX_PAGES = 30


def xml(data):
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    root = etree.fromstring(data, parser=parser)
    if root.getroottree().docinfo.doctype:
        raise ValueError('xlsx_doctype')
    return root


def inspect_workbook(archive):
    parts = archive.infolist()
    if len(parts) > 4096 or sum(part.file_size for part in parts) > 128 * 1024 * 1024:
        raise ValueError('xlsx_too_large')
    names = {part.filename for part in parts}
    if len(names) != len(parts):
        raise ValueError('xlsx_duplicate_parts')
    forbidden = ('xl/externallinks/', 'xl/embeddings/', 'xl/activex/', 'xl/querytables/')
    for name in names:
        lower = name.lower()
        if lower.startswith(forbidden) or lower.endswith(('/vbaproject.bin', '/connections.xml')):
            raise ValueError('xlsx_active_content')
        if lower.endswith('.rels'):
            for relation in xml(archive.read(name)):
                if relation.get('TargetMode', '').lower() == 'external':
                    raise ValueError('xlsx_external_relationship')
    book = xml(archive.read(BOOK))
    tabs = list(book.findall(f'{{{NS}}}sheets/{{{NS}}}sheet'))
    return {tab.get('name'): index for index, tab in enumerate(tabs, 1)
            if tab.get('state', 'visible') == 'visible'}


def check_renderer(soffice):
    info = subprocess.run([soffice, '--version'], capture_output=True, timeout=15, check=True)
    version = re.search(rb'LibreOffice(?:Dev)? (\d+)\.(\d+)', info.stdout)
    if not version or tuple(map(int, version.groups())) < (26, 8):
        raise ValueError('sheet_range_unsupported')


def renderer_environment(work):
    env = os.environ.copy()
    if sys.platform != 'darwin' or env.get('FONTCONFIG_FILE'):
        return env
    # Bundled headless LibreOffice can miss Japanese fallback on macOS.
    fontconfig = etree.Element('fontconfig')
    for directory in ('/System/Library/Fonts', '/Library/Fonts', str(Path.home() / 'Library/Fonts')):
        etree.SubElement(fontconfig, 'dir').text = directory
    etree.SubElement(fontconfig, 'cachedir').text = str(work / 'font-cache')
    for family in ('sans-serif', '游ゴシック', 'メイリオ'):
        alias = etree.SubElement(fontconfig, 'alias')
        etree.SubElement(alias, 'family').text = family
        fallback = etree.SubElement(alias, 'accept')
        etree.SubElement(fallback, 'family').text = 'Arial Unicode MS'
    config = work / 'fonts.conf'
    config.write_bytes(etree.tostring(fontconfig, encoding='UTF-8', xml_declaration=True))
    env['FONTCONFIG_FILE'] = str(config)
    return env


def parse_selection(selection):
    if not isinstance(selection, list) or not 1 <= len(selection) <= MAX_PAGES:
        raise ValueError('invalid_selection')
    for entry in selection:
        if (not isinstance(entry, dict) or set(entry) != {'sheet', 'page', 'expected_text'}
                or not isinstance(entry['sheet'], str) or not entry['sheet']
                or type(entry['page']) is not int or entry['page'] < 1
                or not isinstance(entry['expected_text'], str)
                or not 1 <= len(entry['expected_text'].strip()) <= 200):
            raise ValueError('invalid_selection')
    return selection


def convert(source, destination, selection, soffice):
    selection = parse_selection(selection)
    check_renderer(soffice)
    writer = PdfWriter()
    with TemporaryDirectory(prefix='estimate-print-') as directory, ZipFile(source) as archive:
        work = Path(directory)
        visible = inspect_workbook(archive)
        env = renderer_environment(work)
        if any(entry['sheet'] not in visible for entry in selection):
            raise ValueError('sheet_not_available')
        rendered = {}
        for entry in selection:
            sheet = entry['sheet']
            if sheet not in rendered:
                index = visible[sheet]
                workbook = work / f'sheet-{index}.xlsx'
                shutil.copyfile(source, workbook)
                filters = json.dumps({'SheetRange': {'type': 'string', 'value': str(index)}})
                pdf_filter = f'pdf:calc_pdf_Export:{filters}'
                process = subprocess.run(
                    [soffice, f'-env:UserInstallation={(work / "profile").as_uri()}',
                     '--headless', '--norestore', '--convert-to', pdf_filter,
                     '--outdir', str(work), str(workbook)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=45, check=False, env=env,
                )
                pdf = workbook.with_suffix('.pdf')
                if process.returncode != 0 or not pdf.is_file() or pdf.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError('sheet_render_failed')
                rendered[sheet] = PdfReader(pdf, strict=True)
            pages = rendered[sheet].pages
            if entry['page'] > len(pages):
                raise ValueError('page_not_found')
            page = pages[entry['page'] - 1]
            printed = unicodedata.normalize('NFC', page.extract_text())
            expected = unicodedata.normalize('NFC', entry['expected_text'].strip())
            if expected not in printed:
                raise ValueError('page_content_mismatch')
            writer.add_page(page, excluded_keys=['/Annots', '/AA'])
        result = io.BytesIO()
        writer.write(result)
        if len(PdfReader(result, strict=True).pages) != len(selection):
            raise ValueError('page_count_mismatch')
        with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
            output.write(result.getbuffer())
    return len(selection)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('selection', type=Path, help='JSON array of sheet names and 1-based print pages')
    parser.add_argument('output', type=Path)
    parser.add_argument('--soffice', default='soffice')
    args = parser.parse_args()
    if args.source.suffix.lower() != '.xlsx' or args.output.suffix.lower() != '.pdf':
        parser.error('Expected .xlsx source and .pdf output')
    try:
        count = convert(args.source, args.output, json.loads(args.selection.read_text()), args.soffice)
    except (ValueError, OSError, BadZipFile, PdfReadError, etree.XMLSyntaxError, subprocess.SubprocessError) as error:
        safe_codes = {'invalid_selection', 'sheet_not_available', 'page_not_found', 'sheet_render_failed',
                      'xlsx_too_large', 'xlsx_duplicate_parts', 'xlsx_active_content',
                      'xlsx_external_relationship', 'xlsx_doctype', 'page_count_mismatch',
                      'sheet_range_unsupported', 'page_content_mismatch'}
        message = str(error)
        print(json.dumps({'code': message if message in safe_codes else 'estimate_pdf_failed'}))
        return 1
    print(json.dumps({'code': 'ok', 'pages': count}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
