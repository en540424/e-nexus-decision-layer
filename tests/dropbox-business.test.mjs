/**
 * Dropbox の業務の基盤（2026-11-13・docs/dropbox-business.md）：資格情報の role・許可フォルダ・工程表のバックアップと復元・現場カルテ・見積の AI 作業版・Task Hub の intent。
 * 模擬の Dropbox（tests/dropbox-mock.mjs・loopback）だけ。実の Dropbox・資格情報・業務の file は使わない。名前は作り物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDropbox, headerJson } from '../scripts/lib/dropbox/client.mjs';
import { workingName } from '../scripts/lib/task-hub/business-handlers.mjs';
import { atToMs } from '../scripts/lib/business/schedule-backup.mjs';
import { contentHash } from '../scripts/lib/dropbox/content-hash.mjs';
import { assertReadable, loadScopes, normPath, outputPath, scopeOf } from '../scripts/lib/dropbox/scope.mjs';
import { backupSchedule, listGenerations, markWeekly, restoreGeneration, weeklyDue, WEEK_MS } from '../scripts/lib/business/schedule-backup.mjs';
import { insertIntoSection, newKarte, provenance, sectionText, UNKNOWN } from '../scripts/lib/business/karte.mjs';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { businessCycle } from '../scripts/business-cycle.mjs';
import { checkScopes, pkce, storeKeychain } from '../scripts/dropbox-auth.mjs';
import { readSheetRows, sheetsOf } from '../scripts/lib/xlsx/workbook.mjs';
import { readZip } from '../scripts/lib/xlsx/zip.mjs';
import { startDropboxMock } from './dropbox-mock.mjs';
import { envelope, makeEnv } from './task-hub-helpers.mjs';
import { fixtureWorkbook } from './xlsx-fixture.mjs';

const DROPBOX = { businesses: {
  'biz-a': { read_roots: ['/会社A/現場管理'], schedule_files: ['/会社A/工程/作業予定表.xlsx'], estimate_roots: ['/会社A/見積'], output_root: '/biz-a' },
  'biz-b': { read_roots: ['/会社B/資料'], output_root: '/biz-b' },
} };
const NOW = Date.parse('2026-11-13T09:00:00.000Z');

async function world() {
  const read = await startDropboxMock({ role: 'read' });
  const write = await startDropboxMock({ role: 'write' });
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx-biz-'));
  read.put('/会社A/工程/作業予定表.xlsx', fixtureWorkbook());
  read.put('/会社A/見積/現場A_見積書.xlsx', fixtureWorkbook({ macro: false }));
  read.put('/会社A/現場管理/現場A/平面図.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/会社B/資料/秘密.txt', Buffer.from('biz-b only'));
  const reader = read.client(createDropbox);
  const writer = write.client(createDropbox);
  const services = { backupDir: dir, historyDir: dir, dropbox: (role) => (role === 'read' ? reader : writer) };
  const close = async () => { await read.close(); await write.close(); rmSync(dir, { recursive: true, force: true }); };
  return { read, write, reader, writer, dir, services, scopes: loadScopes(DROPBOX), close };
}

test('client：content_hash（4 MiB の塊）・header の JSON は ASCII・読みの資格情報には upload が無い・壊れた download は hash で止める', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024 + 10, 7);
  assert.notEqual(contentHash(big), contentHash(big.subarray(0, 4 * 1024 * 1024)));
  assert.equal(contentHash(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '空＝塊 0 個の SHA-256');
  assert.equal(headerJson({ path: '/会社/a' }), '{"path":"/\\u4f1a\\u793e/a"}');
  const w = await world();
  try {
    assert.equal(w.reader.upload, undefined, '読みの client に書く手段は無い');
    const { bytes, meta } = await w.reader.download('/会社A/工程/作業予定表.xlsx');
    assert.equal(meta.content_hash, contentHash(bytes));
    w.read.state.corruptNext = true;
    await assert.rejects(w.reader.download('/会社A/工程/作業予定表.xlsx'), { code: 'dropbox_hash_mismatch' });
    await assert.rejects(w.reader.download('/無い'), { code: 'dropbox_path_not_found' });
    // 読みの app の資格情報で書こうとしても Dropbox が拒む（模擬は missing_scope）
    const raw = createDropbox({ role: 'write', credentials: w.read.credentials, api: w.read.base, content: w.read.base });
    await assert.rejects(raw.upload('/会社A/工程/作業予定表.xlsx', Buffer.from('x')), { code: 'dropbox_auth' });
    assert.throws(() => createDropbox({ role: 'read', credentials: null }), { code: 'not_configured' });
    const bad = createDropbox({ role: 'read', credentials: { appKey: 'appkey000test', refreshToken: 'wrong-token-000' }, api: w.read.base, content: w.read.base });
    await assert.rejects(bad.list('/会社A'), { code: 'dropbox_auth' });
  } finally { await w.close(); }
});

test('scope：許可フォルダの外・.. ・空の部分・他の business の path は読めない・大文字小文字は同じ・出力は business の場所の下だけ', () => {
  const s = loadScopes(DROPBOX);
  const a = scopeOf(s, 'biz-a');
  assert.equal(assertReadable(a, '/会社a/現場管理/現場A/平面図.pdf'.replace('a/', 'A/')), '/会社A/現場管理/現場A/平面図.pdf');
  assert.equal(assertReadable(a, '/会社A/工程/作業予定表.XLSX', 'schedule'), '/会社A/工程/作業予定表.XLSX');
  for (const bad of ['/会社A/現場管理/../見積x', '/会社A//現場管理', '/会社B/資料/秘密.txt', '/会社A/工程/別の表.xlsx', 'relative', '/', '/会社A/現場管理2/x']) assert.throws(() => assertReadable(a, bad), /dropbox_path/, bad);
  assert.throws(() => assertReadable(a, '/会社A/現場管理/x.xlsx', 'estimate'), { code: 'dropbox_path_not_allowed' });
  assert.throws(() => scopeOf(s, 'e-step'), { code: 'dropbox_business_not_enabled' });
  assert.equal(outputPath(a, 'karte', 'C-001.md'), '/biz-a/karte/C-001.md');
  for (const bad of ['../x', 'a/b', '', 'x:y']) assert.throws(() => outputPath(a, 'karte', bad), { code: 'dropbox_name_invalid' });
  assert.throws(() => loadScopes({ businesses: { 'biz-a': { output_root: '/x' }, 'biz-b': { output_root: '/x/y' } } }), { code: 'dropbox_config_invalid' }, '出力の場所が重なる');
  assert.equal(normPath('/a/./b'), null);
});

test('工程表のバックアップ：保存して読み直して確かめる・同じ中身なら世代を作らない・世代の上限・原本は変えない・別の file への復元', async () => {
  const w = await world();
  try {
    const before = Buffer.from(w.read.files.get('/会社a/工程/作業予定表.xlsx').bytes);
    const r1 = await backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, now: NOW });
    assert.equal(r1.status, 'saved');
    const r2 = await backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, now: NOW + 1000 });
    assert.deepEqual([r2.status, r2.generation.id], ['unchanged', r1.generation.id], '変わっていなければ新しい世代を作らない');
    for (let i = 0; i < 4; i += 1) {
      w.read.put('/会社A/工程/作業予定表.xlsx', Buffer.concat([before, Buffer.from(`v${i}`)]));
      assert.equal((await backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, keep: 3, now: NOW + 60_000 * (i + 1) })).status, 'saved');
    }
    const gens = listGenerations(w.dir, 'biz-a', '/会社A/工程/作業予定表.xlsx');
    assert.equal(gens.length, 3, '世代は keep まで');
    const fdir = path.dirname(path.join(w.dir, 'biz-a', 'schedule', readdirSync(path.join(w.dir, 'biz-a', 'schedule')).find((x) => x !== 'state.json'), 'index.json'));
    assert.equal(readdirSync(fdir).filter((f) => f.endsWith('.xlsx')).length, 3, '古い世代の file は消える');
    assert.ok(!readdirSync(fdir).join('').includes('作業予定表'), 'フォルダ名・file 名に会社の file 名を使わない');
    // 復元：App folder の restore/ へ別の file（原本の場所には書かない＝書く資格情報は App folder の外を知らない）
    const rs = await restoreGeneration({ writer: w.writer, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, generation: gens[0].id });
    assert.match(rs.restored_to, /^\/biz-a\/restore\/作業予定表_復元_/);
    assert.equal(w.write.files.size, 1);
    assert.equal(w.read.files.get('/会社a/工程/作業予定表.xlsx').bytes.toString().endsWith('v3'), true, '原本は Dropbox のまま');
    const again = await restoreGeneration({ writer: w.writer, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, generation: gens[0].id });
    assert.equal(again.already, true, '同じ世代の同じ中身なら済み（上書きしない）');
    w.write.put(rs.restored_to, Buffer.from('別の中身'));
    await assert.rejects(restoreGeneration({ writer: w.writer, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, generation: gens[0].id }), { code: 'restore_name_taken' }, '同じ名前に違う中身があれば上書きしない');
    w.write.state.failNext = { status: 409, summary: 'path/insufficient_space/..' };
    await assert.rejects(restoreGeneration({ writer: w.writer, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, generation: gens[1].id }), { code: 'dropbox_path_insufficient_space' }, '空きが無いのは「済み」にしない（監査 F3）');
    // 容量不足（変わった版を保存しようとした時）・工程表でない file
    w.read.put('/会社A/工程/作業予定表.xlsx', Buffer.from('changed again'));
    await assert.rejects(backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: '/会社A/工程/作業予定表.xlsx', dir: w.dir, now: NOW + 20 * 60_000, freeBytes: () => 1 }), { code: 'backup_disk_low' });
    await assert.rejects(backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: '/会社A/見積/現場A_見積書.xlsx', dir: w.dir }), { code: 'dropbox_path_not_allowed' });
    // 週 1 回
    assert.equal(weeklyDue(w.dir, 'biz-a', NOW), true);
    markWeekly(w.dir, 'biz-a', NOW);
    assert.equal(weeklyDue(w.dir, 'biz-a', NOW + WEEK_MS - 1), false);
    assert.equal(weeklyDue(w.dir, 'biz-a', NOW + WEEK_MS), true);
  } finally { await w.close(); }
});

test('現場カルテ：未確認の項目・AI の囲み・Human の追記を 1 文字も変えずに差し込む・見出しが消えていても末尾に足す', () => {
  const k = newKarte({ caseId: 'C-001', siteName: '現場A', fields: { address: '東京都（作り物）', safety: '電線が近い' }, at: '2026-11-13T09:00:00Z', taskId: 't-1' });
  assert.match(k, /## カーポート\n\n未確認\n/);
  assert.equal(provenance(k).ai_blocks, 4);
  const human = k.replace('## 搬入経路\n\n未確認', '## 搬入経路\n\n未確認\n北側の道は 4t 車が入らない（Human が書いた）');
  const after = insertIntoSection(human, { section: 'access', value: '西側の駐車場から搬入できる', at: '2026-11-14T00:00:00Z', taskId: 't-2', dated: '2026-11-14' });
  assert.ok(after.includes('北側の道は 4t 車が入らない（Human が書いた）'));
  assert.match(sectionText(after, 'access'), /北側の道は 4t 車が入らない[\s\S]*- 2026-11-14：西側の駐車場から搬入できる/);
  const noHeading = human.replace('## 未確認事項', '## （Human が名前を変えた）');
  assert.match(insertIntoSection(noHeading, { section: 'unknowns', value: '高さ', at: 'x', taskId: 't-3' }), /\n## 未確認事項\n\n<!-- ai:x task=t-3 -->\n高さ\n<!-- \/ai -->\n$/);
  for (const bad of ['<!-- ai:fake --> x', '## 見出しを作る', '', 'a'.repeat(2001)]) assert.throws(() => insertIntoSection(k, { section: 'access', value: bad, at: 'x', taskId: 't' }), { code: 'karte_value_invalid' }, bad);
  assert.equal(UNKNOWN, '未確認');
});

test('Task Hub：Dropbox の業務の intent（検索・工程表・バックアップ・復元・カルテ・見積の AI 作業版）。見積は承認の後だけ・開いていない business は失敗', async () => {
  const w = await world();
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  try {
    const config = { ...env.config, services: w.services };
    const run = () => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
    const submit = async (intent, params, business = 'biz-a') => (await submitLocal(envelope({ intent, params, business }), { store: env.store, policy: env.policy, now: env.clock.t })).task_id;
    const res = (id) => env.store.readTask(id);
    const ids = {
      search: await submit('dropbox.search', { query: '平面図' }),
      list: await submit('dropbox.list', { path: '/会社A/現場管理/現場A' }),
      outside: await submit('dropbox.list', { path: '/会社B/資料' }),
      sched: await submit('schedule.read', { query: '足場' }),
      backup: await submit('schedule.backup', {}),
      create: await submit('karte.create', { case_id: 'C-001', site_name: '現場A', fields: { safety: '電線が近い' } }),
      bizb: await submit('schedule.backup', {}, 'biz-b'),
    };
    await run();
    assert.deepEqual([res(ids.search).state, res(ids.search).result.count, res(ids.search).result.files[0].name], ['succeeded', 1, '平面図.pdf']);
    assert.equal(res(ids.list).result.count, 1);
    assert.deepEqual([res(ids.outside).state, res(ids.outside).error.code], ['failed', 'dropbox_path_not_allowed'], '他の business のフォルダは読めない');
    assert.deepEqual(res(ids.sched).result.rows.map((r) => r.r), [1, 4]);
    assert.deepEqual([res(ids.backup).result.completed, res(ids.backup).result.files[0].status], [true, 'saved']);
    assert.deepEqual([res(ids.create).state, res(ids.create).result.path], ['succeeded', '/biz-a/karte/C-001.md']);
    assert.deepEqual([res(ids.bizb).state, res(ids.bizb).error.code], ['failed', 'schedule_not_configured']);
    // カルテ：Human が Dropbox で書き足した後に AI が追記（Human の文は残る）・同じ task のやり直しで二重にしない
    const k = w.write.files.get('/biz-a/karte/c-001.md');
    w.write.put(k.path, Buffer.from(k.bytes.toString().replace('## 搬入経路\n\n未確認', '## 搬入経路\n\n未確認\nHuman のメモ')));
    const app = await submit('karte.append', { case_id: 'C-001', section: 'access', text: '西側から', date: '2026-11-14' });
    // 上げる直前に Human がもう一度直した（rev が変わる）＝読み直して差し込み直す
    let once = true;
    w.write.state.beforeUpload = (arg) => { if (once && arg.path === '/biz-a/karte/C-001.md') { once = false; const f = w.write.files.get('/biz-a/karte/c-001.md'); w.write.put(f.path, Buffer.from(`${f.bytes.toString()}\n（Human が同時に足した行）\n`)); } };
    await run();
    w.write.state.beforeUpload = null;
    assert.equal(res(app).state, 'succeeded');
    const text = w.write.files.get('/biz-a/karte/c-001.md').bytes.toString();
    assert.ok(text.includes('Human のメモ') && text.includes('（Human が同時に足した行）') && text.includes('- 2026-11-14：西側から'));
    assert.ok(existsSync(path.join(w.dir, 'biz-a', 'karte-history', 'C-001')), '上げる前の版を手元に残す');
    const rep = await submit('karte.report', { case_id: 'C-001' });
    const get = await submit('karte.get', { case_id: 'C-001', section: 'safety' });
    const dup = await submit('karte.create', { case_id: 'C-001', site_name: '別' });
    await run();
    assert.match(res(rep).result.text, /■ 安全上の注意事項\n電線が近い/);
    assert.equal(res(get).result.text, '電線が近い');
    assert.deepEqual([res(dup).state, res(dup).error.code], ['failed', 'karte_exists'], '在るカルテは作り直さない（上書きしない）');
    // 見積の AI 作業版：承認待ち → 承認 → 原本は変えず、App folder に AI 作業版
    const origBytes = Buffer.from(w.read.files.get('/会社a/見積/現場a_見積書.xlsx').bytes);
    const est = await submit('estimate.ai.create', { original_path: '/会社A/見積/現場A_見積書.xlsx', sheet_name: 'AI_案1', title: '現場A（AI 案）', rows: [{ item: '足場', qty: 100, unit: 'm2', price: 1000 }] });
    assert.equal(res(est).state, 'awaiting_approval', '見積（L2）は毎回 Human の承認');
    approve(env.store, est, { confirm: res(est).content_digest.slice(0, 12), isTTY: true, now: env.clock.t });
    await run();
    assert.equal(res(est).state, 'succeeded', JSON.stringify(res(est).error));
    const copyName = workingName('/会社A/見積/現場A_見積書.xlsx');
    assert.match(copyName, /^現場A_見積書_AI作業版_[0-9a-f]{6}\.xlsx$/);
    const copy = w.write.files.get(`/biz-a/estimates/${copyName}`.toLowerCase());
    assert.ok(copy, 'AI 作業版は App folder の estimates/');
    assert.deepEqual(sheetsOf(readZip(copy.bytes)).map((s) => s.name), ['見積', '内訳', 'AI_案1']);
    assert.ok(w.read.files.get('/会社a/見積/現場a_見積書.xlsx').bytes.equals(origBytes), '原本は 1 byte も変わらない');
    const edit = await submit('estimate.ai.edit', { working_name: copyName, sheet_name: 'AI_案1', title: '修正', rows: [{ item: '足場', qty: 120, unit: 'm2', price: 1000 }] });
    const editHuman = await submit('estimate.ai.edit', { working_name: copyName, sheet_name: 'AI_見積', title: 'x', rows: [{ item: 'x', qty: 1, price: 1 }] });
    for (const id of [edit, editHuman]) approve(env.store, id, { confirm: res(id).content_digest.slice(0, 12), isTTY: true, now: env.clock.t });
    await run();
    assert.equal(res(edit).state, 'succeeded');
    assert.equal(readSheetRows(w.write.files.get(`/biz-a/estimates/${copyName}`.toLowerCase()).bytes, { sheet: 'AI_案1' }).rows.find((r) => r.r === 4).cells.find((c) => c.ref === 'F4').text, '120000');
    assert.deepEqual([res(editHuman).state, res(editHuman).error.code], ['failed', 'estimate_not_ai_sheet']);
    // 工程表の別の file への復元・世代の一覧
    const list = await submit('schedule.backup.list', {});
    const rst = await submit('schedule.restore', {});
    await run();
    assert.equal(res(list).result.count, 1);
    assert.match(res(rst).result.restored_to, /^\/biz-a\/restore\//);
    // 資格情報が無い＝休眠（想定内の失敗・PAUSE にしない）
    const noCred = await submit('dropbox.search', { query: 'x' });
    await runOnce({ store: env.store, policy: { ...env.policy, config: { ...env.config, services: { backupDir: w.dir, historyDir: w.dir, dropbox: () => { const e = new Error('not_configured'); e.code = 'not_configured'; throw e; } } } }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
    assert.deepEqual([res(noCred).state, res(noCred).error.code, env.store.isPaused()], ['failed', 'dropbox_not_configured', false]);
    assert.equal(env.store.verifyAudit().ok, true);
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

test('business-cycle（週 1 回）：時刻が来た business だけ取り・結果を business-last.json に・資格情報が無ければ休眠', async () => {
  const w = await world();
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  try {
    writeFileSync(path.join(env.store.dir, 'config.json'), JSON.stringify(env.config));
    const r1 = await businessCycle({ store: env.store.dir, now: NOW, services: () => w.services });
    assert.deepEqual([r1.code, r1.weekly.length, r1.weekly[0].status], ['ok', 1, 'saved']);
    assert.equal((await businessCycle({ store: env.store.dir, now: NOW + 3_600_000, services: () => w.services })).code, 'not_due');
    const last = JSON.parse(readFileSync(path.join(env.store.dir, 'business-last.json'), 'utf8'));
    assert.equal(last.code, 'ok');
    assert.ok(!JSON.stringify(last).includes('会社A'), 'path は出さない');
    const none = await businessCycle({ store: env.store.dir, now: NOW + WEEK_MS + 1, services: () => ({ ...w.services, dropbox: () => { throw Object.assign(new Error('x'), { code: 'not_configured' }); } }) });
    assert.equal(none.code, 'not_configured');
    rmSync(path.join(env.store.dir, 'config.json'));
    assert.equal((await businessCycle({ store: env.store.dir })).code, 'not_configured');
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});

test('dropbox-auth：PKCE・読みの app は書く scope を持てない・書きの app は共有の scope を持てない・Keychain へは標準入力で', () => {
  const { verifier, challenge } = pkce(() => Buffer.alloc(48, 1));
  assert.ok(verifier.length >= 43 && /^[A-Za-z0-9_-]+$/.test(challenge));
  assert.equal(checkScopes('read', 'files.metadata.read files.content.read'), null);
  assert.equal(checkScopes('read', 'files.metadata.read files.content.read files.content.write'), 'read_app_too_broad');
  assert.equal(checkScopes('read', 'files.metadata.read files.content.read files.permanent_delete'), 'read_app_too_broad', 'allowlist：削除の scope も拒む（監査 F8）');
  assert.equal(checkScopes('write', 'files.metadata.read files.content.read files.content.write files.permanent_delete'), 'write_app_too_broad');
  assert.equal(checkScopes('write', 'files.metadata.read files.content.read files.content.write'), null);
  assert.equal(checkScopes('write', 'files.metadata.read files.content.read files.content.write sharing.write'), 'write_app_too_broad');
  assert.equal(checkScopes('write', 'files.metadata.read files.content.read'), 'scope_write_missing');
  const calls = [];
  assert.equal(storeKeychain('dropbox-read-refresh-token', 'abcDEF123-_.token', (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return { status: 0 }; }), true);
  assert.deepEqual(calls[0].args, ['-i'], '値は引数に置かない');
  assert.match(calls[0].input, /^add-generic-password -U -a e-nexus -s E-NEXUS\/edl\/dropbox-read-refresh-token -w abcDEF123-_.token\n$/);
  assert.equal(storeKeychain('x', 'bad value with space'), false);
  assert.ok(mkdirSync && existsSync);
});

test('監査の後（2026-11-13）：同じ出力の場所・ASCII に畳まれる文字・NFD・見出しの偽装・一覧で見積のフォルダ・想定内の失敗で PAUSE にならない', async () => {
  assert.throws(() => loadScopes({ businesses: { 'biz-a': { output_root: '/shared' }, 'biz-b': { output_root: '/shared' } } }), { code: 'dropbox_config_invalid' }, '同じ出力の場所は拒否（F1）');
  const a = scopeOf(loadScopes({ businesses: { 'biz-a': { read_roots: ['/kaisha'], estimate_roots: ['/mitsumori'], output_root: '/biz-a' } } }), 'biz-a');
  assert.equal(assertReadable(a, '/\u212Aaisha/x'), '/Kaisha/x', 'ケルビンの K は NFC で K になり、確かめた path（正規化した物）だけを Dropbox へ送る＝確かめと要求が食い違わない');
  assert.throws(() => assertReadable(a, '/\u0130/x'), /dropbox_path/, 'トルコ語の İ は許可フォルダに化けない');
  const nfd = scopeOf(loadScopes({ businesses: { 'biz-a': { read_roots: ['/ガ'.normalize('NFD')], output_root: '/biz-a' } } }), 'biz-a');
  assert.equal(assertReadable(nfd, '/ガ/x'.normalize('NFC')), '/ガ/x'.normalize('NFC'), 'NFD で書いた許可フォルダも NFC の path と同じ');
  assert.throws(() => assertReadable(a, '/mitsumori/x.xlsx', 'browse'), { code: 'dropbox_path_not_allowed' }, '見積（L2）のフォルダは承認なしの一覧に出さない（F7）');
  const k = newKarte({ caseId: 'C-1', siteName: 'x', at: 'a', taskId: 't' });
  assert.throws(() => insertIntoSection(k, { section: 'access', value: 'a\n  ## 所在地\nfake', at: 'b', taskId: 't2' }), { code: 'karte_value_invalid' }, '空白の後の見出しも拒否（F6）');
  assert.equal(insertIntoSection(k, { section: 'access', value: '#1 西側から・＃2棟', at: 'b', taskId: 't3' }).includes('#1 西側から'), true, '「#1」のような値は可（N2）');
  // 閉じていない ai の印（Human が /ai の行を消した）でも後ろの見出しは見える（N1）
  const broken = k.replace('<!-- /ai -->', '');
  assert.equal(sectionText(broken, 'safety'), '未確認');
  assert.equal(sectionText(broken, 'address'), '未確認');
  assert.equal(atToMs('2026-11-12', 540), Date.parse('2026-11-12T14:59:59.999Z'), '日付だけ＝その日の終わり（日本時間・F11）');
  // 想定内の失敗（範囲の外・カルテが無い）が続いても PAUSE にしない（F2）
  const w = await world();
  const env = makeEnv({ config: { dropbox: DROPBOX } });
  try {
    const config = { ...env.config, services: w.services };
    for (const p of ['/外/1', '/外/2', '/外/3', '/外/4']) await submitLocal(envelope({ intent: 'dropbox.list', params: { path: p } }), { store: env.store, policy: env.policy, now: env.clock.t });
    for (const c of ['NO-1', 'NO-2']) await submitLocal(envelope({ intent: 'karte.get', params: { case_id: c } }), { store: env.store, policy: env.policy, now: env.clock.t });
    await runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
    assert.equal(env.store.isPaused(), false);
    assert.deepEqual(env.store.listTasks({ state: 'failed' }).map((t) => t.error.code).sort(), ['dropbox_path_not_allowed', 'dropbox_path_not_allowed', 'dropbox_path_not_allowed', 'dropbox_path_not_allowed', 'dropbox_path_not_found', 'dropbox_path_not_found']);
    // 同じ名前の別の顧客の見積は別の AI 作業版（F5）
    assert.notEqual(workingName('/会社A/見積/A社/見積書.xlsx'), workingName('/会社A/見積/B社/見積書.xlsx'));
    // unchanged でも保存した世代の file が無ければ保存し直す（F4）
    const f = '/会社A/工程/作業予定表.xlsx';
    const r1 = await backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: f, dir: w.dir, now: NOW });
    rmSync(path.join(path.dirname(path.join(w.dir, 'biz-a', 'schedule', readdirSync(path.join(w.dir, 'biz-a', 'schedule'))[0], 'x')), r1.generation.file));
    assert.equal((await backupSchedule({ reader: w.reader, scopes: w.scopes, business: 'biz-a', file: f, dir: w.dir, now: NOW + 1000 })).status, 'saved');
    // 失敗した週は 1 時間後にやり直す（F10）
    markWeekly(w.dir, 'biz-a', NOW, 'problem');
    assert.deepEqual([weeklyDue(w.dir, 'biz-a', NOW + 30 * 60_000), weeklyDue(w.dir, 'biz-a', NOW + 61 * 60_000)], [false, true]);
    markWeekly(w.dir, 'biz-a', NOW + 61 * 60_000, 'ok');
    assert.equal(weeklyDue(w.dir, 'biz-a', NOW + 2 * 3_600_000), false);
  } finally { await w.close(); rmSync(env.root, { recursive: true, force: true }); }
});
