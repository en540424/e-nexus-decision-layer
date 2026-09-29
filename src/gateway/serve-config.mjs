/**
 * HTTP Gateway（`gateway serve`）の起動設定の検証（2026-09-29・Full Autonomous Build FB-05：Production-capable Gateway）。
 *
 * 環境（EDL_ENVIRONMENT）ごとに「起動してよい条件」を決め、満たさなければ起動を拒否する（推測で補わない・fail-closed）。
 *
 *   dev        : 既定 127.0.0.1。loopback 以外へ bind するなら token 必須（従来どおり）。rate limit 既定 OFF
 *   staging /  : token 必須（32 文字以上・host に関係なく）・release.json 必須かつ EDL_EXPECTED_RELEASE と一致（pinned version：
 *   production   意図しない版で動かない）・mock-jev 禁止（gateway.mjs が強制）・rate limit 既定 600/分
 *
 * deploy・token 発行・EDL_ENVIRONMENT を staging / production にすること・常駐の登録は Human-only（技術スタック正本§3-8-7）。
 * この module は値を検証するだけで、Secret の値をログ・エラー文へ出さない。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { resolveRuntimeEnvironment, DEFAULT_RUNTIME_ENVIRONMENT } from '../core/environment.mjs';

export const RELEASE_FILE = 'release.json';
export const MIN_TOKEN_LENGTH = 32;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/;

/** repo 直下の release.json（scripts/gateway-release.mjs stamp が書く）。無い・壊れていれば null */
export function loadReleaseInfo(root = ROOT) {
  const p = join(root, RELEASE_FILE);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof r?.commit !== 'string' || !COMMIT_SHAPE.test(r.commit)) return null;
    return { commit: r.commit, version: typeof r.version === 'string' ? r.version : null, stamped_at: typeof r.stamped_at === 'string' ? r.stamped_at : null };
  } catch {
    return null;
  }
}

function positiveInt(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
}

/**
 * @param {object} a
 * @param {object} a.env process env
 * @param {string} [a.host]
 * @param {number|string} [a.port]
 * @param {{commit:string, version:string|null}|null} [a.release] loadReleaseInfo() の結果
 * @returns {{ ok: boolean, errors: string[], config: object }}
 */
export function resolveServeConfig({ env = process.env, host = '127.0.0.1', port = 8787, release = loadReleaseInfo() } = {}) {
  const errors = [];
  let environment;
  try {
    environment = resolveRuntimeEnvironment(env);
  } catch (err) {
    return { ok: false, errors: [err.message], config: null };
  }
  const token = typeof env.EDL_GATEWAY_TOKEN === 'string' && env.EDL_GATEWAY_TOKEN !== '' ? env.EDL_GATEWAY_TOKEN : null;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 0 || p > 65535) errors.push('port must be 0-65535');
  const loopback = LOOPBACK.has(String(host));
  const deployed = environment !== DEFAULT_RUNTIME_ENVIRONMENT;

  if (!loopback && !token) errors.push('non-loopback bind requires EDL_GATEWAY_TOKEN (Human-only: issue and set the token first)');
  if (deployed) {
    if (!token || token.length < MIN_TOKEN_LENGTH) errors.push(`${environment} requires EDL_GATEWAY_TOKEN of at least ${MIN_TOKEN_LENGTH} characters`);
    if (!release) errors.push(`${environment} requires ${RELEASE_FILE} (run scripts/gateway-release.mjs stamp on the deployed checkout)`);
    const expected = env.EDL_EXPECTED_RELEASE;
    if (!expected) errors.push(`${environment} requires EDL_EXPECTED_RELEASE (the commit this deployment is pinned to)`);
    else if (release && release.commit !== expected && !release.commit.startsWith(expected)) {
      errors.push(`${RELEASE_FILE} commit does not match EDL_EXPECTED_RELEASE (refusing to run an unpinned version)`);
    }
  }
  const rateLimitPerMin = positiveInt(env.EDL_GATEWAY_RATE_LIMIT_PER_MIN, deployed ? 600 : 0);
  if (Number.isNaN(rateLimitPerMin)) errors.push('EDL_GATEWAY_RATE_LIMIT_PER_MIN must be a non-negative integer');
  const drainTimeoutMs = positiveInt(env.EDL_GATEWAY_DRAIN_MS, 10000);
  if (Number.isNaN(drainTimeoutMs)) errors.push('EDL_GATEWAY_DRAIN_MS must be a non-negative integer');

  return {
    ok: errors.length === 0,
    errors,
    config: { environment, host: String(host), port: p, token, rateLimitPerMin, drainTimeoutMs, release: release ?? null },
  };
}
