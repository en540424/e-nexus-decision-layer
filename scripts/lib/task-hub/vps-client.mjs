/**
 * Task Hub の Mac 側の通信（2026-11-09・MA-24）。outbound だけ（Mac は待ち受けない）。VPS の受け口（deploy/vps-task-intake/intake.mjs）の /pull・/ack・/status を呼ぶ。依存なし。
 *
 *   pull    : 依頼の封を取りに行く（削除はしない）。channel を渡すと、署名と形が合わない封は捨てて数える（VPS を信用しきらない）
 *   writeInbox : 取れた封を <nonce>.json で inbox へ置く（0600・既にあれば上書きしない）。取り込みは別の component（store）の仕事
 *   ack     : inbox へ置けた封だけを VPS から消す
 *   pushStatuses : outbox の結果（store が書く）に署名して VPS の板へ返す。届いた物は sentDir へ移し、届かなかった物は outbox に残す
 *
 * baseUrl は https://（試験の loopback http://127.0.0.1 だけ例外）・path なし。redirect に従わない・15 秒で切る。鍵・本文・応答の中身はログにも例外にも出さない（コードだけ）。
 * 要求の署名は channel の鍵の HMAC-SHA256。時刻は ms で、同じ endpoint では前より大きくする（VPS が再送を拒む）。呼び出し側の now が進まない時は自分で +1 する。
 */
import { createHash, createHmac } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { readSmallFile } from './safe-read.mjs';
import { NONCE_RE, RECORD_MAX_AGE_MS, openRecord, sealStatus, shapeError } from './wire.mjs';

const DISCARD_CODES = /^(?:bad_signature|too_old|shape_(?!version$)[a-z_]+)$/; // 版の違い（shape_version）は消さない＝VPS と Mac の更新がずれた間に依頼を失わない
export const CLIENT_LIMITS = Object.freeze({ timeout_ms: 15_000, status_batch: 20, status_batch_bytes: 256 * 1024, ack_batch: 200, response_bytes: 4 * 1024 * 1024, outbox_file_bytes: 64 * 1024, record_max_age_ms: RECORD_MAX_AGE_MS });

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** baseUrl を検査して origin を返す（https のみ・loopback の http は試験用）。違えば null */
export function normalizeBase(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return null; }
  const loopback = u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !loopback) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return u.origin;
}

const keyOk = (key) => Buffer.isBuffer(key) && key.length >= 32;
export const keyFromHex = (hex) => (typeof hex === 'string' && /^(?:[0-9a-f]{2}){32,}$/i.test(hex.trim()) ? Buffer.from(hex.trim(), 'hex') : null);

