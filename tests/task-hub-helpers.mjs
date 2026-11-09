/**
 * Task Hub の test 用の道具（2026-11-09・MA-24）。合成の id だけ（biz-a・biz-b・bot-front・bot-research）。通信なし・Keychain なし。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HANDLERS } from '../scripts/lib/task-hub/handlers.mjs';
import { createPolicy, defaultGateway, loadCatalog, validateConfig } from '../scripts/lib/task-hub/policy.mjs';
import { openStore } from '../scripts/lib/task-hub/store.mjs';
import { sealRecord } from '../scripts/lib/task-hub/wire.mjs';

export const NOW = Date.parse('2026-11-09T09:00:00.000Z');
export const KEY_A = Buffer.alloc(32, 0xa1);
export const KEY_B = Buffer.alloc(32, 0xb2);
export const KEYS = { 'chan-front': KEY_A, 'chan-research': KEY_B };
export const keyFor = (channel) => KEYS[channel] ?? null;

export const baseConfig = (over = {}) => validateConfig({
  sources: {
    'bot-front': { channels: ['chan-front'], businesses: ['biz-a', 'biz-b'] },
    'bot-research': { channels: ['chan-research'], businesses: ['biz-b'], intents: ['status.query', 'note.record'] },
    'human-cli': { channels: ['local-cli'], businesses: ['biz-a', 'biz-b'] },
  },
  businesses: ['biz-a', 'biz-b'],
  ...over,
});

export const gateway = defaultGateway();

/** 一時フォルダの store・policy・inbox。clock は tick() で進める */
export function makeEnv({ config = {}, gw = gateway } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'task-hub-test-'));
  const clock = { t: NOW };
  const store = openStore(path.join(root, 'store'), { now: () => clock.t });
  const cfg = baseConfig(config);
  const policy = createPolicy({ catalog: loadCatalog(), config: cfg, gateway: gw });
  const inbox = path.join(root, 'inbox');
  mkdirSync(inbox, { recursive: true });
  return { root, clock, store, policy, config: cfg, inbox, handlers: HANDLERS, tick: (ms) => { clock.t += ms; return clock.t; } };
}

let seq = 0;
export const keyId = (label = 'k') => `${label}-${String(++seq).padStart(6, '0')}-abcd`;
export const envelope = (over = {}) => ({ v: 1, idempotency_key: keyId(), business: 'biz-a', intent: 'status.query', params: {}, ...over });

/** 封を作る（VPS の受け口の役）。source・channel は封を作る側が決める */
export function seal(env, { channel = 'chan-front', source = 'bot-front', key = KEY_A, received_at = NOW, nonce } = {}) {
  return sealRecord(key, { channel, source, received_at, body: typeof env === 'string' ? env : JSON.stringify(env), ...(nonce ? { nonce } : {}) });
}
export function dropInbox(dir, name, record) {
  writeFileSync(path.join(dir, name), JSON.stringify(record), { mode: 0o600 });
}
