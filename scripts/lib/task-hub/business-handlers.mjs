/**
 * Dropbox の業務の handler（2026-11-13・MA-24・docs/dropbox-business.md）。AI を使わない普通の処理。Dropbox とだけ通信する（role ごとの資格情報）。
 *
 * 守り（文やプロンプトではなく、次で強制）：
 *   資格情報：読み＝Full Dropbox の読み取り専用の app（書けない）／書き＝App folder の app（AI の出力フォルダの外へ書けない）。原本を書く資格情報は無い
 *   範囲：business ごとの許可フォルダ（config の dropbox・Human が承認して書く）。無い business は dropbox_business_not_enabled
 *   操作：この file に在る handler だけ。移動・削除・共有・上書き（overwrite）は client に無い
 *   承認：見積（L2）の AI 作業版は human_required（policies/task-hub/intents.json）。EN司令塔へ出すかは source の intents（Human）
 *
 * services（CLI が作って config.services に入れる。test は模擬を入れる）：{ dropbox(role) → client, backupDir, historyDir }
 * 書く handler は task_id で冪等（同じ task をもう一度動かしても二重に書かない）＝resumable
 *
 * 結果の大きさ（2026-11-16・実の Dropbox での確かめ）：Task Hub の結果は 16 KiB まで（wire.MAX_BODY_BYTES）で、越えると runner が result_invalid＝想定外（続けば PAUSE）にする。
 *   日本語の名前は 1 文字 3 bytes＝一覧 100 件・カルテ 6000 字・工程表の 30 行はどれも越える。読む handler は bytes で数えて手前で切り（truncated）、
 *   それでも越えた結果は想定内の result_too_large で終える（依頼 1 つの大きさで Task Hub 全体を止めない）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveReal } from '../dropbox/resolve.mjs';
import { browsable, foldPath, loadScopes, nameDenied, outputPath, scopeOf, searchRoot, ScopeError, withinRoot } from '../dropbox/scope.mjs';
import { appendToKarte, CARTE_SECTIONS, CASE_ID_RE, decodeKarte, KarteError, newKarte, provenance, sectionText, unknownSections } from '../business/karte.mjs';
import { backupSchedule, BackupError, listGenerations, restoreGeneration } from '../business/schedule-backup.mjs';
import { addAiSheet, estimateSheetXml, readCalendar, readSheetRows, replaceAiSheet, summarizeAiSheet, XlsxError } from '../xlsx/workbook.mjs';
import { fail } from './handler-error.mjs';
import { MAX_BODY_BYTES } from './wire.mjs';

const RESULT_TEXT_MAX = 6000;
/** 文の結果の上限（bytes）。日本語 3,600 字ほど。結果の他の項目と JSON の escape（改行・引用符は 2 bytes）のぶんを残す */
const RESULT_TEXT_BYTES = 11_000;
/** 一覧の結果の上限（bytes）。超える手前で切る */
export const RESULT_LIST_BYTES = 12_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * 想定外（runner の回路遮断に数える＝続けば PAUSE）は、資格情報・Dropbox の障害・壊れた file・保存の確かめの失敗だけ。
 * 範囲の外・形の誤り・見つからない・同時の編集などは依頼の側の問題＝想定内（Bot の誤った依頼で Task Hub 全体を止めない・監査 F2）
 */
