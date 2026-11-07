/**
 * バックアップの道具（2026-11-04・Mac Runtime）。暗号化・改ざん検知・復元の一致・合成データだけの予行・棚卸しの範囲。外へ送らない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { MAGIC, manifestOf, pack, restore, unpack } from '../scripts/lib/backup-archive.mjs';
import { runDrill } from '../scripts/backup-drill.mjs';
import { catalog, inventory } from '../scripts/backup-inventory.mjs';
import { backupSources, denyLines, planBackup, policyViolations, retentionPlan } from '../scripts/lib/backup-plan.mjs';
import { SIZE_LIMIT_KIB, VERIFY_EVERY_MS, attestKey, buildArchive, keyAttested, runBackup, validate, verifyArchive, verifyBackups, workRoot } from '../scripts/backup-run.mjs';
import { BACKUP_RECEIPT_SCHEMA } from '../scripts/lib/runtime-guard.mjs';
import { renderJob, validateJobArgs } from '../scripts/scheduled-job-service.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'edl-backup-'));
function tree() {
  const dir = tmp();
  mkdirSync(path.join(dir, 'a'));
  writeFileSync(path.join(dir, 'a', 'x.md'), 'secret-note\n', { mode: 0o600 });
  writeFileSync(path.join(dir, 'y.bin'), Buffer.from([0, 255, 1]));
  return dir;
}

test('暗号化：平文が残らない・復元で全部一致（中身・mode）・passphrase が無ければ作らない', () => {
  const src = tree();
  const dst = path.join(tmp(), 'out');
  try {
    const archive = pack(src, 'pw');
    assert.ok(archive.subarray(0, MAGIC.length).equals(MAGIC));
    assert.ok(!archive.includes('secret-note') && !archive.includes('x.md'), 'パス名も暗号の中');
    assert.equal(restore(archive, 'pw', dst), 2);
    assert.deepEqual(manifestOf(dst), manifestOf(src));
    assert.equal(statSync(path.join(dst, 'a', 'x.md')).mode & 0o777, 0o600);
    assert.throws(() => pack(src, ''), /passphrase/);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(path.dirname(dst), { recursive: true, force: true });
  }
});

test('改ざん・passphrase の誤り・別のファイルは復号で失敗する。空でない先へ復元しない', () => {
  const src = tree();
  try {
    const archive = pack(src, 'pw');
    const bad = Buffer.from(archive);
    bad[archive.length - 20] ^= 1;
    assert.throws(() => unpack(bad, 'pw'));
    assert.throws(() => unpack(archive, 'other'));
    assert.throws(() => unpack(Buffer.from('not an archive'), 'pw'), /not a backup/);
    assert.throws(() => restore(archive, 'pw', src), /must be empty/, '既存のファイルを上書きしない');
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('symlink はたどらない（外のファイルを取り込まない）', () => {
  const src = tree();
  const outside = tmp();
  try {
    writeFileSync(path.join(outside, 'private.txt'), 'outside');
    symlinkSync(path.join(outside, 'private.txt'), path.join(src, 'link.txt'));
    assert.deepEqual(manifestOf(src).map((f) => f.path), ['a/x.md', 'y.bin']);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('予行：合成データだけで全項目を通し、入力口を持たない', () => {
  const r = runDrill();
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.data, 'synthetic');
  const src = readFileSync(new URL('../scripts/backup-drill.mjs', import.meta.url), 'utf8');
  assert.ok(!/process\.argv\.slice|parseArgs/.test(src), '実データの指定を受け取らない');
  assert.ok(!/\bfetch\(|https?:/.test(src), '外へ送らない');
});

test('棚卸し：Trading Lab の領域を含まない・中身を読まない（du と git だけ）・鍵は backup の対象にしない', async () => {
  const args = { base: '/b/rt', home: '/h', repoRoot: '/b/rt/e-nexus-decision-layer' };
  assert.ok(!catalog(args).some((t) => /parallels|trading/i.test(t.dir)));
  assert.ok(!catalog({ ...args, base: '/b/trading-lab' }).some((t) => /trading/i.test(t.dir)));
  const calls = [];
  const run = async (bin, a) => {
    calls.push(bin);
    return bin.endsWith('du') ? { code: 0, stdout: `2048\t${a[1]}\n` } : { code: 0, stdout: '# branch.oid a\n# branch.upstream o/m\n# branch.ab +1 -0\n' };
  };
  const rows = await inventory({ ...args, run, repos: ['r1'], exists: (p) => !p.includes('tools') });
  assert.deepEqual([...new Set(calls)].sort(), ['/usr/bin/du', '/usr/bin/git']);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['repo:r1'].protection, 'git_unpushed');
  assert.equal(by.mac_runtime_state.bytes, 2048 * 1024);
  assert.equal(by.rea_install.protection, 'absent');
  assert.equal(by.keychain_secrets.protection, 'secret');
  assert.ok(!rows.some((r) => 'dir' in r), '結果にパスを持たない');
});

test('復元：全項目を確かめてから書く（悪い項目があれば 1 つも書かない）・同じパスを 2 回書かない', () => {
  const dst = tmp();
  const target = path.join(dst, 'out');
  const craft = (files) => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync('pw', salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(gzipSync(JSON.stringify({ files }))), c.final()]);
    return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
  };
  const entry = (p, text = 'x') => ({ path: p, mode: 0o600, data: Buffer.from(text).toString('base64'), sha256: createHash('sha256').update(text).digest('hex') });
  try {
    assert.throws(() => restore(craft([entry('good.txt'), entry('../../evil.txt')]), 'pw', target), /escapes/);
    assert.ok(!existsSync(target), '途中まで書かない');
    assert.throws(() => restore(craft([entry('a.txt'), entry('a.txt', 'y')]), 'pw', target), /EEXIST/);
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});

// ─── 本番の道具（2026-11-05・H5）。合成データと差し替えた fetch だけで回す。GitHub・Keychain には触れない ───

const PASS = 'synthetic-passphrase-0123456789';
const TOKEN = 'github_pat_SYNTHETIC0000';
const creds = (over = {}) => async (t) => ({ 'E-NEXUS/edl/backup-passphrase': PASS, 'E-NEXUS/edl/backup-token': TOKEN, ...over })[t] ?? null;
const EXPIRY = '2027-02-03 08:39:03 UTC';
const reply = (status, json = null, bytes = null, extra = {}) => ({ status, json: async () => json, arrayBuffer: async () => bytes, headers: { get: (k) => (k === 'github-authentication-token-expiration' ? EXPIRY : extra[k] ?? null) } });
const blob = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

/** 保存先の役。files に置いたものを読み直しで返す。tamper で読み直しの中身を変える */
function fakeRepo({ repo = { private: true, visibility: 'private', size: 10, default_branch: 'main', pushed_at: 'x' }, other = 404, list = [{ name: 'backup' }], keys = 403, otherJson = {}, refProbe = 403, probeHeaders = {}, tamper = false, putStatus = 201, calls = [], files = new Map() } = {}) {
  return async (url, opts) => {
    const u = new URL(url);
    calls.push([opts.method, u.pathname, opts.body ?? null, opts.headers.authorization]);
    if (u.hostname !== 'api.github.com') throw new Error('other host');
    if (u.pathname === '/repos/o/backup') return reply(repo ? 200 : 404, repo);
    if (u.pathname === '/user/repos') return reply(list === 'denied' ? 403 : 200, list === 'denied' ? {} : list);
    if (u.pathname === '/repos/o/private-other') return reply(other, otherJson);
    if (u.pathname === '/repos/o/private-other/git/refs') return reply(refProbe, {}, null, probeHeaders);
    if (u.pathname === '/repos/o/backup/keys') return reply(keys, []);
    if (u.pathname === '/repos/o/backup/contents/archives') return reply(200, [...files.entries()].map(([n, b]) => ({ name: path.basename(n), sha: blob(b) })));
    if (opts.method === 'PUT') {
      if (putStatus === 201) files.set(u.pathname, Buffer.from(JSON.parse(opts.body).content, 'base64'));
      return reply(putStatus, {});
    }
    if (opts.method === 'DELETE') { files.delete(u.pathname); return reply(200, {}); }
    if (opts.method === 'GET' && files.has(u.pathname)) {
      const b = Buffer.from(files.get(u.pathname));
      if (tamper) b[b.length >> 1] ^= 1;
      return reply(200, null, b);
    }
    return reply(404);
  };
}
function setup() {
  const home = tmp();
  const src = tree();
  const stored = attestKey({ home, typed: PASS, stored: PASS, at: '2026-11-05T00:00:00.000Z' });
  assert.equal(stored, true);
  const planFiles = () => ({ files: [{ id: 'notes', rel: 'a/x.md', body: readFileSync(path.join(src, 'a', 'x.md')), bytes: 12 }], excluded: { denied: 1 }, bytes: 12 });
  return { home, src, planFiles, base: { owner: 'o', repo: 'backup', home, otherRepos: ['private-other'], planFiles, read: creds(), now: () => new Date('2026-11-05T04:40:00.000Z') } };
}
const clean = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
const receiptOf = (home) => JSON.parse(readFileSync(path.join(home, '.enexus', 'backup', 'last.json'), 'utf8'));

