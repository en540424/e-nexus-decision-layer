/**
 * E-NEXUS Consumer Integration Kit：Node 用 HTTP transport の reference implementation（2026-09-29・FB-05）。
 * deploy された HTTP Gateway（staging / production、または dev の loopback）へ Contract v1 の request を送る。
 * CLI transport（cli-transport.mjs）と同じく、throw せず fail-closed の envelope を返す。docs/gateway.md §9-4。
 *
 * 持つもの（transport 契約）：
 *   - POST <baseUrl>/v1/decisions・Authorization: Bearer <token>・Content-Type: application/json
 *   - https 必須（loopback の http だけ例外）。token は引数で受け取り、ログ・エラーへ出さない
 *   - expected_environment をこの transport の環境で上書きし、envelope の gateway.environment を照合（違えば ENVIRONMENT_MISMATCH）
 *   - timeout（既定 35s＝Gateway 側 30s より長い）。自動再試行はしない（Gateway の timeout 時点で送信済みの Decision Engine 呼び出しは課金され得る。
 *     再試行するかは consumer が failure.retryable と自分の事情で決める）
 *   - 401・403・429・5xx・非 JSON・非 v1 は fail-closed（human-required）
 * 持たないもの（consumer 固有）：input の組み立て・outcome の正規化・Decision Point の検出・承認系
 *
 * 使い方：新しい Node consumer はこのファイルをコピーして持つ（repo をまたぐ runtime import はしない）。版は KIT_VERSION。
 */
export const KIT_VERSION = '1';
export const CONTRACT_VERSION = '1';
export const DEFAULT_TIMEOUT_MS = 35000;
export const RUNTIME_ENVIRONMENTS = Object.freeze(['dev', 'staging', 'production']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function unavailableEnvelope(code, request, { kind = 'gateway_unreachable', retryable = true } = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    ok: false,
    request_id: request?.request_id ?? null,
    correlation_id: request?.correlation_id ?? null,
    decision: null,
    error: { code, kind, retryable },
    failure: { policy: 'human-required', human_required: true, proceed_automatically: false },
    gateway: null,
  };
}

/** baseUrl が使えるか（https、または loopback の http）。dev 以外で http は不可 */
export function checkBaseUrl(baseUrl, environment) {
  let u;
  try { u = new URL(baseUrl); } catch { return { ok: false, code: 'GATEWAY_URL_INVALID' }; }
  const loopback = LOOPBACK_HOSTS.has(u.hostname) || LOOPBACK_HOSTS.has(`[${u.hostname}]`);
  if (u.protocol === 'https:') return { ok: true, url: u };
  if (u.protocol === 'http:' && loopback && environment === 'dev') return { ok: true, url: u };
  return { ok: false, code: 'GATEWAY_URL_INSECURE' };
}

export function verifyEnvelope(envelope, expectedEnvironment, request = null) {
  if (!envelope || typeof envelope !== 'object' || envelope.contract_version !== CONTRACT_VERSION || typeof envelope.ok !== 'boolean') {
    return unavailableEnvelope('GATEWAY_BAD_RESPONSE', request);
  }
  if (!envelope.ok) return envelope;
  if (!envelope.decision || typeof envelope.decision !== 'object') return unavailableEnvelope('GATEWAY_BAD_RESPONSE', request);
  if (envelope.gateway?.environment !== expectedEnvironment) {
    return unavailableEnvelope('ENVIRONMENT_MISMATCH', envelope, { kind: 'environment_mismatch', retryable: false });
  }
  return envelope;
}

/**
 * @param {object} o
 * @param {string} o.baseUrl 例 https://gateway.example.internal
 * @param {string} o.token Bearer token（環境ごとに別）
 * @param {'dev'|'staging'|'production'} o.environment この transport が想定する実行環境
 * @param {number} [o.timeoutMs]
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createHttpTransport({ baseUrl, token, environment, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  async function call(request) {
    if (!RUNTIME_ENVIRONMENTS.includes(environment)) return unavailableEnvelope('ENVIRONMENT_UNKNOWN', request, { kind: 'environment_config', retryable: false });
    const base = checkBaseUrl(baseUrl, environment);
    if (!base.ok) return unavailableEnvelope(base.code, request, { kind: 'environment_config', retryable: false });
    if (typeof token !== 'string' || token.length === 0) return unavailableEnvelope('GATEWAY_TOKEN_MISSING', request, { kind: 'environment_config', retryable: false });
    if (typeof fetchImpl !== 'function') return unavailableEnvelope('GATEWAY_FETCH_UNAVAILABLE', request, { kind: 'environment_config', retryable: false });
    const req = { ...request, contract_version: CONTRACT_VERSION, expected_environment: environment };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(new URL('/v1/decisions', base.url).href, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (err) {
      return unavailableEnvelope(err?.name === 'AbortError' ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE', req);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.status === 401 || res.status === 403) return unavailableEnvelope('GATEWAY_UNAUTHORIZED', req, { kind: 'environment_config', retryable: false });
    // 429 は Gateway の envelope（GATEWAY_BUSY）か、入口の rate limit（{error:'RATE_LIMITED'}）のどちらか
    if (res.status === 429 && body?.contract_version !== CONTRACT_VERSION) return unavailableEnvelope('GATEWAY_RATE_LIMITED', req, { kind: 'busy', retryable: true });
    return verifyEnvelope(body, environment, req);
  }

  return { call, environment };
}
