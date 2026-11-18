#!/usr/bin/env node
/**
 * Dropbox の許可フォルダの設定を、実の Dropbox に**読むだけ**で照らす（2026-11-16・docs/dropbox-business.md §2）。書かない・file を保存しない・AI を使わない。
 * 許可フォルダを config に書く前（案の file）と書いた後（本番の config）に、Claude Code か Human が実行する。
 *
 *   node scripts/dropbox-preflight.mjs [--config <案の file>] [--store <dir>] [--deep] [--show-paths]
 *
 * なぜ要るか（実の接続で分かったこと）：人が画面で読んだ名前と Dropbox の名前は 1 文字ずれる（全角と半角のかっこ・名前の中の全角の空白）。
 * Dropbox は大文字小文字と NFC／NFD は同じに扱うが、**全角と半角・空白の有無は別の名前**＝config の path が 1 文字違えば path_not_found で、
 * 工程表のバックアップは失敗のまま気づくのが 1 週間後になる。また同じ名前のフォルダ・file が別の場所に在ると、古い側を登録してしまう。
 *
 * 確かめること（metadata だけ。--deep の時だけ工程表を手元の memory に取って形を見る＝保存しない）：
 *   read_roots・estimate_roots・deny_roots：在る・フォルダである
 *   schedule_files：在る・file である・xlsx／xlsm・大きさが上限の内・**同じ名前の file が別の場所にも在るか**（在れば warning＝古い写しを登録していないか人が見る）
 *   無い path：どの部分から無いかと、全角半角・空白を畳むと同じになる名前が在るか（在れば「似た名前あり」）
 *   在るフォルダ：同じ親の中に、全角半角だけが違う名前の別のフォルダが在るか（在れば warning＝依頼の文字からどちらか決められない場面が出る）
 *   書きの資格情報：App folder の app である（Dropbox の一番上の項目が見えない）
 *   --deep：工程表が読める xlsx か・日付で読める形か（sheet の数と期間だけ）
 * 出すもの：既定は business と項目の番号と code だけ（会社のフォルダ名は出さない＝log に残してよい）。--show-paths で path も出す（手元の画面だけで使う）
 * exit：0＝ok か warning だけ／1＝problem（無い path・種類の違い・資格情報なし・設定が読めない）
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAppNamespace } from './dropbox-auth.mjs';
import { createDropbox, MAX_DOWNLOAD_BYTES } from './lib/dropbox/client.mjs';
import { dropboxCredentials } from './lib/dropbox/keychain.mjs';
import { foldPath, loadScopes } from './lib/dropbox/scope.mjs';
import { readCalendar, sheetsOf } from './lib/xlsx/workbook.mjs';
import { readZip } from './lib/xlsx/zip.mjs';

export const DEFAULT_STORE = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub');
/** 見た目が同じに見える名前を同じにする（全角半角・大文字小文字・空白の有無）。「似た名前」を探すためだけに使う＝読む範囲の判定には使わない */
export const foldName = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const codeOf = (e) => String(e?.code ?? 'error').slice(0, 40);
const notFound = (e) => /_not_found$/.test(codeOf(e));

/**
 * 無い path を、上から順にたどる：{ broken_at（1 から数えた、無かった部分の番号）, similar（畳むと同じ名前が親の中に在る）, suggestion（在った時の正しい path） }。
 * 親の一覧は 1 回だけ（再帰しない）
 */
async function locate(reader, p) {
  const parts = p.slice(1).split('/');
  let prefix = '';
  for (let i = 0; i < parts.length; i += 1) {
    const next = `${prefix}/${parts[i]}`;
    try { const m = await reader.metadata(next); prefix = m.path ?? next; continue; } catch (e) { if (!notFound(e)) return { code: codeOf(e) }; }
    let hit = null;
    try {
      const l = await reader.list(prefix, { limit: 2000 });
      const want = foldName(parts[i]);
      hit = l.entries.filter((x) => foldName(x.name) === want);
    } catch (e) { return { broken_at: i + 1, code: codeOf(e) }; }
    return { broken_at: i + 1, similar: hit.length, ...(hit.length === 1 ? { suggestion: [hit[0].path, ...parts.slice(i + 1)].join('/') } : {}) };
  }
  return {};
}