test('1 回分：暗号化して送り、読み直して復号し、受領票を書く。平文も passphrase も外へ出ない・token は header だけ', async () => {
  const { home, src, base } = setup();
  try {
    const calls = [];
    const files = new Map();
    const r = await runBackup({ ...base, fetchImpl: fakeRepo({ calls, files }) });
    assert.equal(r.code, 0);
    assert.equal(r.archive, '2026-11-05T0440Z.edlbk');
    const stored = [...files.values()][0];
    assert.ok(!stored.includes('secret-note') && !stored.includes('x.md'));
    const sent = calls.map(([m, p, b]) => `${m} ${p} ${b ?? ''}`).join('\n');
    assert.ok(!sent.includes(PASS) && !sent.includes(TOKEN) && !sent.includes('secret-note'));
    assert.ok(calls.every(([, , , auth]) => auth === `Bearer ${TOKEN}`));
    const out = path.join(tmp(), 'out');
    assert.equal(restore(stored, PASS, out), 1, '別の場所で passphrase だけで戻せる');
    assert.equal(readFileSync(path.join(out, 'notes', 'a', 'x.md'), 'utf8'), 'secret-note\n');
    clean(path.dirname(out));
    const rc = receiptOf(home);
    assert.equal(rc.schema, BACKUP_RECEIPT_SCHEMA);
    assert.equal(rc.restore_verified_at, rc.finished_at);
    assert.deepEqual([rc.consecutive_failures, rc.files], [0, 1]);
    assert.ok(!JSON.stringify(rc).includes(path.dirname(src)), '受領票にパスを残さない');
  } finally {
    clean(home, src);
  }
});

