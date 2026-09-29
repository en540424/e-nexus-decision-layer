/**
 * Jev Provider（経路）Interface。
 *
 *   Decision Layer → Jev Adapter → Jev Provider（direct / cloudflare …）
 *
 * Jev Adapter は「decision_type → Jev向けリクエスト → AdapterResult」の変換だけを持ち、
 * どの経路で Jev に到達するかは Provider が担う。経路を足すときはこの契約を満たす1ファイルを追加し、
 * Adapter・Engine は変更しない。
 *
 *   provider = {
 *     id: 'direct' | 'cloudflare' | ...,
 *     available(env) -> { ok: boolean, reason?: string }   // キー名の有無など。値はログに出さない
 *     send({ request, env }) -> Promise<raw Jev response>  // ネットワーク送信はここだけ
 *   }
 *
 * direct（jev-direct-provider.mjs。TypeSafe Direct API）が正式経路（2026-09-29〜）。cloudflare は予約のみ（API仕様未確認のため推測実装しない）。
 * vercel（Vercel AI Gateway 経由）は Direct が使えるまでの暫定経路で、2026-09-29 に廃止・削除した（履歴は git の 88459ad 以前）。
 * env に JEV_PROVIDER=vercel が残っていても direct へ読み替えない（JEV_PROVIDER_UNKNOWN → Engine は次の Adapter / Human へ）。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';
import { createDirectJevProvider } from './jev-direct-provider.mjs';

export const JEV_PROVIDER_IDS = Object.freeze(['direct', 'cloudflare']);

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
  cloudflare: createCloudflareJevProvider,
}) {
  const id = env.JEV_PROVIDER || 'direct';
  const factory = registry[id];
  if (!factory) throw new AdapterUnavailableError('jev', 'JEV_PROVIDER_UNKNOWN', { route: id });
  return assertJevProviderShape(factory());
}
