/**
 * 承認の記録の via（2026-11-24・スマホからの承認の準備＝案 A：iPhone から Tailscale 経由の SSH で Mac の端末に入り、今の承認をそのまま使う）。
 * 関所（端末・確認コード・digest）は変えない。via は記録だけ（local／ssh の 2 語・接続元の IP は残さない）。合成の id だけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { approve, dismiss, reject } from '../scripts/lib/task-hub/approval.mjs';
import { submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { main } from '../scripts/task-hub.mjs';
import { envelope, makeEnv } from './task-hub-helpers.mjs';

async function waiting(env, key) {
  const r = await submitLocal(envelope({ intent: 'hermes.task', params: { title: 't', body: 'b' }, idempotency_key: key }), { store: env.store, policy: env.policy, now: env.clock.t });
  return env.store.readTask(r.task_id);
}

test('via は local／ssh だけ記録・他の語は記録しない・無ければ今までと同じ形', async () => {
  const env = makeEnv();
  try {
    const a = await waiting(env, 'via-a-000001');
    assert.equal(approve(env.store, a.task_id, { confirm: a.content_digest.slice(0, 12), actor: 'tester', isTTY: true, via: 'ssh' }).task.approval.via, 'ssh');
    const b = await waiting(env, 'via-b-000001');
    assert.ok(!('via' in reject(env.store, b.task_id, { confirm: b.content_digest.slice(0, 12), actor: 'tester', isTTY: true, via: '203.0.113.9 22' }).task.rejection), '決まった語の他（IP など）は残さない');
    const c = await waiting(env, 'via-c-000001');
    assert.ok(!('via' in approve(env.store, c.task_id, { confirm: c.content_digest.slice(0, 12), actor: 'tester', isTTY: true }).task.approval));
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('SSH の端末でも関所は同じ：端末でなければ tty_required・確認コードが違えば confirm_mismatch', async () => {
  const env = makeEnv();
  try {
    const a = await waiting(env, 'via-d-000001');
    assert.deepEqual(approve(env.store, a.task_id, { confirm: a.content_digest.slice(0, 12), isTTY: false, via: 'ssh' }), { ok: false, code: 'tty_required' });
    assert.deepEqual(approve(env.store, a.task_id, { confirm: '0'.repeat(12), isTTY: true, via: 'ssh' }), { ok: false, code: 'confirm_mismatch' });
    assert.deepEqual(dismiss(env.store, a.task_id, { confirm: a.content_digest.slice(0, 12), isTTY: true, via: 'ssh' }), { ok: false, code: 'not_stopped' });
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});

test('CLI：approve は via を渡す（SSH の端末なら ssh）', async () => {
  const env = makeEnv();
  try {
    const a = await waiting(env, 'via-e-000001');
    const cfg = `${env.root}/config.json`;
    (await import('node:fs')).writeFileSync(cfg, JSON.stringify(env.config));
    const lines = [];
    const code = await main(['approve', a.task_id, '--confirm', a.content_digest.slice(0, 12), '--store', `${env.root}/store`, '--config', cfg], { out: (s) => lines.push(s), err: (s) => lines.push(s), isTTY: true, via: 'ssh', now: env.clock.t });
    assert.equal(code, 0, lines.join('\n'));
    assert.equal(env.store.readTask(a.task_id).approval.via, 'ssh');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});