const UNEXPECTED = new Set(['dropbox_auth', 'dropbox_forbidden', 'dropbox_unavailable', 'dropbox_hash_mismatch', 'dropbox_bad_response', 'backup_verify_failed', 'backup_generation_corrupt', 'xlsx_preserve_failed', 'xlsx_zip_corrupt', 'karte_insert_changed_text']);
async function guarded(fn) {
  try { return await fn(); } catch (e) {
    const code = String(e?.code ?? '');
    if (e instanceof ScopeError || e instanceof KarteError || e instanceof BackupError || e instanceof XlsxError || /^dropbox_|^not_configured$/.test(code)) {
      const c = code === 'not_configured' ? 'dropbox_not_configured' : code.slice(0, 40);
      throw fail(c, { retryable: e.retryable === true, expected: !UNEXPECTED.has(c) });
    }
    throw e;
  }
}
function services(config) {
  const s = config?.services;
  if (!s?.dropbox) throw fail('dropbox_not_configured', { expected: true });
  return s;
}
const scopesOf = (config) => loadScopes(config.dropbox);
const jsonBytes = (x) => Buffer.byteLength(JSON.stringify(x), 'utf8');
/** 文を字数と bytes（JSON にした時の大きさ）の両方で切る。切る所は code point の境（サロゲートの対の途中で切らない。結合文字の列の途中では切れうる） */
export function clip(s) {
  // 長い文は先頭だけを見る（6000 字は UTF-16 で 12000 単位まで＝それより長ければ必ず切る）
  const long = s.length > RESULT_TEXT_MAX * 2;
  const chars = [...(long ? s.slice(0, RESULT_TEXT_MAX * 2) : s)];
  if (!long && chars.length <= RESULT_TEXT_MAX && jsonBytes(s) <= RESULT_TEXT_BYTES) return s;
  let used = 2;
  let n = 0;
  for (; n < chars.length && n < RESULT_TEXT_MAX; n += 1) { const b = jsonBytes(chars[n]) - 2; if (used + b > RESULT_TEXT_BYTES) break; used += b; }
  return `${chars.slice(0, n).join('')}\n…(省略)`;
}
/** 一覧を bytes の上限の手前まで取る：{ kept, cut }（cut＝上限で落とした件数） */
export function fitList(items, budget = RESULT_LIST_BYTES) {
  const kept = [];
  let used = 2;
  for (const x of items) { const b = jsonBytes(x) + 1; if (used + b > budget) break; used += b; kept.push(x); }
  return { kept, cut: items.length - kept.length };
}

function karteHistory(svc, business, caseId) {
  return (text, rev) => {
    if (!svc.historyDir) return;
    const d = path.join(svc.historyDir, business, 'karte-history', caseId);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(d, `${String(rev).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}.md`), text, { mode: 0o600 }); // text：Dropbox から取った bytes のまま
  };
}

// ─── 資料（読むだけ）───
const SEARCH_MAX = 30;
const dropboxSearch = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  // 名前で読ませない語（給与・名簿など）を探す検索は受けない：結果は絞っても「件数・続きがある」の印で、隠した file の在ることが分かってしまう（2026-11-18 監査）
  if (nameDenied(task.params.query, scope.deny_names)) throw new ScopeError('dropbox_path_not_allowed');
  // path の指定は実の名前に直す（依頼の文字は受け口で NFKC に揃っている＝全角を含む名前はそのままでは Dropbox に無い）
  const root = task.params.path ? await resolveReal(svc.dropbox('read'), scope, task.params.path, 'browse', { signal }) : searchRoot(scope, null);
  const raw = await svc.dropbox('read').search(task.params.query, { path: root, max: SEARCH_MAX, signal });
  const hits = raw.filter((h) => withinRoot(root, h.path) && browsable(scope, h.path)); // 範囲の中だけ（見積・読ませない場所の file は名前も返さない）
  const { kept, cut } = fitList(hits.slice(0, SEARCH_MAX).map((h) => ({ name: h.name, path: h.path, size: h.size, server_modified: h.server_modified })));
  // truncated：Dropbox が上限の件数を返した（もっと在るかもしれない）か、bytes の上限で切った。無ければ「これで全部」
  return { result: { count: hits.length, files: kept, ...(cut || raw.length >= SEARCH_MAX ? { truncated: true } : {}) } };
});
const dropboxList = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const p = await resolveReal(svc.dropbox('read'), scope, task.params.path, 'browse', { signal }); // 実の名前に直す。見積（L2）のフォルダは承認なしの一覧に出さない
  const r = await svc.dropbox('read').list(p, { limit: 200, signal });
  r.entries = r.entries.filter((e) => browsable(scope, e.path)); // 一覧の中の見積のフォルダ・読ませない場所は名前も出さない（2026-11-16 監査）
  // 名前だけ返す（path は依頼の path＋名前＝同じ文字を 100 回返さない）。bytes の上限の手前で切る（切ったら truncated）
  const { kept, cut } = fitList(r.entries.slice(0, 100).map((e) => ({ tag: e.tag, name: e.name, ...(e.tag === 'file' ? { size: e.size, server_modified: e.server_modified } : {}) })));
  return { result: { path: p, count: r.entries.length, truncated: r.truncated || r.entries.length > kept.length, entries: kept, ...(r.entries.length > kept.length ? { returned: kept.length } : {}) } };
});

