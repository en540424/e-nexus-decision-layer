/**
 * Task Hub の依頼の形 envelope v1（2026-11-09・MA-24）。封（wire.mjs）の body、または Human の CLI の JSON を検査する。依存なし・通信なし。
 *
 *   { v: 1, idempotency_key, business, intent, params（≤ 8 KiB の object）, summary?（≤ 200 字・データとして保存するだけ） }
 *
 * 守ること：未知の top-level field は拒否／承認を主張する key は params の深さを問わず拒否（human-only.json の forbidden_outcome_keys ＋ approved 系）／
 * 鍵・token の形の値は拒否／不可視文字・制御文字は NFKC のあと取り除く（id に入っていたら拒否）／summary は命令として読まない。
 * 戻り値は { ok: true, envelope, sanitized } か { ok: false, code }。code は理由の名前だけ（値を返さない）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ID_RE, MAX_BODY_BYTES, TASK_REF_RE } from './wire.mjs';

export const ENVELOPE_VERSION = 1;
/** 封の body（16 KiB）に収まる params の絶対の上限。intent ごとの上限（既定 8 KiB）は policy が見る */
export const MAX_PARAMS_BYTES_HARD = 14_000;
export const DEFAULT_MAX_PARAMS_BYTES = 8_192;
export const KEY_RE = TASK_REF_RE; // ^[A-Za-z0-9._:-]{8,128}$
export const BUSINESS_RE = ID_RE;
export const INTENT_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,3}$/;
const TOP_KEYS = new Set(['v', 'idempotency_key', 'business', 'intent', 'params', 'summary']);
const MAX_DEPTH = 6;
const MAX_NODES = 2000;
const MAX_STRING = 2000;
const MAX_SUMMARY = 200;

const HUMAN_ONLY = JSON.parse(readFileSync(new URL('../../../policies/safety/human-only.json', import.meta.url), 'utf8'));
// 英数字だけに畳んで比べる（Approved／human-approved／approvedBy を同じに見る）
const squash = (k) => String(k).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const APPROVAL_KEYS = new Set([...HUMAN_ONLY.forbidden_outcome_keys, 'approved', 'approval', 'approved_by', 'human_approved', 'human_approval', 'pre_approved', 'auto_approve', 'confirmed_by_human'].map(squash));
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 不可視・制御文字：C0（\n \t 以外）・DEL・C1・行／段落区切り・書式の制御 Cf（soft hyphen・零幅・方向制御 bidi・word joiner・tag 文字・BOM ほか）・
// 既定で無視される文字 Default_Ignorable（variation selector・ハングルの埋め字・補助面の書式 ほか）・点字の空白 U+2800・object replacement。scripts/lib/backup-plan.mjs と同じ考え方
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\uFFFC\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/u;
const INVISIBLE_G = new RegExp(INVISIBLE.source, 'gu');

