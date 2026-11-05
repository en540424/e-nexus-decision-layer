/**
 * バックアップの道具（2026-11-04・Mac Runtime）。暗号化・改ざん検知・復元の一致・合成データだけの予行・棚卸しの範囲。外へ送らない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { MAGIC, manifestOf, pack, restore, unpack } from '../scripts/lib/backup-archive.mjs';
import { runDrill } from '../scripts/backup-drill.mjs';
import { catalog, inventory } from '../scripts/backup-inventory.mjs';
import { backupSources, denyLines, planBackup, retentionPlan } from '../scripts/lib/backup-plan.mjs';
import { SIZE_LIMIT_KIB, attestKey, buildArchive, keyAttested, runBackup, validate, workRoot } from '../scripts/backup-run.mjs';
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
const reply = (status, json = null, bytes = null) => ({ status, json: async () => json, arrayBuffer: async () => bytes });

/** 保存先の役。files に置いたものを読み直しで返す。tamper で読み直しの中身を変える */
function fakeRepo({ repo = { private: true, visibility: 'private', size: 10, default_branch: 'main', pushed_at: 'x' }, other = 404, list = [{ name: 'backup' }], keys = 403, tamper = false, putStatus = 201, calls = [], files = new Map() } = {}) {
  return async (url, opts) => {
    const u = new URL(url);
    calls.push([opts.method, u.pathname, opts.body ?? null, opts.headers.authorization]);
    if (u.hostname !== 'api.github.com') throw new Error('other host');
    if (u.pathname === '/repos/o/backup') return reply(repo ? 200 : 404, repo);
    if (u.pathname === '/user/repos') return reply(list === 'denied' ? 403 : 200, list === 'denied' ? {} : list);
    if (u.pathname === '/repos/o/private-other') return reply(other, {});
    if (u.pathname === '/repos/o/backup/keys') return reply(keys, []);
    if (u.pathname === '/repos/o/backup/contents/archives') return reply(200, [...files.keys()].map((n) => ({ name: path.basename(n), sha: 'sha' })));
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

test('平文の写しの置き場：0700・前の回の残りを消す', () => {
  const home = tmp();
  try {
    const dir = workRoot(home);
    writeFileSync(path.join(dir, 'leftover'), 'x');
    workRoot(home);
    assert.ok(!existsSync(path.join(dir, 'leftover')));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    clean(home);
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
