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
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadScopes, outputPath, scopeOf, searchRoot, assertReadable, ScopeError, withinRoot } from '../dropbox/scope.mjs';
import { appendToKarte, CARTE_SECTIONS, CASE_ID_RE, KarteError, newKarte, provenance, sectionText } from '../business/karte.mjs';
import { backupSchedule, BackupError, listGenerations, restoreGeneration } from '../business/schedule-backup.mjs';
import { addAiSheet, estimateSheetXml, readSheetRows, replaceAiSheet, XlsxError } from '../xlsx/workbook.mjs';
import { fail } from './handler-error.mjs';

const RESULT_TEXT_MAX = 6000;
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
const clip = (s) => (s.length > RESULT_TEXT_MAX ? `${s.slice(0, RESULT_TEXT_MAX)}\n…(省略)` : s);

function karteHistory(svc, business, caseId) {
  return (text, rev) => {
    if (!svc.historyDir) return;
    const d = path.join(svc.historyDir, business, 'karte-history', caseId);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(d, `${String(rev).replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}.md`), text, { mode: 0o600 });
  };
}

// ─── 資料（読むだけ）───
const dropboxSearch = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const root = searchRoot(scope, task.params.path ?? null);
  const hits = (await svc.dropbox('read').search(task.params.query, { path: root, max: 30, signal })).filter((h) => withinRoot(root, h.path));
  return { result: { count: hits.length, files: hits.slice(0, 30).map((h) => ({ name: h.name, path: h.path, size: h.size, server_modified: h.server_modified })) } };
});
const dropboxList = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const p = assertReadable(scope, task.params.path, 'browse'); // 見積（L2）のフォルダは承認なしの一覧に出さない
  const r = await svc.dropbox('read').list(p, { limit: 200, signal });
  return { result: { count: r.entries.length, truncated: r.truncated, entries: r.entries.slice(0, 100).map((e) => ({ tag: e.tag, name: e.name, path: e.path, ...(e.tag === 'file' ? { size: e.size, server_modified: e.server_modified } : {}) })) } };
});

// ─── 工程表（読むだけ・バックアップ・別の file への復元）───
function scheduleFile(scope, n) {
  const i = Number.isInteger(n) ? n - 1 : 0;
  const f = scope.schedule_files[i];
  if (!f) throw new ScopeError('schedule_not_configured');
  return f;
}
const scheduleRead = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const file = scheduleFile(scope, task.params.file);
  const { bytes, meta } = await svc.dropbox('read').download(file, { signal });
  const r = readSheetRows(bytes, { sheet: task.params.sheet ?? null, query: task.params.query ?? null, maxRows: 30 });
  return { result: { server_modified: meta.server_modified, rev: meta.rev, ...r } };
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
    if (bytes.toString('utf8').includes(`task=${task.task_id} -->`)) return { result: { created: true, already: true, path: p } };
    throw new KarteError('karte_exists');
  }
});
const karteGet = ({ task, config, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const { bytes, meta } = await svc.dropbox('write').download(kartePath(scope, task.params.case_id), { signal });
  const text = bytes.toString('utf8');
  if (task.params.section) {
    const t = sectionText(text, task.params.section);
    if (t === null) throw new KarteError('karte_field_unknown');
    return { result: { case_id: task.params.case_id, section: task.params.section, text: clip(t), rev: meta.rev, server_modified: meta.server_modified } };
  }
  return { result: { case_id: task.params.case_id, text: clip(text), rev: meta.rev, server_modified: meta.server_modified, ...provenance(text) } };
});
const karteAppend = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const p = kartePath(scope, task.params.case_id);
  const w = svc.dropbox('write');
  const { bytes } = await w.download(p, { signal });
  if (bytes.toString('utf8').includes(`task=${task.task_id} -->`)) return { result: { appended: true, already: true } }; // 冪等
  const r = await appendToKarte({ writer: w, path: p, section: task.params.section, value: task.params.text, at: iso(now), taskId: task.task_id, dated: task.params.date ?? null, history: karteHistory(svc, task.business, task.params.case_id), signal });
  return { result: { appended: true, rev: r.rev, ai_blocks: r.ai_blocks } };
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
  const t = bytes.toString('utf8');
  const part = (k, label) => `■ ${label}\n${sectionText(t, k) || '（記載なし）'}`;
  const text = [`【現場カルテの要点】${task.params.case_id}`, part('schedule', '作業予定'), part('safety', '安全上の注意事項'), part('unknowns', '未確認事項'), part('survey_log', '現調履歴')].join('\n');
  return { result: { case_id: task.params.case_id, text: clip(text) } };
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

