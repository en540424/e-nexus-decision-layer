/**
 * Common Decision Gateway — HTTP 入口（言語・Runtime 非依存。Python / Hermes / Worker / 他LLM Agent 向け）。
 *
 *   POST /v1/decisions      Decision Request → Gateway envelope（要認証）
 *   GET  /v1/decision-types decision_type 一覧（要認証）
 *   GET  /v1/health         詳細 health・stats（要認証。Secret は含まない）
 *   GET  /health            最小 health（認証不要：status・contract_version・engine 版だけ）
 *   GET  /version           同上
 *
 * 境界（2026-09-25 決定・docs/gateway.md §認証）：
 *   - 既定 bind は 127.0.0.1。loopback 以外へ bind するときは EDL_GATEWAY_TOKEN が無いと起動しない（fail-closed）
 *   - token が設定されていれば Authorization: Bearer <token> を timingSafeEqual で照合。token の値はログ・応答に出さない
 *   - Origin ヘッダ付き request は 403、POST は Content-Type: application/json 以外 415
 *     （ブラウザの任意ページから localhost の有料 Jev 呼び出しを起こさせない）
 *   - body 上限（既定 64KiB）
 *   - HTTP status は「Gateway が decision を返せたか」だけを表す。tier=human でも 200（Decision 結果と status を混同しない）
 * deploy（VPS / Mac mini / Cloud）・token の発行と投入は Human-only。
 */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_MAX_BODY = 64 * 1024;

const STATUS_BY_KIND = Object.freeze({
  invalid_request: 400,
  human_gate_violation: 422,
  busy: 429,
  timeout: 504,
  engine_error: 502,
});

export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host));
}

function tokenMatches(expected, header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  // 長さの違いで早期 return しないよう、両方を固定長 digest にしてから比較する
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(header.slice(7)).digest();
  return timingSafeEqual(a, b);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createGatewayHttpHandler({ gateway, token = null, maxBodyBytes = DEFAULT_MAX_BODY }) {
  const authorized = (req) => (token ? tokenMatches(token, req.headers.authorization) : true);

  return async function handler(req, res) {
    try {
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
      const url = new URL(req.url, 'http://gateway.local');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health') return send(res, 200, { status: 'ok', ...gateway.version() });
      if (route === 'GET /version') return send(res, 200, gateway.version());

      const known = ['POST /v1/decisions', 'GET /v1/decision-types', 'GET /v1/health'];
      if (!known.includes(route)) return send(res, 404, { error: 'NOT_FOUND' });
      if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED' });

      if (route === 'GET /v1/health') return send(res, 200, gateway.health());
      if (route === 'GET /v1/decision-types') return send(res, 200, { decision_types: gateway.decisionTypes() });

      const ctype = String(req.headers['content-type'] ?? '');
      if (!/^application\/json\b/i.test(ctype)) return send(res, 415, { error: 'CONTENT_TYPE_MUST_BE_JSON' });
      let raw;
      try {
        raw = JSON.parse(await readBody(req, maxBodyBytes));
      } catch (err) {
        if (err.status === 413) return send(res, 413, { error: 'BODY_TOO_LARGE' });
        raw = null; // 不正 JSON は Gateway に envelope エラーとして返させる（failure policy を必ず付ける）
      }
      const envelope = await gateway.decide(raw, { via: 'http' });
      return send(res, envelope.ok ? 200 : (STATUS_BY_KIND[envelope.error.kind] ?? 500), envelope);
    } catch {
      return send(res, 500, { error: 'INTERNAL_ERROR' });
    }
  };
}

/**
 * 起動。loopback 以外への bind は token 必須（無ければ throw して起動しない）。
 * 返り値の server.address() で実ポートを得る（port 0 = 空きポート）。
 */
export function startGatewayServer({ gateway, host = '127.0.0.1', port = 8787, token = null, maxBodyBytes } = {}) {
  if (!isLoopbackHost(host) && !token) {
    throw new Error('refusing to bind a non-loopback host without EDL_GATEWAY_TOKEN (Human-only: issue and set the token first)');
  }
  const server = createServer(createGatewayHttpHandler({ gateway, token, maxBodyBytes }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
