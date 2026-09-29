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
 *
 * 2026-09-29 再確認（docs.typesafe.ai/api.md・/models.md。TypeSafe Direct を正式経路とし、Vercel 経路を廃止）:
 *   endpoint・Bearer 認証・request {model, state, questions}・noul criteria {true,false} optional は上記と同じ。
 *   応答の `model` は「実際に答えた版付きID」（例 jev-1.13.0。jev-latest / jev-preview は alias）→ jev-adapter が model_version に写す。
 *   choice / score は probabilities と confidence、score は legend も返す（legend は使わない）。
 *   課金は入力 token のみ（公表値。registries/models.json）・rate limit 1,200 req/min（公表値・予告なく変わる）。
 *   鍵は console.typesafe.ai/keys（Jev は early access 表記）。公式 SDK の変数名は TYPESAFE_API_KEY だが、ここでは
 *   engine-env manifest と consumer 側の除去対象に揃えるため JEV_API_KEY だけを読む。
 *   公式に記載の無い 400 / 402 / 403 は推測で再試行せず止める：400 は 422 と同じ JEV_REQUEST_REJECTED、
 *   402 は JEV_PAYMENT_REQUIRED、403 は JEV_FORBIDDEN（鍵は通ったがアカウント・early access・モデル権限で拒否）。
 * 依存ゼロ方針を維持するため @typesafe-ai/sdk は使わず、Node 20+ 組み込みの fetch / AbortController だけで実装する。
 * SDK既定値と同等の挙動（timeout 10s/attempt・maxRetries 2・backoff 500ms→最大5000ms・jitter・Retry-After上限60s）を
 * 自前で再現する（値は SDK ドキュメントの既定値であり、コードでは調整可能な定数として置く。ベンダー数値を仕様として固定しない）。
 */
import { AdapterUnavailableError, abortReasonOf } from '../../core/errors.mjs';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5000;
const BACKOFF_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60000;

/** backoff 待機。外部 signal が abort したら待たずに戻る（2026-09-29 FB-01。戻った後に呼び出し側が signal を見て止まる） */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 外部 signal（Gateway timeout・client 切断）による中断。再試行しない。networked＝この send() の中で1回でも送信したか */
function abortedError(networked, signal) {
  return new AdapterUnavailableError('jev', 'JEV_ABORTED', { route: 'direct', retryable: false, networked, abort_reason: abortReasonOf(signal) });
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
  if (res.status === 402) {
    throw new AdapterUnavailableError('jev', 'JEV_PAYMENT_REQUIRED', { route: 'direct', networked: true, status: 402, retryable: false });
  }
  if (res.status === 403) {
    throw new AdapterUnavailableError('jev', 'JEV_FORBIDDEN', { route: 'direct', networked: true, status: 403, retryable: false });
  }
  if (res.status === 422 || res.status === 400) {
    const body = await safeJson(res);
    throw new AdapterUnavailableError('jev', 'JEV_REQUEST_REJECTED', {
      route: 'direct', networked: true,
      status: res.status,
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

/**
 * noul の criteria（x-boolean-criteria 由来）：公式 API（docs.typesafe.ai/api.md・2026-09-29 Fable追加レビューP D6 で確認）で
 * Noul の `criteria: { true, false }` は optional として対応済み。以前は「仕様未確認」で strip していたが、当時の Vercel 経路と同じ
 * 質問を Direct にも送るため、true / false が両方 string の正しい形のときだけ送る（形が崩れたものは送らない＝推測で補わない）。
 */
export function toDirectRequest(request) {
  const questions = Object.fromEntries(Object.entries(request?.questions ?? {}).map(([k, q]) => {
    if (q?.type !== 'noul' || !('criteria' in q)) return [k, q];
    const c = q.criteria;
    if (c && typeof c.true === 'string' && typeof c.false === 'string') return [k, { ...q, criteria: { true: c.true, false: c.false } }];
    const { criteria, ...rest } = q; // eslint-disable-line no-unused-vars
    return [k, rest];
  }));
  return { ...request, questions };
}

async function attemptOnce({ fetchImpl, url, apiKey, request, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 外部 signal（2026-09-29 FB-01）：Gateway が timeout したら in-flight の fetch も止める（止めないと同時実行上限を実質超える）
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
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
    // 外部 signal による中断は per-attempt timeout（JEV_TIMEOUT・再試行する）と分ける。fetch は発行済み＝networked
    if (signal?.aborted) throw abortedError(true, signal);
    if (err instanceof AdapterUnavailableError) throw err;
    const isAbort = err?.name === 'AbortError';
    throw new AdapterUnavailableError('jev', isAbort ? 'JEV_TIMEOUT' : 'JEV_NETWORK_ERROR', { route: 'direct', retryable: true, networked: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  テスト用に注入する fetch 実装（既定: globalThis.fetch）
 * @param {(ms:number, signal?:AbortSignal)=>Promise<void>} [opts.sleepImpl]  テスト用に注入するバックオフ待機（既定: 実時間 setTimeout・abort で早期復帰）
 *
 * send({ request, env, meta, signal }) の signal（任意・2026-09-29 FB-01）：abort されたら in-flight の fetch とバックオフ待機を止め、
 * 再試行せず JEV_ABORTED を投げる（networked＝この send() の中で1回でも送信したか。送信前の中断は false＝課金なしが確定）。
 */
export function createDirectJevProvider({ fetchImpl = globalThis.fetch, sleepImpl = defaultSleep } = {}) {
  return {
    id: 'direct',
    available(env) {
      if (!env.JEV_API_KEY) return { ok: false, reason: 'JEV_API_KEY_MISSING' };
      return { ok: true };
    },
    async send({ request, env, meta, signal }) {
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
        if (signal?.aborted) throw abortedError(attempt > 0, signal);
        if (meta && typeof meta === 'object') meta.retry_count = attempt;
        try {
          // eslint-disable-next-line no-await-in-loop
          return await attemptOnce({ fetchImpl, url, apiKey: env.JEV_API_KEY, request, timeoutMs, signal });
        } catch (err) {
          lastError = err;
          const retryable = err instanceof AdapterUnavailableError && err.details.retryable === true;
          if (!retryable || attempt === DEFAULT_MAX_RETRIES) throw err;
          const retryAfterMs = err.details.retryAfterMs;
          const delay = typeof retryAfterMs === 'number' ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : backoffDelayMs(attempt);
          // eslint-disable-next-line no-await-in-loop
          await sleepImpl(delay, signal);
        }
      }
      throw lastError ?? new AdapterUnavailableError('jev', 'JEV_UNKNOWN_ERROR', { route: 'direct' });
    },
  };
}