// ─── 工程表（読むだけ・バックアップ・別の file への復元）───
function scheduleFile(scope, n) {
  const i = Number.isInteger(n) ? n - 1 : 0;
  const f = scope.schedule_files[i];
  if (!f) throw new ScopeError('schedule_not_configured');
  return f;
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => typeof d === 'string' && DAY_RE.test(d) && d >= '1995-01-01' && d <= '2064-12-31' && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
/**
 * 工程表を読む（読むだけ）。日付が横に並ぶ表（実の工程表の形）なら日付で抜き出す（2026-11-16）：
 *   {}＝今日から 7 日／{date}＝その日／{from,to}＝期間（31 日まで）／{query}＝今日以後でその文字を含む項目／sheet で sheet を指定
 * 日付の見出しが無い表は、前のとおり query を含む行（bytes の上限の手前まで）。「今日」は config の utc_offset_minutes の時刻
 */
const scheduleRead = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const file = scheduleFile(scope, task.params.file);
  const p = task.params;
  for (const k of ['date', 'from', 'to']) if (p[k] !== undefined && !validDay(p[k])) throw new XlsxError('schedule_date_invalid');
  if ((p.date && (p.from || p.to)) || (p.to && !p.from) || (p.from && p.to && p.to < p.from)) throw new XlsxError('schedule_date_invalid');
  const from = p.date ?? p.from ?? null;
  const to = p.date ?? p.to ?? null;
  const { bytes, meta } = await svc.dropbox('read').download(file, { signal });
  const head = { server_modified: meta.server_modified, rev: meta.rev };
  const today = iso(now + (config.utc_offset_minutes ?? 0) * 60_000).slice(0, 10);
  const cal = readCalendar(bytes, { sheet: p.sheet ?? null, from, to, query: p.query ?? null, today });
  if (cal) return { result: { ...head, today, ...cal } };
  if (from) throw new XlsxError('schedule_not_calendar'); // 日付の見出しが無い表に日付の指定は使えない
  const r = readSheetRows(bytes, { sheet: p.sheet ?? null, query: p.query ?? null, maxRows: 30 });
  const sheets = r.sheets.slice(0, 40);
  const { kept, cut } = fitList(r.rows, RESULT_LIST_BYTES - jsonBytes(sheets));
  return { result: { ...head, mode: 'rows', ...r, sheets, rows: kept, truncated: r.truncated || cut > 0 } };
});
const scheduleBackup = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scopes = scopesOf(config);
  const scope = scopeOf(scopes, task.business);
  if (!scope.schedule_files.length) throw new ScopeError('schedule_not_configured');
  const files = [];
  for (const [i, f] of scope.schedule_files.entries()) {
    const r = await backupSchedule({ reader: svc.dropbox('read'), scopes, business: task.business, file: f, dir: svc.backupDir, reason: 'manual', now, signal });
    files.push({ n: i + 1, status: r.status, generation: r.generation.id, server_modified: r.generation.server_modified, size: r.generation.size, sha256: r.generation.sha256.slice(0, 16) });
  }
  // 「完了」は保存と検証が済んだ時だけ（unchanged＝前の世代と同じ中身＝その世代が今の版のバックアップ）
  return { result: { completed: true, files } };
});
const scheduleBackupList = ({ task, config }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const file = scheduleFile(scope, task.params.file);
  const gens = listGenerations(svc.backupDir, task.business, file);
  return { result: { count: gens.length, generations: gens.slice(-20).reverse().map((g) => ({ id: g.id, saved_at: g.saved_at, reason: g.reason, server_modified: g.server_modified, size: g.size })) } };
});
const scheduleRestore = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scopes = scopesOf(config);
  const scope = scopeOf(scopes, task.business);
  const file = scheduleFile(scope, task.params.file);
  const r = await restoreGeneration({ writer: svc.dropbox('write'), scopes, business: task.business, file, dir: svc.backupDir, generation: task.params.generation ?? null, at: task.params.at ?? null, offsetMin: config.utc_offset_minutes ?? 0, now, signal });
  return { result: { restored: true, ...(r.already ? { already: true } : {}), generation: r.generation.id, saved_at: r.generation.saved_at, restored_to: r.restored_to, note: '原本は変えていない（別の file）。原本への置き換えは Human' } };
});

