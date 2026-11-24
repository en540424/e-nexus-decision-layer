/**
 * 現場の口述の受け付け（2026-11-24・Human 決定 E・G）。架空の現場だけ（実案件の原本は使わない）。
 * Mac は原文・現場名・日付・入力の経路を残すだけで、寸法を構造化・確定しない（APP 側の karte-adapter と Human の担当）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportDictations, main, toDictationInput } from '../scripts/karte-dictation-export.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

// Vault の karte-adapter/schemas/dictation-input-v1.schema.json（2026-11-23）の必須と項目
const DI_REQUIRED = ['schema', 'input_id', 'case_id', 'text', 'recorded_on', 'channel'];
const DI_KEYS = [...DI_REQUIRED, 'speaker'];
const TEXT = '11月23日、架空町の試験邸。正面10メートル、左側5メートル、高さ約6メートル。バルコニーあり、カーポートあり、4トンワイド駐車可能';

function setup() {
  const env = makeEnv();
  const run = () => runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => env.tick(10) });
  const human = async (params, key) => { const r = await submitLocal(envelope({ intent: 'note.record', params, ...(key ? { idempotency_key: key } : {}) }), { store: env.store, policy: env.policy, now: env.clock.t }); await run(); return env.store.readTask(r.task_id); };
  const bot = async (params) => {
    dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(envelope({ intent: 'note.record', params })));
    const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
    await run();
    const t = env.store.readTask(r.task_id);
    const rows = env.store.listOutbox().filter((o) => o.task_ref === t.idempotency_key).sort((a, b) => a.updated_at - b.updated_at);
    return { t, board: rows.length ? rows.at(-1).body : null };
  };
  const rows = () => [...env.store.readRecords('biz-a', 'dictation').values()];
  return { env, human, bot, rows, cleanup: () => rmSync(env.root, { recursive: true, force: true }) };
}
const dict = (over = {}) => ({ kind: 'dictation', text: TEXT, site: '架空町の試験邸', recorded_on: '2026-11-23', channel: 'voice_transcript', ...over });

test('初回の登録：原文・現場名・日付・経路を残す・寸法は構造化しない（「約6メートル」は原文のまま）・結果に内部の ID が無い', async () => {
  const s = setup();
  try {
    const t = await s.human(dict());
    assert.equal(t.state, 'succeeded');
    assert.deepEqual(t.result, { recorded: true, kind: 'dictation', site: '架空町の試験邸', recorded_on: '2026-11-23' });
    const [r] = s.rows();
    assert.equal(r.text, TEXT);
    assert.ok(!('height' in r) && !('dimensions' in r), 'Mac は寸法の項目を作らない');
    assert.equal([...s.env.store.readRecords('biz-a', 'notes').values()].length, 0, 'メモ（2000 件で詰める）には入れない');
  } finally { s.cleanup(); }
});

test('同じ現場への追記・訂正は別の行で両方残る（前の内容を消さない）・同じ文の出し直しは duplicate で 1 件', async () => {
  const s = setup();
  try {
    await s.human(dict());
    await s.human(dict({ text: '架空町の試験邸、搬入は西側から', recorded_on: '2026-11-24' }));
    await s.human(dict({ text: '訂正：架空町の試験邸の高さは約6メートルではなく約7メートル', recorded_on: '2026-11-24' }));
    const again = await s.human(dict());
    assert.equal(again.result.duplicate, true);
    assert.equal(s.rows().length, 3);
    assert.ok(s.rows().some((r) => r.text.includes('約6メートル。')) && s.rows().some((r) => r.text.startsWith('訂正:')), '訂正の前と後の両方が残る');
    // 受け口は文字を NFKC に揃える＝全角の「：」は半角の「:」になる（原文のままではない・台帳 task-hub-nfkc-text の判断待ち）
    assert.ok(!s.rows().some((r) => r.text.includes('：')));
  } finally { s.cleanup(); }
});

test('Bot からの口述も結果の板に内部の ID・原文を返さない・現場名が無ければ断る・口述の項目をメモに混ぜない', async () => {
  const s = setup();
  try {
    const { t, board } = await s.bot(dict());
    assert.equal(t.state, 'succeeded');
    const b = JSON.parse(board);
    assert.deepEqual(b.result, { recorded: true, kind: 'dictation', site: '架空町の試験邸', recorded_on: '2026-11-23' });
    assert.ok(!/t-\d{14}-|id:|input_id/.test(JSON.stringify(b.result)), 'result に内部の ID（task・記録・Dropbox）が無い');
    assert.ok(!JSON.stringify(b.result).includes('正面10メートル'), '原文を結果に返さない');
    const noSite = await s.human({ kind: 'dictation', text: 'a' });
    assert.deepEqual([noSite.state, noSite.error?.code], ['failed', 'params_dictation_site']);
    const mixed = await s.human({ text: 'メモ', site: '架空町の試験邸' });
    assert.deepEqual([mixed.state, mixed.error?.code], ['failed', 'params_dictation_only']);
    const memo = await s.human({ text: '普通のメモ' });
    assert.deepEqual(memo.result, { recorded: true }, 'メモは今までどおり');
  } finally { s.cleanup(); }
});

test('書き出し：dictation-input-v1 の形（必須の項目・余分な項目なし）・同じ口述は何度でも同じ input_id・task の ID を出さない・file は 0600', async () => {
  const s = setup();
  try {
    await s.human(dict());
    await s.human({ kind: 'dictation', text: '搬入は西側', case_ref: 'case-x1' });
    const a = exportDictations(s.env.store, 'biz-a');
    const b = exportDictations(s.env.store, 'biz-a');
    assert.equal(a.inputs.length, 2);
    for (const x of a.inputs) {
      assert.deepEqual(Object.keys(x).sort(), [...DI_KEYS].sort());
      for (const k of DI_REQUIRED) assert.ok(k in x);
      assert.ok(['typed', 'voice_transcript', 'unknown'].includes(x.channel));
      assert.ok(!/t-\d{14}-/.test(x.input_id), 'task の ID そのものではない');
    }
    assert.deepEqual(a.inputs.map((x) => x.input_id), b.inputs.map((x) => x.input_id));
    assert.deepEqual(a.inputs.map((x) => [x.case_id, x.channel]), [['架空町の試験邸', 'voice_transcript'], ['case-x1', 'unknown']]);
    assert.equal(a.inputs[0].text, TEXT);
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'dict-')), 'out.jsonl');
    assert.equal(main(['--business', 'biz-a', '--out', out, '--store', path.join(s.env.root, 'store')], { out: () => {}, err: () => {} }), 0);
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 2);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(main(['--business', 'BAD', '--out', out], { out: () => {}, err: () => {} }), 2);
    assert.equal(toDictationInput({ id: 'x', text: 'a' }), null, '現場の手がかりが無い行は書き出さない');
  } finally { s.cleanup(); }
});
