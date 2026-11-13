/**
 * Dropbox の API の小さな client（2026-11-13・MA-24・docs/dropbox-business.md）。依存なし（fetch・crypto だけ）。
 *
 * 権限は「資格情報で分ける」（プロンプトや設定の文に頼らない）：
 *   role 'read'  ：Dropbox の App Console の Full Dropbox の app・scope は files.metadata.read と files.content.read だけ＝**どこにも書けない資格情報**。
 *                  さらに path を business ごとの許可フォルダ（scope.mjs）で絞る（読みの範囲はこの code が強制）
 *   role 'write' ：App folder の app（Dropbox が /Apps/<app 名>/ の外を見せない）・scope は files.content.write など＝**AI の出力フォルダの外へ書けない資格情報**。
 *                  upload は add（新規）か update（rev つき＝Human が同時に直していたら conflict）だけ。overwrite・削除・移動・共有の呼び出しは**この client に無い**
 * 鍵は Keychain（E-NEXUS/edl/dropbox-<role>-app-key・dropbox-<role>-refresh-token）から呼び出し側が渡す。値は表示しない・log に出さない。
 * Dropbox-API-Arg の header の JSON は ASCII にする（日本語の path は \uXXXX＝Dropbox の公式の決まり）。
 */
import { contentHash } from './content-hash.mjs';

export const API = 'https://api.dropboxapi.com';
export const CONTENT = 'https://content.dropboxapi.com';
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export class DropboxError extends Error {
  constructor(code, { status = null, retryable = false } = {}) { super(code); this.code = code; this.status = status; this.retryable = retryable; }
}

/** header に入れる JSON（非 ASCII と 0x7f を \uXXXX に） */
export function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Dropbox の error を固定のコードへ（本文の自由文は捨てる・path は出さない） */
function errorCode(status, body) {
  const parts = typeof body?.error_summary === 'string' ? body.error_summary.split('/').map((x) => x.replace(/[^a-z_]/g, '')).filter(Boolean) : [];
  const tag = parts.slice(0, 2).join('_').slice(0, 40); // 例 path_conflict・path_not_found・path_insufficient_space
  if (status === 401) return 'dropbox_auth';
  if (status === 403) return 'dropbox_forbidden';
  if (status === 409) return tag ? `dropbox_${tag}` : 'dropbox_conflict';
  if (status === 429) return 'dropbox_rate_limited';
  if (status >= 500) return 'dropbox_unavailable';
  return 'dropbox_bad_request';
}

/**
 * client を作る。credentials：{ appKey, refreshToken }（PKCE の app＝client secret なし）。
 * fetchImpl・base は test が模擬のサーバーへ向ける。timeoutMs は 1 回の要求の上限
 */
