/**
 * Dropbox の資格情報を Keychain から読む（2026-11-13）。service：E-NEXUS/edl/<name>・account：e-nexus（deploy/macos/keychain-edl.sh と同じ）。
 * 値は表示しない・引数に置かない。無い（exit 44）＝その role は未接続（not_configured）。
 */
import { spawnSync } from 'node:child_process';
import { KEYCHAIN_NAMES } from './client.mjs';

export function readKeychainValue(name, { run = spawnSync } = {}) {
  const r = run('/usr/bin/security', ['find-generic-password', '-s', `E-NEXUS/edl/${name}`, '-a', 'e-nexus', '-w'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  const v = String(r.stdout ?? '').replace(/\n$/, '');
  return /^[A-Za-z0-9._~+/=-]{8,512}$/.test(v) ? v : null;
}

/** role の資格情報（{ appKey, refreshToken }）か null */
export function dropboxCredentials(role, opts) {
  const n = KEYCHAIN_NAMES[role];
  if (!n) return null;
  const appKey = readKeychainValue(n.appKey, opts);
  const refreshToken = appKey ? readKeychainValue(n.refreshToken, opts) : null;
  return appKey && refreshToken ? { appKey, refreshToken } : null;
}
