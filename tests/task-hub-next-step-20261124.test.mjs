/**
 * 失敗した依頼の「次にやること」（2026-11-24・MA-24）。EN司令塔が「失敗の原因と対応は？」に 1 回の往復で答えられるように、
 * task.status が code ごとに決まった文（who・retry・text）を添える。依頼の中身・他の依頼元の情報は混ざらない。合成の id だけ・通信なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { NEXT_STEP_TABLE_FOR_TEST, nextStepOf, nextStepsFor } from '../scripts/lib/task-hub/next-step.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

function setup() {
  const env = makeEnv();
  const fromBot = async (e) => { dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(e)); const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy }); return r; };
  const run = () => runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => env.tick(10) });
  const task = (id) => env.store.readTask(id);
  const board = (id) => {
    const key = task(id).idempotency_key;
    const rows = env.store.listOutbox().filter((o) => o.task_ref === key).sort((a, b) => a.updated_at - b.updated_at);
    return JSON.parse(rows.at(-1).body);
  };
  const ask = async (params) => { const q = await fromBot(envelope({ intent: 'task.status', params })); await run(); return board(q.task_id).result; };
  return { env, fromBot, run, task, ask };
}

test('表：依頼元が直せる・Human が要る・一時的の 3 つに分かれる。表に無い code・形の合わない code は既定（止まる側・code の文字を返さない）', () => {
  assert.deepEqual([nextStepOf('params_invalid').who, nextStepOf('params_invalid').retry], ['requester', 'new_key']);
  assert.deepEqual([nextStepOf('intent_not_allowed').who, nextStepOf('intent_not_allowed').retry], ['human', 'no']);
  assert.deepEqual([nextStepOf('rejected_by_human').who, nextStepOf('rejected_by_human').retry], ['human', 'no']);
  assert.deepEqual([nextStepOf('dropbox_rate_limited').who, nextStepOf('dropbox_rate_limited').retry], ['wait', 'later']);
  assert.deepEqual([nextStepOf('dropbox_path_not_allowed').who, nextStepOf('dropbox_path_not_allowed').retry], ['human', 'no'], '許可の外は依頼元が path を変えて試すものではない');
  assert.equal(nextStepOf(undefined, 'expired').retry, 'new_key', 'code が無ければ state で引く');
  const unknown = nextStepOf('something_new');
  assert.deepEqual([unknown.who, unknown.retry], ['human', 'no']);
  const odd = nextStepOf('../etc/passwd<script>', 'failed');
  assert.equal(odd, unknown, '形の合わない code は既定の文');
  assert.ok(!JSON.stringify(odd).includes('passwd'));
  // 文は決まった文だけ（置き換えの印が無い）・who と retry は決まった語だけ
  for (const [, s] of NEXT_STEP_TABLE_FOR_TEST) {
    assert.ok(['requester', 'human', 'wait'].includes(s.who) && ['new_key', 'later', 'no'].includes(s.retry));
    assert.ok(!/\$\{|%s|\{\{/.test(s.text) && s.text.length <= 160);
    assert.ok(Object.isFrozen(s));
  }
});

test('nextStepsFor：code ごとに 1 つ（同じ文を繰り返さない）・形の合わない key は落とす', () => {
  const r = nextStepsFor([{ code: 'params_invalid', state: 'rejected' }, { code: 'params_invalid', state: 'rejected' }, { state: 'expired' }, { code: 'BAD KEY', state: 'failed' }]);
  assert.deepEqual(Object.keys(r).sort(), ['expired', 'params_invalid']);
});

test('task.status：failed の一覧に next_steps が付く・成功だけの一覧には付かない・1 件の task_ref の失敗には next が付く', async () => {
  const { env, fromBot, run, task, ask } = setup();
  const ok = await fromBot(envelope({ intent: 'note.record', params: { text: 'a' } }));
  const bad = await fromBot(envelope({ intent: 'note.record', params: { text: '' } })); // params_invalid で rejected
  await run();
  const f = await ask({ view: 'failed' });
  assert.deepEqual(f.items.map((i) => i.code), ['params_invalid']);
  assert.deepEqual(f.next_steps, { params_invalid: nextStepOf('params_invalid') });
  const s = await ask({ view: 'succeeded' });
  assert.ok(!('next_steps' in s), '失敗の無い一覧には付けない');
  const one = await ask({ task_ref: task(bad.task_id).idempotency_key });
  assert.deepEqual([one.found, one.state, one.code, one.next], [true, 'rejected', 'params_invalid', nextStepOf('params_invalid')]);
  const good = await ask({ task_ref: task(ok.task_id).idempotency_key });
  assert.ok(!('next' in good), '成功した依頼には付けない');
  rmSync(env.root, { recursive: true, force: true });
});

test('境は変えない：他の依頼元（Human の CLI）の失敗は next_steps にも出ない', async () => {
  const { env, fromBot, run, ask } = setup();
  await submitLocal(envelope({ intent: 'note.record', params: { text: '' }, idempotency_key: 'human-bad-0001' }), { store: env.store, policy: env.policy, now: env.clock.t });
  await fromBot(envelope({ intent: 'note.record', params: { text: 'a' } }));
  await run();
  const f = await ask({ view: 'failed' });
  assert.deepEqual([f.total, f.items, 'next_steps' in f], [0, [], false]);
  rmSync(env.root, { recursive: true, force: true });
});