/** 1 回の要求。{ ok, status, json } か { ok:false, code }。code は network／http_<status>／bad_response／bad_config */
async function call({ baseUrl, key, fetchImpl = globalThis.fetch, now = Date.now, ts: tsIn, timeoutMs = CLIENT_LIMITS.timeout_ms }, { method, route, label, tail, body }) {
  const origin = normalizeBase(baseUrl);
  if (!origin || !keyOk(key)) return { ok: false, code: 'bad_config' };
  const ts = tsIn ?? now();
  const text = body === undefined ? undefined : JSON.stringify(body);
  const sig = createHmac('sha256', key).update(`${label}\n${ts}\n${tail ?? sha256hex(text)}`).digest('hex');
  const headers = { 'x-edl-ts': String(ts), 'x-edl-sig': sig, ...(text === undefined ? {} : { 'content-type': 'application/json' }) };
  let res;
  try {
    res = await fetchImpl(`${origin}${route}`, { method, headers, body: text, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, code: 'network' };
  }
  if (res.status !== 200) return { ok: false, code: `http_${res.status}` };
  try {
    const raw = await res.text();
    if (raw.length > CLIENT_LIMITS.response_bytes) return { ok: false, code: 'bad_response' };
    return { ok: true, status: 200, json: JSON.parse(raw) };
  } catch {
    return { ok: false, code: 'bad_response' };
  }
}

/** VPS の queue の上限（intake.mjs の LIMITS.queue_total）。offset はこれ以下 */
export const PULL_OFFSET_MAX = 500;

/**
 * 取りに行く。{ ok, records, invalid, kept_count, received } か { ok:false, code }。records は channel を渡した時は検査済みの物だけ。
 * offset：queue の先頭から読み飛ばす件数（残してある封＝kept が先頭を塞ぎ、後ろの有効な封が見えなくなるのを避ける）。署名の対象に含める。
 */
export async function pull({ baseUrl, key, fetchImpl, now = Date.now, max = 50, offset = 0, channel, timeoutMs }) {
  const n = Number.isInteger(max) && max >= 1 ? Math.min(max, 50) : 50;
  const off = Number.isInteger(offset) && offset >= 0 ? Math.min(offset, PULL_OFFSET_MAX) : 0;
  const query = `offset=${off}&max=${n}`;
  const r = await call({ baseUrl, key, fetchImpl, now, timeoutMs }, { method: 'GET', route: `/pull?${query}`, label: 'edl-pull-v1', tail: `GET /pull?${query}` });
  if (!r.ok) return r;
  if (!Array.isArray(r.json?.records)) return { ok: false, code: 'bad_response' };
  const records = [];
  const invalid = [];
  let kept = 0;
  for (const rec of r.json.records.slice(0, 50)) {
    if (channel === undefined) {
      if (shapeError(rec) === null) records.push(rec); else invalid.push(rec?.nonce);
      continue;
    }
    const opened = openRecord(rec, { keyFor: (ch) => (ch === channel ? key : null), now: now(), maxAgeMs: CLIENT_LIMITS.record_max_age_ms });
    if (opened.ok) records.push(rec);
    else if (DISCARD_CODES.test(opened.code)) invalid.push(rec?.nonce); // 偽物・壊れた物・古すぎる物だけ消す
    else kept += 1; // 鍵の設定・時刻・版の違いは Mac 側の問題かもしれない＝消さずに VPS に残す（7 日で VPS が捨てる）
  }
  return { ok: true, records, invalid: invalid.filter((x) => typeof x === 'string' && NONCE_RE.test(x)), invalid_count: invalid.length, kept_count: kept, received: Math.min(r.json.records.length, 50) };
}

/** フォルダ自身を fsync する（link・rename の記録を disk へ）。fsync を拒む環境（EINVAL・EPERM・ENOTSUP）は何もしない扱いで true。本当の I/O エラーは false */
function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
    return true;
  } catch (e) {
    return ['EINVAL', 'EPERM', 'ENOTSUP', 'EBADF'].includes(e?.code);
  } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* 済 */ } } }
}

/**
 * 封を inbox へ <nonce>.json で置く。tmp に書いて link（既にあれば EEXIST＝置き済みとして数える）。
 * 戻り値：written（新しく置いた nonce）・existing（既にあった nonce）・failed（置けなかった数）。inbox の読み手は「.」で始まる名前を無視すること。
 */
export function writeInbox(records, inboxDir) {
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const written = [];
  const existing = [];
  let failed = 0;
  for (const rec of records) {
    if (shapeError(rec) !== null || typeof rec.sig !== 'string') { failed += 1; continue; }
    const final = path.join(inboxDir, `${rec.nonce}.json`);
    const tmp = path.join(inboxDir, `.${rec.nonce}.tmp`);
    try {
      try { unlinkSync(tmp); } catch { /* 残骸が無ければ何もしない */ }
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(rec)); fsyncSync(fd); } finally { closeSync(fd); } // ack で VPS から消す前に中身を disk へ
      try {
        linkSync(tmp, final);
        written.push(rec.nonce);
      } catch (err) {
        if (err?.code === 'EEXIST') existing.push(rec.nonce); else failed += 1;
      }
      unlinkSync(tmp);
    } catch {
      failed += 1;
    }
  }
  // link の記録を disk へ（ack で VPS から消す前に、置いた名前が電源断で消えないように）。できなければ ack させない（次の回は existing として扱われる）
  if (written.length && !fsyncDir(inboxDir)) { failed += written.length; written.length = 0; }
  return { written, existing, failed };
}

/** VPS から消す。{ ok, deleted } か { ok:false, code } */
export async function ack({ baseUrl, key, fetchImpl, now = Date.now, nonces, timeoutMs }) {
  let deleted = 0;
  let last = 0;
  for (let i = 0; i < nonces.length; i += CLIENT_LIMITS.ack_batch) {
    const ts = Math.max(now(), last + 1);
    last = ts;
    const r = await call({ baseUrl, key, fetchImpl, now, ts, timeoutMs }, { method: 'POST', route: '/ack', label: 'edl-ack-v1', body: { nonces: nonces.slice(i, i + CLIENT_LIMITS.ack_batch) } });
    if (!r.ok) return { ...r, deleted };
    deleted += Number.isInteger(r.json?.deleted) ? r.json.deleted : 0;
  }
  return { ok: true, deleted };
}

