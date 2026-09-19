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
 * direct は実装済み（jev-direct-provider.mjs、2026-09-19公式API仕様確認済み）。vercel / cloudflare は
 * 引き続き予約のみ（API仕様未確認のため推測実装しない）。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';
import { createDirectJevProvider } from './jev-direct-provider.mjs';

export const JEV_PROVIDER_IDS = Object.freeze(['direct', 'vercel', 'cloudflare']);

export { createDirectJevProvider };

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
