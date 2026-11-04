/**
 * バックアップの道具（2026-11-04・Mac Runtime）。暗号化・改ざん検知・復元の一致・合成データだけの予行・棚卸しの範囲。外へ送らない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAGIC, manifestOf, pack, restore, unpack } from '../scripts/lib/backup-archive.mjs';
import { runDrill } from '../scripts/backup-drill.mjs';
import { catalog, inventory } from '../scripts/backup-inventory.mjs';

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
    const body = Buffer.concat([c.update(JSON.stringify({ files })), c.final()]);
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
