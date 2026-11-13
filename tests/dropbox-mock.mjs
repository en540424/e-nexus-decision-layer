/**
 * 試験用の模擬の Dropbox（2026-11-13）。loopback の http server。role 'read'（Full Dropbox・書けない）と 'write'（App folder＝別の名前空間）を別々に起こす。
 * 実の Dropbox・資格情報には接続しない。名前は作り物だけ。
 */
import http from 'node:http';
import { contentHash } from '../scripts/lib/dropbox/content-hash.mjs';
import { headerJson } from '../scripts/lib/dropbox/client.mjs';

export async function startDropboxMock({ role = 'read', appKey = 'appkey000test', refreshToken = 'refresh-token-test-0001' } = {}) {
  const files = new Map(); // lower path → { path, bytes, rev, server_modified }
  const state = { calls: [], corruptNext: false, failNext: null, beforeUpload: null };
  let revN = 0;
  const meta = (f) => ({ '.tag': 'file', name: f.path.split('/').pop(), path_display: f.path, path_lower: f.path.toLowerCase(), id: `id:${f.path.length}`, size: f.bytes.length, rev: f.rev, server_modified: f.server_modified, content_hash: contentHash(f.bytes) });
  const put = (p, bytes) => { revN += 1; const f = { path: p, bytes: Buffer.from(bytes), rev: `0${String(revN).padStart(8, '0')}abc`, server_modified: new Date(Date.UTC(2026, 10, 13, 0, 0, revN)).toISOString().replace('.000', '') }; files.set(p.toLowerCase(), f); return f; };
  const children = (p) => {
    const base = p === '' ? '' : p.toLowerCase();
    const out = new Map();
    for (const f of files.values()) {
      const l = f.path.toLowerCase();
      if (!(base === '' || l.startsWith(`${base}/`))) continue;
      const rest = f.path.slice(base === '' ? 1 : base.length + 1);
      const i = rest.indexOf('/');
      if (i < 0) out.set(l, meta(f));
      else { const fp = `${f.path.slice(0, f.path.length - rest.length)}${rest.slice(0, i)}`; out.set(fp.toLowerCase(), { '.tag': 'folder', name: rest.slice(0, i), path_display: fp }); }
    }
    return [...out.values()];
  };
  const tokens = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const err = (code, summary) => send(code, { error_summary: summary, error: {} });
      state.calls.push(req.url);
      if (state.failNext) { const f = state.failNext; state.failNext = null; return err(f.status, f.summary ?? 'x/'); }
      if (req.url === '/oauth2/token') {
        const q = new URLSearchParams(body.toString());
        if (q.get('grant_type') !== 'refresh_token' || q.get('refresh_token') !== refreshToken || q.get('client_id') !== appKey) return err(400, 'invalid_grant/');
        const t = `tok-${role}-${tokens.size + 1}`;
        tokens.add(t);
        return send(200, { access_token: t, expires_in: 14400, token_type: 'bearer' });
      }
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      if (!auth || !tokens.has(auth[1])) return err(401, 'invalid_access_token/');
      if (req.url === '/2/files/download' || req.url === '/2/files/upload') {
        let arg;
        try { arg = JSON.parse(req.headers['dropbox-api-arg']); } catch { return err(400, 'bad_arg/'); }
        if (/[^\x20-\x7e]/.test(req.headers['dropbox-api-arg'])) return err(400, 'header_not_ascii/');
        if (req.url === '/2/files/download') {
          const f = files.get(String(arg.path).toLowerCase());
          if (!f) return err(409, 'path/not_found/..');
          let bytes = f.bytes;
          if (state.corruptNext) { state.corruptNext = false; bytes = Buffer.from(bytes); bytes[0] ^= 0xff; }
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'dropbox-api-result': headerJson(meta(f)) });
          return res.end(bytes);
        }
        if (role === 'read') return err(401, 'missing_scope/files.content.write');
        state.beforeUpload?.(arg);
        const cur = files.get(String(arg.path).toLowerCase());
        const mode = arg.mode?.['.tag'] ?? arg.mode;
        if (mode === 'add' && cur) return err(409, 'path/conflict/file/..');
        if (mode === 'update' && (!cur || cur.rev !== arg.mode.update)) return err(409, 'path/conflict/file/..');
        if (!['add', 'update'].includes(mode)) return err(400, 'mode_not_allowed/');
        return send(200, meta(put(cur?.path ?? arg.path, body)));
      }
      let j;
      try { j = JSON.parse(body.toString() || '{}'); } catch { return err(400, 'bad_json/'); }
      if (req.url === '/2/files/list_folder') return send(200, { entries: children(j.path), has_more: false, cursor: 'c1' });
      if (req.url === '/2/files/list_folder/continue') return send(200, { entries: [], has_more: false });
      if (req.url === '/2/files/get_metadata') { const f = files.get(String(j.path).toLowerCase()); return f ? send(200, meta(f)) : err(409, 'path/not_found/'); }
      if (req.url === '/2/files/search_v2') {
        const root = String(j.options?.path ?? '').toLowerCase();
        const q = String(j.query).toLowerCase();
        const hits = [...files.values()].filter((f) => f.path.toLowerCase().startsWith(`${root}/`) && f.path.split('/').pop().toLowerCase().includes(q)).slice(0, j.options?.max_results ?? 100);
        return send(200, { matches: hits.map((f) => ({ metadata: { '.tag': 'metadata', metadata: meta(f) } })), has_more: false });
      }
      return err(404, 'not_found/');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, files, state, put, appKey, refreshToken,
    credentials: { appKey, refreshToken },
    client: (create, extra = {}) => create({ role, credentials: { appKey, refreshToken }, api: base, content: base, ...extra }),
    close: () => new Promise((r) => server.close(r)),
  };
}
