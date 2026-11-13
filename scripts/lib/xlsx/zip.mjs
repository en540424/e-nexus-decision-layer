/**
 * xlsx（zip）を読み書きする最小の部品（2026-11-13・依存なし）。変えない部品は**圧縮された bytes をそのまま写す**＝マクロ・画像・印影・書式・印刷設定・
 * 外部リンク・Human の tab は 1 byte も変わらない。zip64・暗号化・分割は扱わない（xlsx_zip_unsupported で止める＝上書きしない）。
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export class XlsxError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** zip を entries（順番どおり）にする。entry：{ name, method, crc, compSize, size, flags, time, date, extAttr, intAttr, madeBy, raw } */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new XlsxError('xlsx_not_zip');
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  if (e < 0) throw new XlsxError('xlsx_not_zip');
  const total = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOff = buf.readUInt32LE(e + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff || buf.readUInt16LE(e + 4) !== 0) throw new XlsxError('xlsx_zip_unsupported');
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new XlsxError('xlsx_zip_corrupt');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const loc = buf.readUInt32LE(p + 42);
    if (flags & 0x1) throw new XlsxError('xlsx_encrypted');
    if (compSize === 0xffffffff || size === 0xffffffff || loc === 0xffffffff) throw new XlsxError('xlsx_zip_unsupported');
    if (![0, 8].includes(method)) throw new XlsxError('xlsx_zip_unsupported');
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (loc + 30 > buf.length || buf.readUInt32LE(loc) !== LOC) throw new XlsxError('xlsx_zip_corrupt');
    // 中央の目録と局所の見出しの名前が同じ（食い違う zip は読み手によって違う中身に見える・監査 nit 3）
    const lnl = buf.readUInt16LE(loc + 26);
    if (lnl !== nameLen || !buf.subarray(loc + 30, loc + 30 + lnl).equals(buf.subarray(p + 46, p + 46 + nameLen))) throw new XlsxError('xlsx_zip_corrupt');
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    if (start + compSize > buf.length) throw new XlsxError('xlsx_zip_corrupt');
    entries.push({ name, method, crc: buf.readUInt32LE(p + 16), compSize, size, flags: flags & ~0x8, time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14), intAttr: buf.readUInt16LE(p + 36), extAttr: buf.readUInt32LE(p + 38), madeBy: buf.readUInt16LE(p + 4), raw: buf.subarray(start, start + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== cdOff + cdSize || cdOff + cdSize > e) throw new XlsxError('xlsx_zip_corrupt'); // 目録の件数と大きさが合う
  if (new Set(entries.map((x) => x.name)).size !== entries.length) throw new XlsxError('xlsx_zip_corrupt');
  // 中身が重ならない（同じ bytes を 2 つの部品として見せる zip を拒否）
  const spans = entries.map((x) => [x.raw.byteOffset, x.raw.byteOffset + x.raw.length]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) if (spans[i][0] < spans[i - 1][1]) throw new XlsxError('xlsx_zip_corrupt');
  return entries;
}

/** 中身（展開して crc を確かめる） */
export function entryData(entry) {
  if (entry.size > 256 * 1024 * 1024) throw new XlsxError('xlsx_too_large'); // 展開の上限（zip bomb をこの host で開かない・監査 nit 2）
  let data;
  try { data = entry.method === 0 ? Buffer.from(entry.raw) : inflateRawSync(entry.raw, { maxOutputLength: Math.max(entry.size, 1) }); } catch { throw new XlsxError('xlsx_zip_corrupt'); }
  if (data.length !== entry.size || (crc32(data) >>> 0) !== entry.crc) throw new XlsxError('xlsx_zip_corrupt');
  return data;
}

/** 新しい中身の entry（deflate）。time・date は元の entry があれば引き継ぐ */
export function makeEntry(name, data, like = null) {
  const raw = deflateRawSync(data);
  return { name, method: 8, crc: crc32(data) >>> 0, compSize: raw.length, size: data.length, flags: 0x800, time: like?.time ?? 0, date: like?.date ?? 0x21, intAttr: 0, extAttr: like?.extAttr ?? 0, madeBy: like?.madeBy ?? 20, raw };
}

/** entries を zip にする（データ記述子なし・中身の bytes は entry.raw をそのまま） */
export function writeZip(entries) {
  const parts = [];
  const cen = [];
  let off = 0;
  for (const x of entries) {
    const name = Buffer.from(x.name, 'utf8');
    const flags = (x.flags & ~0x8) | (/[^\x20-\x7e]/.test(x.name) ? 0x800 : 0);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(LOC, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(x.method, 8); h.writeUInt16LE(x.time, 10); h.writeUInt16LE(x.date, 12);
    h.writeUInt32LE(x.crc, 14); h.writeUInt32LE(x.compSize, 18); h.writeUInt32LE(x.size, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, x.raw);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CEN, 0); c.writeUInt16LE(x.madeBy, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(x.method, 10); c.writeUInt16LE(x.time, 12); c.writeUInt16LE(x.date, 14);
    c.writeUInt32LE(x.crc, 16); c.writeUInt32LE(x.compSize, 20); c.writeUInt32LE(x.size, 24); c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34); c.writeUInt16LE(x.intAttr, 36); c.writeUInt32LE(x.extAttr, 38); c.writeUInt32LE(off, 42);
    cen.push(c, name);
    off += 30 + name.length + x.raw.length;
  }
  const cdSize = cen.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(off, 16);
  if (entries.length > 0xfffe || off > 0xfffffff0) throw new XlsxError('xlsx_zip_unsupported');
  return Buffer.concat([...parts, ...cen, end]);
}
