/**
 * Human 決定 B（2026-11-24）：Mac で読める範囲と、外のサービス（Grok など human-cli 以外）へ返してよい範囲を分ける（scope.external）。
 * 例：Mac は元請のフォルダ（図面・契約・請求書）を読めるが、Grok には図面だけ。模擬の Dropbox・作り物の名前だけ。本番の config は変えていない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDropbox } from '../scripts/lib/dropbox/client.mjs';
import { externalVisible, loadScopes } from '../scripts/lib/dropbox/scope.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { startDropboxMock } from './dropbox-mock.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';
import { bigCalendar } from './xlsx-calendar-fixture.mjs';

const MOTO = '/業務/元請/会社A';
const SCHED = '/業務/予定/年間予定表.xlsx';
const READS = ['dropbox.list', 'dropbox.search', 'schedule.read'];
const biz = (external) => ({ read_only: true, read_roots: ['/業務/元請', '/業務/予定'], schedule_files: [SCHED], output_root: '/biz-b', ...(external ? { external } : {}) });

async function world(external) {
  const read = await startDropboxMock({ role: 'read' });
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx-ext-'));
  read.put(SCHED, bigCalendar());
  read.put(`${MOTO}/図面/平面図.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put(`${MOTO}/契約/基本契約書.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put(`${MOTO}/請求書_11月.pdf`, Buffer.from('%PDF-1.4 fake'));
  const reader = read.client(createDropbox);
  const services = { backupDir: dir, historyDir: dir, dropbox: () => reader };
  const env = makeEnv({ config: { sources: { 'grok-sim': { channels: ['chan-front'], businesses: ['biz-b'], intents: ['task.status', ...READS] }, 'human-cli': { channels: ['local-cli'], businesses: ['biz-b'] } }, businesses: ['biz-a', 'biz-b'], dropbox: { businesses: { 'biz-b': biz(external) } }, utc_offset_minutes: 540 } });
  const config = { ...env.config, services };
  const run = () => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
  const grok = async (intent, params) => {
    dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(envelope({ intent, params, business: 'biz-b' }), { channel: 'chan-front', source: 'grok-sim' }));
    const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
    await run();
    return env.store.readTask(r.task_id);
  };
  const human = async (intent, params) => { const r = await submitLocal(envelope({ intent, params, business: 'biz-b' }), { store: env.store, policy: env.policy, now: env.clock.t }); await run(); return env.store.readTask(r.task_id); };
  const boards = () => env.store.listOutbox().map((o) => o.body).join('\n');
  const close = async () => { await read.close(); rmSync(dir, { recursive: true, force: true }); rmSync(env.root, { recursive: true, force: true }); };
  return { grok, human, boards, close };
}
const names = (t) => (t.result?.entries ?? t.result?.files ?? []).map((e) => e.name).sort();
const EXT = { deny_roots: [`${MOTO}/契約`], deny_names: ['請求'] };

test('Mac（human-cli）は元請の図面・契約・請求書を読める・Grok には図面だけ（契約のフォルダ・請求の名前は外に返さない）', async () => {
  const w = await world(EXT);
  try {
    assert.deepEqual(names(await w.human('dropbox.list', { path: MOTO })), ['図面', '契約', '請求書_11月.pdf'].sort());
    const g = await w.grok('dropbox.list', { path: MOTO });
    assert.equal(g.state, 'succeeded');
    assert.deepEqual(names(g), ['図面']);
    assert.deepEqual(names(await w.grok('dropbox.search', { query: 'pdf' })), ['平面図.pdf']);
    assert.deepEqual(names(await w.human('dropbox.search', { query: 'pdf' })), ['基本契約書.pdf', '平面図.pdf', '請求書_11月.pdf'].sort());
    for (const h of ['契約', '請求']) assert.ok(!w.boards().includes(h), `Grok の結果の板に「${h}」が無い`);
  } finally { await w.close(); }
});

test('外に見せない場所は、在る場所も無い場所も同じ答え（在ることを教えない）・拒む語の検索・外に見せない工程表', async () => {
  const w = await world({ ...EXT, deny_roots: [...EXT.deny_roots, '/業務/予定'] });
  try {
    const a = await w.grok('dropbox.list', { path: `${MOTO}/契約` });
    const b = await w.grok('dropbox.list', { path: `${MOTO}/契約/無いフォルダ` });
    assert.deepEqual([a.state, a.error?.code], ['failed', 'dropbox_path_not_allowed']);
    assert.deepEqual([b.state, b.error?.code], ['failed', 'dropbox_path_not_allowed']);
    assert.equal((await w.grok('dropbox.search', { query: '請求' })).error?.code, 'dropbox_path_not_allowed');
    assert.equal((await w.grok('dropbox.search', { query: 'pdf', path: `${MOTO}/契約` })).error?.code, 'dropbox_path_not_allowed');
    assert.equal((await w.grok('schedule.read', {})).error?.code, 'dropbox_path_not_allowed', '工程表の中身は名前で絞れない＝丸ごと断る');
    assert.equal((await w.human('schedule.read', {})).state, 'succeeded', 'Mac の端末からは読める');
  } finally { await w.close(); }
});

test('allow_roots：外へは指定のフォルダの下だけ（Mac の範囲より広くできない）', async () => {
  const w = await world({ allow_roots: [`${MOTO}/図面`] });
  try {
    assert.equal((await w.grok('dropbox.list', { path: MOTO })).error?.code, 'dropbox_path_not_allowed');
    assert.deepEqual(names(await w.grok('dropbox.list', { path: `${MOTO}/図面` })), ['平面図.pdf']);
  } finally { await w.close(); }
  assert.throws(() => loadScopes({ businesses: { 'biz-b': biz({ allow_roots: ['/他のフォルダ'] }) } }), /dropbox_config_invalid/, 'read_roots の外は書けない');
});

test('config の検査：知らない key・短すぎる語・形の悪い path は誤り（閉じる側）・external が無ければ今までどおり', () => {
  const bad = (external) => assert.throws(() => loadScopes({ businesses: { 'biz-b': biz(external) } }), /dropbox_config_invalid/, JSON.stringify(external));
  bad({ allow: [] });
  bad({ deny_names: ['x'] });
  bad({ deny_names: ['ab/c'] });
  bad({ deny_roots: ['relative'] });
  bad([]);
  const plain = loadScopes({ businesses: { 'biz-b': biz() } }).get('biz-b');
  assert.equal(externalVisible(plain, `${MOTO}/契約/a.pdf`), true);
  const ext = loadScopes({ businesses: { 'biz-b': biz(EXT) } }).get('biz-b');
  assert.equal(externalVisible(ext, `${MOTO}/契約/a.pdf`), false);
  assert.equal(externalVisible(ext, `${MOTO}/請　求/a.pdf`), false, '全角の空白を挟んでも当たる');
  assert.equal(externalVisible(ext, 'id:abc'), false);
});
