/**
 * Common Decision Gateway — HTTP 入口（言語・Runtime 非依存。Python / Hermes / Worker / 他LLM Agent 向け）。
 *
 *   POST /v1/decisions      Decision Request → Gateway envelope（要認証）
 *   GET  /v1/decision-types decision_type 一覧（要認証）
 *   GET  /v1/health         詳細 health・stats（要認証。Secret は含まない）
 *   GET  /health            最小 health（認証不要：status・contract_version・engine 版だけ）
 *   GET  /version           同上＋ release（pinned commit。2026-09-29）
 *   GET  /ready             受付中なら 200・停止処理中（draining）なら 503（認証不要・load balancer / service manager 用。2026-09-29）
 *
 * 境界（2026-09-25 決定・docs/gateway.md §認証）：
 *   - 既定 bind は 127.0.0.1。loopback 以外へ bind するときは EDL_GATEWAY_TOKEN が無いと起動しない（fail-closed）
 *   - token が設定されていれば Authorization: Bearer <token> を timingSafeEqual で照合。token の値はログ・応答に出さない
 *   - Origin ヘッダ付き request は 403、POST は Content-Type: application/json 以外 415
 *     （ブラウザの任意ページから localhost の有料 Jev 呼び出しを起こさせない）
 *   - body 上限（既定 64KiB）
 *   - HTTP status は「Gateway が decision を返せたか」だけを表す。tier=human でも 200（Decision 結果と status を混同しない）
 * Production-capable（2026-09-29・FB-05）：
 *   - rate limit（/v1/* ・process 全体・分あたり。超過は 429＋Retry-After。0＝OFF）。有料 Jev の呼び出し量を入口で抑える
 *   - access log（1 request 1 行の JSON。method・path・status・latency・request_id・error code・environment だけ。
 *     body・token・IP・outcome は出さない）
 *   - graceful shutdown：server.shutdown() で受付停止（/ready は 503）→ 進行中の decision を SHUTDOWN で abort（FB-01 の経路）→
 *     drain timeout 後に残りの接続を閉じる
 * deploy（VPS / Mac mini / Cloud）・token の発行と投入・常駐の登録は Human-only（docs/deploy-production-gateway.md）。
 */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_MAX_BODY = 64 * 1024;