/**
 * 設定（config の dropbox の節）を照らす。reader・writer は client（writer は null でもよい）。
 * 戻り値：{ code: 'ok'|'warning'|'problem'|'not_configured'|'config_invalid', problems, warnings, items: [{ business, key, n, status, code?, … }] }
 */
export async function preflight({ dropbox, reader, writer = null, deep = false, today = new Date().toISOString().slice(0, 10) }) {
  if (dropbox === undefined || dropbox === null) return { code: 'not_configured', problems: 0, warnings: 0, items: [] };
  let scopes;
  try { scopes = loadScopes(dropbox); } catch (e) { return { code: 'config_invalid', config_code: String(e?.code ?? 'error').slice(0, 60), problems: 1, warnings: 0, items: [] }; }
  const items = [];
  for (const scope of scopes.values()) {
    for (const key of ['read_roots', 'estimate_roots', 'deny_roots', 'schedule_files']) {
      const wantFile = key === 'schedule_files';
      for (const [i, p] of scope[key].entries()) {
        const it = { business: scope.business, key, n: i + 1, path: p, status: 'ok' };
        items.push(it);
        let m;
        try { m = await reader.metadata(p); } catch (e) {
          it.status = 'problem';
          it.code = notFound(e) ? 'not_found' : codeOf(e);
          if (notFound(e)) Object.assign(it, await locate(reader, p));
          continue;
        }
        if ((m.tag === 'file') !== wantFile) { it.status = 'problem'; it.code = wantFile ? 'not_file' : 'not_folder'; continue; }
        // Dropbox の名前と違う書き方（大文字小文字・NFD）は動くが、知らせる（次に書く時に Dropbox の名前に揃える）
        if (typeof m.path === 'string' && m.path !== p) { it.status = 'warning'; it.code = 'spelled_differently'; it.suggestion = m.path; }
        if (!wantFile) {
          // 同じ親の中に、全角半角・大文字小文字だけが違う名前の別のフォルダが在るか（依頼の文字は受け口で畳まれる＝どちらか決められない）
          try {
            const parent = p.slice(0, p.lastIndexOf('/'));
            const l = await reader.list(parent, { limit: 2000 });
            const n = l.entries.filter((x) => foldPath(x.name) === foldPath(p.slice(parent.length + 1)) && x.path.toLowerCase() !== p.toLowerCase()).length;
            if (n) { it.fold_siblings = n; if (it.status === 'ok') { it.status = 'warning'; it.code = 'similar_name_sibling'; } }
          } catch { /* 親を見られない＝この確かめは飛ばす */ }
          continue;
        }
        if (!/\.(xlsx|xlsm)$/i.test(p)) { it.status = 'problem'; it.code = 'not_xlsx'; continue; }
        if (m.size > MAX_DOWNLOAD_BYTES) { it.status = 'problem'; it.code = 'too_large'; continue; }
        it.server_modified = m.server_modified;
        // 同じ名前の file が別の場所にも在るか（名前の検索・metadata だけ）
        try {
          const name = p.split('/').pop();
          const twins = (await reader.search(name, { max: 100, filenameOnly: true })).filter((x) => x.name.toLowerCase() === name.toLowerCase() && x.path.toLowerCase() !== p.toLowerCase());
          if (twins.length) {
            it.status = 'warning';
            it.code = 'same_name_elsewhere';
            it.twins = twins.length;
            it.twins_newer = twins.filter((x) => x.server_modified > m.server_modified).length; // 登録した側より新しい物が在れば、登録が古い側かもしれない
            // 画面に出す path（--show-paths）から、読ませない場所の中の物は外す（数には入れる）
            it.twin_paths = twins.filter((x) => !scope.deny_roots.some((d) => { const a = foldPath(x.path); const b = foldPath(d); return a === b || a.startsWith(`${b}/`); })).slice(0, 5).map((x) => x.path);
          }
        } catch (e) { it.twins_check = codeOf(e); }
        if (deep) {
          try {
            const { bytes } = await reader.download(p);
            const sheets = sheetsOf(readZip(bytes)).filter((s) => s.isWorksheet);
            const cal = readCalendar(bytes, { today });
            it.deep = { sheets: sheets.length, mode: cal ? 'calendar' : 'rows', ...(cal?.range ? { from: cal.range.from, to: cal.range.to } : {}), ...(cal?.out_of_range ? { today_out_of_range: true } : {}) };
            if (cal?.out_of_range && it.status === 'ok') { it.status = 'warning'; it.code = 'today_not_in_schedule'; }
          } catch (e) { it.status = 'problem'; it.code = codeOf(e); }
        }
      }
    }
  }
  if (writer) {
    const it = { business: '*', key: 'write_app', n: 1, status: 'ok' };
    items.push(it);
    const v = await writeAppNamespace(reader, writer);
    if (v !== 'app_folder') { it.status = 'problem'; it.code = v === 'full_dropbox' ? 'write_app_not_app_folder' : 'write_app_unverified'; }
  }
  const problems = items.filter((x) => x.status === 'problem').length;
  const warnings = items.filter((x) => x.status === 'warning').length;
  return { code: problems ? 'problem' : warnings ? 'warning' : 'ok', problems, warnings, items };
}