// ─── 現場カルテ（App folder の karte/）───
const kartePath = (scope, caseId) => { if (!CASE_ID_RE.test(caseId ?? '')) throw new KarteError('karte_case_id_invalid'); return outputPath(scope, 'karte', `${caseId}.md`); };
const karteCreate = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const p = kartePath(scope, task.params.case_id);
  const text = newKarte({ caseId: task.params.case_id, siteName: task.params.site_name, fields: task.params.fields ?? {}, at: iso(now), taskId: task.task_id });
  try {
    const up = await svc.dropbox('write').upload(p, Buffer.from(text, 'utf8'), { signal });
    return { result: { created: true, path: up.path, rev: up.rev, unknown_fields: CARTE_SECTIONS.filter(([k]) => !(k in (task.params.fields ?? {})) && !['case_id', 'site_name'].includes(k)).length } };
  } catch (e) {
    if (e?.code !== 'dropbox_path_conflict') throw e;
    // 既にある：この task が作った物なら済み（冪等）、違えば作らない（上書きしない）
    const { bytes } = await svc.dropbox('write').download(p, { signal });
    if (decodeKarte(bytes).includes(`task=${task.task_id} -->`)) return { result: { created: true, already: true, path: p } };
    throw new KarteError('karte_exists');
  }
});
const karteGet = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const { bytes, meta } = await svc.dropbox('write').download(kartePath(scope, task.params.case_id), { signal });
  const text = decodeKarte(bytes);
  if (task.params.section) {
    const t = sectionText(text, task.params.section);
    if (t === null) throw new KarteError('karte_field_unknown');
    return { result: { case_id: task.params.case_id, section: task.params.section, text: clip(t), ...(clip(t) !== t ? { truncated: true } : {}), rev: meta.rev, server_modified: meta.server_modified } };
  }
  // 長いカルテは途中まで（truncated）。続きは section を指定して読む
  return { result: { case_id: task.params.case_id, text: clip(text), ...(clip(text) !== text ? { truncated: true } : {}), rev: meta.rev, server_modified: meta.server_modified, ...provenance(text) } };
});
const karteAppend = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const p = kartePath(scope, task.params.case_id);
  const w = svc.dropbox('write');
  const { bytes } = await w.download(p, { signal });
  if (decodeKarte(bytes).includes(`task=${task.task_id} -->`)) return { result: { appended: true, already: true } }; // 冪等
  const r = await appendToKarte({ writer: w, path: p, section: task.params.section, value: task.params.text, at: iso(now), taskId: task.task_id, dated: task.params.date ?? null, history: karteHistory(svc, task.business, task.params.case_id), signal });
  return { result: { appended: true, ...(r.already ? { already: true } : {}), rev: r.rev, ai_blocks: r.ai_blocks } };
});
const karteSearch = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const root = `${scope.output_root}/karte`;
  const hits = (await svc.dropbox('write').search(task.params.query, { path: root, max: 30, signal })).filter((h) => withinRoot(root, h.path));
  return { result: { count: hits.length, kartes: hits.map((h) => ({ case_id: h.name.replace(/\.md$/, ''), server_modified: h.server_modified })) } };
});
/** 決まった形の報告（AI の要約ではない）：作業予定・注意事項・未確認事項・現調履歴の抜き出し */
const karteReport = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const { bytes } = await svc.dropbox('write').download(kartePath(scope, task.params.case_id), { signal });
  const t = decodeKarte(bytes);
  const part = (k, label) => `■ ${label}\n${sectionText(t, k) || '（記載なし）'}`;
  const blank = unknownSections(t);
  const text = [`【現場カルテの要点】${task.params.case_id}`, part('schedule', '作業予定'), part('safety', '安全上の注意事項'), part('unknowns', '未確認事項'), part('survey_log', '現調履歴'), `■ まだ「未確認」のままの項目（${blank.length} 件）\n${blank.join('・') || '（なし）'}`].join('\n');
  return { result: { case_id: task.params.case_id, text: clip(text), ...(clip(text) !== text ? { truncated: true } : {}) } };
});

// ─── 見積書の AI 作業版（App folder の estimates/）───
const ledgerFile = (svc, business) => path.join(svc.historyDir, business, 'estimates', 'ledger.json');
function readLedger(svc, business) { try { return JSON.parse(readFileSync(ledgerFile(svc, business), 'utf8')); } catch { return { copies: {} }; } }
function writeLedger(svc, business, l) {
  const f = ledgerFile(svc, business);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(l, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, f);
}
function keepPrevious(svc, business, bytes, rev) {
  const d = path.join(svc.historyDir, business, 'estimates', 'history');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(d, `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}-${String(rev).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}.xlsx`), bytes, { mode: 0o600 });
}
/** AI 作業版の名前：原本の名前＋原本の path の短い hash（別の顧客の同じ名前の見積を 1 つの写しに混ぜない・監査 F5） */
export const workingName = (original) => { const b = path.posix.basename(original); const ext = path.posix.extname(b); const h = createHash('sha256').update(original.normalize('NFC').toLowerCase()).digest('hex').slice(0, 6); return `${[...b.slice(0, b.length - ext.length)].slice(0, 80).join('')}_AI作業版_${h}${ext}`; };
const stampOf = (task, now) => `AI 作成 ${iso(now).slice(0, 16)}Z task ${task.task_id}`;

