/**
 * Dropbox の content_hash（公式の定義）：中身を 4 MiB の塊に分け、塊ごとの SHA-256 を連結して、もう一度 SHA-256（hex）。
 * 取った file・上げた file が Dropbox の版と同じかを確かめる（途中で切れた・壊れた file を「保存した」と言わない）
 */
import { createHash } from 'node:crypto';

const BLOCK = 4 * 1024 * 1024;

export function contentHash(buf) {
  const outer = createHash('sha256');
  for (let i = 0; i < buf.length; i += BLOCK) outer.update(createHash('sha256').update(buf.subarray(i, i + BLOCK)).digest());
  return outer.digest('hex');
}
