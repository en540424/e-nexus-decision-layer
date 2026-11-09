#!/usr/bin/env node
/**
 * Mac mini の外部死活監視の受け側（2026-11-05・H6）。VPS で動く。依存なし・1 ファイル・AI／課金なし。導入は Human（README.md）。
 *
 *   node receiver.mjs                  env：HEARTBEAT_TOKEN・DISCORD_WEBHOOK_URL・[HEARTBEAT_PORT=8795]・[HEARTBEAT_STATE=/var/lib/e-nexus-heartbeat/state.json]
 *   node receiver.mjs --delivery-test  配送試験を 1 通だけ送る（install.sh から）
 *
 * loopback だけで待ち、POST /hb の HMAC が合う時だけ最後の受信時刻を更新する。それ以外は全部 404 で接続も閉じる（何があるかを教えない）。送信元・本文は記録しない。
 * 通知：LIMIT_MS 途絶えたら 1 回・戻ったら 1 回・正常時はなし。LIMIT_MS は「60 分以上」を満たしたうえで、1 回の抜け（60 分）と実行時間の揺れでは鳴らない長さ。
 * 24 時間に 2 回途絶えたら「反復」を 1 通送り、24 時間は静かにする。静かな間に始まった途絶も、明けた時に続いていれば知らせる。反復の後に落ち着けば復旧を 1 回。
 * 原因は断定しない。送れなければ RETRY_MS ごとにもう一度。送れない時と保存できない時はコードだけ journal へ出す。
 * 途絶（反復）を送れないうちに戻った時は、復旧の 1 通に置き換えず「途絶えていて戻った」の 1 通にする（2026-11-09：前は復旧だけが届き、途絶があったことが消えた）。
 * 一度も受信していない間は知らせない。VPS が止まっていた時は起動から LIMIT_MS 待つ（止まっていた間を Mac の途絶と言わない）。再起動が続くだけなら待ち直さない。
 * 限界：VPS 自身・Cloudflare・Discord が止まると知らせられない。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const LIMIT_MS = 70 * MINUTE;
/** これより長く tick が無ければ VPS 側が止まっていた（待ち直す）。短ければ再起動だけ（待ち直さない） */
export const OUTAGE_MS = 5 * MINUTE;
export const RETRY_MS = 5 * MINUTE;
export const SKEW_MS = 5 * MINUTE;
export const FLAP = Object.freeze({ window_ms: DAY, count: 2 });
const HEADER = '[E-NEXUS Mac Runtime 外部監視]';
export const TEXT = Object.freeze({
  down: `${HEADER}\n【重大】Mac mini：生存信号が 60 分以上届いていない（電源・回線・監視・経路の停止のどれかは不明）→ 確認`,
  repeat: `${HEADER}\n【反復】Mac mini：生存信号の途絶を繰り返している（原因は不明）→ 確認。落ち着くまで通知を控える`,
  up: `${HEADER}\n【復旧】Mac mini：生存信号が戻った → 対応不要`,
  down_up: `${HEADER}\n【途絶と復旧】Mac mini：生存信号が 60 分以上途絶えていた（通知を送れないうちに戻った・原因は不明）→ 確認`,
  repeat_up: `${HEADER}\n【反復と復旧】Mac mini：生存信号の途絶を繰り返していた（通知を送れないうちに落ち着いた・原因は不明）→ 確認`,
  test: `${HEADER}\n配送試験：異常ではありません → 対応不要`,
});

/** 送れていない途絶の予約に復旧が重なった時の置き換え先。送れていない予約が無ければ復旧だけ */
const UNSENT_THEN_UP = Object.freeze({ down: 'down_up', repeat: 'repeat_up', down_up: 'down_up', repeat_up: 'repeat_up' });
const upAfter = (pending) => UNSENT_THEN_UP[pending] ?? 'up';
/** 送れた予約が、送っている間に「途絶と復旧」へ変わっていたら、残りは復旧だけ */
const SENT_PART = Object.freeze({ down: { down_up: 'up' }, repeat: { repeat_up: 'up' } });

export const initialState = (now) => ({ started_at: now, alive_at: now, last_seen: null, last_ts: 0, down: false, alerted: false, owed_up: false, hits: [], quiet_until: 0, pending: null, next_try: 0 });

/** 署名の検査。合えば ts（ms）。時刻のずれ・再送は拒む */
export function verifyBeat({ token, ts, sig, now, lastTs }) {
  const t = Number(ts);
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > SKEW_MS || t <= lastTs) return null;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = createHmac('sha256', token).update(String(t)).digest();
  return timingSafeEqual(want, Buffer.from(sig, 'hex')) ? t : null;
}

/** 受信の 1 回分。知らせた途絶の復旧を予約する。静かな間は持ち越す（onTick が明けた時に送る） */
export function onBeat(s, { now, ts }) {
  const next = { ...s, last_seen: now, last_ts: ts };
  if (s.down) {
    next.down = false;
    if (s.alerted) {
      next.alerted = false;
      if (now >= s.quiet_until) next.pending = upAfter(s.pending);
      else next.owed_up = true;
    }
  }
  return next;
}

/** 毎分の判定。途絶の始まりを 1 回だけ数え、知らせるのは静かな間の外だけ */
export function onTick(s, { now }) {
  let next = s;
  if (s.last_seen != null && !s.down && now - Math.max(s.last_seen, s.started_at) >= LIMIT_MS) {
    next = { ...s, down: true, hits: [...s.hits.filter((h) => h <= now && now - h < FLAP.window_ms), now] };
  }
  if (now < next.quiet_until) return next;
  if (next.down && !next.alerted) {
    const repeat = next.hits.length >= FLAP.count;
    return { ...next, alerted: true, owed_up: false, pending: repeat ? 'repeat' : 'down', quiet_until: repeat ? now + FLAP.window_ms : next.quiet_until, next_try: 0 };
  }
  if (!next.down && next.owed_up) return { ...next, owed_up: false, pending: upAfter(next.pending), next_try: 0 }; // 反復の後に落ち着いた
  return next;
}