const NAMES_MAX = 40;
const estimateAiCreate = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const original = await resolveReal(svc.dropbox('read'), scope, task.params.original_path, 'estimate', { signal }); // 実の名前に直す（全角を含む file 名）
  if (!/\.(xlsx|xlsm)$/i.test(original)) throw new XlsxError('estimate_not_xlsx');
  const w = svc.dropbox('write');
  const target = outputPath(scope, 'estimates', workingName(original));
  const ledger = readLedger(svc, task.business);
  const key = target.toLowerCase();
  const rec = ledger.copies[key] ?? { original, ai_sheets: [], ai_ids: {}, tasks: [] };
  if (rec.original.toLowerCase() !== original.toLowerCase()) throw new XlsxError('estimate_copy_other_original');
  if (rec.tasks.includes(task.task_id)) return { result: { created: true, already: true, path: target } }; // 冪等
  const xml = estimateSheetXml({ title: task.params.title, rows: task.params.rows, stamp: stampOf(task, now) });
  let base;
  let rev = null;
  let from = 'working_copy';
  try {
    const cur = await w.download(target, { signal }); // AI 作業版が既にある：その版に足す（Human がその写しに足した物も残る）
    base = cur.bytes;
    rev = cur.meta.rev;
    keepPrevious(svc, task.business, base, rev);
  } catch (e) {
    if (e?.code !== 'dropbox_path_not_found') throw e; // AI 作業版がまだ無い時だけ原本から作る
    const o = await svc.dropbox('read').download(original, { signal }); // 原本は読むだけ（読みの資格情報は書けない）
    base = o.bytes;
    from = 'original';
    // どの版の原本から写したか（後で原本が変わったことに気づける・2026-11-16）
    rec.original_rev = o.meta.rev;
    rec.original_hash = o.meta.content_hash;
  }
  const { bytes, sheet, preserved, sheets_before: sheetsBefore } = addAiSheet(base, { name: task.params.sheet_name, xml });
  // 台帳を先に（上げた後に止まっても、AI が作った tab として直せる＝監査 nit 11）。上げられなければ戻す
  const before = JSON.stringify(rec);
  rec.ai_sheets = [...rec.ai_sheets, sheet.name];
  rec.ai_ids = { ...(rec.ai_ids ?? {}), [sheet.name]: sheet.sheetId };
  ledger.copies[key] = rec;
  writeLedger(svc, task.business, ledger);
  let up;
  try { up = await w.upload(target, bytes, { rev, signal }); } catch (e) { ledger.copies[key] = JSON.parse(before); if (!ledger.copies[key].ai_sheets.length) delete ledger.copies[key]; writeLedger(svc, task.business, ledger); throw e; }
  rec.tasks = [...rec.tasks, task.task_id].slice(-200);
  rec.path = up.path; // Dropbox の名前（直す時はこの path を使う＝小文字にした台帳の鍵を path にしない）
  writeLedger(svc, task.business, ledger);
  // 保存の前後の差分（2026-11-16）：何から作り・どの tab が増え・元の部品が何個そのままだったか。前の版は Mac の履歴に残した（previous_sha256）
  // tab の名前の一覧は 40 までを返す（tab の多いブックで結果の上限を越えない。数は sheets_count）
  const diff = { base: from, sheets_before: sheetsBefore.slice(0, NAMES_MAX), sheets_after: [...sheetsBefore.slice(0, NAMES_MAX - 1), sheet.name], sheets_count: sheetsBefore.length + 1, added_sheet: sheet.name, ...(summarizeAiSheet(xml) ?? {}), preserved_parts: preserved, previous_sha256: rev ? createHash('sha256').update(base).digest('hex').slice(0, 16) : null };
  return { result: { created: true, path: up.path, rev: up.rev, sheet: sheet.name, ai_sheets: rec.ai_sheets.slice(-NAMES_MAX), diff, note: '原本は変えていない。Human の tab は 1 byte も変えていない（保存の前に確かめた）' } };
});
const estimateAiEdit = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const asked = outputPath(scope, 'estimates', task.params.working_name);
  const ledger = readLedger(svc, task.business);
  // 台帳の名前は実の名前（全角を含む）。依頼の名前は受け口で NFKC に揃っている＝畳んで同じ名前の写しを探す（2 つ在れば決められない）
  const keys = ledger.copies[asked.toLowerCase()] ? [asked.toLowerCase()] : Object.keys(ledger.copies).filter((k) => foldPath(k) === foldPath(asked));
  if (keys.length > 1) throw new XlsxError('estimate_copy_ambiguous');
  const rec = keys.length ? ledger.copies[keys[0]] : null;
  if (!rec) throw new XlsxError('estimate_not_ai_copy');
  const target = rec.path ?? keys[0]; // 作った時に Dropbox が返した名前（古い台帳には無い＝鍵の path）
  if (rec.tasks.includes(task.task_id)) return { result: { edited: true, already: true } };
  const w = svc.dropbox('write');
  const cur = await w.download(target, { signal });
  keepPrevious(svc, task.business, cur.bytes, cur.meta.rev);
  const xml = estimateSheetXml({ title: task.params.title, rows: task.params.rows, stamp: stampOf(task, now) });
  const { bytes, sheet, preserved, before } = replaceAiSheet(cur.bytes, { name: task.params.sheet_name, xml, aiSheets: rec.ai_sheets, aiIds: rec.ai_ids ?? {} });
  const up = await w.upload(target, bytes, { rev: cur.meta.rev, signal });
  rec.tasks = [...rec.tasks, task.task_id].slice(-200);
  writeLedger(svc, task.business, ledger);
  // 保存の前後の差分（2026-11-16）：その tab の明細の行数と合計の前後。前が読めない形（Human がその tab を作り変えた）なら null（数を作らない）
  const after = summarizeAiSheet(xml);
  const diff = { sheet: sheet.name, rows_before: before?.rows ?? null, rows_after: after?.rows ?? null, total_before: before?.total ?? null, total_after: after?.total ?? null, preserved_parts: preserved, previous_sha256: createHash('sha256').update(cur.bytes).digest('hex').slice(0, 16) };
  return { result: { edited: true, path: up.path, rev: up.rev, sheet: sheet.name, diff, note: 'AI の tab を作り直した（その tab に Human が書いた物は Mac の履歴に残した版から戻せる）' } };
});

