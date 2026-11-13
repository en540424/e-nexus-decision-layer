/**
 * 業務の handler に渡す services（2026-11-13）。Keychain は Dropbox の handler が実際に動く時にだけ読む（他の依頼では読まない）。
 * 置き場所：business_backup_dir（local config・既定 ~/e-nexus-runtime/business-backups＝Dropbox の同期の外・Mac Runtime の GitHub のバックアップの対象の外）
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { createDropbox } from '../dropbox/client.mjs';
import { dropboxCredentials } from '../dropbox/keychain.mjs';

export const DEFAULT_BUSINESS_DIR = path.join(homedir(), 'e-nexus-runtime', 'business-backups');

export function businessServices(config = {}, { credentials = dropboxCredentials, create = createDropbox } = {}) {
  const dir = typeof config.business_backup_dir === 'string' && path.isAbsolute(config.business_backup_dir) ? config.business_backup_dir : DEFAULT_BUSINESS_DIR;
  const cache = new Map();
  return {
    backupDir: dir,
    historyDir: dir,
    dropbox(role) {
      if (!cache.has(role)) {
        const c = credentials(role);
        if (!c) { const e = new Error('not_configured'); e.code = 'not_configured'; throw e; }
        cache.set(role, create({ role, credentials: c }));
      }
      return cache.get(role);
    },
  };
}