/** 予約の送信の結果を今の state へ当てる。送っている間に別の予約へ変わっていれば消さない */
export function settle(s, { attempted, ok, now }) {
  if (ok) {
    if (s.pending === attempted) return { ...s, pending: null, next_try: 0 };
    const rest = SENT_PART[attempted]?.[s.pending];
    return rest ? { ...s, pending: rest, next_try: 0 } : s;
  }
  return { ...s, next_try: now + RETRY_MS };
}

/** 予約の送信。失敗は RETRY_MS 後にもう一度。pending が消えるのは送れた時だけ */
export async function flush(s, { now, send }) {
  if (!s.pending || now < s.next_try) return s;
  const attempted = s.pending;
  const ok = await send(TEXT[attempted]).catch(() => false);
  return settle(s, { attempted, ok, now });
}

export function discordSender({ url, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  return async (content) => {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
    return res.ok;
  };
}

/** 読めない値は初期値へ（壊れた state で毎回例外にしない・未来の last_ts で全部の信号を拒まない） */
function load(file, now) {
  const fresh = initialState(now);
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fresh;
  }
  if (saved === null || typeof saved !== 'object') return fresh;
  const num = (v, fallback) => (Number.isSafeInteger(v) && v >= 0 ? v : fallback);
  const past = (v, fallback) => { const n = num(v, fallback); return n != null && n > now ? fallback : n; }; // 未来の時刻で黙らない
  const aliveAt = past(saved.alive_at, 0);
  return {
    ...fresh,
    started_at: now - aliveAt > OUTAGE_MS ? now : past(saved.started_at, now), // VPS が止まっていた時だけ待ち直す
    last_seen: saved.last_seen == null ? null : past(saved.last_seen, now),
    last_ts: Math.min(num(saved.last_ts, 0), now + SKEW_MS),
    down: saved.down === true,
    alerted: saved.alerted === true,
    owed_up: saved.owed_up === true,
    hits: Array.isArray(saved.hits) ? saved.hits.filter((h) => Number.isSafeInteger(h)) : [],
    quiet_until: Math.min(num(saved.quiet_until, 0), now + FLAP.window_ms),
    pending: Object.hasOwn(TEXT, saved.pending ?? '') && saved.pending !== 'test' ? saved.pending : null, // 配送試験は予約にならない
    next_try: Math.min(num(saved.next_try, 0), now + RETRY_MS),
  };
}
function save(file, s) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(s), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error(JSON.stringify({ component: 'edl-heartbeat-receiver', error: 'state_unwritable', code: String(err?.code ?? 'error') })); // 判定はメモリで続ける
  }
}

/** 受け側の本体。clock・send を差し替えて test する。戻り値の tick を呼ぶと 1 回分の判定 */
export function startReceiver({ token, port, host = '127.0.0.1', stateFile, send, clock = Date.now }) {
  let state = load(stateFile, clock());
  const update = (s) => { state = s; save(stateFile, s); };
  update({ ...state, alive_at: clock() });
  const server = createServer({ connectionsCheckingInterval: 2000 }, (req, res) => {
    const deny = () => { res.writeHead(404, { connection: 'close' }).end(() => req.destroy()); };
    if (req.method !== 'POST' || req.url !== '/hb') return deny();
    const now = clock();
    const ts = verifyBeat({ token, ts: req.headers['x-edl-ts'], sig: req.headers['x-edl-sig'], now, lastTs: state.last_ts });
    if (ts == null) return deny();
    req.resume();
    update(onBeat(state, { now, ts }));
    return res.writeHead(204, { connection: 'close' }).end();
  });
  // 認証の前に接続を溜めさせない（Tunnel の先は公開）
  server.maxConnections = 32;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 1;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = clock();
      const decided = onTick({ ...state, alive_at: now }, { now });
      update(decided);
      const attempted = state.pending;
      if (attempted && now >= state.next_try) {
        const ok = await send(TEXT[attempted]).catch(() => false);
        if (!ok) console.error(JSON.stringify({ component: 'edl-heartbeat-receiver', error: 'delivery_failed' }));
        update(settle(state, { attempted, ok, now })); // 送っている間の受信を失わない
      }
    } finally {
      busy = false;
    }
  };
  return new Promise((resolve) => { server.listen(port, host, () => resolve({ server, tick, port: server.address().port, state: () => state })); });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const token = process.env.HEARTBEAT_TOKEN;
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!/^[0-9a-f]{64}$/.test(token ?? '') || !/^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url ?? '')) {
    console.error('HEARTBEAT_TOKEN and DISCORD_WEBHOOK_URL are required');
    process.exit(2);
  }
  if (process.argv[2] === '--delivery-test') {
    const ok = await discordSender({ url })(TEXT.test).catch(() => false);
    console.log(JSON.stringify({ component: 'edl-heartbeat-receiver', delivery_test: ok ? 'SENT' : 'FAILED' }));
    process.exit(ok ? 0 : 1);
  }
  const r = await startReceiver({ token, port: Number(process.env.HEARTBEAT_PORT ?? 8795), stateFile: process.env.HEARTBEAT_STATE ?? '/var/lib/e-nexus-heartbeat/state.json', send: discordSender({ url }) });
  setInterval(() => { r.tick().catch(() => {}); }, MINUTE);
  console.log(JSON.stringify({ component: 'edl-heartbeat-receiver', status: 'listening' }));
}