export function createDropbox({ role, credentials, fetchImpl = fetch, api = API, content = CONTENT, timeoutMs = 30_000, now = () => Date.now() }) {
  if (!['read', 'write'].includes(role)) throw new DropboxError('bad_role');
  if (!credentials?.appKey || !credentials?.refreshToken) throw new DropboxError('not_configured');
  let token = null;
  let tokenUntil = 0;

  async function call(url, init, signal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener?.('abort', onAbort);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ac.signal });
    } catch (e) {
      throw new DropboxError(signal?.aborted ? 'aborted' : ac.signal.aborted ? 'dropbox_timeout' : 'dropbox_network', { retryable: true });
    } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
  }
  async function accessToken(signal) {
    if (token && now() < tokenUntil) return token;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: credentials.appKey });
    const res = await call(`${api}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, signal);
    let j = null;
    try { j = await res.json(); } catch { /* 形が違う */ }
    if (!res.ok || typeof j?.access_token !== 'string') throw new DropboxError(res.status === 400 || res.status === 401 ? 'dropbox_auth' : errorCode(res.status, j), { status: res.status, retryable: res.status >= 500 });
    token = j.access_token;
    tokenUntil = now() + Math.max(60, Number(j.expires_in) || 3600) * 1000 - 120_000;
    return token;
  }
  async function rpc(endpoint, args, signal) {
    const res = await call(`${api}/2/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(signal)}`, 'content-type': 'application/json' }, body: JSON.stringify(args) }, signal);
    let j = null;
    try { j = await res.json(); } catch { /* 空 */ }
    if (!res.ok) throw new DropboxError(errorCode(res.status, j), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    return j;
  }

  const api_ = {
    role,
    /** フォルダの一覧（名前・path・種類・大きさ・rev・更新時刻だけ）。recursive は既定 false。上限 limit 件 */
    async list(path, { recursive = false, limit = 500, signal } = {}) {
      const entries = [];
      let j = await rpc('files/list_folder', { path, recursive, limit: Math.min(limit, 2000), include_deleted: false }, signal);
      for (;;) {
        for (const e of j.entries ?? []) {
          entries.push({ tag: e['.tag'], name: e.name, path: e.path_display, ...(e['.tag'] === 'file' ? { size: e.size, rev: e.rev, server_modified: e.server_modified, content_hash: e.content_hash } : {}) });
          if (entries.length >= limit) return { entries, truncated: true };
        }
        if (!j.has_more) return { entries, truncated: false };
        j = await rpc('files/list_folder/continue', { cursor: j.cursor }, signal);
      }
    },
    /** 名前・中身の検索（path の下だけ）。結果は file の要点だけ */
    async search(query, { path, max = 50, filenameOnly = false, signal } = {}) {
      const j = await rpc('files/search_v2', { query: String(query).slice(0, 200), options: { path, max_results: Math.min(max, 100), file_status: 'active', filename_only: filenameOnly } }, signal);
      return (j.matches ?? []).map((m) => m.metadata?.metadata).filter((x) => x && x['.tag'] === 'file').map((e) => ({ name: e.name, path: e.path_display, size: e.size, rev: e.rev, server_modified: e.server_modified }));
    },
    async metadata(path, { signal } = {}) {
      const e = await rpc('files/get_metadata', { path }, signal);
      return { tag: e['.tag'], name: e.name, path: e.path_display, ...(e['.tag'] === 'file' ? { size: e.size, rev: e.rev, server_modified: e.server_modified, content_hash: e.content_hash } : {}) };
    },
    /** 1 file を取る。Dropbox の content_hash と照らして壊れていないことを確かめる（違えば dropbox_hash_mismatch） */
    async download(path, { signal, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
      const res = await call(`${content}/2/files/download`, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(signal)}`, 'dropbox-api-arg': headerJson({ path }) } }, signal);
      if (!res.ok) { let j = null; try { j = await res.json(); } catch { /* 空 */ } throw new DropboxError(errorCode(res.status, j), { status: res.status, retryable: res.status === 429 || res.status >= 500 }); }
      let meta;
      try { meta = JSON.parse(res.headers.get('dropbox-api-result')); } catch { throw new DropboxError('dropbox_bad_response'); }
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > maxBytes) throw new DropboxError('dropbox_too_large');
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new DropboxError('dropbox_too_large');
      if (typeof meta?.content_hash !== 'string' || contentHash(bytes) !== meta.content_hash) throw new DropboxError('dropbox_hash_mismatch', { retryable: true });
      return { bytes, meta: { name: meta.name, path: meta.path_display, rev: meta.rev, size: meta.size, server_modified: meta.server_modified, content_hash: meta.content_hash } };
    },
  };
  if (role === 'write') {
    /**
     * App folder の中へ書く。mode：'add'（無ければ作る・在れば dropbox_path＝conflict）か { rev }（その版の時だけ更新＝Human の同時の編集を上書きしない）。
     * 書いた後の content_hash を手元で計算した値と照らす（違えば dropbox_hash_mismatch）
     */
    api_.upload = async (path, bytes, { rev = null, signal } = {}) => {
      const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
      const res = await call(`${content}/2/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${await accessToken(signal)}`, 'content-type': 'application/octet-stream', 'dropbox-api-arg': headerJson({ path, mode, autorename: false, mute: true, strict_conflict: true }) }, body: bytes }, signal);
      let j = null;
      try { j = await res.json(); } catch { /* 空 */ }
      if (!res.ok) throw new DropboxError(errorCode(res.status, j), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      if (j?.content_hash !== contentHash(bytes)) throw new DropboxError('dropbox_hash_mismatch');
      return { path: j.path_display, rev: j.rev, size: j.size, content_hash: j.content_hash, server_modified: j.server_modified };
    };
  }
  return Object.freeze(api_);
}

/**
 * Keychain の資格情報（呼び出し側が読む＝test では渡す）。名前は role ごとに固定
 */
export const KEYCHAIN_NAMES = Object.freeze({
  read: { appKey: 'dropbox-read-app-key', refreshToken: 'dropbox-read-refresh-token' },
  write: { appKey: 'dropbox-write-app-key', refreshToken: 'dropbox-write-refresh-token' },
});