test('送る条件：1 つでも欠ければ PUT しない（Public・鍵の控えなし・広い token・弱い passphrase・classic token・予行の失敗）', async () => {
  const { home, src, base } = setup();
  try {
    const cases = [
      ['repo_not_private', { fetchImpl: { repo: { private: false, visibility: 'public', size: 1 } } }],
      ['repo_not_private', { fetchImpl: { repo: { private: true, visibility: 'internal', size: 1 } } }],
      ['repo_not_found', { fetchImpl: { repo: null } }],
      ['token_too_broad', { fetchImpl: { other: 200 } }],
      ['token_too_broad', { fetchImpl: { list: [{ name: 'backup' }, { name: 'unlisted-private' }] } }],
      ['token_too_broad', { fetchImpl: { keys: 200 } }],
      ['scope_unverified', { fetchImpl: { list: 'denied' } }],
      ['scope_unverified', { fetchImpl: { list: [] } }],
      ['scope_unverified', { fetchImpl: { other: 500 } }],
      ['scope_unverified', { fetchImpl: { other: 403 } }],
      ['scope_unverified', { fetchImpl: { other: 429 } }],
      ['scope_unverified', { fetchImpl: { keys: 500 } }],
      ['scope_unverified', { fetchImpl: { keys: 429 } }],
      ['scope_unverified', { otherRepos: [] }],
      ['scope_unverified', { otherRepos: undefined }],
      ['no_passphrase', { read: creds({ 'E-NEXUS/edl/backup-passphrase': null }) }],
      ['weak_passphrase', { read: creds({ 'E-NEXUS/edl/backup-passphrase': 'short' }) }],
      ['key_not_attested', { read: creds({ 'E-NEXUS/edl/backup-passphrase': `${PASS}-changed` }) }],
      ['no_token', { read: creds({ 'E-NEXUS/edl/backup-token': null }) }],
      ['token_not_fine_grained', { read: creds({ 'E-NEXUS/edl/backup-token': 'gho_broad' }) }],
      ['drill_failed', { drill: () => ({ ok: false }) }],
    ];
    for (const [code, over] of cases) {
      const calls = [];
      const r = await runBackup({ ...base, ...over, fetchImpl: fakeRepo({ calls, ...(over.fetchImpl ?? {}) }) });
      assert.deepEqual([r.code, r.failure], [3, code], code);
      assert.ok(!calls.some(([m]) => m !== 'GET'), `${code}：何も送らない`);
    }
    rmSync(path.join(home, '.enexus', 'backup', 'key-offsite.json'));
    assert.equal((await runBackup({ ...base, fetchImpl: fakeRepo() })).failure, 'key_not_attested', '控えの確認の記録が無い');
  } finally {
    clean(home, src);
  }
});

test('届いたことの実証：読み直しが違えば成功にしない。失敗は受領票に数え、成功の時刻を残す・成功で数え直す', async () => {
  const { home, src, base } = setup();
  try {
    const ok = await runBackup({ ...base, fetchImpl: fakeRepo() });
    assert.equal(ok.code, 0);
    const finished = receiptOf(home).finished_at;
    const later = { ...base, now: () => new Date('2026-11-06T04:40:00.000Z') };
    assert.equal((await runBackup({ ...later, fetchImpl: fakeRepo({ tamper: true }) })).failure, 'read_back_mismatch');
    assert.equal((await runBackup({ ...later, fetchImpl: fakeRepo({ putStatus: 403 }) })).failure, 'token_cannot_write');
    assert.equal((await runBackup({ ...later, fetchImpl: async () => { throw new Error(`/Users/x ${TOKEN}`); } })).failure, 'github_unreachable');
    const rc = receiptOf(home);
    assert.deepEqual([rc.consecutive_failures, rc.finished_at, rc.last_failure_code], [3, finished, 'github_unreachable']);
    assert.ok(!JSON.stringify(rc).includes(TOKEN));
    assert.equal((await runBackup({ ...later, fetchImpl: fakeRepo() })).code, 0);
    assert.equal(receiptOf(home).consecutive_failures, 0);
  } finally {
    clean(home, src);
  }
});

