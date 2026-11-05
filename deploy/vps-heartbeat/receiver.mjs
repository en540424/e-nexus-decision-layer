#!/usr/bin/env node
/**
 * Mac mini の外部死活監視の受け側（2026-11-05・H6）。VPS で動く。依存なし・1 ファイル・AI／課金なし。導入は Human（README.md）。
 *
 *   node receiver.mjs     env：HEARTBEAT_TOKEN・DISCORD_WEBHOOK_URL・[HEARTBEAT_PORT=8791]・[HEARTBEAT_STATE=/var/lib/e-nexus-heartbeat/state.json]
 *
 * loopback だけで待ち、POST /hb の HMAC が合う時だけ最後の受信時刻を更新する。それ以外は全部 404（何があるかを教えない）。送信元・本文は記録しない。
 * 通知：LIMIT_MS 途絶えたら 1 回・戻ったら 1 回・正常時はなし。24 時間に 2 回途絶えたら「繰り返し」を 1 通送り、24 時間は静かにする。
 * 原因は断定しない（電源・回線・Mac の監視の停止は区別できない）。送れなければ RETRY_MS ごとにもう一度。
 * 一度も受信していない間は知らせない。VPS の再起動の後は起動から LIMIT_MS 待つ（VPS 側が止まっていた間を Mac の途絶と言わない）。
 * 限界：VPS 自身・Discord が止まると知らせられない。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const LIMIT_MS = 60 * MINUTE;
export const RETRY_MS = 5 * MINUTE;
export const SKEW_MS = 5 * MINUTE;
export const FLAP = Object.freeze({ window_ms: DAY, count: 2 });
const HEADER = '[E-NEXUS Mac Runtime 外部監視]';
export const TEXT = Object.freeze({
  down: `${HEADER}\n【重大】Mac mini：生存信号が 60 分以上届いていない（電源・回線・監視の停止のどれかは不明）→ 確認`,
  repeat: `${HEADER}\n【反復】Mac mini：生存信号の途絶を繰り返している（原因は不明）→ 確認。落ち着くまで通知を控える`,
  up: `${HEADER}\n【復旧】Mac mini：生存信号が戻った → 対応不要`,
});

export const initialState = (now) => ({ started_at: now, last_seen: null, last_ts: 0, down: false, alerted: false, hits: [], quiet_until: 0, pending: null, next_try: 0 });

/** 署名の検査。合えば ts（ms）。時刻のずれ・再送は拒む */
export function verifyBeat({ token, ts, sig, now, lastTs }) {
  const t = Number(ts);
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > SKEW_MS || t <= lastTs) return null;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = createHmac('sha256', token).update(String(t)).digest();
  return timingSafeEqual(want, Buffer.from(sig, 'hex')) ? t : null;
}

/** 受信の 1 回分。途絶を知らせていた時だけ回復を予約する（静かな間は予約しない） */
export function onBeat(s, { now, ts }) {
  const next = { ...s, last_seen: now, last_ts: ts };
  if (s.down) {
    next.down = false;
    if (s.alerted && now >= s.quiet_until) next.pending = 'up';
    else if (s.pending === 'down' || s.pending === 'repeat') next.pending = null; // 送れないうちに戻った：知らせる相手がいない途絶は捨てる
    next.alerted = false;
  }
  return next;
}

/** 毎分の判定。途絶の始まりを 1 回だけ数える */
export function onTick(s, { now }) {
  if (s.last_seen == null || s.down) return s;
  if (now - Math.max(s.last_seen, s.started_at) < LIMIT_MS) return s;
  const hits = [...s.hits.filter((h) => now - h < FLAP.window_ms), now];
  if (now < s.quiet_until) return { ...s, down: true, hits };
  const repeat = hits.length >= FLAP.count;
  return { ...s, down: true, alerted: true, hits, pending: repeat ? 'repeat' : 'down', quiet_until: repeat ? now + FLAP.window_ms : s.quiet_until, next_try: 0 };
}

/** 予約の送信。失敗は RETRY_MS 後にもう一度。state の pending が消えるのは送れた時だけ */
export async function flush(s, { now, send }) {
  if (!s.pending || now < s.next_try) return s;
  const ok = await send(TEXT[s.pending]).catch(() => false);
  return ok ? { ...s, pending: null, next_try: 0 } : { ...s, next_try: now + RETRY_MS };
}

export function discordSender({ url, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  return async (content) => {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
    return res.ok;
  };
}

function load(file, now) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { ...initialState(now), ...s, started_at: now }; // 起動し直した時は待ち直す
  } catch {
    return initialState(now);
  }
}
function save(file, s) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(s), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** 受け側の本体。clock・send を差し替えて test する。戻り値の tick を呼ぶと 1 回分の判定 */
export function startReceiver({ token, port, host = '127.0.0.1', stateFile, send, clock = Date.now }) {
  let state = load(stateFile, clock());
  const update = (s) => { state = s; save(stateFile, s); };
  update(state);
  const server = createServer((req, res) => {
    const deny = () => { res.writeHead(404).end(); };
    req.resume();
    if (req.method !== 'POST' || req.url !== '/hb') return deny();
    const now = clock();
    const ts = verifyBeat({ token, ts: req.headers['x-edl-ts'], sig: req.headers['x-edl-sig'], now, lastTs: state.last_ts });
    if (ts == null) return deny();
    update(onBeat(state, { now, ts }));
    return res.writeHead(204).end();
  });
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = clock();
      const decided = onTick(state, { now });
      if (decided !== state) update(decided);
      const sent = await flush(state, { now, send });
      if (sent !== state) update({ ...state, pending: sent.pending, next_try: sent.next_try }); // 送っている間の受信を失わない
    } finally {
      busy = false;
    }
  };
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, tick, port: server.address().port, state: () => state })));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const token = process.env.HEARTBEAT_TOKEN;
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!/^[0-9a-f]{64}$/.test(token ?? '') || !/^https:\/\/discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url ?? '')) {
    console.error('HEARTBEAT_TOKEN and DISCORD_WEBHOOK_URL are required');
    process.exit(2);
  }
  const r = await startReceiver({ token, port: Number(process.env.HEARTBEAT_PORT ?? 8791), stateFile: process.env.HEARTBEAT_STATE ?? '/var/lib/e-nexus-heartbeat/state.json', send: discordSender({ url }) });
  setInterval(() => { r.tick().catch(() => {}); }, MINUTE);
  console.log(JSON.stringify({ component: 'edl-heartbeat-receiver', status: 'listening' }));
}