/** 画面の 1 行。showPaths が無ければ path・似た名前の候補は出さない */
export function describe(it, showPaths = false) {
  const extra = [];
  if (it.code) extra.push(it.code);
  if (it.broken_at) extra.push(`${it.broken_at} 番目の部分から無い`);
  if (it.similar) extra.push(`似た名前あり ${it.similar} 件（全角半角・空白のちがい）`);
  if (it.fold_siblings) extra.push(`全角半角だけが違う名前の別のフォルダが同じ親に ${it.fold_siblings} 件`);
  if (it.twins) extra.push(`同じ名前の file が別の場所に ${it.twins} 件（うち登録した側より新しい ${it.twins_newer} 件）`);
  if (it.deep) extra.push(`sheet ${it.deep.sheets} 枚・${it.deep.mode === 'calendar' ? `日付で読める（${it.deep.from}〜${it.deep.to}）` : '行で読む形'}`);
  const lines = [`${it.status.padEnd(7)} ${it.business} ${it.key}[${it.n}]${extra.length ? ` — ${extra.join('・')}` : ''}`];
  if (showPaths) {
    if (it.path) lines.push(`          path: ${it.path}`);
    if (it.suggestion) lines.push(`          Dropbox の名前: ${it.suggestion}`);
    for (const t of it.twin_paths ?? []) lines.push(`          同じ名前: ${t}`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const file = opt('--config') ? path.resolve(opt('--config')) : path.join(opt('--store') ? path.resolve(opt('--store')) : DEFAULT_STORE, 'config.json');
  const done = (r, exit) => { console.log(JSON.stringify({ component: 'edl-dropbox-preflight', code: r.code, ...(r.config_code ? { config_code: r.config_code } : {}), problems: r.problems ?? 0, warnings: r.warnings ?? 0 })); process.exitCode = exit; };
  let raw = null;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 読めない */ }
  if (!raw) done({ code: 'config_unreadable', problems: 1 }, 1);
  else {
    const creds = dropboxCredentials('read');
    if (raw.dropbox !== undefined && !creds) done({ code: 'no_credentials', problems: 1 }, 1);
    else {
      const wc = dropboxCredentials('write');
      const r = await preflight({ dropbox: raw.dropbox, reader: creds ? createDropbox({ role: 'read', credentials: creds }) : null, writer: wc ? createDropbox({ role: 'write', credentials: wc }) : null, deep: argv.includes('--deep'), today: new Date(Date.now() + (Number(raw.utc_offset_minutes) || 0) * 60_000).toISOString().slice(0, 10) });
      for (const it of r.items) console.log(describe(it, argv.includes('--show-paths')));
      if (raw.dropbox !== undefined && !wc) console.log('note    書きの資格情報が無い（App folder の確かめは飛ばした）');
      done(r, r.problems ? 1 : 0);
    }
  }
}
