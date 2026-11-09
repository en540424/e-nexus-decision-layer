/**
 * Task Hub の受け渡しの形（2026-11-09・MA-24）。VPS の受け口（deploy/vps-task-intake）と Mac の取り込み（scripts/task-hub.mjs）が同じ形を使う。依存なし。
 *
 * 外から来た依頼は「封」（record）に入って届く。封を作るのは依頼元を認証した側（VPS の受け口・Mac の Human の CLI）で、依頼元（Grok Bot 等）は自分で署名しない
 * （Grok Bot は Bearer しか出せない）。source は封を作った側が「どの鍵で認証できたか」から決める＝依頼の本文の自己申告ではない。
 *
 *   record = { v: 1, channel, source, received_at（ms）, nonce（32 hex）, body（依頼の JSON の文字列）, sig（hex） }
 *   sig    = HMAC-SHA256(channel の鍵, "edl-task-v1\n" + channel + "\n" + source + "\n" + received_at + "\n" + nonce + "\n" + sha256hex(body))
 *
 * 結果を返す時（Mac → VPS の状態の板）も同じ鍵で status record に署名する（domain の語を変えて取り違えを防ぐ）。
 *   status = { v: 1, channel, task_ref, source, state, updated_at, nonce, body（結果の JSON の文字列）, sig }
 *   sig    = HMAC-SHA256(鍵, "edl-task-status-v1\n" + channel + "\n" + task_ref + "\n" + source + "\n" + state + "\n" + updated_at + "\n" + nonce + "\n" + sha256hex(body))
 *
 * 鍵は 32 byte 以上。値はどこにも書かない（log・error・結果）。検査は timingSafeEqual。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WIRE_VERSION = 1;
export const MAX_BODY_BYTES = 16 * 1024;
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const NONCE_RE = /^[0-9a-f]{32}$/;
export const TASK_REF_RE = /^[A-Za-z0-9._:-]{8,128}$/;
/** 封の古さの上限。VPS の queue の保存（7 日）より長く、Mac の取り込み・運び手の両方がこの値を使う（運び手が ack して消した後に取り込みで too_old にしない） */
export const RECORD_MAX_AGE_MS = 8 * 24 * 3_600_000;
export const STATES = Object.freeze(['received', 'awaiting_approval', 'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'rejected', 'blocked', 'expired', 'stopped']);

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const keyOk = (key) => Buffer.isBuffer(key) && key.length >= 32;

function mac(key, parts) {
  if (!keyOk(key)) throw new Error('wire key must be a Buffer of 32 bytes or more');
  return createHmac('sha256', key).update(parts.join('\n'), 'utf8').digest('hex');
}
function same(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string' || !/^[0-9a-f]{64}$/.test(hexB)) return false;
  return timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
}

export const newNonce = () => randomBytes(16).toString('hex');

function recordParts({ channel, source, received_at, nonce, body }) {
  return ['edl-task-v1', channel, source, String(received_at), nonce, sha256hex(body)];
}

/** 封を作る（認証できた側だけが呼ぶ）。body は文字列（依頼の JSON をそのまま） */
export function sealRecord(key, { channel, source, received_at, body, nonce = newNonce() }) {
  const r = { v: WIRE_VERSION, channel, source, received_at, nonce, body };
  const why = shapeError(r);
  if (why) throw new Error(`cannot seal: ${why}`);
  return { ...r, sig: mac(key, recordParts(r)) };
}

/** 形の検査。合っていれば null、違えば理由のコード（値は返さない） */
export function shapeError(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return 'not_object';
  if (r.v !== WIRE_VERSION) return 'version';
  if (typeof r.channel !== 'string' || !ID_RE.test(r.channel)) return 'channel';
  if (typeof r.source !== 'string' || !ID_RE.test(r.source)) return 'source';
  if (!Number.isSafeInteger(r.received_at) || r.received_at <= 0) return 'received_at';
  if (typeof r.nonce !== 'string' || !NONCE_RE.test(r.nonce)) return 'nonce';
  if (typeof r.body !== 'string' || Buffer.byteLength(r.body, 'utf8') > MAX_BODY_BYTES) return 'body';
  return null;
}

/**
 * 封の検査。{ ok: true, record } か { ok: false, code }。
 * keyFor(channel) は Buffer か null（知らない channel は null＝拒否）。時刻：未来は skewMs まで・古さは maxAgeMs まで。
 * 再送（同じ nonce）の判定はここではしない（保存先を持つ queue の仕事）。
 */
export function openRecord(raw, { keyFor, now, skewMs = 5 * 60_000, maxAgeMs = RECORD_MAX_AGE_MS }) {
  const known = new Set(['v', 'channel', 'source', 'received_at', 'nonce', 'body', 'sig']);
  if (raw && typeof raw === 'object' && Object.keys(raw).some((k) => !known.has(k))) return { ok: false, code: 'unknown_field' };
  const why = shapeError(raw);
  if (why) return { ok: false, code: `shape_${why}` };
  const key = keyFor(raw.channel);
  if (!keyOk(key)) return { ok: false, code: 'unknown_channel' };
  if (!same(mac(key, recordParts(raw)), raw.sig)) return { ok: false, code: 'bad_signature' };
  if (raw.received_at > now + skewMs) return { ok: false, code: 'future' };
  if (now - raw.received_at > maxAgeMs) return { ok: false, code: 'too_old' };
  return { ok: true, record: { channel: raw.channel, source: raw.source, received_at: raw.received_at, nonce: raw.nonce, body: raw.body } };
}

function statusParts({ channel, task_ref, source, state, updated_at, nonce, body }) {
  return ['edl-task-status-v1', channel, task_ref, source, state, String(updated_at), nonce, sha256hex(body)];
}

export function statusShapeError(s) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return 'not_object';
  if (s.v !== WIRE_VERSION) return 'version';
  if (typeof s.channel !== 'string' || !ID_RE.test(s.channel)) return 'channel';
  if (typeof s.task_ref !== 'string' || !TASK_REF_RE.test(s.task_ref)) return 'task_ref';
  if (typeof s.source !== 'string' || !ID_RE.test(s.source)) return 'source';
  if (!STATES.includes(s.state)) return 'state';
  if (!Number.isSafeInteger(s.updated_at) || s.updated_at <= 0) return 'updated_at';
  if (typeof s.nonce !== 'string' || !NONCE_RE.test(s.nonce)) return 'nonce';
  if (typeof s.body !== 'string' || Buffer.byteLength(s.body, 'utf8') > MAX_BODY_BYTES) return 'body';
  return null;
}

export function sealStatus(key, { channel, task_ref, source, state, updated_at, body, nonce = newNonce() }) {
  const s = { v: WIRE_VERSION, channel, task_ref, source, state, updated_at, nonce, body };
  const why = statusShapeError(s);
  if (why) throw new Error(`cannot seal status: ${why}`);
  return { ...s, sig: mac(key, statusParts(s)) };
}

export function openStatus(raw, { keyFor, now, skewMs = 5 * 60_000 }) {
  const known = new Set(['v', 'channel', 'task_ref', 'source', 'state', 'updated_at', 'nonce', 'body', 'sig']);
  if (raw && typeof raw === 'object' && Object.keys(raw).some((k) => !known.has(k))) return { ok: false, code: 'unknown_field' };
  const why = statusShapeError(raw);
  if (why) return { ok: false, code: `shape_${why}` };
  const key = keyFor(raw.channel);
  if (!keyOk(key)) return { ok: false, code: 'unknown_channel' };
  if (!same(mac(key, statusParts(raw)), raw.sig)) return { ok: false, code: 'bad_signature' };
  if (raw.updated_at > now + skewMs) return { ok: false, code: 'future' };
  const { sig, v, ...rest } = raw;
  return { ok: true, status: rest };
}
