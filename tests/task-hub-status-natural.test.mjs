/**
 * task.status を「普通の語」で呼べること（2026-11-16・MA-24）。2026-11-15 の本番で EN司令塔（LLM の Bot）が
 * `{}`（→ params_task_ref_or_view で failed）と `{"view":"pending"}`（→ params_invalid で rejected）で呼び、一覧が取れなかった。
 * 直し：空は recent・意味が 1 つに決まる別名を受ける・succeeded の view・断った時は台帳の usage を hint として依頼元へ返す。
 * 境（同じ依頼元・同じ business だけ）は変えない。合成の id だけ・通信なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isHint } from '../scripts/lib/task-hub/envelope.mjs';
import { VIEW_ALIASES, VIEW_NAMES } from '../scripts/lib/task-hub/handlers.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { loadCatalog } from '../scripts/lib/task-hub/policy.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { nextStepOf } from '../scripts/lib/task-hub/next-step.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const cleanup = (env) => rmSync(env.root, { recursive: true, force: true });
const USAGE = loadCatalog().intents['task.status'].usage;

function setup() {
  const env = makeEnv();
  const fromBot = async (e, opts) => { dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(e, opts)); const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy }); return r; };
  const run = () => runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => env.tick(10) });
  const task = (id) => env.store.readTask(id);
  /** 依頼元が結果の板で読む本文（その task_ref の最新の知らせ） */
  const board = (id) => {
    const key = task(id).idempotency_key;
    const rows = env.store.listOutbox().filter((o) => o.task_ref === key).sort((a, b) => a.updated_at - b.updated_at);
    return JSON.parse(rows.at(-1).body);
  };
  const ask = async (params, over = {}) => { const q = await fromBot(envelope({ intent: 'task.status', params, ...over })); await run(); return q; };
  return { env, fromBot, run, task, board, ask };
}

test('本番で失敗した 2 つの呼び方（params が空・view: "pending"）が一覧を返す', async () => {
  const { env, fromBot, run, task, board, ask } = setup();
  await fromBot(envelope({ intent: 'note.record', params: { text: 'a' } }));
  const waiting = await fromBot(envelope({ intent: 'hermes.task', params: { title: 't', body: 'b' } })); // 承認待ち
  await run();
  const empty = await ask({});
  assert.equal(task(empty.task_id).state, 'succeeded');
  assert.deepEqual([board(empty.task_id).result.view, board(empty.task_id).result.total], ['recent', 2], '空＝自分の依頼の新しい順');
  const pending = await ask({ view: 'pending' });
  const r = board(pending.task_id).result;
  assert.deepEqual([task(pending.task_id).state, r.view, r.total, r.items[0].task_ref], ['succeeded', 'awaiting_approval', 1, task(waiting.task_id).idempotency_key], '別名は正式な view の名前で返す');
  cleanup(env);
});

test('別名はどれも正式な view と同じ答え。台帳の enum は VIEWS と別名の和（食い違えば test が落ちる）', async () => {
  const { env, fromBot, run, board, ask } = setup();
  await fromBot(envelope({ intent: 'note.record', params: { text: 'a' } }));
  await fromBot(envelope({ intent: 'hermes.task', params: { title: 't', body: 'b' } }));
  await fromBot(envelope({ intent: 'note.record', params: { text: 'x'.repeat(501) } })); // rejected
  await run();
  const strip = (res) => ({ view: res.view, total: res.total, refs: res.items.map((i) => i.task_ref).sort() });
  const canon = {};
  for (const v of VIEW_NAMES) canon[v] = strip(board((await ask({ view: v, limit: 20 })).task_id).result);
  assert.deepEqual([canon.awaiting_approval.total, canon.succeeded.total >= 1, canon.failed.total, canon.hermes.total], [1, true, 1, 1]);
  for (const [alias, to] of Object.entries(VIEW_ALIASES)) {
    const got = strip(board((await ask({ view: alias, limit: 20 })).task_id).result);
    assert.equal(got.view, to, `${alias} → ${to}`);
    // 聞くたびに task.status 自身の依頼が増えるので、正式な view が返した依頼を全部含むことを見る（recent・succeeded は増える）
    for (const ref of canon[to].refs) assert.ok(got.refs.includes(ref), `${alias} は ${to} と同じ依頼を返す`);
  }
  const schemaEnum = loadCatalog().intents['task.status'].params_schema.properties.view.enum;
  assert.deepEqual([...schemaEnum].sort(), [...VIEW_NAMES, ...Object.keys(VIEW_ALIASES)].sort());
  for (const to of Object.values(VIEW_ALIASES)) assert.ok(VIEW_NAMES.includes(to), `${to} は正式な view`);
  for (const a of Object.keys(VIEW_ALIASES)) assert.ok(!VIEW_NAMES.includes(a), `${a} は正式な view と重ならない`);
  cleanup(env);
});

