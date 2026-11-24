/**
 * Dropbox の資格情報を Keychain から読む（2026-11-13）。service：E-NEXUS/edl/<name>・account：e-nexus（deploy/macos/keychain-edl.sh と同じ）。
 * 値は表示しない・引数に置かない。無い（exit 44）＝その role は未接続（not_configured）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findOp, loadProviderMap, ProviderError, readOnePasswordSync, routeOf } from '../credential-provider.mjs';
import { KEYCHAIN_NAMES } from './client.mjs';

const VALUE_RE = /^[A-Za-z0-9._~+/=-]{8,512}$/;
export function readKeychainValue(name, { run = spawnSync, providerMap, opPath } = {}) {
  // 将来の 1Password（2026-11-24）：対応表に書いた名前だけ 1Password から。読めなければ null（未接続と同じ＝Dropbox の task は止まる側）
  let route;
  try { route = routeOf(`E-NEXUS/edl/${name}`, providerMap ?? loadProviderMap()); } catch { return null; }
  if (route.provider === '1password') {
    try { const v = readOnePasswordSync(route.ref, { spawn: run, opPath: opPath === undefined ? findOp({ exists: existsSync }) : opPath }); return VALUE_RE.test(v) ? v : null; } catch (e) { if (e instanceof ProviderError) return null; throw e; }
  }
  const r = run('/usr/bin/security', ['find-generic-password', '-s', `E-NEXUS/edl/${name}`, '-a', 'e-nexus', '-w'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  const v = String(r.stdout ?? '').replace(/\n$/, '');
  return VALUE_RE.test(v) ? v : null;
}

/** role の資格情報（{ appKey, refreshToken }）か null */
export function dropboxCredentials(role, opts) {
  const n = KEYCHAIN_NAMES[role];
  if (!n) return null;
  const appKey = readKeychainValue(n.appKey, opts);
  const refreshToken = appKey ? readKeychainValue(n.refreshToken, opts) : null;
  return appKey && refreshToken ? { appKey, refreshToken } : null;
}