/** outbox の 1 ファイル → { file, parsed } か { file, invalid }。symlink・FIFO・大きすぎる file は読まない（safe-read.mjs） */
function readOutboxFile(dir, file) {
  try {
    const j = JSON.parse(readSmallFile(path.join(dir, file), CLIENT_LIMITS.outbox_file_bytes));
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return { file, invalid: 'shape' };
    return { file, parsed: j };
  } catch (e) {
    return { file, invalid: e?.code === 'bad_file' ? 'file' : 'unreadable' };
  }
}

/** VPS が「何度送っても通らない」と答える理由（transient の future・unknown_channel・通信の失敗は含めない＝outbox に残して送り直す） */
// 隔離するのは「何度送っても受からない」物だけ。unknown_source・bad_signature・unknown_field・shape_version・shape_state は VPS の設定や版の違いで起きうる＝outbox に残して次の回に送り直す（2026-11-09 再検証）
const PERMANENT_REJECT = /^(?:body_not_json|shape_(?!version$|state$)[a-z_]+)$/;

function moveToSent(outboxDir, sentDir, file) {
  mkdirSync(sentDir, { recursive: true, mode: 0o700 });
  let target = path.join(sentDir, file);
  for (let i = 1; existsSync(target); i += 1) target = path.join(sentDir, `${file}.${i}`);
  renameSync(path.join(outboxDir, file), target);
}
/** outbox の隣の outbox-rejected/（0700）。永久に拒まれる結果を毎回送り直さないために退避する（削除はしない＝Human が見られる） */
export const rejectedDirFor = (outboxDir) => path.join(path.dirname(path.resolve(outboxDir)), 'outbox-rejected');

/**
 * outbox の結果に署名して VPS へ返す。20 件（または 256KiB）ごとに 1 要求。
 * 戻り値：{ sent, kept, invalid, rejected:[{file, code}], quarantined, failed_batches, code? }。届かなかった物と一時的に拒まれた物は outbox に残る。永久に拒まれる物（unknown_source 等）は outbox-rejected/ へ移して quarantined に数える。
 */
export async function pushStatuses({ baseUrl, key, fetchImpl, now = Date.now, outboxDir, sentDir, channel, timeoutMs }) {
  const out = { sent: 0, kept: 0, invalid: 0, rejected: [], quarantined: 0, failed_batches: 0 };
  if (!normalizeBase(baseUrl) || !keyOk(key)) return { ...out, code: 'bad_config' };
  let names;
  try { names = readdirSync(outboxDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort(); } catch { return { ...out, code: 'outbox_unreadable' }; }
  const items = [];
  for (const f of names) {
    const r = readOutboxFile(outboxDir, f);
    if (r.invalid) { out.invalid += 1; continue; }
    const o = r.parsed;
    if (o.channel !== channel) { out.invalid += 1; continue; }
    try {
      items.push({ file: f, sealed: sealStatus(key, { channel, task_ref: o.task_ref, source: o.source, state: o.state, updated_at: o.updated_at, body: o.body }) });
    } catch {
      out.invalid += 1;
    }
  }
  let last = 0;
  for (let i = 0; i < items.length;) {
    const batch = [];
    let bytes = 0;
    while (i < items.length && batch.length < CLIENT_LIMITS.status_batch) {
      const size = Buffer.byteLength(JSON.stringify(items[i].sealed), 'utf8');
      if (batch.length && bytes + size > CLIENT_LIMITS.status_batch_bytes) break;
      batch.push(items[i]);
      bytes += size;
      i += 1;
    }
    const ts = Math.max(now(), last + 1);
    last = ts;
    const r = await call({ baseUrl, key, fetchImpl, now, ts, timeoutMs }, { method: 'POST', route: '/status', label: 'edl-status-v1', body: { statuses: batch.map((b) => b.sealed) } });
    const results = r.ok && Array.isArray(r.json?.results) && r.json.results.length === batch.length ? r.json.results : null;
    if (!results) {
      out.failed_batches += 1;
      out.kept += batch.length;
      out.code = r.ok ? 'bad_response' : r.code;
      continue;
    }
    batch.forEach((b, idx) => {
      const res = results[idx];
      if (res?.ok === true) {
        try { moveToSent(outboxDir, sentDir, b.file); out.sent += 1; } catch { out.kept += 1; }
      } else {
        const code = typeof res?.code === 'string' ? res.code : 'unknown';
        if (PERMANENT_REJECT.test(code)) {
          try { moveToSent(outboxDir, rejectedDirFor(outboxDir), b.file); out.quarantined += 1; return; } catch { /* 移せなければ outbox に残す */ }
        }
        out.kept += 1;
        out.rejected.push({ file: b.file, code });
      }
    });
  }
  return out;
}