test('容量：repo の上限を超えたら送らない・空の対象は成功にしない', async () => {
  const { home, src, base, planFiles } = setup();
  try {
    assert.equal((await runBackup({ ...base, fetchImpl: fakeRepo({ repo: { private: true, visibility: 'private', size: SIZE_LIMIT_KIB + 1 } }) })).failure, 'repo_too_large');
    assert.equal((await runBackup({ ...base, planFiles: () => ({ ...planFiles(), files: [] }), fetchImpl: fakeRepo() })).failure, 'nothing_to_back_up');
  } finally {
    clean(home, src);
  }
});

test('世代：新しい 14 と月ごとの最新 12 か月を残す。形の違う名前は消さない', () => {
  const names = [];
  for (let d = 0; d < 500; d += 1) names.push(`${new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10)}T0440Z.edlbk`);
  const gone = new Set(retentionPlan([...names, 'README.md']));
  const kept = names.filter((n) => !gone.has(n));
  assert.ok(!gone.has('README.md'));
  assert.ok(kept.includes(names.at(-1)));
  assert.equal(new Set(kept.map((n) => n.slice(0, 7))).size, 12);
  assert.ok(kept.length <= 14 + 12);
  assert.deepEqual(retentionPlan(names.slice(0, 5)), [], '少なければ消さない');
});

const DENY = '# c\n\nacme-[[:alnum:]]+-id\n^ACCOUNT=\nSECRET_END$\n\\<acct\\>\nfiller-one\nfiller-two\n';
const planOf = (dir, over = {}) => {
  const work = tmp();
  try {
    return planBackup({ sources: [{ id: 's', dir, exclude: /^hermes\/bundle-/ }], denyText: DENY, tmpRoot: work, ...over });
  } finally {
    clean(work);
  }
};
const put = (dir) => (rel, body) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), body); };

test('選別：allowlist の外・Secret の形・Trading Lab・deny・symlink・再生成できるものを落とす。記録に本文を出さないのは呼ぶ側', () => {
  const dir = tmp();
  try {
    const w = put(dir);
    w('keep.md', 'plain note\n');
    w('sub/state.json', '{}\n');
    w('photo.png', 'x');
    w('.env.local', 'A=1\n');
    w('private.key', 'x\n');
    w('leak-pat.md', `token ${'github_pat_'}${'A'.repeat(30)}\n`);
    w('leak-key.md', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    w('leak-hook.md', `https://discord.com/api/webhooks/123/${'a'.repeat(30)}\n`);
    w('trading-lab-notes.md', 'x\n');
    w('customer.md', 'ACME-SYNTHETIC-ID\n');
    w('hermes/bundle-1/x.md', 'x\n');
    symlinkSync('/etc/hosts', path.join(dir, 'link.md'));
    const p = planOf(dir);
    assert.deepEqual(p.files.map((f) => f.rel), ['keep.md', 'sub/state.json']);
    assert.deepEqual(p.excluded, { file_type: 3, secret: 3, trading_lab: 1, denied: 1, regenerable: 1 });
  } finally {
    clean(dir);
  }
});

test('deny は grep -E のとおりに効く（行頭・行末・語の境界・class。途中の行でも）。名前にも効く', () => {
  const dir = tmp();
  try {
    const w = put(dir);
    w('a.md', 'first line\nACCOUNT=1\n');
    w('b.md', 'x SECRET_END\nnext line\n');
    w('c.md', 'the acct here\n');
    w('d.md', 'Acme-Abc1-ID\n');
    w('filler-one.md', 'name only\n');
    w('e.md', 'NOTACCOUNT=1 account\n');
    const p = planOf(dir);
    assert.deepEqual(p.files.map((f) => f.rel), ['e.md']);
    assert.equal(p.excluded.denied, 5);
  } finally {
    clean(dir);
  }
});

test('文字列でないファイルは入れない（UTF-16・bplist・NUL は検査をすり抜ける）', () => {
  const dir = tmp();
  try {
    const w = put(dir);
    w('u16.txt', Buffer.from(`token ghp_${'A'.repeat(36)}`, 'utf16le'));
    w('bin.plist', Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xff, 0xfe, 0, 1])]));
    w('nul.md', 'a\0b\n');
    assert.deepEqual([planOf(dir).files.length, planOf(dir).excluded.binary], [0, 3]);
  } finally {
    clean(dir);
  }
});

test('Secret の形と名前の抜けを塞ぐ', () => {
  const dir = tmp();
  try {
    const w = put(dir);
    const shapes = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', `sk-proj-${'a'.repeat(30)}`, `sk-or-v1-${'a'.repeat(30)}`, `xai-${'a'.repeat(30)}`, `AIza${'a'.repeat(35)}`, `https://hooks.slack.com/services/${'A'.repeat(30)}`, `eyJhbGciOiJI.${'b'.repeat(20)}.${'c'.repeat(20)}`, `HEARTBEAT_TOKEN=${'a'.repeat(64)}`, `{"api_key":"${'a'.repeat(24)}"}`, `password: ${'a'.repeat(20)}`];
    shapes.forEach((v, i) => w(`s${i}.md`, `${v}\n`));
    w('mention2.md', 'Trading  Lab の話\n');
    w('mention3.md', 'トレーディングラボ\n');
    for (const n of ['id_rsa.txt', 'x.pem.md', 'credentials.json', 'token.txt', 'trading_lab_notes.md', 'Trading Lab.md', 'trading.lab.md']) w(n, 'x\n');
    w('mention.md', 'Trading Lab の話\n');
    w('ok.md', 'token の話だけ\n');
    assert.deepEqual(planOf(dir).files.map((f) => f.rel), ['ok.md']);
  } finally {
    clean(dir);
  }
});