test('view: succeeded は終わった依頼だけ・failed は失敗と断った依頼（code つき）・新しい順・limit', async () => {
  const { env, fromBot, run, task, board, ask } = setup();
  const ok1 = await fromBot(envelope({ intent: 'note.record', params: { text: 'a' } }));
  env.tick(1000);
  const ok2 = await fromBot(envelope({ intent: 'note.record', params: { text: 'b' } }));
  const bad = await fromBot(envelope({ intent: 'note.record', params: { text: '' } }));
  await run();
  const s = board((await ask({ view: 'succeeded' })).task_id).result;
  assert.deepEqual(s.items.map((i) => [i.task_ref, i.state]), [[task(ok2.task_id).idempotency_key, 'succeeded'], [task(ok1.task_id).idempotency_key, 'succeeded']]);
  const f = board((await ask({ view: 'failed' })).task_id).result;
  assert.deepEqual(f.items.map((i) => [i.task_ref, i.state, i.code]), [[task(bad.task_id).idempotency_key, 'rejected', 'params_invalid']]);
  const one = board((await ask({ view: 'recent', limit: 1 })).task_id).result;
  assert.deepEqual([one.items.length, one.total >= 3], [1, true]);
  cleanup(env);
});

test('形の誤りで断った時は、台帳の usage が hint として依頼元へ返る（知らない view・知らない key・型違い・両方）', async () => {
  const { env, task, board, ask } = setup();
  assert.ok(isHint(USAGE) && USAGE.includes('awaiting_approval') && USAGE.includes('task_ref'));
  for (const params of [{ view: 'approvals' }, { status: 'pending' }, { view: 'recent', limit: '10' }, { view: ['failed'] }]) {
    const q = await ask(params);
    assert.deepEqual([task(q.task_id).state, board(q.task_id)], ['rejected', { task_id: q.task_id, state: 'rejected', intent: 'task.status', code: 'params_invalid', hint: USAGE, next: nextStepOf('params_invalid') }], JSON.stringify(params));
  }
  const both = await ask({ view: 'recent', task_ref: 'abcdefgh' });
  assert.deepEqual([task(both.task_id).state, board(both.task_id).code, board(both.task_id).hint], ['failed', 'params_task_ref_or_view', USAGE]);
  // 依頼元の呼び方の誤りは runner の連続失敗に数えない（Bot の誤り 3 回で queue を止めない）
  await ask({ view: 'recent', task_ref: 'abcdefgh' });
  await ask({ view: 'recent', task_ref: 'abcdefgh' });
  const fine = await ask({ view: 'recent' });
  assert.equal(task(fine.task_id).state, 'succeeded');
  cleanup(env);
});

