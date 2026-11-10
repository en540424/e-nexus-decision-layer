#!/usr/bin/env node
/**
 * VPS の受け口（deploy/vps-task-intake）と Mac の Task Hub の間を運ぶ（2026-11-09・MA-24）。outbound だけ。AI／課金なし。
 *
 *   node scripts/task-intake-sync.mjs pull --inbox <dir> [--channel vps-intake] [--max 50]
 *   node scripts/task-intake-sync.mjs push --outbox <dir> --sent <dir> [--channel vps-intake]
 *
 * URL と channel の鍵は Keychain（E-NEXUS/edl/task-intake-url・E-NEXUS/edl/task-intake-<channel>。入れるのは Human）だけから読む。
 * どちらか無ければ `not_configured` を出して 0 で終わる（休眠）。結果はコードと件数だけで、鍵・本文は出さない。
 * exit：0＝休眠か成功（鍵が無い・届かなかった物が outbox に残るのは失敗にしない）／1＝通信か設定の失敗・inbox へ置けなかった封・VPS に残してある封（kept）がある／2＝引数の誤り
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE } from './lib/task-hub/wire.mjs';
import { PULL_OFFSET_MAX, ack, keyFromHex, normalizeBase, pull, pushStatuses, requestClock, writeInbox } from './lib/task-hub/vps-client.mjs';

const MAX_PAGES = 10; // 1 回の pull で進むページ数の上限（残してある封を飛び越える分）
const ACCOUNT = 'e-nexus'; // scripts/lib/env-file.mjs の readCredential と同じ
export const KEYCHAIN_URL = 'E-NEXUS/edl/task-intake-url';
export const keychainKeyTarget = (channel) => `E-NEXUS/edl/task-intake-${channel}`;

/** Keychain から 1 つ読む（macOS）。無ければ null。10 秒で切る */
export function readKeychain(service) {
  if (!/^E-NEXUS\/edl\/[a-z0-9-]{1,64}$/.test(service)) return null;
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return null;
  const v = String(r.stdout ?? '').trim();
  return v === '' ? null : v;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith('--') || rest[i + 1] === undefined) return { error: 'usage' };
    opts[k.slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

/** 本体。keychain・fetchImpl・now を差し替えて test する。{ code, exit, ...件数 } を返す */
export async function runSync({ argv, keychain = readKeychain, fetchImpl, now = Date.now }) {
  const parsed = parseArgs(argv);
  if (parsed.error || !['pull', 'push'].includes(parsed.command)) return { code: 'usage', exit: 2 };
  const { command, opts } = parsed;
  const channel = opts.channel ?? 'vps-intake';
  if (!ID_RE.test(channel)) return { code: 'usage', exit: 2 };
  if (command === 'pull' && !opts.inbox) return { code: 'usage', exit: 2 };
  if (command === 'push' && (!opts.outbox || !opts.sent)) return { code: 'usage', exit: 2 };
  const baseUrl = keychain(KEYCHAIN_URL);
  const keyHex = keychain(keychainKeyTarget(channel));
  if (!baseUrl || !keyHex) return { code: 'not_configured', exit: 0 };
  const key = keyFromHex(keyHex);
  if (!key || !normalizeBase(baseUrl)) return { code: 'config_invalid', exit: 1 };
  const common = { baseUrl: baseUrl.trim(), key, fetchImpl, now, stamp: requestClock(now) }; // 1 回の運びの全部の要求で時刻を進める（同じ ms の 2 ページ目・2 回目の ack を再送と見なされない）

  if (command === 'pull') {
    const max = opts.max === undefined ? 50 : Number(opts.max);
    const pageSize = Number.isInteger(max) && max >= 1 ? Math.min(max, 50) : 50;
    const total = { pulled: 0, written: 0, existing: 0, dropped_invalid: 0, failed: 0, deleted: 0, kept: 0 };
    let offset = 0;
    // 残している封（kept＝鍵・時刻・版の違いかもしれないので消さない）は VPS の queue の先頭に居座る＝後ろの有効な封が見えなくなる。残した数だけ読み飛ばして次のページへ進む（上限 MAX_PAGES）
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await pull({ ...common, max: pageSize, offset, channel });
      if (!r.ok) return { code: r.code, exit: 1, ...total };
      const w = writeInbox(r.records, path.resolve(opts.inbox));
      const done = [...w.written, ...w.existing, ...r.invalid]; // 置けた物と、捨てる物（検査に通らない封）だけ VPS から消す
      if (done.length) {
        const a = await ack({ ...common, nonces: done });
        if (!a.ok) return { code: a.code, exit: 1, ...total, pulled: total.pulled + r.records.length, written: total.written + w.written.length };
        total.deleted += a.deleted;
      }
      total.pulled += r.records.length;
      total.written += w.written.length;
      total.existing += w.existing.length;
      total.dropped_invalid += r.invalid_count;
      total.failed += w.failed;
      total.kept += r.kept_count;
      offset += r.kept_count + w.failed; // 消えなかった封の数だけ先頭に残る
      if (r.received < pageSize || offset >= PULL_OFFSET_MAX) break;
    }
    // kept があれば exit 1（止まっている依頼を、定期実行の失敗として見せる）
    return { code: 'pulled', exit: total.failed || total.kept ? 1 : 0, ...total };
  }

  const r = await pushStatuses({ ...common, outboxDir: path.resolve(opts.outbox), sentDir: path.resolve(opts.sent), channel });
  // 届かなかった物は outbox に残るので次の回で送り直す。通信の失敗だけ exit 1
  return { code: r.code ?? 'pushed', exit: (r.code && r.sent === 0 && r.kept > 0) || r.quarantined > 0 ? 1 : 0, sent: r.sent, kept: r.kept, invalid: r.invalid, rejected: r.rejected.length, quarantined: r.quarantined };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await runSync({ argv: process.argv.slice(2) });
  const { exit, ...rest } = result;
  console.log(JSON.stringify({ component: 'edl-task-intake-sync', ...rest }));
  process.exitCode = exit;
}
