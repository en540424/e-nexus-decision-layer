/**
 * Task Hub の file の読み方（2026-11-09・MA-24）。lstat の後に読む形は、確かめと開くの間に FIFO・symlink へ差し替えられると止まる／外を読む。
 * 開く時に O_NOFOLLOW（最後の要素が symlink なら ELOOP）＋ O_NONBLOCK（FIFO の open で待たない）、開いた fd を fstat して通常ファイルで上限以下の時だけ読む。
 * 依存なし・通信なし。runtime-ops の taskHubCounts もこれを使う（store の外から読む側）。
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

const badFile = () => Object.assign(new Error('bad_file'), { code: 'bad_file' });
/** 通常ファイルだけ開く fd を返す（呼ぶ側が close する）。形の悪い file（symlink・FIFO などの通常でないもの）は code = 'bad_file' の error。ほかの失敗（ENOENT・EACCES）はそのまま投げる */
export function openPlain(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    throw e?.code === 'ELOOP' || e?.code === 'ENXIO' ? badFile() : e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw badFile();
  } catch (e) { closeSync(fd); throw e; }
  return fd;
}

/** 通常ファイルで maxBytes 以下の時だけ文字列で読む。上限超えも bad_file */
export function readSmallFile(file, maxBytes = 1_048_576) {
  const fd = openPlain(file);
  try {
    if (fstatSync(fd).size > maxBytes) throw badFile();
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** JSON として読む。読めない・形が悪い・大きすぎる＝null */
export function readJsonSafe(file, maxBytes = 1_048_576) {
  try { return JSON.parse(readSmallFile(file, maxBytes)); } catch { return null; }
}