test('hint は台帳の決まった文だけ：依頼の中身は混ざらない・params 以外の失敗には付かない・succeeded には付かない・人の依頼は板へ出ない', async () => {
  const { env, fromBot, run, task, board, ask } = setup();
  const marker = 'ZZ-MARKER-ZZ';
  const q = await ask({ view: marker });
  const body = board(q.task_id);
  assert.equal(body.hint, USAGE);
  assert.ok(!JSON.stringify(body).includes(marker), '依頼の値を返さない');
  // params 以外の失敗（brief が未設定）には hint が付かない
  const st = await fromBot(envelope({ intent: 'status.query' }));
  await run();
  assert.deepEqual([task(st.task_id).state, task(st.task_id).error, 'hint' in board(st.task_id)], ['failed', { code: 'brief_not_configured' }, false]);
  const ok = await ask({});
  assert.deepEqual(['hint' in board(ok.task_id), task(ok.task_id).error], [false, null]);
  // usage の無い intent は hint なしで今までと同じ
  const m = await fromBot(envelope({ intent: 'mail.digest.ingest', params: { items: 'x' } }));
  assert.deepEqual(board(m.task_id), { task_id: m.task_id, state: 'rejected', intent: 'mail.digest.ingest', code: 'params_invalid', next: nextStepOf('params_invalid') });
  const before = env.store.listOutbox().length;
  await submitLocal(envelope({ intent: 'task.status', params: { view: 'nope' } }), { store: env.store, policy: env.policy, now: env.clock.t });
  assert.equal(env.store.listOutbox().length, before, '人の端末の依頼は結果の板へ出さない');
  cleanup(env);
});

test('境は変わらない：別名・空でも他の依頼元と他の business の依頼は一覧に出ない（承認待ちは件数だけ）', async () => {
  const { env, fromBot, run, task, board, ask } = setup();
  const mine = await fromBot(envelope({ intent: 'hermes.task', params: { title: 't', body: 'b' } }));
  await fromBot(envelope({ intent: 'hermes.task', business: 'biz-b', params: { title: 'other-biz', body: 'b' } })); // 同じ依頼元・別の business
  await fromBot(envelope({ intent: 'hermes.task', business: 'biz-b', params: { title: 'other-src', body: 'b' } }), { channel: 'chan-research', source: 'bot-research', key: Buffer.alloc(32, 0xb2) });
  await submitLocal(envelope({ intent: 'hermes.task', params: { title: 'h', body: 'human' } }), { store: env.store, policy: env.policy, now: env.clock.t }); // 人（biz-a）
  await run();
  for (const params of [{}, { view: 'pending' }, { view: 'all' }, { view: 'hermes' }]) {
    const r = board((await ask(params)).task_id).result;
    const refs = r.items.filter((i) => i.intent === 'hermes.task').map((i) => i.task_ref);
    assert.deepEqual(refs, [task(mine.task_id).idempotency_key], JSON.stringify(params));
    assert.ok(!JSON.stringify(r).includes('other-') && !JSON.stringify(r).includes('human'), '題名・本文は返さない');
  }
  const p = board((await ask({ view: 'approval' })).task_id).result;
  assert.deepEqual([p.total, p.others_awaiting_approval], [1, 1], '人の承認待ちは件数だけ');
  cleanup(env);
});

test('台帳の usage：1 行・300 字まで・制御文字なしだけを読み込む。store は形の悪い hint を残さない', () => {
  assert.ok(isHint('params: {}'));
  for (const bad of ['', 'a\nb', 'a\u0000', 'a\u2028b', 'x'.repeat(301), 5, null, undefined, ['a']]) assert.equal(isHint(bad), false, JSON.stringify(bad));
  const dir = mkdtempSync(path.join(tmpdir(), 'task-hub-usage-'));
  const base = JSON.parse(JSON.stringify(loadCatalog()));
  for (const usage of ['two\nlines', 'x'.repeat(301), 7]) {
    base.intents['task.status'].usage = usage;
    const f = path.join(dir, 'c.json');
    writeFileSync(f, JSON.stringify(base));
    assert.throws(() => loadCatalog(f), /task\.status\.usage/);
  }
  const env = makeEnv();
  const t = env.store.createTask({ source: 'bot-front', channel: 'chan-front', business: 'biz-a', intent: 'task.status', idempotency_key: 'hint-shape-0001', params: {}, class: 'auto', handler: 'task.status', state: 'rejected', code: 'params_invalid', hint: 'bad\nhint', content_digest: 'd'.repeat(64) }, env.clock.t).task;
  assert.deepEqual(t.error, { code: 'params_invalid' });
  rmSync(dir, { recursive: true, force: true });
  cleanup(env);
});
