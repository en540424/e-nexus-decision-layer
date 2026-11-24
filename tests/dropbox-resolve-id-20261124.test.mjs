/**
 * Dropbox の file の ID から実の path を引いて判定する（2026-11-24・resolveById）。模擬の reader だけ（実の Dropbox・資格情報に接続しない・名前は作り物）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveById } from '../scripts/lib/dropbox/resolve.mjs';
import { loadScopes, ScopeError } from '../scripts/lib/dropbox/scope.mjs';
import { nextStepOf } from '../scripts/lib/task-hub/next-step.mjs';

const scope = loadScopes({ businesses: { 'biz-a': { read_roots: ['/業務/現場管理', '/アプリ/link-app/sites'], estimate_roots: ['/業務/見積書の原本'], output_root: '/biz-a' } } }).get('biz-a');
const FILES = {
  'id:okA1': { tag: 'file', id: 'id:okA1', path: '/業務/現場管理/現場A/平面図.pdf', rev: '0123abcd' },
  'id:site_photo-1': { tag: 'file', id: 'id:site_photo-1', path: '/アプリ/link-app/sites/s-1/IMG_0001.jpg', rev: 'ff00' },
  'id:outside': { tag: 'file', id: 'id:outside', path: '/個人/家計.xlsx', rev: '1' },
  'id:talk': { tag: 'file', id: 'id:talk', path: '/アプリ/link-app/talk/r-1/a.jpg', rev: '2' },
  'id:denied': { tag: 'file', id: 'id:denied', path: '/業務/現場管理/作業員名簿.xlsx', rev: '3' },
  'id:est': { tag: 'file', id: 'id:est', path: '/業務/見積書の原本/A.xlsx', rev: '4' },
  'id:other': { tag: 'file', id: 'id:someone-else', path: '/業務/現場管理/x.pdf', rev: '5' },
  'id:nopath': { tag: 'file', id: 'id:nopath' },
};
const reader = (calls = []) => ({
  async metadata(p, opts) {
    calls.push([p, opts?.ids]);
    if (p === 'id:boom') throw Object.assign(new Error('x'), { code: 'dropbox_network' });
    const m = FILES[p];
    if (!m) throw Object.assign(new Error('nf'), { code: 'dropbox_path_not_found' });
    return m;
  },
});
const code = async (id, kind) => { try { await resolveById(reader(), scope, id, kind); return 'ok'; } catch (e) { return e.code; } };

test('許可フォルダの中の ID は実の path と rev を返す（読む時はこの path と rev で読む）', async () => {
  const calls = [];
  assert.deepEqual(await resolveById(reader(calls), scope, 'id:okA1', 'browse'), { path: '/業務/現場管理/現場A/平面図.pdf', tag: 'file', rev: '0123abcd' });
  assert.deepEqual(calls, [['id:okA1', true]], 'ID の照合のために ids を求める');
  assert.equal((await resolveById(reader(), scope, 'id:site_photo-1', 'browse')).path, '/アプリ/link-app/sites/s-1/IMG_0001.jpg', 'LINK の sites/ を足した時の形');
});

test('範囲の外・talk/・読ませない名前・見積（browse）・ID の食い違い・path なし・無い ID は、どれも同じ dropbox_id_not_readable（在ることを教えない）', async () => {
  for (const id of ['id:outside', 'id:talk', 'id:denied', 'id:other', 'id:nopath', 'id:missing']) assert.equal(await code(id, 'browse'), 'dropbox_id_not_readable', id);
  assert.equal(await code('id:est', 'browse'), 'dropbox_id_not_readable', '見積のフォルダは承認なしの一覧に出さない');
  assert.equal(await code('id:est', 'estimate'), 'ok', '見積の読み方なら読める');
});

test('ID の形が違えば Dropbox に聞かない・通信の失敗はそのまま（範囲の判定と混ぜない）', async () => {
  for (const id of ['/業務/現場管理/x.pdf', 'id:', 'id:a/b', 'id:../x', 'ID:abc', `id:${'a'.repeat(129)}`, 42, null]) {
    const calls = [];
    await assert.rejects(resolveById(reader(calls), scope, id), (e) => e instanceof ScopeError && e.code === 'dropbox_id_invalid', String(id));
    assert.equal(calls.length, 0);
  }
  await assert.rejects(resolveById(reader(), scope, 'id:boom'), (e) => e.code === 'dropbox_network');
});

test('次にやること：形の誤りは依頼元が直す・読めない ID は Human（出し直さない）', () => {
  assert.deepEqual([nextStepOf('dropbox_id_invalid').who, nextStepOf('dropbox_id_invalid').retry], ['requester', 'new_key']);
  assert.deepEqual([nextStepOf('dropbox_id_not_readable').who, nextStepOf('dropbox_id_not_readable').retry], ['human', 'no']);
});
