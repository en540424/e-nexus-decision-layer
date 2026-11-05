/**
 * 外部の死活監視へ生存信号を送る（2026-11-05・H6）。host-health の --heartbeat の 1 回分の最後に動く。AI／課金なし。
 *
 * 送るのは時刻と HMAC だけ（本文なし・ホストの情報なし）。URL と token は Keychain（E-NEXUS/edl/heartbeat-url・heartbeat-token）だけに置く。
 * 無ければ何もしない（off）。https だけ・redirect に従わない。失敗しても 1 回分の監視は失敗にしない（続いた時だけ heartbeat の WARN）。
 * 受け側は deploy/vps-heartbeat/receiver.mjs。
 */
import { createHmac } from 'node:crypto';
import { readCredential } from './env-file.mjs';

export const HEARTBEAT_URL = 'E-NEXUS/edl/heartbeat-url';
export const HEARTBEAT_TOKEN = 'E-NEXUS/edl/heartbeat-token';
export const HEARTBEAT_LIMITS = Object.freeze({ fail_hours: 6 });
const TOKEN = /^[0-9a-f]{64}$/;

/** 戻り値：off／sent／config_invalid／rejected（認証が合わない）／failed */
export async function sendHeartbeat({ read = readCredential, fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 6000 } = {}) {
  let url;
  let token;
  try {
    [url, token] = await Promise.all([read(HEARTBEAT_URL), read(HEARTBEAT_TOKEN)]);
  } catch {
    return 'failed';
  }
  if (!url || !token) return 'off';
  let target;
  try {
    target = new URL(url);
  } catch {
    return 'config_invalid';
  }
  if (target.protocol !== 'https:' || !TOKEN.test(token)) return 'config_invalid';
  const ts = String(clock());
  try {
    const res = await fetchImpl(target.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'x-edl-ts': ts, 'x-edl-sig': createHmac('sha256', token).update(ts).digest('hex') } });
    return res.status === 204 ? 'sent' : res.status === 404 ? 'rejected' : 'failed';
  } catch {
    return 'failed';
  }
}

/** 状態の項目。prev は state の heartbeat（{ code, fail_since }）。off は項目にしない */
export function heartbeatItem(prev, now) {
  if (!prev || prev.code === 'off') return null;
  const failing = prev.code !== 'sent';
  const old = failing && prev.fail_since && Date.parse(now) - Date.parse(prev.fail_since) >= HEARTBEAT_LIMITS.fail_hours * 3_600_000;
  return { id: 'heartbeat', level: old || prev.code === 'config_invalid' ? 'warn' : 'ok', value: prev.code, kind: 'state' };
}

export function nextHeartbeat(code, prev, now) {
  return { code, fail_since: code === 'sent' || code === 'off' ? null : (prev?.fail_since ?? now) };
}
