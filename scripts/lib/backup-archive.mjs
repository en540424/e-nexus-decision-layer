/**
 * バックアップの暗号化アーカイブ（2026-11-04・Mac Runtime）。依存なし（node:crypto）。保存先は持たない（どこへ置くかは Human の決定）。
 *
 * 形式：MAGIC＋salt 16＋iv 12＋AES-256-GCM の暗号文＋tag 16。平文は gzip した JSON（files：相対パス・mode・sha256・base64）。鍵は passphrase から scrypt で作る。
 * 改ざん・passphrase の誤りは復号で失敗する。全部をメモリに載せるので MAX_BYTES まで（Mac Runtime の控えの大きさ。大きいものは git か再生成で守る）。
 * 復元は全項目を確かめてから書く（途中まで書いて止まらない）。相対パスだけ・空でない先へは書かない・同じパスを 2 回書かない。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const MAGIC = Buffer.from('EDLBK2\n');
export const MAX_BYTES = 256 * 1024 ** 2;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 ** 2 };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const keyOf = (passphrase, salt) => scryptSync(passphrase, salt, 32, SCRYPT);

/** dir の下の通常ファイルだけ。symlink はたどらない */
export function manifestOf(dir) {
  const rows = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const body = readFileSync(p);
        rows.push({ path: path.relative(dir, p), mode: lstatSync(p).mode & 0o777, bytes: body.length, sha256: sha256(body) });
      }
    }
  };
  walk(dir);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export function pack(dir, passphrase) {
  if (!passphrase) throw new Error('passphrase required');
  const manifest = manifestOf(dir);
  if (manifest.reduce((n, f) => n + f.bytes, 0) > MAX_BYTES) throw new Error('too large for this archive');
  const files = manifest.map((f) => ({ ...f, data: readFileSync(path.join(dir, f.path)).toString('base64') }));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify({ files }))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]);
}

export function unpack(archive, passphrase) {
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a backup archive');
  const salt = archive.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = archive.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
  decipher.setAuthTag(archive.subarray(archive.length - 16));
  const body = archive.subarray(MAGIC.length + 28, archive.length - 16);
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(body), decipher.final()])).toString('utf8')).files; // 改ざん・passphrase の誤りは final で投げる
}

export function restore(archive, passphrase, targetDir) {
  if (existsSync(targetDir) && readdirSync(targetDir).length) throw new Error('restore target must be empty');
  const files = unpack(archive, passphrase).map((f) => {
    const p = path.resolve(targetDir, f.path);
    if (path.isAbsolute(f.path) || !p.startsWith(`${path.resolve(targetDir)}${path.sep}`)) throw new Error('path escapes the restore target');
    const body = Buffer.from(f.data, 'base64');
    if (sha256(body) !== f.sha256) throw new Error('file hash mismatch');
    return { p, body, mode: f.mode };
  });
  for (const f of files) {
    mkdirSync(path.dirname(f.p), { recursive: true, mode: 0o700 });
    writeFileSync(f.p, f.body, { mode: f.mode, flag: 'wx' });
  }
  return files.length;
}
