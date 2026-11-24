/**
 * EN司令塔に「E-STEP の Dropbox の読むだけ」を開く時の形（2026-11-24・承認の前の模擬の E2E）。本番の config は変えていない。
 *
 * 形：依頼元の businesses に e-step を足し、business_intents で e-step の無人の intent を読むだけ（task.status・dropbox.list・dropbox.search・schedule.read）に絞る。
 * 封（VPS の受け口の役）→ 取り込み → 分類（Decision Layer）→ 実行 → 結果の板（依頼元が get_task_status で読む本文）まで、模擬の Dropbox で通す。
 * 見ること：許可フォルダ・deny_roots・deny_names・見積のフォルダが結果の板に名前も出ない・任意の path／ID／検索語で外を指せない・
 * e-step の他の intent（メモ・朝の報告・Hermes・カルテ・PDF）は無人で動かない・他の依頼元の依頼は見えない・結果の大きさの上限。
 * 名前は作り物（biz-a＝e-nexus の役・biz-b＝e-step の役）。通信は 127.0.0.1 の模擬だけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDropbox } from '../scripts/lib/dropbox/client.mjs';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { createPolicy, loadCatalog, validateConfig } from '../scripts/lib/task-hub/policy.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { MAX_BODY_BYTES } from '../scripts/lib/task-hub/wire.mjs';
import { startDropboxMock } from './dropbox-mock.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';
import { bigCalendar } from './xlsx-calendar-fixture.mjs';

const FIVE = ['status.query', 'task.status', 'report.morning', 'note.record', 'hermes.task'];
const READS = ['dropbox.list', 'dropbox.search', 'schedule.read'];
const SCHED = '/業務/予定/年間予定表.xlsx';
const ROOT = '/業務/現場管理';
const HIDDEN = ['元請', '作業員名簿', '安全書類', '給与', '見積書の原本', 'A_見積書'];
const sources = (bi = { 'biz-b': ['task.status', ...READS] }) => ({
  'grok-sim': { channels: ['chan-front'], businesses: ['biz-a', 'biz-b'], intents: [...FIVE, ...READS], business_intents: bi },
  'human-cli': { channels: ['local-cli'], businesses: ['biz-a', 'biz-b'] },
});
const DROPBOX = { businesses: { 'biz-b': { read_only: true, read_roots: [ROOT], schedule_files: [SCHED], estimate_roots: ['/業務/見積書の原本'], deny_roots: [`${ROOT}/元請`], deny_names: ['安全書類'], output_root: '/biz-b' } } };

async function world() {
  const read = await startDropboxMock({ role: 'read' });
  const write = await startDropboxMock({ role: 'write' });
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-estep-'));
  read.put(SCHED, bigCalendar());
  read.put(`${ROOT}/現場A/平面図.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put(`${ROOT}/工程写真.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put(`${ROOT}/作業員名簿.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put(`${ROOT}/安全書類/入場.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put(`${ROOT}/元請/取引先/給与明細.pdf`, Buffer.from('%PDF-1.4 fake'));
  read.put('/業務/見積書の原本/A_見積書.pdf', Buffer.from('%PDF-1.4 fake'));
  const reader = read.client(createDropbox);
  const writer = write.client(createDropbox);
  const services = { backupDir: dir, historyDir: dir, dropbox: (role) => (role === 'read' ? reader : writer) };
  const env = makeEnv({ config: { sources: sources(), dropbox: DROPBOX, utc_offset_minutes: 540 } });
  const config = { ...env.config, services };
  const run = () => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: () => (env.clock.t += 1000) });
  const fromGrok = async (intent, params, business = 'biz-b') => {
    dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(envelope({ intent, params, business }), { channel: 'chan-front', source: 'grok-sim' }));
    const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
    return r;
  };
  const task = (id) => env.store.readTask(id);
  const board = (id) => {
    const rows = env.store.listOutbox().filter((o) => o.task_ref === task(id).idempotency_key).sort((a, b) => a.updated_at - b.updated_at);
    return rows.length ? JSON.parse(rows.at(-1).body) : null;
  };
  const ask = async (intent, params, business) => { const r = await fromGrok(intent, params, business); await run(); return { r, t: task(r.task_id), b: board(r.task_id) }; };
  const allBoards = () => env.store.listOutbox().map((o) => o.body).join('\n');
  const close = async () => { await read.close(); await write.close(); rmSync(dir, { recursive: true, force: true }); rmSync(env.root, { recursive: true, force: true }); };
  return { env, config, run, fromGrok, task, board, ask, allBoards, close };
}

test('読むだけの 3 つは無人で動き、結果の板に許可の外の名前が出ない（deny_roots・deny_names・共通の下限・見積のフォルダ）', async () => {
  const w = await world();
  try {
    const list = await w.ask('dropbox.list', { path: ROOT });
    assert.equal(list.t.state, 'succeeded');
    assert.deepEqual(list.b.result.entries.map((e) => e.name).sort(), ['工程写真.pdf', '現場A'].sort(), '元請（deny_roots）・安全書類（deny_names）・作業員名簿（共通の下限）は名前も出ない');
    const search = await w.ask('dropbox.search', { query: 'pdf' });
    assert.equal(search.t.state, 'succeeded');
    assert.deepEqual(search.b.result.files.map((f) => f.name).sort(), ['平面図.pdf', '工程写真.pdf'].sort());
    const sched = await w.ask('schedule.read', {});
    assert.equal(sched.t.state, 'succeeded');
    for (const x of [list, search, sched]) assert.ok(Buffer.byteLength(JSON.stringify(x.b), 'utf8') <= MAX_BODY_BYTES, '結果の板の 1 封の上限');
    const text = w.allBoards();
    for (const h of HIDDEN) assert.ok(!text.includes(h), `結果の板に「${h}」が無い`);
  } finally { await w.close(); }
});

test('任意の path・ID・検索語で外を指せない：Dropbox の全体・上の階層・.. ・ID・deny_roots・見積のフォルダ・拒む語の検索', async () => {
  const w = await world();
  try {
    const cases = [
      ['dropbox.list', { path: '/' }], ['dropbox.list', { path: '/業務' }], ['dropbox.list', { path: `${ROOT}/../見積書の原本` }],
      ['dropbox.list', { path: `${ROOT}/元請` }], ['dropbox.list', { path: `${ROOT}/安全書類` }], ['dropbox.list', { path: '/業務/見積書の原本' }],
      ['dropbox.list', { path: 'id:dir-read-12' }], ['dropbox.search', { query: '名簿' }], ['dropbox.search', { query: '給与' }],
      ['dropbox.search', { query: 'pdf', path: '/業務/見積書の原本' }], ['dropbox.search', { query: 'pdf', path: `${ROOT}/元請` }],
    ];
    for (const [intent, params] of cases) {
      const { t, b } = await w.ask(intent, params);
      assert.ok(['failed', 'rejected'].includes(t.state), `${intent} ${JSON.stringify(params)} → ${t.state}`);
      assert.ok(!b.result?.entries && !b.result?.files, '一覧・検索の結果を返さない');
    }
    const text = w.allBoards();
    for (const h of HIDDEN) assert.ok(!text.includes(h), `断った結果の板にも「${h}」が無い（依頼の path・語を返さない）`);
    // 断った依頼の「次にやること」：許可の外は Human（出し直さない）
    const f = (await w.ask('task.status', { view: 'failed', limit: 20 })).b.result;
    assert.ok(f.total >= cases.length - 1);
    for (const [k, step] of Object.entries(f.next_steps)) if (/not_allowed/.test(k)) assert.deepEqual([step.who, step.retry], ['human', 'no']);
  } finally { await w.close(); }
});

test('business_intents：e-step の役の他の intent は無人で動かない（承認待ち）・e-nexus の役の 5 つは今までどおり', async () => {
  const w = await world();
  try {
    for (const [intent, params] of [['note.record', { text: 'a' }], ['report.morning', {}], ['status.query', {}], ['hermes.task', { title: 't', body: 'b' }]]) {
      const { t } = await w.ask(intent, params);
      assert.equal(t.state, 'awaiting_approval', `${intent} は e-step の役では承認待ち`);
      assert.ok(t.decision.reasons.includes('intent_not_in_business_allowlist') || intent === 'hermes.task', intent);
    }
    const note = await w.ask('note.record', { text: 'a' }, 'biz-a');
    assert.equal(note.t.state, 'succeeded', 'e-nexus の役の note.record は今までどおり無人');
    const own = await w.ask('dropbox.list', { path: ROOT }, 'biz-a');
    assert.deepEqual([own.t.state, own.t.error?.code], ['failed', 'dropbox_business_not_enabled'], 'e-nexus の役には Dropbox の設定が無い＝読めない');
  } finally { await w.close(); }
});

test('カルテと PDF は Human が承認しても Grok の依頼では読めない（read_only・Mac だけ）', async () => {
  const w = await world();
  try {
    const intents = loadCatalog().intents;
    let checked = 0;
    for (const [intent, params, code] of [['karte.get', { case_id: 'C-001' }, 'dropbox_read_only'], ['dropbox.pdf.search', { path: ROOT, query: 'pdf' }, 'dropbox_pdf_local_only']]) {
      if (!intents[intent]) continue;
      const r = await w.fromGrok(intent, params);
      const t0 = w.task(r.task_id);
      if (t0.state === 'rejected') continue; // params の形が台帳と違う時（この試験の目的ではない）
      assert.equal(t0.state, 'awaiting_approval', `${intent} は無人で動かない`);
      approve(w.env.store, r.task_id, { confirm: t0.content_digest.slice(0, 12), isTTY: true, now: w.env.clock.t });
      await w.run();
      const t = w.task(r.task_id);
      assert.deepEqual([t.state, t.error?.code], ['failed', code], `${intent} は承認の後も ${code}`);
      checked += 1;
    }
    assert.equal(checked, 2, 'カルテと PDF の両方を確かめた（台帳の形が変わったら直す）');
  } finally { await w.close(); }
});

test('task.status は自分の依頼だけ：Human の CLI の e-step の依頼は Grok に見えない', async () => {
  const w = await world();
  try {
    await submitLocal(envelope({ intent: 'dropbox.list', params: { path: ROOT }, business: 'biz-b', idempotency_key: 'human-list-000001' }), { store: w.env.store, policy: w.env.policy, now: w.env.clock.t });
    await w.ask('dropbox.list', { path: ROOT });
    const s = (await w.ask('task.status', { view: 'recent', limit: 20 })).b.result;
    assert.ok(s.items.every((i) => i.task_ref !== 'human-list-000001'));
    assert.equal(s.items.filter((i) => i.intent === 'dropbox.list').length, 1);
  } finally { await w.close(); }
});

test('config の検査：business_intents は依頼元の businesses と intents の中だけ（広げる道にしない）・絞ると承認の前の task は policy_changed', async () => {
  const base = { businesses: ['biz-a', 'biz-b'] };
  const cfg = (bi) => ({ ...base, sources: { 'src-x': { channels: ['chan-x'], businesses: ['biz-b'], intents: ['dropbox.list', 'task.status'], business_intents: bi } } });
  assert.throws(() => validateConfig(cfg({ 'biz-a': ['task.status'] })), /business_intents\.biz-a/, '依頼元の外の business');
  assert.throws(() => validateConfig(cfg({ 'biz-b': ['note.record'] })), /business_intents\.biz-b/, 'intents の外の intent');
  assert.throws(() => validateConfig(cfg({ 'biz-b': 'dropbox.list' })), /business_intents/);
  assert.throws(() => validateConfig(cfg([])), /business_intents/);
  assert.doesNotThrow(() => validateConfig(cfg({ 'biz-b': ['dropbox.list'] })));
  // 絞った後の再確認：前は auto だった task は止まる
  const w = await world();
  try {
    const r = await w.fromGrok('dropbox.list', { path: ROOT });
    const narrowed = createPolicy({ catalog: loadCatalog(), config: validateConfig({ ...w.env.config, sources: sources({ 'biz-b': ['task.status'] }) }) });
    assert.deepEqual(narrowed.recheck(w.task(r.task_id)), { ok: false, code: 'policy_changed' });
  } finally { await w.close(); }
});