/**
 * 最後の確かめ：結果が Task Hub の上限（16 KiB）を越えたら、
 *   読む handler：想定内の result_too_large で終える（runner の result_invalid＝想定外にしない）
 *   書く handler：**書いた後に失敗と言わない**（やり直しで二重に書かせない・2026-11-16 監査）＝小さな値だけを残した結果（result_trimmed: true）で成功を返す
 * 読む handler は上の fitList・clip・readCalendar の budget で手前に収めている＝ここに来るのは見落としだけ
 */
export const bounded = (run, { writes = false } = {}) => async (ctx) => {
  const out = await run(ctx);
  if (out?.result === undefined || jsonBytes(out.result) <= MAX_BODY_BYTES) return out;
  if (!writes) throw fail('result_too_large', { expected: true });
  const small = Object.fromEntries(Object.entries(out.result).filter(([, v]) => (v === null || typeof v !== 'object') && jsonBytes(v) <= 1500).slice(0, 8));
  return { ...out, result: { ...small, result_trimmed: true } };
};
const entry = (run, opts) => ({ resumable: true, group: 'dropbox', run: bounded(run, opts) }); // group：機能ごとの回路遮断（runner）。Dropbox の障害で Task Hub 全体を PAUSE にしない
/** Dropbox に触らない handler（手元の写しだけ）。機能ごとの回路遮断の対象にしない＝動いても Dropbox の失敗の数えを戻さない */
const localEntry = (run, opts) => ({ resumable: true, run: bounded(run, opts) });
const W = { writes: true };

export const BUSINESS_HANDLERS = Object.freeze({
  'dropbox.search': entry(dropboxSearch),
  'dropbox.list': entry(dropboxList),
  'schedule.read': entry(scheduleRead),
  'schedule.backup': entry(scheduleBackup, W),
  'schedule.backup.list': localEntry(scheduleBackupList),
  'schedule.restore': entry(scheduleRestore, W),
  'karte.create': entry(karteCreate, W),
  'karte.get': entry(karteGet),
  'karte.append': entry(karteAppend, W),
  'karte.search': entry(karteSearch),
  'karte.report': entry(karteReport),
  'estimate.ai.create': entry(estimateAiCreate, W),
  'estimate.ai.edit': entry(estimateAiEdit, W),
});