const estimateAiCreate = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const original = assertReadable(scope, task.params.original_path, 'estimate');
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
  try {
    const cur = await w.download(target, { signal }); // AI 作業版が既にある：その版に足す（Human がその写しに足した物も残る）
    base = cur.bytes;
    rev = cur.meta.rev;
    keepPrevious(svc, task.business, base, rev);
  } catch (e) {
    if (e?.code !== 'dropbox_path_not_found') throw e; // AI 作業版がまだ無い時だけ原本から作る
    base = (await svc.dropbox('read').download(original, { signal })).bytes; // 原本は読むだけ（読みの資格情報は書けない）
  }
  const { bytes, sheet } = addAiSheet(base, { name: task.params.sheet_name, xml });
  // 台帳を先に（上げた後に止まっても、AI が作った tab として直せる＝監査 nit 11）。上げられなければ戻す
  const before = JSON.stringify(rec);
  rec.ai_sheets = [...rec.ai_sheets, sheet.name];
  rec.ai_ids = { ...(rec.ai_ids ?? {}), [sheet.name]: sheet.sheetId };
  ledger.copies[key] = rec;
  writeLedger(svc, task.business, ledger);
  let up;
  try { up = await w.upload(target, bytes, { rev, signal }); } catch (e) { ledger.copies[key] = JSON.parse(before); if (!ledger.copies[key].ai_sheets.length) delete ledger.copies[key]; writeLedger(svc, task.business, ledger); throw e; }
  rec.tasks = [...rec.tasks, task.task_id].slice(-200);
  writeLedger(svc, task.business, ledger);
  return { result: { created: true, path: up.path, rev: up.rev, sheet: sheet.name, ai_sheets: rec.ai_sheets, note: '原本は変えていない。Human の tab は 1 byte も変えていない（保存の前に確かめた）' } };
});
const estimateAiEdit = ({ task, config, now, signal }) => guarded(async () => {
  const svc = services(config);
  const scope = scopeOf(scopesOf(config), task.business);
  const target = outputPath(scope, 'estimates', task.params.working_name);
  const ledger = readLedger(svc, task.business);
  const rec = ledger.copies[target.toLowerCase()];
  if (!rec) throw new XlsxError('estimate_not_ai_copy');
  if (rec.tasks.includes(task.task_id)) return { result: { edited: true, already: true } };
  const w = svc.dropbox('write');
  const cur = await w.download(target, { signal });
  keepPrevious(svc, task.business, cur.bytes, cur.meta.rev);
  const xml = estimateSheetXml({ title: task.params.title, rows: task.params.rows, stamp: stampOf(task, now) });
  const { bytes, sheet } = replaceAiSheet(cur.bytes, { name: task.params.sheet_name, xml, aiSheets: rec.ai_sheets, aiIds: rec.ai_ids ?? {} });
  const up = await w.upload(target, bytes, { rev: cur.meta.rev, signal });
  rec.tasks = [...rec.tasks, task.task_id].slice(-200);
  writeLedger(svc, task.business, ledger);
  return { result: { edited: true, path: up.path, rev: up.rev, sheet: sheet.name, note: 'AI の tab を作り直した（その tab に Human が書いた物は Mac の履歴に残した版から戻せる）' } };
});

export const BUSINESS_HANDLERS = Object.freeze({
  'dropbox.search': { resumable: true, run: dropboxSearch },
  'dropbox.list': { resumable: true, run: dropboxList },
  'schedule.read': { resumable: true, run: scheduleRead },
  'schedule.backup': { resumable: true, run: scheduleBackup },
  'schedule.backup.list': { resumable: true, run: scheduleBackupList },
  'schedule.restore': { resumable: true, run: scheduleRestore },
  'karte.create': { resumable: true, run: karteCreate },
  'karte.get': { resumable: true, run: karteGet },
  'karte.append': { resumable: true, run: karteAppend },
  'karte.search': { resumable: true, run: karteSearch },
  'karte.report': { resumable: true, run: karteReport },
  'estimate.ai.create': { resumable: true, run: estimateAiCreate },
  'estimate.ai.edit': { resumable: true, run: estimateAiEdit },
});
