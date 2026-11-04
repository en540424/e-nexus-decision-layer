#!/usr/bin/env node
/**
 * バックアップの復元の予行（2026-11-04・Mac Runtime）。**合成データだけ**で、暗号化→改ざん検知→passphrase 誤り→復元→一致確認を通す。
 * 実データの入力口を持たない（保存先と鍵の決定は Human）。一時フォルダの中だけで動き、外へ送らず、終わったら消す。
 *
 *   node scripts/backup-drill.mjs [--json]
 *
 * exit：0＝全部通った／1＝どれかが失敗
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestOf, pack, restore, unpack } from './lib/backup-archive.mjs';

function makeSyntheticTree(dir) {
  mkdirSync(path.join(dir, 'notes', '日本語'), { recursive: true });
  mkdirSync(path.join(dir, 'state', 'empty-sibling'), { recursive: true });
  writeFileSync(path.join(dir, 'notes', 'a.md'), '# synthetic note\n');
  writeFileSync(path.join(dir, 'notes', '日本語', 'メモ.md'), '合成データ\n');
  writeFileSync(path.join(dir, 'state', 'state.json'), '{"synthetic":true}\n');
  writeFileSync(path.join(dir, 'state', 'blob.bin'), randomBytes(64 * 1024));
  chmodSync(path.join(dir, 'state', 'state.json'), 0o600);
}

const rejects = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

export function runDrill() {
  const root = mkdtempSync(path.join(tmpdir(), 'edl-backup-drill-'));
  try {
    const src = path.join(root, 'src');
    const dst = path.join(root, 'dst');
    mkdirSync(src);
    makeSyntheticTree(src);
    const passphrase = randomBytes(24).toString('base64');
    const archive = pack(src, passphrase);
    const flipped = Buffer.from(archive);
    flipped[flipped.length >> 1] ^= 1;
    const restored = restore(archive, passphrase, dst);
    const before = JSON.stringify(manifestOf(src));
    const checks = {
      plaintext_not_in_archive: !archive.includes('synthetic'),
      tamper_rejected: rejects(() => unpack(flipped, passphrase)),
      wrong_passphrase_rejected: rejects(() => unpack(archive, `${passphrase}x`)),
      restored_matches: before === JSON.stringify(manifestOf(dst)),
      nonempty_target_refused: rejects(() => restore(archive, passphrase, dst)),
    };
    return { component: 'edl-backup-drill', data: 'synthetic', files: restored, archive_bytes: archive.length, checks, ok: Object.values(checks).every(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = runDrill();
  console.log(JSON.stringify(r, null, process.argv.includes('--json') ? 2 : 0));
  process.exitCode = r.ok ? 0 : 1;
}