// 鍵・token の形（src/gateway/gateway.mjs の SECRET_SHAPES の写し。private symbol は import しない）＋ 一般的な token の形を少し足した
// 語頭は (?<![A-Za-z0-9])（\b だと token_ghp_… の "_" の後ろが語の中になり見逃す）。語末の \b も同じ理由で (?![A-Za-z0-9])
const B = '(?<![A-Za-z0-9])';
const SECRET_SHAPES = Object.freeze([
  new RegExp(`${B}sk-[A-Za-z0-9_-]{16,}`), new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{20,}`), new RegExp(`${B}github_pat_[A-Za-z0-9_]{20,}`), new RegExp(`${B}AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`),
  new RegExp(`${B}xox[baprs]-[A-Za-z0-9-]{10,}`), /-----BEGIN [A-Z ]*PRIVATE KEY-----/, new RegExp(`${B}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.`), new RegExp(`${B}Bearer\\s+[A-Za-z0-9._~+/=-]{12,}`, 'i'),
  new RegExp(`${B}AIza[0-9A-Za-z_-]{30,}`), new RegExp(`${B}glpat-[A-Za-z0-9_-]{16,}`), new RegExp(`${B}npm_[A-Za-z0-9]{30,}`),
  // 受け口の channel の鍵の形（etk_ ＋ 64 桁 hex）と、64 桁以上の hex の連なり（鍵・digest の形。docomo の export の id など 32 桁は対象外）
  new RegExp(`${B}etk_[0-9a-fA-F]{64}`), /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/,
]);
export const hasSecretShape = (s) => SECRET_SHAPES.some((re) => re.test(s));

class Reject extends Error {
  constructor(code) { super(code); this.code = code; }
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** 文字列を整える。NFKC のあと不可視文字を取る。取った印を ctx に残す。上限は正規化のあとで見直す（NFKC は 1 字を 18 字に広げうる）。Secret の形は取る前の形でも取った後の形でも見る */
function cleanString(s, ctx, max = MAX_STRING) {
  if (!s.isWellFormed()) throw new Reject('ill_formed_string');
  if (s.length > MAX_STRING) throw new Reject('string_too_long');
  const n = s.normalize('NFKC');
  const c = n.replace(INVISIBLE_G, '');
  if (c !== s) ctx.sanitized = true;
  if (c.length > max) throw new Reject(max === MAX_STRING ? 'string_too_long' : 'summary');
  if (hasSecretShape(c) || (n !== c && hasSecretShape(n))) throw new Reject('secret_shaped_value');
  return c;
}

function walk(v, ctx, depth) {
  if (depth > MAX_DEPTH) throw new Reject('too_deep');
  if (++ctx.nodes > MAX_NODES) throw new Reject('too_many_nodes');
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Reject('bad_number');
    return v;
  }
  if (typeof v === 'string') return cleanString(v, ctx);
  if (Array.isArray(v)) return v.map((x) => walk(x, ctx, depth + 1));
  if (isPlain(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (UNSAFE_KEYS.has(k)) throw new Reject('unsafe_key');
      const sq = squash(k);
      if (APPROVAL_KEYS.has(sq) || sq.includes('approv')) throw new Reject('approval_claim');
      if (INVISIBLE.test(k) || k.normalize('NFKC') !== k) throw new Reject('invisible_or_unnormalized_key');
      if (k.length > 64) throw new Reject('key_too_long');
      if (hasSecretShape(k)) throw new Reject('secret_shaped_value');
      out[k] = walk(x, ctx, depth + 1);
    }
    return out;
  }
  throw new Reject('bad_type');
}

/** id の欄（idempotency_key・business・intent）。不可視文字・NFKC で変わる文字が入っていたら拒否 */
function idField(v, re, code) {
  if (typeof v !== 'string') throw new Reject(code);
  if (INVISIBLE.test(v)) throw new Reject('invisible_char_in_id');
  if (v.normalize('NFKC') !== v) throw new Reject('unnormalized_id');
  if (!re.test(v)) throw new Reject(code);
  return v;
}

/** 依頼の検査。input は body の文字列か、すでに parse 済みの object（Human の CLI） */
export function parseEnvelope(input) {
  try {
    let raw = input;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > MAX_BODY_BYTES) throw new Reject('body_too_large');
      try { raw = JSON.parse(input); } catch { throw new Reject('bad_json'); }
    }
    if (!isPlain(raw)) throw new Reject('not_object');
    for (const k of Object.keys(raw)) {
      if (UNSAFE_KEYS.has(k)) throw new Reject('unsafe_key');
      if (!TOP_KEYS.has(k)) throw new Reject(APPROVAL_KEYS.has(squash(k)) || squash(k).includes('approv') ? 'approval_claim' : 'unknown_field');
    }
    if (raw.v !== ENVELOPE_VERSION) throw new Reject('version');
    const idempotency_key = idField(raw.idempotency_key, KEY_RE, 'idempotency_key');
    const business = idField(raw.business, BUSINESS_RE, 'business');
    const intent = idField(raw.intent, INTENT_RE, 'intent');
    if (!isPlain(raw.params)) throw new Reject('params');
    if (Buffer.byteLength(JSON.stringify(raw.params), 'utf8') > MAX_PARAMS_BYTES_HARD) throw new Reject('params_too_large');
    const ctx = { nodes: 0, sanitized: false };
    const params = walk(raw.params, ctx, 0);
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > MAX_PARAMS_BYTES_HARD) throw new Reject('params_too_large'); // NFKC のあとの大きさ（保存する形）で見直す
    let summary = '';
    if (raw.summary !== undefined) {
      if (typeof raw.summary !== 'string' || raw.summary.length > MAX_SUMMARY) throw new Reject('summary');
      summary = cleanString(raw.summary, ctx, MAX_SUMMARY);
    }
    return { ok: true, envelope: { v: ENVELOPE_VERSION, idempotency_key, business, intent, params, summary }, sanitized: ctx.sanitized };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, code: e.code };
    return { ok: false, code: 'invalid' };
  }
}

// ─── 正規形と content_digest ───

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** 承認の対象になる内容の指紋。source・business・intent・params（summary は含めない＝命令でも承認の対象でもない） */
export function contentDigest({ source, business, intent, params }) {
  return createHash('sha256').update(`${source}|${business}|${intent}|${canonical(params)}`, 'utf8').digest('hex');
}

// ─── params の形の検査（小さな JSON-schema 風。値は返さず、場所と規則の名前だけ返す）───

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
export const isIso = (s) => typeof s === 'string' && ISO_RE.test(s) && Number.isFinite(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : /(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : `${s}Z`));

/** 違えば 'パス:規則' を返す。合っていれば null */
export function checkSpec(spec, v, at = '$') {
  if (!spec) return null;
  const bad = (rule) => `${at}:${rule}`;
  switch (spec.type) {
    case 'object': {
      if (!isPlain(v)) return bad('type');
      for (const r of spec.required ?? []) if (!(r in v)) return bad(`required.${r}`);
      for (const [k, x] of Object.entries(v)) {
        const sub = spec.properties?.[k];
        if (!sub) {
          if (spec.additionalProperties === false) return bad(`unknown.${k.slice(0, 20)}`);
          continue;
        }
        const e = checkSpec(sub, x, `${at}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(v)) return bad('type');
      if (spec.maxItems !== undefined && v.length > spec.maxItems) return bad('maxItems');
      for (let i = 0; i < v.length; i += 1) {
        const e = checkSpec(spec.items, v[i], `${at}[${i}]`);
        if (e) return e;
      }
      return null;
    }
    case 'string':
      if (typeof v !== 'string') return bad('type');
      if (spec.minLength !== undefined && v.length < spec.minLength) return bad('minLength');
      if (spec.maxLength !== undefined && v.length > spec.maxLength) return bad('maxLength');
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) return bad('pattern');
      if (spec.enum && !spec.enum.includes(v)) return bad('enum');
      if (spec.format === 'iso' && !isIso(v)) return bad('format');
      return null;
    case 'integer':
      return Number.isInteger(v) ? null : bad('type');
    case 'number': // 2026-11-13：見積の数量・単価（小数）。有限の数だけ
      return typeof v === 'number' && Number.isFinite(v) ? null : bad('type');
    case 'boolean':
      return typeof v === 'boolean' ? null : bad('type');
    default:
      return bad('spec');
  }
}
