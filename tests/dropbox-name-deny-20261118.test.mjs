/**
 * Dropbox の業務基盤：名前で読ませない（2026-11-18）。実の Dropbox・資格情報には接続しない（模擬と作り物だけ。名前は作り物）。
 * きっかけ：実の元請のフォルダに、作業員名簿・保険証・給与の名前の file が在った＝許可フォルダに足すと、一覧・検索の結果に名前が出る。
 * 許可フォルダ・deny_roots の書き方に頼らず、個人の資料・給与・口座・Secret の名前を共通の下限として断る（広げるだけの規則）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDropbox } from '../scripts/lib/dropbox/client.mjs';
import { resolveReal } from '../scripts/lib/dropbox/resolve.mjs';
import { DENY_NAME_TERMS, assertReadable, browsable, loadScopes, nameDenied } from '../scripts/lib/dropbox/scope.mjs';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { preflight } from '../scripts/dropbox-preflight.mjs';
import { startDropboxMock } from './dropbox-mock.mjs';
import { envelope, makeEnv } from './task-hub-helpers.mjs';
import { fixtureWorkbook } from './xlsx-fixture.mjs';

const CFG = { businesses: { 'biz-a': { read_roots: ['/業務/現場管理'], estimate_roots: ['/業務/見積書の原本'], schedule_files: ['/(株)会社A/年間予定表.xlsx'], deny_names: ['安全書類'], output_root: '/biz-a' } } };

test('名前の拒否：個人・給与・口座・Secret の名前は全角半角・大文字小文字・NFD を畳んで断る・普通の名前と似た別の語は断らない', () => {
  const denyAll = [
    '/業務/現場A/作業員名簿.xlsx', '/業務/給与明細/2026.pdf', '/業務/Ｐａｓｓｗｏｒｄ.txt', '/業務/在留カード.zip', '/業務/B社/ID_RSA', '/業務/証明書/KEY.PEM',
    '/業務/通帳のコピー.pdf', `/業務/${'パスワード'.normalize('NFD')}.txt`, '/業務/源泉徴収票/a.pdf', '/業務/マイナンバー/x', '/業務/健康診断結果.pdf', '/業務/ＳＥＣＲＥＴ/x.txt',
  ];
  for (const p of denyAll) assert.equal(nameDenied(p), true, `断る：${p}`);
  const keep = ['/業務/現場A/平面図.pdf', '/業務/見積書の原本/現場A_見積書.xlsx', '/業務/講座資料.pdf', '/業務/○○銀行支店新築/図面.pdf', '/業務/Q＆A/資料.pdf', '/業務/現場管理/工程写真.pdf', '/業務/keynote.key'];
  for (const p of keep) assert.equal(nameDenied(p), false, `断らない：${p}`);
  assert.ok(DENY_NAME_TERMS.length > 30 && Object.isFrozen(DENY_NAME_TERMS), '下限は固定（config で外せない）');
});

test('名前の拒否：字の間に空白・見えない文字・中黒を挟んでも断る（2026-11-18 監査）・語を含むが別の意味の言葉は断らない', () => {
  const ZWJ = String.fromCodePoint(0x200d);
  const ZWNJ = String.fromCodePoint(0x200c);
  const VS = String.fromCodePoint(0xe0100);
  const SHY = String.fromCodePoint(0xad);
  const denyAll = [
    '/業務/履\u3000歴\u3000書.pdf', '/業務/給 与 明 細.pdf', `/業務/給${ZWJ}与.xlsx`, `/業務/pass${ZWJ}word.txt`, `/業務/作業員${ZWNJ}名簿.xlsx`, `/業務/作業員 名簿.xlsx`,
    `/業務/保険証${VS}.pdf`, `/業務/給${SHY}与.pdf`, '/業務/作業員・名簿.xlsx', '/業務/社員名簿.xlsx', '/業務/協力会社名簿.xlsx', '/業務/健康保険被保険者証.pdf',
    '/業務/個人情報の取扱い.pdf', '/業務/Payroll_2026.xlsx', '/業務/印鑑証明.pdf', '/業務/雇用保険料.pdf',
  ];
  for (const p of denyAll) assert.equal(nameDenied(p), true, `断る：${JSON.stringify(p)}`);
  const keep = ['/業務/個人事業主の一覧.xlsx', '/業務/工事保険証券.pdf', '/業務/賠償責任保険証券.pdf', '/業務/個人事業 主.pdf'];
  for (const p of keep) assert.equal(nameDenied(p), false, `断らない：${p}`);
  assert.equal(nameDenied('/業務/個人事業主の保険証.pdf'), true, '別の語が残れば断る');
  assert.equal(nameDenied('/a/abc', ['ＡＢＣ']), true, 'config の語は畳んでいなくても効く');
});

test('deny_names：config で語を足せる（畳んで効く）・形の誤りは Dropbox を閉じる・足しても下限は外れない', () => {
  const s = loadScopes(CFG).get('biz-a');
  assert.deepEqual(s.deny_names, ['安全書類']);
  assert.equal(browsable(s, '/業務/現場管理/B社/安全書類.zip'), false, 'config で足した語');
  assert.equal(browsable(s, '/業務/現場管理/B社/ＡＮＺＥＮ/安全書類'), false, '深い所の名前でも');
  assert.equal(browsable(s, '/業務/現場管理/B社/作業員名簿.xlsx'), false, '下限の語は config に書かなくても断る');
  assert.equal(browsable(s, '/業務/現場管理/B社/平面図.pdf'), true);
  const withNone = loadScopes({ businesses: { 'biz-a': { read_roots: ['/業務/現場管理'], output_root: '/biz-a', deny_names: [] } } }).get('biz-a');
  assert.equal(browsable(withNone, '/業務/現場管理/給与明細.pdf'), false, 'deny_names が空でも下限は効く');
  assert.equal(assertReadable(s, '/業務/現場管理/B社/平面図.pdf', 'browse'), '/業務/現場管理/B社/平面図.pdf');
  assert.throws(() => assertReadable(s, '/業務/現場管理/B社/口座情報.xlsx', 'browse'), { code: 'dropbox_path_not_allowed' });
  const base = { read_roots: ['/業務/現場管理'], output_root: '/biz-a' };
  for (const bad of ['安全書類', [''], ['  '], ['a/b'], ['安全／書類'], ['.'], ['　'], ['x'.repeat(41)], ['a\u0000b'], ['a' + String.fromCodePoint(0x200b) + 'b'], [1], Array.from({ length: 51 }, (_, i) => `語${i}`)]) {
    assert.throws(() => loadScopes({ businesses: { 'biz-a': { ...base, deny_names: bad } } }), { code: 'dropbox_config_invalid' }, `誤り：${JSON.stringify(bad).slice(0, 30)}`);
  }
});

test('config の矛盾：許可フォルダ・工程表・見積の原本の名前が拒む語を含む設定は、原因が分かる code で読み込まない', () => {
  const mk = (over) => ({ businesses: { 'biz-a': { read_roots: ['/業務/現場管理'], output_root: '/biz-a', ...over } } });
  assert.throws(() => loadScopes(mk({ read_roots: ['/業務/給与'] })), { code: 'dropbox_config_denied_name' });
  assert.throws(() => loadScopes(mk({ schedule_files: ['/業務/パスワード一覧.xlsx'] })), { code: 'dropbox_config_denied_name' });
  assert.throws(() => loadScopes(mk({ estimate_roots: ['/業務/人事/見積'] })), { code: 'dropbox_config_denied_name' });
  assert.throws(() => loadScopes(mk({ deny_names: ['現場管理'] })), { code: 'dropbox_config_denied_name' }, 'config で足した語が許可フォルダの名前に当たる');
  assert.ok(loadScopes(mk({ deny_roots: ['/業務/給与'] })).get('biz-a'), 'deny_roots は名前の拒否と重なっても矛盾ではない');
});

async function world() {
  const read = await startDropboxMock({ role: 'read' });
  const write = await startDropboxMock({ role: 'write' });
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx-deny-'));
  read.put('/(株)会社A/年間予定表.xlsx', fixtureWorkbook());
  read.put('/業務/現場管理/現場A/平面図.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/業務/現場管理/現場A/作業員名簿.xlsx', Buffer.from('x'));
  read.put('/業務/現場管理/現場A/保険証コピー.pdf', Buffer.from('x'));
  read.put('/業務/現場管理/現場B/安全書類/現場B資料.pdf', Buffer.from('x'));
  read.put('/業務/現場管理/現場B/工程写真.pdf', Buffer.from('%PDF-1.4 fake'));
  read.put('/業務/見積書の原本/給与明細風の名前.xlsx', fixtureWorkbook());
  read.put('/業務/見積書の原本/現場A_見積書.xlsx', fixtureWorkbook());
  const reader = read.client(createDropbox);
  const writer = write.client(createDropbox);
  const services = { backupDir: dir, historyDir: dir, dropbox: (role) => (role === 'read' ? reader : writer) };
  return { read, write, reader, writer, dir, services, close: async () => { await read.close(); await write.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function hub(w) {
  const env = makeEnv({ config: { dropbox: CFG, utc_offset_minutes: 540 } });
  const config = { ...env.config, services: w.services };
  const run = () => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
  const submit = async (intent, params) => (await submitLocal(envelope({ intent, params, business: 'biz-a' }), { store: env.store, policy: env.policy, now: env.clock.t })).task_id;
  const res = (id) => env.store.readTask(id);
  const approved = async (intent, params) => { const id = await submit(intent, params); approve(env.store, id, { confirm: res(id).content_digest.slice(0, 12), isTTY: true, now: env.clock.t }); return id; };
  return { env, run, submit, res, approved };
}

test('一覧・検索：名前の拒否に当たる file・フォルダは名前も出さず、直接指しても断る（Dropbox に聞く前に）', async () => {
  const w = await world();
  try {
    const { run, submit, res } = hub(w);
    const ids = {
      a: await submit('dropbox.list', { path: '/業務/現場管理/現場A' }),
      b: await submit('dropbox.list', { path: '/業務/現場管理/現場B' }),
      s1: await submit('dropbox.search', { query: '名簿', path: '/業務/現場管理' }),
      s3: await submit('dropbox.search', { query: '安全 書類', path: '/業務/現場管理' }),
      s2: await submit('dropbox.search', { query: '資料', path: '/業務/現場管理' }),
      direct: await submit('dropbox.list', { path: '/業務/現場管理/現場B/安全書類' }),
      direct2: await submit('dropbox.list', { path: '/業務/現場管理/現場A/作業員名簿.xlsx' }),
    };
    await run();
    assert.deepEqual(res(ids.a).result.entries.map((e) => e.name), ['平面図.pdf'], '名簿・保険証の file は一覧に出ない');
    assert.deepEqual(res(ids.b).result.entries.map((e) => e.name), ['工程写真.pdf'], 'config で足した語のフォルダも');
    assert.deepEqual([res(ids.s1).state, res(ids.s1).error.code], ['failed', 'dropbox_path_not_allowed'], '拒む語の検索は受けない（件数・続きの印で隠した file が分からない）');
    assert.deepEqual([res(ids.s3).state, res(ids.s3).error.code], ['failed', 'dropbox_path_not_allowed'], 'config の語も・語の間の空白を挟んでも');
    assert.ok(!JSON.stringify(res(ids.s2).result).includes('安全書類'), '検索の結果に拒む名前の path が混ざらない');
    for (const k of ['direct', 'direct2']) assert.deepEqual([res(ids[k]).state, res(ids[k]).error.code], ['failed', 'dropbox_path_not_allowed']);
  } finally { await w.close(); }
});

test('見積の原本：名前の拒否に当たる file は承認があっても AI 作業版の元にしない（resolveReal・estimate.ai.create）', async () => {
  const w = await world();
  try {
    const s = loadScopes(CFG).get('biz-a');
    await assert.rejects(resolveReal(w.reader, s, '/業務/見積書の原本/給与明細風の名前.xlsx', 'estimate'), { code: 'dropbox_path_not_allowed' });
    assert.equal(await resolveReal(w.reader, s, '/業務/見積書の原本/現場A_見積書.xlsx', 'estimate'), '/業務/見積書の原本/現場A_見積書.xlsx');
    const { run, approved, res } = hub(w);
    const id = await approved('estimate.ai.create', { original_path: '/業務/見積書の原本/給与明細風の名前.xlsx', sheet_name: 'AI_案1', title: 'テスト', rows: [{ item: '足場', qty: 1, price: 1 }] });
    await run();
    assert.equal(res(id).state, 'failed');
    assert.equal(res(id).error.code, 'dropbox_path_not_allowed');
    assert.equal(w.write.state.calls.filter((u) => u === '/2/files/upload').length, 0, '何も書かない');
  } finally { await w.close(); }
});

test('preflight：config が読めない理由の code を返す（名前の矛盾と形の誤りを分ける）', async () => {
  const bad = { businesses: { 'biz-a': { read_roots: ['/業務/給与'], output_root: '/biz-a' } } };
  const r = await preflight({ dropbox: bad, reader: null });
  assert.deepEqual([r.code, r.config_code], ['config_invalid', 'dropbox_config_denied_name']);
  const r2 = await preflight({ dropbox: { businesses: 5 }, reader: null });
  assert.deepEqual([r2.code, r2.config_code], ['config_invalid', 'dropbox_config_invalid']);
});