test('検査の後の差し替えは入らない：検査した本文を持つ・symlink に変えられたファイルは開かない', async () => {
  const dir = tmp();
  const home = tmp();
  try {
    const w = put(dir);
    w('a.md', 'clean\n');
    const p = planOf(dir);
    writeFileSync(path.join(dir, 'a.md'), `ghp_${'A'.repeat(36)}\n`);
    const archive = buildArchive({ files: p.files, passphrase: PASS, tmpRoot: workRoot(home) });
    assert.equal(Buffer.from(unpack(archive, PASS)[0].data, 'base64').toString(), 'clean\n');
  } finally {
    clean(dir, home);
  }
});

test('平文の写しの置き場：0700・古い残骸だけ消す（別の process の回を消さない）・復元の件数が足りなければ成功にしない', () => {
  const home = tmp();
  try {
    const dir = workRoot(home);
    writeFileSync(path.join(dir, 'running'), 'x');
    workRoot(home);
    assert.ok(existsSync(path.join(dir, 'running')), '動いている回の写しを消さない');
    workRoot(home, Date.now() + 2 * 3_600_000);
    assert.ok(!existsSync(path.join(dir, 'running')), '強制終了の残骸は消す');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const same = { id: 's', rel: 'x.md', body: Buffer.from('x'), bytes: 1 };
    assert.throws(() => buildArchive({ files: [same, same], passphrase: PASS, tmpRoot: dir }), /local_restore_mismatch/, '同じパスの 2 件は 1 件に潰れる');
  } finally {
    clean(home);
  }
});

test('host-health の記録は新しい 2 か月だけ（古い月で容量の上限に近づかない）', () => {
  const dir = tmp();
  try {
    const w = put(dir);
    for (const m of ['2026-09', '2026-10', '2026-11']) w(`${m}.jsonl`, '{}\n');
    w('state.json', '{}\n');
    const work = tmp();
    const p = planBackup({ sources: [{ id: 's', dir, recentMonths: 2 }], denyText: DENY, tmpRoot: work });
    clean(work);
    assert.deepEqual(p.files.map((f) => f.rel), ['2026-10.jsonl', '2026-11.jsonl', 'state.json']);
    assert.equal(p.excluded.old_records, 1);
  } finally {
    clean(dir);
  }
});

test('名前の判定：行頭のパターンが名前にも効く・数字のパターンが添字にあたらない・改行入りの名前は落とす', () => {
  const dir = tmp();
  try {
    const w = put(dir);
    w('acct-note.md', 'x\n');
    w('b.md', 'x\n');
    w('c\nd.md', 'x\n');
    const denyText = '^acct\nzz1\nzz2\nzz3\n[0-9]{1}zz\n';
    assert.deepEqual(planOf(dir, { denyText }).files.map((f) => f.rel), ['b.md']);
  } finally {
    clean(dir);
  }
});

test('Secret の判定は長い入力でも時間が延びない', () => {
  const dir = tmp();
  try {
    put(dir)('a.md', `${'a-'.repeat(64 * 1024)}\n`);
    const t = Date.now();
    planOf(dir);
    assert.ok(Date.now() - t < 5000);
  } finally {
    clean(dir);
  }
});

test('世代：今送ったものは時計が戻っても消さない', () => {
  const names = Array.from({ length: 40 }, (_, i) => `${new Date(Date.UTC(2030, i, 1)).toISOString().slice(0, 10)}T0440Z.edlbk`);
  const current = '2026-11-05T0440Z.edlbk';
  assert.ok(!retentionPlan([...names, current], { keep: current }).includes(current));
});

test('deny のファイル：無いのと同じ（少なすぎる・空）は止まる・grep が読めない行も止まる', () => {
  assert.throws(() => denyLines('# only comment\n'), /too few/);
  assert.throws(() => denyLines('harmless\n'), /too few/);
  assert.throws(() => denyLines('a\r\nb\r\nc\r\nd\r\ne\r\n'), /CR/, 'CRLF は黙って効かなくなる');
  const dir = tmp();
  try {
    put(dir)('a.md', 'x\n');
    assert.throws(() => planOf(dir, { denyText: '(unclosed\nb\nc\nd\ne\n' }), /deny check failed/);
  } finally {
    clean(dir);
  }
});

