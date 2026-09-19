/**
 * Jev Provider（経路）Interface。
 *
 *   Decision Layer → Jev Adapter → Jev Provider（direct / vercel / cloudflare …）
 *
 * Jev Adapter は「decision_type → Jev向けリクエスト → AdapterResult」の変換だけを持ち、
 * どの経路で Jev に到達するかは Provider が担う。経路を足すときはこの契約を満たす1ファイルを追加し、
 * Adapter・Engine は変更しない。
 *
 *   provider = {
 *     id: 'direct' | 'vercel' | 'cloudflare' | ...,
 *     available(env) -> { ok: boolean, reason?: string }   // キー名の有無など。値はログに出さない
 *     send({ request, env }) -> Promise<raw Jev response>  // ネットワーク送信はここだけ
 *   }
 *
 * 現時点で実装されている Provider は無い（すべて stub）。API仕様未確認のため推測実装しない。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

export const JEV_PROVIDER_IDS = Object.freeze(['direct', 'vercel', 'cloudflare']);

export function assertJevProviderShape(provider) {
  const problems = [];
  if (!provider || typeof provider !== 'object') problems.push('provider is not an object');
  else {
    if (typeof provider.id !== 'string' || !provider.id) problems.push('id missing');
    if (typeof provider.available !== 'function') problems.push('available() missing');
    if (typeof provider.send !== 'function') problems.push('send() missing');
  }
  if (problems.length) throw new Error(`invalid jev provider: ${problems.join(', ')}`);
  return provider;
}

/**
 * TypeSafe Direct 経路 — stub。
 * 必要なキー名は JEV_API_KEY（値は .env・Human設定）。API仕様が確定するまで send() は実装しない。
 */
export function createDirectJevProvider() {
  return {
    id: 'direct',
    available(env) {
      if (!env.JEV_API_KEY) return { ok: false, reason: 'JEV_API_KEY_MISSING' };
      return { ok: true };
    },
    async send({ request }) {
      throw new AdapterUnavailableError('jev', 'JEV_CLIENT_NOT_IMPLEMENTED', { route: 'direct', task: request?.task });
    },
  };
}

/** Vercel AI Gateway 経路 — 予約のみ（キー名・エンドポイント仕様は未確認） */
export function createVercelJevProvider() {
  return {
    id: 'vercel',
    available() {
      return { ok: false, reason: 'JEV_ROUTE_NOT_IMPLEMENTED' };
    },
    async send() {
      throw new AdapterUnavailableError('jev', 'JEV_ROUTE_NOT_IMPLEMENTED', { route: 'vercel' });
    },
  };
}

/** Cloudflare 経由（Workers / AI Gateway 等）— 予約のみ（仕様未確認） */
export function createCloudflareJevProvider() {
  return {
    id: 'cloudflare',
    available() {
      return { ok: false, reason: 'JEV_ROUTE_NOT_IMPLEMENTED' };
    },
    async send() {
      throw new AdapterUnavailableError('jev', 'JEV_ROUTE_NOT_IMPLEMENTED', { route: 'cloudflare' });
    },
  };
}

/** env.JEV_PROVIDER（既定 direct）から Provider を選ぶ。未知の値は direct にせず unavailable にする */
export function resolveJevProvider(env = process.env, registry = {
  direct: createDirectJevProvider,
  vercel: createVercelJevProvider,
  cloudflare: createCloudflareJevProvider,
}) {
  const id = env.JEV_PROVIDER || 'direct';
  const factory = registry[id];
  if (!factory) throw new AdapterUnavailableError('jev', 'JEV_PROVIDER_UNKNOWN', { route: id });
  return assertJevProviderShape(factory());
}
