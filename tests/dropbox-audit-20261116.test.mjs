/**
 * Dropbox の業務基盤：本番接続の前の独立監査（2026-11-16）の指摘の再発防止。実の Dropbox・資格情報には接続しない（模擬と作り物だけ）。
 *   権限の境：広い read_roots の中の見積（L2）・読ませない場所（deny_roots）を承認なしの一覧・検索に出さない／見えない文字の path
 *   client：中止済みの signal で要求を出さない・本文の読み込みが止まっても時間切れで終わる
 *   カルテ：UTF-8 でない file を化けさせて上げ直さない・同じ task の二重の差し込み・書式の「未確認」・NFKC で文字を変えない・23 項目・business の境
 *   見積：文字を変えない・構成を保護したブック・Human が参照している AI の tab・保存の前後の差分・原本の版の記録
 *   工程表：資格情報が無いまま取れていないことを知らせる・business ごとの結果・書ける config を使わない
 *   dropbox-auth：書きの app が App folder の app であることの自動の確かめ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDropbox } from '../scripts/lib/dropbox/client.mjs';
import { assertReadable, browsable, loadScopes, normPath, scopeOf, searchRoot } from '../scripts/lib/dropbox/scope.mjs';
import { appendToKarte, CARTE_SECTIONS, decodeKarte, insertIntoSection, newKarte, PLACEHOLDER_LINE, provenance, sectionText, unknownSections } from '../scripts/lib/business/karte.mjs';
import { markWeekly } from '../scripts/lib/business/schedule-backup.mjs';
import { addAiSheet, estimateSheetXml, replaceAiSheet, summarizeAiSheet } from '../scripts/lib/xlsx/workbook.mjs';
import { entryData, makeEntry, readZip, writeZip } from '../scripts/lib/xlsx/zip.mjs';
import { businessBackupItem } from '../scripts/lib/task-hub/audit-watch.mjs';
import { workingName } from '../scripts/lib/task-hub/business-handlers.mjs';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { ruleOf } from '../scripts/lib/alert-policy.mjs';
import { safeValue } from '../scripts/host-health.mjs';
import { businessCycle } from '../scripts/business-cycle.mjs';
import { writeAppNamespace } from '../scripts/dropbox-auth.mjs';
import { startDropboxMock } from './dropbox-mock.mjs';
import { envelope, makeEnv } from './task-hub-helpers.mjs';
import { fixtureWorkbook } from './xlsx-fixture.mjs';

const NOW = Date.parse('2026-11-16T03:00:00.000Z');
const WEEK_MS = 7 * 86_400_000;
const DROPBOX = { businesses: {
  'biz-a': { read_roots: ['/会社A'], schedule_files: ['/会社A/工程/作業予定表.xlsx'], estimate_roots: ['/会社A/現場管理/現場A/見積'], deny_roots: ['/会社A/人事'], output_root: '/biz-a' },
  'biz-b': { read_roots: ['/会社B/資料'], schedule_files: ['/会社B/工程.xlsx'], output_root: '/biz-b' },
} };

async function world() {
  const read = await startDropboxMock({ role: 'read' });
  const write = await startDropboxMock({ role: 'write' });
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx-audit-'));
  read.put('/会社A/工程/作業予定表.xlsx', fixtureWorkbook());
  read.put('/会社B/工程.xlsx', fixtureWorkbook());
  read.put('/会社A/現場管理/現場A/平面図.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/会社A/現場管理/現場A/見積/現場A_見積書.xlsx', fixtureWorkbook());
  read.put('/会社A/人事/給与_平面図.pdf', Buffer.from('secret'));
  const reader = read.client(createDropbox);
  const writer = write.client(createDropbox);
  const services = { backupDir: dir, historyDir: dir, dropbox: (role) => (role === 'read' ? reader : writer) };
  const close = async () => { await read.close(); await write.close(); rmSync(dir, { recursive: true, force: true }); };
  return { read, write, reader, writer, dir, services, close };
}
function hub(w) {
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  const config = { ...env.config, services: w.services };
  const run = () => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
  const submit = async (intent, params, business = 'biz-a') => (await submitLocal(envelope({ intent, params, business }), { store: env.store, policy: env.policy, now: env.clock.t })).task_id;
  const res = (id) => env.store.readTask(id);
  const approved = async (intent, params) => { const id = await submit(intent, params); approve(env.store, id, { confirm: res(id).content_digest.slice(0, 12), isTTY: true, now: env.clock.t }); return id; };
  return { env, run, submit, res, approved };
}

// ─── 権限の境 ───
test('範囲：広い read_roots の中の見積（L2）と deny_roots は、承認なしの一覧・検索の対象にならない・見積の読み方（承認つき）だけが見積を読める', () => {
  const s = scopeOf(loadScopes(DROPBOX), 'biz-a');
  assert.equal(browsable(s, '/会社A/現場管理/現場A/平面図.pdf'), true);
  for (const p of ['/会社A/現場管理/現場A/見積', '/会社A/現場管理/現場A/見積/現場A_見積書.xlsx', '/会社A/人事', '/会社A/人事/給与.xlsx', '/会社a/人事/x', '/会社B/資料/x', '/会社AB/x']) assert.equal(browsable(s, p), false, p);
  for (const p of ['/会社A/現場管理/現場A/見積', '/会社A/人事/給与.xlsx']) {
    assert.throws(() => assertReadable(s, p, 'browse'), { code: 'dropbox_path_not_allowed' });
    assert.throws(() => searchRoot(s, p), { code: 'dropbox_path_not_allowed' });
  }
  assert.equal(assertReadable(s, '/会社A/現場管理/現場A/見積/現場A_見積書.xlsx', 'estimate'), '/会社A/現場管理/現場A/見積/現場A_見積書.xlsx');
  for (const kind of ['any', 'estimate', 'schedule', 'browse']) assert.throws(() => assertReadable(s, '/会社A/人事/給与.xlsx', kind), { code: 'dropbox_path_not_allowed' }, `deny は ${kind} でも拒否`);
  // 読ませない場所の中に工程表・見積の原本を置く設定は読み込まない
  for (const bad of [{ schedule_files: ['/x/人事/工程.xlsx'] }, { estimate_roots: ['/x/人事/見積'] }, { deny_roots: ['/'] }, { deny_roots: 'x' }]) assert.throws(() => loadScopes({ businesses: { 'biz-a': { read_roots: ['/x'], deny_roots: ['/x/人事'], output_root: '/biz-a', ...bad } } }), { code: 'dropbox_config_invalid' }, JSON.stringify(bad));
  assert.deepEqual(scopeOf(loadScopes({ businesses: { 'biz-a': { read_roots: ['/x'], output_root: '/biz-a' } } }), 'biz-a').deny_roots, [], '省けば空');
});

test('範囲：見えない文字（零幅・bidi の向き）を含む path は扱わない', () => {
  for (const p of ['/会社A/a\u200bb', '/会社A/\u202egpj.exe', '/会社A/a\u2060b', '/会社A/\ufeffx', '/会社A/a\u200eb', '/会社A/\u2066x\u2069']) assert.equal(normPath(p), null, JSON.stringify(p));
  // 絵文字をつなぐ文字（U+200D）は名前の一部：フォルダ名の絵文字 1 つで config 全体を無効にしない
  const emoji = `/会社A/${String.fromCodePoint(0x1f477, 0x200d, 0x2642, 0xfe0f)}現場`;
  assert.equal(normPath(emoji), emoji);
  assert.equal(scopeOf(loadScopes({ businesses: { 'biz-a': { read_roots: [emoji], output_root: '/biz-a' } } }), 'biz-a').read_roots.length, 1);
  assert.equal(normPath('/会社A/現場Ａ／Ｂ（全角の斜線は名前の文字）'), '/会社A/現場Ａ／Ｂ（全角の斜線は名前の文字）');
  assert.throws(() => loadScopes({ businesses: { 'biz-a': { read_roots: ['/x\u200b'], output_root: '/biz-a' } } }), { code: 'dropbox_config_invalid' });
});

test('Task Hub：一覧・検索の結果から、見積のフォルダと読ませない場所は名前も出ない（Dropbox が返しても絞る）', async () => {
  const w = await world();
  const { env, run, submit, res } = hub(w);
  try {
    const ids = {
      list: await submit('dropbox.list', { path: '/会社A/現場管理/現場A' }),
      top: await submit('dropbox.list', { path: '/会社A' }),
      search: await submit('dropbox.search', { query: '平面図' }),
      est: await submit('dropbox.list', { path: '/会社A/現場管理/現場A/見積' }),
      hr: await submit('dropbox.list', { path: '/会社A/人事' }),
      hrSearch: await submit('dropbox.search', { query: '給与', path: '/会社A/人事' }),
    };
    await run();
    assert.deepEqual(res(ids.list).result.entries.map((e) => e.name), ['平面図.pdf'], '見積のフォルダは一覧に出ない');
    assert.deepEqual(res(ids.top).result.entries.map((e) => e.name).sort(), ['工程', '現場管理'], '人事は一覧に出ない');
    assert.deepEqual(res(ids.search).result.files.map((f) => f.path), ['/会社A/現場管理/現場A/平面図.pdf'], '人事の「給与_平面図.pdf」は検索に出ない');
    for (const k of ['est', 'hr', 'hrSearch']) assert.deepEqual([res(ids[k]).state, res(ids[k]).error.code], ['failed', 'dropbox_path_not_allowed'], k);
    assert.ok(!JSON.stringify([res(ids.list).result, res(ids.top).result, res(ids.search).result]).includes('給与'));
    assert.equal(env.store.isPaused(), false);
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

// ─── client ───
test('client：中止済みの signal では要求を出さない・本文の読み込みが止まっても時間切れで終わる（古い試行が後から書きに行かない）', async () => {
  const sent = [];
  const ok = (j) => ({ ok: true, status: 200, headers: new Map(), json: async () => j });
  const fetchImpl = async (url) => { sent.push(String(url)); return String(url).endsWith('/oauth2/token') ? ok({ access_token: 't', expires_in: 3600 }) : ok({ entries: [], has_more: false }); };
  const c = createDropbox({ role: 'write', credentials: { appKey: 'k', refreshToken: 'r' }, fetchImpl, api: 'http://x', content: 'http://x' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(c.upload('/a', Buffer.from('x'), { signal: ac.signal }), { code: 'aborted' });
  await assert.rejects(c.list('', { signal: ac.signal }), { code: 'aborted' });
  assert.deepEqual(sent, [], '1 本も出さない');
  // header は届いたが本文が来ない：前は終わらなかった
  const stall = async (url) => (String(url).endsWith('/oauth2/token') ? ok({ access_token: 't', expires_in: 3600 }) : { ok: true, status: 200, headers: new Map([['dropbox-api-result', '{}']]), json: () => new Promise(() => {}), arrayBuffer: () => new Promise(() => {}) });
  const slow = createDropbox({ role: 'read', credentials: { appKey: 'k', refreshToken: 'r' }, fetchImpl: stall, api: 'http://x', content: 'http://x', timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(slow.download('/a'), { code: 'dropbox_timeout' });
  await assert.rejects(slow.list(''), { code: 'dropbox_timeout' });
  assert.ok(Date.now() - t0 < 3000);
  // 途中で task が中止された：待たずに aborted
  const ac2 = new AbortController();
  const p = createDropbox({ role: 'read', credentials: { appKey: 'k', refreshToken: 'r' }, fetchImpl: stall, api: 'http://x', content: 'http://x', timeoutMs: 60_000 }).download('/a', { signal: ac2.signal });
  setTimeout(() => ac2.abort(), 30);
  await assert.rejects(p, { code: 'aborted' });
});

// ─── カルテ ───
test('カルテ：共通の書式は 23 項目・値の無い項目は印つきの「未確認」・値が入ると書式の「未確認」は外れる（Human の「未確認」と直した行は残す）', () => {
  assert.equal(CARTE_SECTIONS.length, 23);
  assert.equal(new Set(CARTE_SECTIONS.map(([k]) => k)).size, 23);
  const k = newKarte({ caseId: 'C-001', siteName: '現場A', fields: { safety: '電線が近い' }, at: '2026-11-16T00:00:00Z', taskId: 't-1' });
  assert.equal((k.match(/^## /gm) ?? []).length, 23);
  assert.equal(k.split('\n').filter((l) => l === PLACEHOLDER_LINE).length, 20, '現場名・案件ID・安全上の注意事項の他は未確認');
  assert.equal(unknownSections(k).length, 20);
  assert.equal(sectionText(k, 'access'), '未確認', '読む時は印を見せない');
  const a = insertIntoSection(k, { section: 'access', value: '西側から搬入', at: 'x', taskId: 't-2' });
  assert.match(a, /## 搬入経路\n\n<!-- ai:x task=t-2 -->\n西側から搬入\n<!-- \/ai -->\n\n## 近隣/);
  assert.equal(sectionText(a, 'access'), '西側から搬入', '値が入った節に「未確認」が残らない');
  assert.equal(unknownSections(a).length, 19);
  // 他の節は 1 文字も変わらない
  assert.equal(a.replace('<!-- ai:x task=t-2 -->\n西側から搬入\n<!-- /ai -->', PLACEHOLDER_LINE), k);
  // Human が印を消して自分で書いた「未確認」・印の行を書き換えた行は Human の文＝残す
  const own = k.replace(`## 搬入経路\n\n${PLACEHOLDER_LINE}`, '## 搬入経路\n\n未確認');
  assert.match(insertIntoSection(own, { section: 'access', value: 'v', at: 'x', taskId: 't-3' }), /## 搬入経路\n\n未確認\n<!-- ai:x task=t-3 -->/);
  const edited = k.replace(`## 搬入経路\n\n${PLACEHOLDER_LINE}`, `## 搬入経路\n\n未確認（来週確認） <!-- placeholder -->`);
  assert.match(insertIntoSection(edited, { section: 'access', value: 'v', at: 'x', taskId: 't-3' }), /未確認（来週確認） <!-- placeholder -->\n<!-- ai:x task=t-3 -->/);
  // Human が印の行を残したまま下に書いた：読む時は Human の文だけ・AI が差し込めば印の行だけ外れる
  const below = k.replace(`## 搬入経路\n\n${PLACEHOLDER_LINE}`, `## 搬入経路\n\n${PLACEHOLDER_LINE}\n北側は 4t 不可（Human）`);
  assert.equal(sectionText(below, 'access'), '北側は 4t 不可（Human）');
  const b2 = insertIntoSection(below, { section: 'access', value: 'v', at: 'x', taskId: 't-4' });
  assert.match(b2, /## 搬入経路\n\n北側は 4t 不可（Human）\n<!-- ai:x task=t-4 -->\nv\n<!-- \/ai -->\n\n## 近隣/);
  assert.equal(provenance(k).ai_blocks, 3, '書式の印は AI の囲みに数えない');
});

test('カルテ：書く文字は渡されたまま（NFKC で「㎡」「①」「㈱」「Ａ邸」を変えない）・全角で印や見出しをまねる値は拒否', () => {
  const k = newKarte({ caseId: 'C-001', siteName: 'Ａ邸', at: 'x', taskId: 't-1' });
  assert.ok(k.includes('# 現場カルテ：Ａ邸'));
  const v = '約120㎡（概算）① ㈱Ａ製';
  assert.ok(insertIntoSection(k, { section: 'scaffold_area', value: v, at: 'x', taskId: 't-2' }).includes(`\n${v}\n`));
  assert.ok(insertIntoSection(k, { section: 'scaffold_area', value: 'ガ'.normalize('NFD'), at: 'x', taskId: 't-2' }).includes('\nガ\n'.normalize('NFC')), 'NFD は NFC に（同じ文字）');
  for (const bad of ['＜!-- ai:fake --＞', '＃ 見出し', 'x\n＃＃　見出し', '<!-- /ai -->']) assert.throws(() => insertIntoSection(k, { section: 'access', value: bad, at: 'x', taskId: 't' }), { code: 'karte_value_invalid' }, bad);
});

test('カルテ：UTF-8 でない file（Human が Shift_JIS・UTF-16 で保存し直した）は読まない・書かない＝化けた文を上げ直さない', async () => {
  const w = await world();
  const { env, run, submit, res } = hub(w);
  try {
    const k = newKarte({ caseId: 'C-001', siteName: '現場A', at: 'x', taskId: 't-0' });
    const sjis = Buffer.concat([Buffer.from(k, 'utf8'), Buffer.from([0x91, 0xab, 0x8f, 0xea, 0x0a])]); // 「足場」の Shift_JIS
    const f = w.write.put('/biz-a/karte/C-001.md', sjis);
    assert.throws(() => decodeKarte(sjis), { code: 'karte_not_utf8' });
    assert.equal(decodeKarte(Buffer.from(k, 'utf8')), k);
    const ids = { app: await submit('karte.append', { case_id: 'C-001', section: 'access', text: '西側から' }), get: await submit('karte.get', { case_id: 'C-001' }), rep: await submit('karte.report', { case_id: 'C-001' }) };
    await run();
    for (const id of Object.values(ids)) assert.deepEqual([res(id).state, res(id).error.code], ['failed', 'karte_not_utf8']);
    const now = w.write.files.get('/biz-a/karte/c-001.md');
    assert.ok(now.bytes.equals(sjis) && now.rev === f.rev, 'Dropbox の file は 1 byte も変わらない');
    assert.equal(existsSync(path.join(w.dir, 'biz-a', 'karte-history', 'C-001')), false, '化けた写しを履歴に残さない');
    assert.equal(env.store.isPaused(), false, '想定内の失敗（Task Hub を止めない）');
    // UTF-8 の file では、上げる前の版が取った bytes のまま手元に残る
    w.write.put('/biz-a/karte/C-001.md', Buffer.from(k, 'utf8'));
    const ok = await submit('karte.append', { case_id: 'C-001', section: 'access', text: '西側から' });
    await run();
    assert.equal(res(ok).state, 'succeeded');
    const hist = path.join(w.dir, 'biz-a', 'karte-history', 'C-001');
    assert.ok(readFileSync(path.join(hist, readdirSync(hist)[0])).equals(Buffer.from(k, 'utf8')));
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

test('カルテ：読み直しの間に同じ task がもう差し込んでいたら二重に書かない・他の business からは同じ案件ID でも読めない', async () => {
  const w = await world();
  const { env, run, submit, res } = hub(w);
  try {
    const k = newKarte({ caseId: 'C-001', siteName: '現場A', at: 'x', taskId: 't-0' });
    w.write.put('/biz-a/karte/C-001.md', Buffer.from(k, 'utf8'));
    // 1 回目の upload の直前に、同じ task の別の試行（時間切れの後の古い試行）が先に書く
    let once = true;
    w.write.state.beforeUpload = () => {
      if (!once) return;
      once = false;
      const cur = w.write.files.get('/biz-a/karte/c-001.md');
      w.write.put(cur.path, Buffer.from(insertIntoSection(cur.bytes.toString(), { section: 'access', value: '西側から', at: 'y', taskId: 'T9' })));
    };
    const r = await appendToKarte({ writer: w.writer, path: '/biz-a/karte/C-001.md', section: 'access', value: '西側から', at: 'x', taskId: 'T9' });
    w.write.state.beforeUpload = null;
    assert.equal(r.already, true);
    assert.equal((w.write.files.get('/biz-a/karte/c-001.md').bytes.toString().match(/task=T9 -->/g) ?? []).length, 1);
    // business の境：biz-b の依頼は biz-b の場所（/biz-b/karte）だけを見る
    const other = await submit('karte.get', { case_id: 'C-001' }, 'biz-b');
    const otherApp = await submit('karte.append', { case_id: 'C-001', section: 'access', text: 'x' }, 'biz-b');
    const trav = await submit('karte.get', { case_id: '../biz-a/karte/C-001' }, 'biz-b');
    await run();
    assert.deepEqual([res(other).state, res(other).error.code], ['failed', 'dropbox_path_not_found']);
    assert.deepEqual([res(otherApp).state, res(otherApp).error.code], ['failed', 'dropbox_path_not_found']);
    assert.equal(res(trav).state, 'rejected', '案件ID に / は使えない（台帳の形）');
    assert.ok(!w.write.state.calls.length || !w.write.files.has('/biz-b/karte/c-001.md'));
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

// ─── 見積 ───
const ROWS = [{ item: '足場', qty: 100, unit: '㎡', price: 1000 }, { item: '養生①', qty: 2, unit: '式', price: 5000 }];
const editPart = (bytes, name, fn) => writeZip(readZip(bytes).map((e) => (e.name === name ? makeEntry(name, Buffer.from(fn(entryData(e).toString('utf8'))), e) : e)));

test('見積：文字は渡されたまま（NFKC にしない）・要点（行数と合計）は作った形からだけ読む', () => {
  const xml = estimateSheetXml({ title: 'Ａ邸 約120㎡（概算）', rows: ROWS, stamp: 's' });
  for (const s of ['Ａ邸 約120㎡（概算）', '㎡', '養生①']) assert.ok(xml.includes(s), s);
  assert.deepEqual(summarizeAiSheet(xml), { rows: 2, total: 110000 });
  assert.equal(summarizeAiSheet('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'), null, '形が違えば数を作らない');
});

test('見積：構成を保護したブックには tab を足さない・Human の tab や定義名が参照している AI の tab は作り直さない', () => {
  const base = fixtureWorkbook();
  const xml = estimateSheetXml({ title: 't', rows: ROWS, stamp: 's' });
  for (const prot of ['<workbookProtection lockStructure="1"/>', '<workbookProtection workbookPassword="CC1A" lockStructure="true"/>']) {
    const locked = editPart(base, 'xl/workbook.xml', (t) => t.replace('<sheets>', `${prot}<sheets>`));
    assert.throws(() => addAiSheet(locked, { name: 'AI_案1', xml }), { code: 'estimate_workbook_structure_locked' });
  }
  assert.ok(addAiSheet(editPart(base, 'xl/workbook.xml', (t) => t.replace('<sheets>', '<workbookProtection lockWindows="1"/><sheets>')), { name: 'AI_案1', xml }).bytes.length > 0, '構成の保護でなければ足せる');
  const { bytes, sheet, preserved, sheets_before: before } = addAiSheet(base, { name: 'AI_案1', xml });
  assert.deepEqual(before, ['見積', '内訳']);
  assert.ok(preserved >= 5);
  const opts = { name: 'AI_案1', xml: estimateSheetXml({ title: 't', rows: [...ROWS, ...ROWS], stamp: 's' }), aiSheets: ['AI_案1'], aiIds: { 'AI_案1': sheet.sheetId } };
  const r = replaceAiSheet(bytes, opts);
  assert.deepEqual(r.before, { rows: 2, total: 110000 });
  // Human の tab が AI の tab の合計の cell を参照している：作り直すと指す先が明細の行に変わる（Human の部品は 1 byte も変わらないまま）＝直さない
  const refs = [
    ['xl/worksheets/sheet2.xml', (t) => t.replace('</row>', '<c r="B1"><f>AI_案1!F7</f><v>110000</v></c></row>')],
    ['xl/worksheets/sheet2.xml', (t) => t.replace('</row>', "<c r=\"B1\"><f>'AI_案1'!F7*1.1</f><v>121000</v></c></row>")],
    ['xl/worksheets/sheet2.xml', (t) => t.replace('</row>', '<c r="B1"><f>SUM(ai_案1!F4:F5)</f><v>110000</v></c></row>')],
    ['xl/workbook.xml', (t) => t.replace('</definedNames>', '<definedName name="合計">AI_案1!$F$7</definedName></definedNames>')],
  ];
  for (const [part, fn] of refs) assert.throws(() => replaceAiSheet(editPart(bytes, part, fn), opts), { code: 'estimate_ai_sheet_referenced' }, part);
  // 似た名前の別の tab への参照・文字としての「AI_案1」は参照ではない
  assert.ok(replaceAiSheet(editPart(bytes, 'xl/worksheets/sheet2.xml', (t) => t.replace('</row>', '<c r="B1"><f>AI_案10!F7</f><v>0</v></c><c r="C1" t="inlineStr"><is><t>AI_案1 を参照</t></is></c></row>')), opts).bytes.length > 0);
});

test('Task Hub：見積の結果に保存の前後の差分（何から作ったか・tab・行数と合計の前後・そのままの部品の数・前の版）と、写した原本の版を残す', async () => {
  const w = await world();
  const { env, run, res, approved } = hub(w);
  try {
    const original = '/会社A/現場管理/現場A/見積/現場A_見積書.xlsx';
    const c1 = await approved('estimate.ai.create', { original_path: original, sheet_name: 'AI_案1', title: '現場A（AI 案）', rows: ROWS });
    await run();
    assert.equal(res(c1).state, 'succeeded', JSON.stringify(res(c1).error));
    const d1 = res(c1).result.diff;
    assert.deepEqual([d1.base, d1.sheets_before, d1.sheets_after, d1.added_sheet, d1.rows, d1.total, d1.previous_sha256], ['original', ['見積', '内訳'], ['見積', '内訳', 'AI_案1'], 'AI_案1', 2, 110000, null]);
    assert.ok(d1.preserved_parts >= 5);
    const ledger = JSON.parse(readFileSync(path.join(w.dir, 'biz-a', 'estimates', 'ledger.json'), 'utf8'));
    const rec = Object.values(ledger.copies)[0];
    const o = w.read.files.get(original.toLowerCase());
    assert.deepEqual([rec.original, rec.original_rev], [original, o.rev], 'どの版の原本から写したか');
    assert.match(rec.original_hash, /^[0-9a-f]{64}$/);
    const c2 = await approved('estimate.ai.create', { original_path: original, sheet_name: 'AI_案2', title: '案2', rows: ROWS.slice(0, 1) });
    const name = workingName(original);
    await run();
    const d2 = res(c2).result.diff;
    assert.deepEqual([d2.base, d2.sheets_before, d2.added_sheet, d2.rows, d2.total], ['working_copy', ['見積', '内訳', 'AI_案1'], 'AI_案2', 1, 100000]);
    assert.match(d2.previous_sha256, /^[0-9a-f]{16}$/);
    const e1 = await approved('estimate.ai.edit', { working_name: name, sheet_name: 'AI_案1', title: '修正', rows: [{ item: '足場', qty: 120, unit: '㎡', price: 1000 }] });
    await run();
    const d3 = res(e1).result.diff;
    assert.deepEqual([d3.sheet, d3.rows_before, d3.rows_after, d3.total_before, d3.total_after], ['AI_案1', 2, 1, 110000, 120000]);
    assert.ok(d3.preserved_parts >= 5 && /^[0-9a-f]{16}$/.test(d3.previous_sha256));
    // Human がその AI の tab を参照する数式を自分の tab に書いた後は、作り直しを断る（想定内の失敗）
    const cur = w.write.files.get(`/biz-a/estimates/${name}`.toLowerCase());
    w.write.put(cur.path, editPart(cur.bytes, 'xl/worksheets/sheet2.xml', (t) => t.replace('</row>', '<c r="B1"><f>AI_案1!F6</f><v>120000</v></c></row>')));
    const e2 = await approved('estimate.ai.edit', { working_name: name, sheet_name: 'AI_案1', title: 'x', rows: ROWS });
    const before = Buffer.from(w.write.files.get(`/biz-a/estimates/${name}`.toLowerCase()).bytes);
    await run();
    assert.deepEqual([res(e2).state, res(e2).error.code, env.store.isPaused()], ['failed', 'estimate_ai_sheet_referenced', false]);
    assert.ok(w.write.files.get(`/biz-a/estimates/${name}`.toLowerCase()).bytes.equals(before), '断った時は何も書かない');
    assert.ok(w.read.files.get(original.toLowerCase()).bytes.equals(o.bytes), '原本は 1 byte も変わらない');
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

// ─── 工程表のバックアップの見張り ───
test('工程表：設定済みなのに読みの資格情報が無い＝no_credentials で知らせる（前は ok と出た）・資格情報が入って取れたら ok', async () => {
  const w = await world();
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  const store = env.store.dir;
  const noCred = () => ({ ...w.services, dropbox: () => { throw Object.assign(new Error('x'), { code: 'not_configured' }); } });
  try {
    assert.equal(businessBackupItem(store, NOW), null, '回が 1 度も書いていない＝項目なし（休眠）');
    writeFileSync(path.join(store, 'config.json'), JSON.stringify(env.config), { mode: 0o600 });
    for (const day of [0, 1, 10, 30]) {
      const r = await businessCycle({ store, now: NOW + day * 86_400_000, services: noCred });
      assert.deepEqual([r.code, r.exit], ['not_configured', 0]);
      assert.deepEqual(businessBackupItem(store, NOW + day * 86_400_000), { id: 'business_backup', level: 'warn', value: 'no_credentials', kind: 'state' }, `day ${day}`);
    }
    assert.equal(safeValue('business_backup', 'no_credentials'), 'no_credentials', 'host-health が値を通す');
    assert.match(ruleOf('business_backup').what('no_credentials'), /資格情報/);
    const ok = await businessCycle({ store, now: NOW + 31 * 86_400_000, services: () => w.services });
    assert.equal(ok.code, 'ok');
    assert.equal(businessBackupItem(store, NOW + 31 * 86_400_000).value, 'ok');
    assert.equal(businessBackupItem(store, NOW + 40 * 86_400_000).value, 'stale', '8 日以上成功していない');
    // 他のユーザーが書ける config は使わない（何も取らない・Task Hub の側が config を拒否して知らせる）
    chmodSync(path.join(store, 'config.json'), 0o666);
    assert.deepEqual(await businessCycle({ store, now: NOW + 60 * 86_400_000, services: () => { throw new Error('使わない'); } }), { code: 'not_configured', exit: 0 });
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

test('工程表：business ごとの結果を持つ＝別の business の成功で、時刻の来ていない business の失敗を消さない', async () => {
  const w = await world();
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  const store = env.store.dir;
  const last = () => JSON.parse(readFileSync(path.join(store, 'business-last.json'), 'utf8'));
  try {
    writeFileSync(path.join(store, 'config.json'), JSON.stringify(env.config), { mode: 0o600 });
    w.read.files.delete('/会社b/工程.xlsx'); // biz-b の工程表が取れない
    const r1 = await businessCycle({ store, now: NOW, services: () => w.services });
    assert.deepEqual([r1.code, last().status], ['problem', { 'biz-a': 'ok', 'biz-b': 'problem' }]);
    // biz-a だけ時刻が来た回（biz-b は再試行の待ち）：biz-a が成功しても全体は problem のまま
    markWeekly(w.dir, 'biz-a', NOW - WEEK_MS); // biz-a をもう一度「時刻が来た」にする
    const r2 = await businessCycle({ store, now: NOW + 60_000, services: () => w.services });
    assert.deepEqual([r2.code, r2.exit, r2.weekly.map((x) => x.business), last().status], ['problem', 0, ['biz-a'], { 'biz-a': 'ok', 'biz-b': 'problem' }]);
    assert.equal(businessBackupItem(store, NOW + 60_000).value, 'problem');
    assert.equal(last().last_weekly_ok_at, null, '全部が成功した回だけ成功の時刻にする');
    // biz-b が取れるようになった
    w.read.put('/会社B/工程.xlsx', fixtureWorkbook());
    const r3 = await businessCycle({ store, now: NOW + 2 * 86_400_000, services: () => w.services });
    assert.deepEqual([r3.code, last().status], ['ok', { 'biz-a': 'ok', 'biz-b': 'ok' }]);
    assert.ok(!JSON.stringify(last()).includes('会社'), 'path は出さない');
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

// ─── dropbox-auth ───
test('dropbox-auth：書きの app が App folder の app か（Dropbox の一番上の項目が同じ id で見えたら Full Dropbox＝保存しない）', async () => {
  const top = [{ tag: 'folder', name: '会社A', path: '/会社A', id: 'id:AAA' }, { tag: 'file', name: 'x.txt', path: '/x.txt', id: 'id:BBB' }];
  const reader = { list: async (p, o) => { assert.deepEqual([p, o.ids], ['', true]); return { entries: top, truncated: false }; } };
  const notFound = Object.assign(new Error('x'), { code: 'dropbox_path_not_found' });
  assert.equal(await writeAppNamespace(reader, { metadata: async () => { throw notFound; } }), 'app_folder');
  assert.equal(await writeAppNamespace(reader, { metadata: async (p) => ({ id: p === '/x.txt' ? 'id:BBB' : 'id:other' }) }), 'full_dropbox');
  assert.equal(await writeAppNamespace(reader, { metadata: async () => ({ id: 'id:same-name-other-file' }) }), 'app_folder', 'App folder に同じ名前の別の物がある');
  assert.equal(await writeAppNamespace(reader, { metadata: async () => { throw Object.assign(new Error('x'), { code: 'dropbox_unavailable' }); } }), 'unverified');
  assert.equal(await writeAppNamespace({ list: async () => ({ entries: [], truncated: false }) }, { metadata: async () => { throw notFound; } }), 'unverified', '一番上が空');
  assert.equal(await writeAppNamespace({ list: async () => { throw new Error('net'); } }, {}), 'unverified');
  // 模擬の Dropbox で：別の名前空間（App folder）と、同じ物が見える app
  const w = await world();
  try {
    assert.equal(await writeAppNamespace(w.reader, w.writer), 'app_folder');
    const full = await startDropboxMock({ role: 'write' });
    full.put('/x.txt', Buffer.from('a'));
    const r2 = await startDropboxMock({ role: 'read' });
    r2.put('/x.txt', Buffer.from('a'));
    try { assert.equal(await writeAppNamespace(r2.client(createDropbox), full.client(createDropbox)), 'full_dropbox'); } finally { await full.close(); await r2.close(); }
  } finally { await w.close(); }
});

// ─── 再検品（2026-11-16・差分の独立レビュー）の指摘 ───
test('再検品：書式の「未確認」を外すのは書式の位置の 1 行だけ（Human が項目の下に写した同じ行は残す）・CRLF の file でも同じ', () => {
  const k = newKarte({ caseId: 'C-001', siteName: '現場A', at: 'x', taskId: 't-1' });
  // Human が書式の行を消して、項目ごとに同じ行を写した
  const copied = k.replace(`## 搬入経路\n\n${PLACEHOLDER_LINE}`, `## 搬入経路\n\n- 北側：\n${PLACEHOLDER_LINE}\n- 南側：\n${PLACEHOLDER_LINE}`);
  const a = insertIntoSection(copied, { section: 'access', value: 'v', at: 'x', taskId: 't-2' });
  assert.ok(a.includes(`## 搬入経路\n\n- 北側：\n${PLACEHOLDER_LINE}\n- 南側：\n${PLACEHOLDER_LINE}\n<!-- ai:x task=t-2 -->\nv\n<!-- /ai -->`), 'Human が写した行は 1 つも消さない');
  assert.equal(sectionText(a, 'access'), '- 北側：\n未確認\n- 南側：\n未確認\n\nv', '読む時も Human の「未確認」はそのまま（AI の囲みの印の行は空行になる）');
  // 書式の行は残したまま、下に同じ行をもう 1 つ写した：外れるのは書式の位置の 1 行だけ
  const two = k.replace(`## 搬入経路\n\n${PLACEHOLDER_LINE}`, `## 搬入経路\n\n${PLACEHOLDER_LINE}\n- 南側：\n${PLACEHOLDER_LINE}`);
  const b = insertIntoSection(two, { section: 'access', value: 'v', at: 'x', taskId: 't-2' });
  assert.ok(b.includes(`## 搬入経路\n\n- 南側：\n${PLACEHOLDER_LINE}\n<!-- ai:x task=t-2 -->`));
  assert.equal(b.split('\n').length, two.split('\n').length + 3 - 1, '差し込んだ 3 行と、外した 1 行だけ');
  // Human の文が書式の行より上にある：書式の位置ではない＝残す
  const above = k.replace(`## 搬入経路\n\n${PLACEHOLDER_LINE}`, `## 搬入経路\n\n（Human）西側は狭い\n${PLACEHOLDER_LINE}`);
  assert.ok(insertIntoSection(above, { section: 'access', value: 'v', at: 'x', taskId: 't-2' }).includes(`（Human）西側は狭い\n${PLACEHOLDER_LINE}\n<!-- ai:x`));
  // CRLF（Windows のエディタで保存）：書式の行を見つけて外す・他の行の \r はそのまま
  const crlf = k.replace(/\n/g, '\r\n');
  const c = insertIntoSection(crlf, { section: 'access', value: '西側から', at: 'x', taskId: 't-3' });
  assert.equal(sectionText(c, 'access'), '西側から');
  assert.equal(unknownSections(c).length, unknownSections(crlf).length - 1);
  assert.equal(unknownSections(crlf).length, 21);
  assert.ok(c.includes('## 近隣・道路条件\r\n'), '他の行は変えない');
});

test('再検品：AI の tab への参照の形（複数の tab にまたがる範囲・ピボットの元・引用符つきの名前）を見落とさない・その tab 自身の印刷範囲は参照に数えない', () => {
  const xml = estimateSheetXml({ title: 't', rows: ROWS, stamp: 's' });
  for (const name of ['AI_案1', 'AI_案 1', "AI_O'Neil"]) {
    const { bytes, sheet } = addAiSheet(fixtureWorkbook(), { name, xml });
    const opts = { name, xml, aiSheets: [name], aiIds: { [name]: sheet.sheetId } };
    const q = `'${name.replace(/'/g, "''")}'`;
    const xq = q.replace(/'/g, '&apos;');
    const cell = (f) => (t) => t.replace('</row>', `<c r="B1"><f>${f}</f><v>0</v></c></row>`);
    const forms = [
      ['xl/worksheets/sheet2.xml', cell(`SUM('見積:${name.replace(/'/g, "''")}'!F7)`)],
      ['xl/worksheets/sheet2.xml', cell('SUM(見積:内訳!F7)')], // 間に挟まる tab は名前で探せない＝またがる範囲が在れば止める
      ['xl/worksheets/sheet2.xml', cell(`${xq}!F7`)],
      ['xl/worksheets/sheet2.xml', (t) => t.replace('</sheetData>', `</sheetData><conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>${xq}!$F$7&gt;0</formula></cfRule></conditionalFormatting>`)],
      ['xl/workbook.xml', (t) => t.replace('</definedNames>', `<definedName name="元">${xq}!$A$3:$G$6</definedName></definedNames>`)],
      ['xl/styles.xml', (t) => `${t}<!-- pivot --><worksheetSource ref="A3:G6" sheet="${name.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>`],
    ];
    for (const [part, fn] of forms) assert.throws(() => replaceAiSheet(editPart(bytes, part, fn), opts), { code: 'estimate_ai_sheet_referenced' }, `${name} ${part}`);
    // Human が AI の tab に印刷範囲・フィルターを付けた（Excel が書く定義名）：その tab 自身の物＝直せる
    const idx = 2;
    const own = editPart(bytes, 'xl/workbook.xml', (t) => t.replace('</definedNames>', `<definedName name="_xlnm.Print_Area" localSheetId="${idx}">${xq}!$A$1:$G$10</definedName><definedName name="_xlnm._FilterDatabase" localSheetId="${idx}" hidden="1">${xq}!$A$3:$G$5</definedName></definedNames>`));
    assert.ok(replaceAiSheet(own, opts).bytes.length > 0, `${name}：自分の印刷範囲`);
    // 他の tab の印刷範囲として AI の tab を指す定義名は参照
    const other = editPart(bytes, 'xl/workbook.xml', (t) => t.replace('</definedNames>', `<definedName name="_xlnm.Print_Area" localSheetId="1">${xq}!$A$1:$G$10</definedName></definedNames>`));
    assert.throws(() => replaceAiSheet(other, opts), { code: 'estimate_ai_sheet_referenced' });
    assert.ok(replaceAiSheet(bytes, opts).bytes.length > 0, `${name}：参照が無ければ直せる（作り物の見積の定義名「見積!…」は別の tab）`);
  }
  assert.equal(summarizeAiSheet('<row><c r="F7"><f>SUM(F4:F5)</f><v></v></c></row>'), null, '空の値を 0 と読まない');
});

test('再検品：既定の検索の場所は、一覧・検索に出してよい read_root だけ・応答の先頭の時間切れは 1 回ぶんのまま・前の版の記録の失敗を引き継ぐ', async () => {
  const s = scopeOf(loadScopes({ businesses: { 'biz-a': { read_roots: ['/会社A/見積/過去', '/会社A/資料'], estimate_roots: ['/会社A/見積'], output_root: '/biz-a' } } }), 'biz-a');
  assert.equal(searchRoot(s, null), '/会社A/資料', '見積の中の read_root は選ばない');
  assert.equal(browsable(s, searchRoot(s, null)), true);
  const none = scopeOf(loadScopes({ businesses: { 'biz-a': { read_roots: ['/会社A/見積/過去'], estimate_roots: ['/会社A/見積'], output_root: '/biz-a' } } }), 'biz-a');
  assert.throws(() => searchRoot(none, null), { code: 'dropbox_path_not_allowed' });
  // 応答が 1 byte も来ない download：長い方（本文の上限＝4 倍）ではなく 1 回ぶんの上限で終わる
  const never = async (url) => (String(url).endsWith('/oauth2/token') ? { ok: true, status: 200, headers: new Map(), json: async () => ({ access_token: 't', expires_in: 3600 }) } : new Promise(() => {}));
  const c = createDropbox({ role: 'read', credentials: { appKey: 'k', refreshToken: 'r' }, fetchImpl: never, api: 'http://x', content: 'http://x', timeoutMs: 300 });
  const t0 = Date.now();
  await assert.rejects(c.download('/a'), { code: 'dropbox_timeout' });
  assert.ok(Date.now() - t0 < 900, `${Date.now() - t0}ms`);
  // 前の版の business-last.json（status が無い・problem）：別の business の成功だけで ok に戻さない
  const w = await world();
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  const store = env.store.dir;
  try {
    writeFileSync(path.join(store, 'config.json'), JSON.stringify(env.config), { mode: 0o600 });
    writeFileSync(path.join(store, 'business-last.json'), JSON.stringify({ at: 'x', code: 'problem', last_weekly_ok_at: null }));
    markWeekly(w.dir, 'biz-b', NOW); // biz-b は時刻が来ていない（前の版で失敗していたかもしれない）
    const r = await businessCycle({ store, now: NOW + 60_000, services: () => w.services });
    assert.deepEqual([r.code, r.status], ['problem', { 'biz-a': 'ok', 'biz-b': 'problem' }]);
    assert.equal(businessBackupItem(store, NOW + 60_000).value, 'problem');
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});