test('対象の一覧：Keychain・Hermes の home・Vault の写し・REA・sent を含まない。Hermes の bundle は再生成として外す', () => {
  const s = backupSources({ base: '/b/rt', home: '/h', repoRoot: '/b/rt/dl' });
  const dirs = s.map((x) => x.dir).join('\n');
  assert.ok(!/Keychains|e-nexus-hermes|\/tools|\/sent|parallels|trading/i.test(dirs));
  assert.ok(s.find((x) => x.id === 'mac_runtime_state').exclude.test('hermes/bundle-2026-11-04/run.sh'));
  assert.equal(s.find((x) => x.id === 'runtime_notes').topLevelOnly, true, 'repo の中へ降りない');
});

test('鍵の控えの確認：打ち直しが違えば記録しない・passphrase を残さない・変えれば無効', () => {
  const home = tmp();
  try {
    assert.equal(attestKey({ home, typed: 'x', stored: PASS, at: 'a' }), false);
    assert.equal(attestKey({ home, typed: PASS, stored: null, at: 'a' }), false);
    assert.equal(keyAttested({ home, passphrase: PASS }), false);
    assert.equal(attestKey({ home, typed: PASS, stored: PASS, at: 'a' }), true);
    assert.ok(!readFileSync(path.join(home, '.enexus', 'backup', 'key-offsite.json'), 'utf8').includes(PASS));
    assert.equal(statSync(path.join(home, '.enexus', 'backup', 'key-offsite.json')).mode & 0o777, 0o600);
    assert.equal(keyAttested({ home, passphrase: PASS }), true);
    assert.equal(keyAttested({ home, passphrase: `${PASS}x` }), false);
  } finally {
    clean(home);
  }
});

test('引数：送る命令は owner・repo・deny-file が要る。接続の道具は端末でなければ何もしない', () => {
  assert.deepEqual(validate({ command: 'run', owner: 'o', repo: 'r', denyFile: '/x' }), []);
  assert.ok(validate({ command: 'run', owner: 'o', repo: 'r' }).length);
  assert.ok(validate({ command: 'run', denyFile: '/x' }).length);
  assert.ok(validate({ command: 'nope' }).length);
  assert.ok(validate({ command: 'restore', archive: 'a' }).length);
  const file = new URL('../deploy/macos/connect-backup.sh', import.meta.url);
  assert.equal(spawnSync('bash', ['-n', file.pathname], { timeout: 10_000 }).status, 0);
  const deny = path.join(tmp(), 'deny');
  writeFileSync(deny, 'x\n');
  assert.equal(spawnSync('bash', [file.pathname, 'o', 'r', deny], { input: '', timeout: 10_000, encoding: 'utf8' }).status, 2, '端末でなければ Keychain に触れない');
  assert.equal(spawnSync('bash', [file.pathname], { input: '', timeout: 10_000, encoding: 'utf8' }).status, 2);
  clean(path.dirname(deny));
});

test('job の定義：runtime-backup は owner・repo・deny-file を持ち、Secret を持たない・定義の生成だけでは登録しない', () => {
  const a = { job: 'runtime-backup', target: 'launchd', dir: '/d', node: '/opt/homebrew/bin/node', hour: 4, minute: 40, owner: 'o', repo: 'r', denyFile: '/x/deny.txt' };
  assert.deepEqual(validateJobArgs(a), []);
  assert.ok(validateJobArgs({ ...a, repo: undefined }).length);
  assert.ok(validateJobArgs({ ...a, target: 'systemd', environment: 'dev', user: 'u' }).length);
  const c = renderJob(a).content;
  assert.match(c, /<string>scripts\/backup-run\.mjs<\/string>\s*<string>run<\/string>/);
  assert.match(c, /<key>Hour<\/key><integer>4<\/integer><key>Minute<\/key><integer>40<\/integer>/);
  assert.ok(!/passphrase|token/i.test(c));
});

// ─── 保存済みの検証（2026-11-05・Batch A／C）───

const VDENY = 'zzdeny1\nzzdeny2\nzzdeny3\nzzdeny4\nzzdeny5\n';

test('保存済みの検証：復号・hash・改ざんと鍵の誤りの拒否・除外の方針。結果は件数だけで平文を返さない', () => {
  const dir = tree();
  const root = tmp();
  try {
    const archive = pack(dir, PASS);
    const scan = (rows) => policyViolations(rows, VDENY, root);
    const r = verifyArchive({ bytes: archive, passphrase: PASS, scan });
    assert.deepEqual(r, { files: 2, bytes: archive.length });
    const names = [];
    verifyArchive({ bytes: archive, passphrase: PASS, scan: (rows) => { names.push(...rows.map((x) => x.rel)); return 0; } });
    assert.deepEqual(names.sort(), ['x.md', 'y.bin'], '名前は先頭の対象の id を除いて見る');
    assert.ok(!JSON.stringify(r).includes('secret-note'));
    assert.throws(() => verifyArchive({ bytes: archive, passphrase: 'other-passphrase-0123456789', scan }));
    const flipped = Buffer.from(archive);
    flipped[flipped.length - 3] ^= 1;
    assert.throws(() => verifyArchive({ bytes: flipped, passphrase: PASS, scan }));
  } finally {
    clean(dir, root);
  }
});

