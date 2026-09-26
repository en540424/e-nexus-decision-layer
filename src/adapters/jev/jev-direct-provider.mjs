/**
 * TypeSafe Direct Provider — 実装（2026-09-19、Jev公式API仕様確認済み）。
 *
 * ここは「経路（transport）だけ」を持つ。HTTPで送る request（{model, state, questions}）の組み立てと
 * 応答の型付き変換は jev-adapter.mjs（変換層）の責務であり、ここでは触らない。
 *
 * 確認済み仕様（一次情報。2026-09-19 MA-30開発ログ「Jev公式API仕様の確定」節を正本とする。ここでは再掲のみ）:
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <JEV_API_KEY>
 *   Content-Type: application/json
 * エラー: 401（キー無効・再試行しない）／422（body検証失敗・再試行しない）／429（rate limit）／
 *         408・5xx・529（overloaded）は指数バックオフで再試行、Retry-After（秒）/retry-after-ms を尊重。
 * 依存ゼロ方針を維持するため @typesafe-ai/sdk は使わず、Node 20+ 組み込みの fetch / AbortController だけで実装する。
 * SDK既定値と同等の挙動（timeout 10s/attempt・maxRetries 2・backoff 500ms→最大5000ms・jitter・Retry-After上限60s）を
 * 自前で再現する（値は SDK ドキュメントの既定値であり、コードでは調整可能な定数として置く。ベンダー数値を仕様として固定しない）。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5000;
const BACKOFF_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_INITIAL_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return base - base * BACKOFF_JITTER * random();
}

/** `Retry-After`（秒）または `retry-after-ms` ヘッダをミリ秒へ。無ければ null */
function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const afterMs = headers.get('retry-after-ms');
  if (afterMs !== null && afterMs !== undefined) {
    const n = Number(afterMs);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const after = headers.get('retry-after');
  if (after !== null && after !== undefined) {
    const n = Number(after);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return null;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** HTTPレスポンスを分類し、成功なら raw JSON を返し、失敗なら AdapterUnavailableError を投げる（details.retryable で再試行可否を示す） */
async function classifyResponse(res) {
  if (res.status === 401) {
    throw new AdapterUnavailableError('jev', 'JEV_AUTH_FAILED', { route: 'direct', networked: true, status: 401, retryable: false });
  }
  if (res.status === 422) {
    const body = await safeJson(res);
    throw new AdapterUnavailableError('jev', 'JEV_REQUEST_REJECTED', {
      route: 'direct', networked: true,
      status: 422,
      problem: body?.error?.field ?? body?.field ?? null,
      retryable: false,
    });
  }
  if (res.status === 429) {
    throw new AdapterUnavailableError('jev', 'JEV_RATE_LIMITED', {
      route: 'direct', networked: true, status: 429, retryable: true, retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }
  if (res.status === 408 || res.status === 529 || (res.status >= 500 && res.status <= 599)) {
    throw new AdapterUnavailableError('jev', 'JEV_OVERLOADED', {
      route: 'direct', networked: true, status: res.status, retryable: true, retryAfterMs: parseRetryAfterMs(res.headers),
    });
  }
  if (!res.ok) {
    throw new AdapterUnavailableError('jev', 'JEV_HTTP_ERROR', { route: 'direct', networked: true, status: res.status, retryable: false });
  }
  const json = await safeJson(res);
  if (json === null || typeof json !== 'object') {
    throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { route: 'direct', networked: true, detail: 'invalid JSON body', retryable: false });
  }
  return json;
}

/** noul の criteria（x-boolean-criteria 由来。Vercel Gateway の boolean criteria 用）は Direct API の仕様で未確認のため送らない */
export function toDirectRequest(request) {
  const questions = Object.fromEntries(Object.entries(request?.questions ?? {}).map(([k, q]) => {
    if (q?.type !== 'noul' || !('criteria' in q)) return [k, q];
    const { criteria, ...rest } = q; // eslint-disable-line no-unused-vars
    return [k, rest];
  }));
  return { ...request, questions };
}

async function attemptOnce({ fetchImpl, url, apiKey, request, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(toDirectRequest(request)),
      signal: controller.signal,
    });
    return await classifyResponse(res);
  } catch (err) {
    if (err instanceof AdapterUnavailableError) throw err;
    const isAbort = err?.name === 'AbortError';
    throw new AdapterUnavailableError('jev', isAbort ? 'JEV_TIMEOUT' : 'JEV_NETWORK_ERROR', { route: 'direct', retryable: true, networked: true });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  テスト用に注入する fetch 実装（既定: globalThis.fetch）
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl]  テスト用に注入するバックオフ待機（既定: 実時間 setTimeout）
 */
export function createDirectJevProvider({ fetchImpl = globalThis.fetch, sleepImpl = defaultSleep } = {}) {
  return {
    id: 'direct',
    available(env) {
      if (!env.JEV_API_KEY) return { ok: false, reason: 'JEV_API_KEY_MISSING' };
      return { ok: true };
    },
    async send({ request, env, meta }) {
      // Adapter 側で EDL_ALLOW_NETWORK / JEV_API_KEY を既にチェックしているが、
      // Provider が単独で呼ばれても迂回できないよう、ここでも同じゲートを再確認する（二重チェック）。
      if (env.EDL_ALLOW_NETWORK !== 'true') {
        throw new AdapterUnavailableError('jev', 'NETWORK_DISABLED', { route: 'direct' });
      }
      if (!env.JEV_API_KEY) {
        throw new AdapterUnavailableError('jev', 'JEV_API_KEY_MISSING', { route: 'direct' });
      }
      if (typeof fetchImpl !== 'function') {
        throw new AdapterUnavailableError('jev', 'JEV_FETCH_UNAVAILABLE', { route: 'direct' });
      }

      const baseUrl = (env.JEV_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
      const url = `${baseUrl}/v1/systemone`;
      const timeoutMs = Number(env.JEV_TIMEOUT_MS) > 0 ? Number(env.JEV_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

      let lastError = null;
      for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
        // attempt metering：ここで実際に送信する。retry_count は「再送した回数」（初回は 0）。meta を渡さない呼び出しでも動く
        if (meta && typeof meta === 'object') meta.retry_count = attempt;
        try {
          // eslint-disable-next-line no-await-in-loop
          return await attemptOnce({ fetchImpl, url, apiKey: env.JEV_API_KEY, request, timeoutMs });
        } catch (err) {
          lastError = err;
          const retryable = err instanceof AdapterUnavailableError && err.details.retryable === true;
          if (!retryable || attempt === DEFAULT_MAX_RETRIES) throw err;
          const retryAfterMs = err.details.retryAfterMs;
          const delay = typeof retryAfterMs === 'number' ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : backoffDelayMs(attempt);
          // eslint-disable-next-line no-await-in-loop
          await sleepImpl(delay);
        }
      }
      throw lastError ?? new AdapterUnavailableError('jev', 'JEV_UNKNOWN_ERROR', { route: 'direct' });
    },
  };
}