const STATUS_BY_KIND = Object.freeze({
  invalid_request: 400,
  human_gate_violation: 422,
  environment_mismatch: 409,
  busy: 429,
  aborted: 499, // client が切断した・shutdown で中断した（通常は応答を受け取る相手がいない。記録・テスト用）
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

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(text);
  return status;
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

/**
 * 固定窓の rate limiter（process 全体・1 分窓）。token は 1 本なので、利用元ごとではなく入口全体の上限。
 * @param {number} perMinute 0 以下は無効（常に許可）
 */
export function createRateLimiter(perMinute, now = () => Date.now()) {
  let windowStart = now();
  let count = 0;
  return {
    enabled: perMinute > 0,
    take() {
      if (!(perMinute > 0)) return { ok: true };
      const t = now();
      if (t - windowStart >= 60_000) { windowStart = t; count = 0; }
      if (count >= perMinute) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + 60_000 - t) / 1000)) };
      count += 1;
      return { ok: true };
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.gateway createGateway() の戻り値
 * @param {string|null} [o.token]
 * @param {number} [o.maxBodyBytes]
 * @param {number} [o.rateLimitPerMin] 0＝OFF
 * @param {(line: object) => void} [o.accessLog] 1 request 1 行（既定は出さない。gateway serve は stderr へ JSON で出す）
 * @param {{ commit: string, version: string|null }|null} [o.release]
 * @param {() => boolean} [o.isDraining]
 * @param {AbortSignal} [o.shutdownSignal] abort されたら進行中の decision を SHUTDOWN で止める
 */
export function createGatewayHttpHandler({ gateway, token = null, maxBodyBytes = DEFAULT_MAX_BODY, rateLimitPerMin = 0, accessLog = null, release = null, isDraining = () => false, shutdownSignal = null }) {
  const authorized = (req) => (token ? tokenMatches(token, req.headers.authorization) : true);
  const limiter = createRateLimiter(rateLimitPerMin);
  const versionBody = () => ({ ...gateway.version(), release: release ? { commit: release.commit, version: release.version ?? null } : null });

  async function route(req, res, url, info) {
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    const r = `${req.method} ${url.pathname}`;

    if (r === 'GET /health') return send(res, 200, { status: 'ok', ...gateway.version() });
    if (r === 'GET /version') return send(res, 200, versionBody());
    if (r === 'GET /ready') return isDraining() ? send(res, 503, { status: 'draining' }) : send(res, 200, { status: 'ready' });

    const known = ['POST /v1/decisions', 'GET /v1/decision-types', 'GET /v1/health'];
    if (!known.includes(r)) return send(res, 404, { error: 'NOT_FOUND' });
    if (isDraining()) return send(res, 503, { error: 'DRAINING' }, { connection: 'close', 'retry-after': '5' });
    const slot = limiter.take();
    if (!slot.ok) return send(res, 429, { error: 'RATE_LIMITED' }, { 'retry-after': String(slot.retryAfterSec) });
    if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED' });

    if (r === 'GET /v1/health') return send(res, 200, { ...gateway.health(), release: versionBody().release, rate_limit_per_min: rateLimitPerMin });
    if (r === 'GET /v1/decision-types') return send(res, 200, { decision_types: gateway.decisionTypes() });

    const ctype = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(ctype)) return send(res, 415, { error: 'CONTENT_TYPE_MUST_BE_JSON' });
    let raw;
    try {
      raw = JSON.parse(await readBody(req, maxBodyBytes));
    } catch (err) {
      if (err.status === 413) return send(res, 413, { error: 'BODY_TOO_LARGE' });
      raw = null; // 不正 JSON は Gateway に envelope エラーとして返させる（failure policy を必ず付ける）
    }
    // client が応答前に切断したら decide を止める（2026-09-29 FB-01）。req の 'close' は body を読み終えた時点でも発火するので使わない
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort('CLIENT_DISCONNECTED'); };
    const onShutdown = () => controller.abort('SHUTDOWN');
    res.on('close', onClose);
    if (shutdownSignal?.aborted) onShutdown();
    else shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
    let envelope;
    try {
      envelope = await gateway.decide(raw, { via: 'http', signal: controller.signal });
    } finally {
      res.off('close', onClose);
      shutdownSignal?.removeEventListener('abort', onShutdown);
    }
    info.request_id = envelope.request_id ?? null;
    info.error_code = envelope.ok ? null : envelope.error?.code ?? null;
    if (res.destroyed) return 499; // 切断済み：送る先が無い
    return send(res, envelope.ok ? 200 : (STATUS_BY_KIND[envelope.error.kind] ?? 500), envelope);
  }

  return async function handler(req, res) {
    const started = Date.now();
    const info = { request_id: null, error_code: null };
    let status = 500;
    let pathname = null;
    try {
      const url = new URL(req.url, 'http://gateway.local');
      pathname = url.pathname;
      status = await route(req, res, url, info);
    } catch {
      if (!res.headersSent) status = send(res, 500, { error: 'INTERNAL_ERROR' });
    } finally {
      if (accessLog) {
        try {
          accessLog({
            ts: new Date().toISOString(),
            component: 'edl-gateway-http',
            environment: gateway.environment ?? null,
            method: req.method,
            // path は既知の route 名だけ（任意の URL・query を記録しない）
            path: ['/health', '/version', '/ready', '/v1/decisions', '/v1/decision-types', '/v1/health'].includes(pathname) ? pathname : 'other',
            status,
            latency_ms: Date.now() - started,
            request_id: info.request_id,
            error_code: info.error_code,
          });
        } catch { /* ログの失敗で応答を変えない */ }
      }
    }
  };
}

/**
 * 起動。loopback 以外への bind は token 必須（無ければ throw して起動しない）。
 * 返り値の server.address() で実ポートを得る（port 0 = 空きポート）。
 * server.shutdown({ timeoutMs }) で graceful shutdown（受付停止 → 進行中の decision を abort → timeout 後に接続を閉じる）。
 */
export function startGatewayServer({ gateway, host = '127.0.0.1', port = 8787, token = null, maxBodyBytes, rateLimitPerMin = 0, accessLog = null, release = null } = {}) {
  if (!isLoopbackHost(host) && !token) {
    throw new Error('refusing to bind a non-loopback host without EDL_GATEWAY_TOKEN (Human-only: issue and set the token first)');
  }
  let draining = false;
  const shutdown = new AbortController();
  const server = createServer(createGatewayHttpHandler({
    gateway, token, maxBodyBytes, rateLimitPerMin, accessLog, release, isDraining: () => draining, shutdownSignal: shutdown.signal,
  }));

  /** @returns {Promise<{ forced: boolean }>} forced=true は timeout で残りの接続を切った */
  server.shutdown = function gracefulShutdown({ timeoutMs = 10000 } = {}) {
    if (draining) return server._shutdownPromise;
    draining = true;
    server._shutdownPromise = new Promise((resolve) => {
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        server.closeAllConnections?.();
      }, timeoutMs);
      timer.unref?.();
      server.close(() => { clearTimeout(timer); resolve({ forced }); });
      // 待機中の keep-alive 接続は今すぐ閉じ、進行中の decision は SHUTDOWN で止める（FB-01 の abort 経路。送信済みの Jev は usage に残る）
      server.closeIdleConnections?.();
      shutdown.abort('SHUTDOWN');
    });
    return server._shutdownPromise;
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