test('除外の方針：Trading Lab の言及・Secret の形・deny にあたる本文は違反に数える。名前も見る', () => {
  const root = tmp();
  try {
    const row = (rel, text) => ({ rel, body: Buffer.from(text) });
    assert.equal(policyViolations([row('a.md', 'ok')], VDENY, root), 0);
    assert.equal(policyViolations([row('a.md', 'see trading lab')], VDENY, root), 1);
    assert.equal(policyViolations([row('a.md', 'ghp_' + 'a'.repeat(36))], VDENY, root), 1);
    assert.equal(policyViolations([row('a.md', 'has zzdeny3 inside')], VDENY, root), 1);
    assert.equal(policyViolations([row('parallels.md', 'ok')], VDENY, root), 1);
  } finally {
    clean(root);
  }
});

test('定期の回：token の期限を受領票に残す。古い世代の検証は 30 日に 1 回で、失敗しても今回の回は成功のまま', async () => {
  const { home, src, base } = setup();
  const root = tmp();
  try {
    const files = new Map();
    const scan = (_tmp, rows) => policyViolations(rows, VDENY, root);
    const calls = [];
    const first = await runBackup({ ...base, scan, fetchImpl: fakeRepo({ files, calls }) });
    assert.equal(first.history, 'verified');
    assert.equal(receiptOf(home).token_expires_at, '2027-02-03T08:39:03.000Z');
    assert.equal(receiptOf(home).history_verified_at, '2026-11-05T04:40:00.000Z');
    const next = await runBackup({ ...base, scan, now: () => new Date('2026-11-06T04:40:00.000Z'), fetchImpl: fakeRepo({ files }) });
    assert.equal(next.history, undefined, '30 日の間は検証しない');
    assert.equal(receiptOf(home).history_verified_at, '2026-11-05T04:40:00.000Z', '毎回の受領票に持ち越す');
    const later = new Date(Date.parse('2026-11-06T04:40:00.000Z') + VERIFY_EVERY_MS);
    const bad = await runBackup({ ...base, scan: () => 1, now: () => later, fetchImpl: fakeRepo({ files }) });
    assert.equal(bad.code, 0);
    assert.equal(bad.history, 'failed');
    assert.equal(receiptOf(home).history_failure, 'policy_violation');
    assert.equal(receiptOf(home).consecutive_failures, 0);
    const failed = await runBackup({ ...base, scan: () => 0, now: () => later, read: creds({ 'E-NEXUS/edl/backup-token': null }), fetchImpl: fakeRepo({ files }) });
    assert.equal(failed.status, 'failed');
    assert.equal(receiptOf(home).token_expires_at, '2027-02-03T08:39:03.000Z', '失敗の回も期限を残す');
    assert.equal(receiptOf(home).history_failure, 'policy_violation');
  } finally {
    clean(home, src, root);
  }
});

test('初回の前の verify：受領票を作らない。期限 header の無い token へ替えたら古い期限を残さない', async () => {
  const { home, src, base } = setup();
  try {
    const none = await verifyBackups({ ...base, scan: () => 0, read: async () => null, fetchImpl: fakeRepo({}) });
    assert.equal(none.status, 'failed');
    assert.equal(existsSync(path.join(home, '.enexus', 'backup', 'last.json')), false);
    const files = new Map();
    await runBackup({ ...base, fetchImpl: fakeRepo({ files }) });
    assert.ok(receiptOf(home).token_expires_at);
    const plain = fakeRepo({ files });
    const noHeader = async (u, o) => ({ ...(await plain(u, o)), headers: { get: () => null } });
    await runBackup({ ...base, now: () => new Date('2026-11-06T04:40:00.000Z'), fetchImpl: noHeader });
    assert.equal(receiptOf(home).token_expires_at, null);
  } finally {
    clean(home, src);
  }
});

test('verify：送らない（PUT・DELETE なし）・読み直しが一覧の sha と違えば失敗・最新と最古を見る', async () => {
  const { home, src, base } = setup();
  try {
    const files = new Map();
    await runBackup({ ...base, fetchImpl: fakeRepo({ files }) });
    await runBackup({ ...base, now: () => new Date('2026-11-06T04:40:00.000Z'), fetchImpl: fakeRepo({ files }) });
    const calls = [];
    const v = await verifyBackups({ ...base, scan: () => 0, fetchImpl: fakeRepo({ files, calls }) });
    assert.equal(v.status, 'verified');
    assert.deepEqual(v.rows.map((x) => x.archive), ['2026-11-06T0440Z.edlbk', '2026-11-05T0440Z.edlbk']);
    assert.ok(calls.every(([m]) => m === 'GET'));
    const t = await verifyBackups({ ...base, scan: () => 0, fetchImpl: fakeRepo({ files, tamper: true }) });
    assert.deepEqual([t.status, t.failure], ['failed', 'read_back_mismatch']);
    assert.equal(receiptOf(home).history_failure, 'read_back_mismatch');
    const again = await verifyBackups({ ...base, scan: () => 0, fetchImpl: fakeRepo({ files }) });
    assert.equal(again.status, 'verified');
    assert.equal(receiptOf(home).history_failure, null, '直れば消える');
    const before = readFileSync(path.join(home, '.enexus', 'backup', 'last.json'), 'utf8');
    const noKey = await verifyBackups({ ...base, scan: () => 0, read: async () => null, fetchImpl: fakeRepo({ files }) });
    assert.equal(noKey.failure, 'no_passphrase');
    const scanBroken = await verifyBackups({ ...base, scan: () => { throw new Error('deny'); }, fetchImpl: fakeRepo({ files }) });
    assert.equal(scanBroken.failure, 'policy_scan_failed');
    assert.equal(readFileSync(path.join(home, '.enexus', 'backup', 'last.json'), 'utf8').includes('history_failure": null'), true);
    assert.equal(JSON.parse(before).history_failure, null);
    assert.equal(receiptOf(home).history_failure, null, '手元の問題で受領票を異常にしない');
  } finally {
    clean(home, src);
  }
});

