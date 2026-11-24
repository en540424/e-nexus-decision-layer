/**
 * 将来の 1Password の入口（2026-11-24）。1Password は未接続・未有効化＝模擬の op と模擬の Keychain だけ。値は作り物。
 * 見ること：対応表が無ければ今の Keychain のまま・対応表の target だけ 1Password・未接続は安全な error・Keychain に黙って戻らない・値と参照を error に出さない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findOp, loadProviderMap, ProviderError, routeOf } from '../scripts/lib/credential-provider.mjs';
import { readCredential } from '../scripts/lib/env-file.mjs';
import { dropboxCredentials, readKeychainValue } from '../scripts/lib/dropbox/keychain.mjs';

const VALUE = 'fake-secret-value-0001';
const REF = 'op://E-NEXUS/dropbox-read/credential';
const map = { 'E-NEXUS/edl/dropbox-read-app-key': REF };
/** 模擬の execFile：呼ばれた bin と引数を記録し、bin ごとの答えを返す */
function fakeExec(answers, calls = []) {
  return (bin, args, opts, cb) => { calls.push({ bin, args, env: opts.env }); const a = answers[bin] ?? { err: Object.assign(new Error('x'), { code: 'ENOENT' }) }; setImmediate(() => cb(a.err ?? null, a.out ?? '')); };
}

test('対応表：無ければ {}（全部 Keychain）・形の悪い表・参照は拒否（黙って Keychain に戻らない）', () => {
  assert.deepEqual(loadProviderMap({ read: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } }), {});
  const bad = (text) => assert.throws(() => loadProviderMap({ read: () => text }), (e) => e instanceof ProviderError && e.code === 'provider_config_invalid');
  bad('not json');
  bad('{"v":2}');
  bad(JSON.stringify({ v: 1, onepassword: { references: { 'other/name': REF } } }));
  bad(JSON.stringify({ v: 1, onepassword: { references: { 'E-NEXUS/edl/x-key': 'op://v/i' } } }));
  bad(JSON.stringify({ v: 1, onepassword: { references: { 'E-NEXUS/edl/x-key': 'op://v/../i/f' } } }));
  bad(JSON.stringify({ v: 1, onepassword: { references: { 'E-NEXUS/edl/x-key': 'op://v/i/f"; rm -rf /' } } }));
  assert.deepEqual(loadProviderMap({ read: () => JSON.stringify({ v: 1, onepassword: { references: map } }) }), map);
  assert.deepEqual(routeOf('E-NEXUS/edl/other-key', map), { provider: 'keychain' });
  assert.deepEqual(routeOf('E-NEXUS/edl/dropbox-read-app-key', map), { provider: '1password', ref: REF });
  assert.throws(() => routeOf('../x', map), /credential_target_invalid/);
});

test('readCredential：対応表に無い target は今までどおり security（Keychain）・対応表の target は op read だけ', async () => {
  const calls = [];
  const exec = fakeExec({ '/usr/bin/security': { out: `${VALUE}\n` }, '/opt/homebrew/bin/op': { out: VALUE } }, calls);
  assert.equal(await readCredential('E-NEXUS/edl/other-key', { platform: 'darwin', execFileImpl: exec, providerMap: map }), VALUE);
  assert.equal(calls[0].bin, '/usr/bin/security');
  assert.equal(await readCredential('E-NEXUS/edl/dropbox-read-app-key', { platform: 'darwin', execFileImpl: exec, providerMap: map, opPath: '/opt/homebrew/bin/op' }), VALUE);
  assert.deepEqual([calls[1].bin, calls[1].args], ['/opt/homebrew/bin/op', ['read', '--no-newline', REF]]);
  assert.ok(!('OP_SERVICE_ACCOUNT_TOKEN' in calls[1].env), '親の token を継がない');
  assert.equal(calls.length, 2, '1Password の target で Keychain を読まない');
});

test('未接続・読めない時は code だけの error（値・参照を出さない）・Keychain に戻らない', async () => {
  const calls = [];
  const exec = fakeExec({ '/usr/bin/security': { out: VALUE }, '/opt/homebrew/bin/op': { err: Object.assign(new Error(`${REF} denied ${VALUE}`), { code: 1 }) } }, calls);
  await assert.rejects(readCredential('E-NEXUS/edl/dropbox-read-app-key', { platform: 'darwin', execFileImpl: exec, providerMap: map, opPath: null }), (e) => e.code === 'provider_not_connected');
  await assert.rejects(readCredential('E-NEXUS/edl/dropbox-read-app-key', { platform: 'darwin', execFileImpl: exec, providerMap: map, opPath: '/opt/homebrew/bin/op' }), (e) => {
    assert.equal(e.code, 'provider_read_failed');
    assert.ok(!e.message.includes(VALUE) && !e.message.includes('op://'), 'error に値も参照も無い');
    return true;
  });
  assert.ok(calls.every((c) => c.bin !== '/usr/bin/security'));
});

test('Dropbox の同期の読み：対応表の名前だけ op・未接続は null（未設定と同じ＝止まる側）・対応表が無ければ今の security のまま', () => {
  const calls = [];
  const spawn = (bin, args) => { calls.push(bin); return bin === '/usr/bin/security' ? { status: 0, stdout: `${VALUE}\n` } : { status: 0, stdout: VALUE }; };
  assert.equal(readKeychainValue('dropbox-read-app-key', { run: spawn, providerMap: {} }), VALUE);
  assert.equal(calls.pop(), '/usr/bin/security');
  assert.equal(readKeychainValue('dropbox-read-app-key', { run: spawn, providerMap: map, opPath: '/opt/homebrew/bin/op' }), VALUE);
  assert.equal(calls.pop(), '/opt/homebrew/bin/op');
  assert.equal(readKeychainValue('dropbox-read-app-key', { run: spawn, providerMap: map, opPath: null }), null);
  assert.equal(readKeychainValue('dropbox-read-app-key', { run: () => ({ status: 0, stdout: 'short' }), providerMap: map, opPath: '/x/op' }), null, '形の合わない値は使わない');
  assert.equal(dropboxCredentials('nope', { run: spawn, providerMap: {} }), null);
});

test('op の場所は決まった場所だけ（PATH を見ない）', () => {
  assert.equal(findOp({ exists: (p) => p === '/usr/local/bin/op' }), '/usr/local/bin/op');
  assert.equal(findOp({ exists: () => false }), null);
});