test('送る条件：公開の repo へ書ける token は通さない。確かめの要求は不正な ref で、何も作らない', async () => {
  const { home, src, base } = setup();
  try {
    const calls = [];
    const pub = { private: false };
    assert.equal((await runBackup({ ...base, fetchImpl: fakeRepo({ other: 200, otherJson: pub, calls }) })).code, 0);
    const probe = calls.find(([m, p]) => m === 'POST');
    assert.equal(probe[1], '/repos/o/private-other/git/refs');
    assert.deepEqual(JSON.parse(probe[2]), { ref: 'invalid', sha: '0'.repeat(40) });
    const r = await runBackup({ ...base, fetchImpl: fakeRepo({ other: 200, otherJson: pub, refProbe: 422 }) });
    assert.deepEqual([r.code, r.failure], [3, 'token_too_broad']);
    const down = await runBackup({ ...base, fetchImpl: fakeRepo({ other: 200, otherJson: pub, refProbe: 502 }) });
    assert.equal(down.failure, 'scope_unverified');
  } finally {
    clean(home, src);
  }
});

test('送る条件：レート制限の 403・429 は「書けない」の証拠に数えない（確かめられなければ送らない）', async () => {
  const { home, src, base } = setup();
  try {
    const pub = { private: false };
    for (const [refProbe, probeHeaders] of [[403, { 'x-ratelimit-remaining': '0' }], [403, { 'retry-after': '60' }], [429, {}]]) {
      const r = await runBackup({ ...base, fetchImpl: fakeRepo({ other: 200, otherJson: pub, refProbe, probeHeaders }) });
      assert.deepEqual([r.code, r.failure], [3, 'scope_unverified']);
    }
    assert.equal((await runBackup({ ...base, fetchImpl: fakeRepo({ other: 200, otherJson: pub, refProbe: 403, probeHeaders: { 'x-ratelimit-remaining': '4999' } }) })).code, 0, '権限の 403 は通す');
  } finally {
    clean(home, src);
  }
});

test('verify は送らないので、公開の repo へ書き込みの要求を出さない（run は毎回確かめる）', async () => {
  const { home, src, base } = setup();
  try {
    const files = new Map();
    const pub = { private: false };
    assert.equal((await runBackup({ ...base, fetchImpl: fakeRepo({ files, other: 200, otherJson: pub }) })).code, 0);
    const calls = [];
    assert.equal((await verifyBackups({ ...base, scan: () => 0, fetchImpl: fakeRepo({ files, other: 200, otherJson: pub, calls }) })).status, 'verified');
    assert.deepEqual(calls.filter(([m]) => m !== 'GET'), [], 'verify の要求は全部 GET');
    assert.equal(calls.some(([, p]) => p.endsWith('/git/refs')), false);
  } finally {
    clean(home, src);
  }
});

test('平文の残骸の掃除は条件より先：条件が落ち続ける間も消える', async () => {
  const { home, src, base } = setup();
  try {
    const work = workRoot(home);
    const old = path.join(work, 'run-old');
    mkdirSync(old);
    utimesSync(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const r = await runBackup({ ...base, read: async () => null, fetchImpl: fakeRepo({}) });
    assert.equal(r.failure, 'no_passphrase');
    assert.equal(existsSync(old), false);
  } finally {
    clean(home, src);
  }
});

test('除外の抜けを塞ぐ：全角コロン・Bearer・--token・passphrase の名前・全角と濁点の分かれた語', () => {
  const root = tmp();
  try {
    const row = (rel, text) => ({ rel, body: Buffer.from(text) });
    for (const r of [row('a.md', `token：${'a'.repeat(32)}`), row('a.md', `Authorization: Bearer ${'a'.repeat(32)}`), row('a.md', `--token ${'a'.repeat(32)}`), row('a.md', `passphrase = ${'a'.repeat(32)}`), row('backup-passphrase.txt', 'x'), row('a.md', 'ＴＲＡＤＩＮＧ　ＬＡＢ'), row('a.md', 'トレーディングラボ'.normalize('NFD'))]) {
      assert.equal(policyViolations([r], VDENY, root), 1, r.rel);
    }
  } finally {
    clean(root);
  }
});
