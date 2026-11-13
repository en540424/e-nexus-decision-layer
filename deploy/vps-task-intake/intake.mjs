#!/usr/bin/env node
/**
 * Task Hub の VPS 側の受け口（2026-11-09・MA-24）。依存なし・1 ファイル（wire.mjs の封の形だけ使う）・AI／課金なし。導入は Human（README.md）。
 *
 *   node intake.mjs                       env：TASK_INTAKE_CHANNEL_KEY・TASK_INTAKE_CHANNEL・TASK_INTAKE_SOURCES・[TASK_INTAKE_PORT=8796]・[TASK_INTAKE_STATE=/var/lib/e-nexus-task-intake]
 *   node intake.mjs --check               env と sources の形だけ確かめる（件数だけ出す。待ち受けない）
 *   node intake.mjs --add-source <id> [intent,intent…]   bot の Bearer 鍵を 1 つ作り、sha256 だけを sources へ書く（鍵は画面に 1 回だけ出る）
 *   node intake.mjs --remove-source <id>
 *
 * 役割は「預かる」ことだけ。Grok Bot 等（MCP の client）は Bearer 鍵で認証し、submit_task で依頼を置き、get_task_status で結果を見る。
 * VPS は params／summary を解釈も実行もしない。置かれた依頼は channel の鍵で封をして（source は認証できた鍵から決める＝本文の自己申告ではない）queue に溜め、
 * Mac が outbound で /pull して検証・処理し、/status で署名付きの結果を返す。Mac へ入ってくる口はない。
 * 認証できない要求は全部 404（/mcp の Bearer 違いは 401）で接続も閉じる。鍵・本文・params・summary はどこにも記録しない（journal はコードだけ）。
 * 限界：VPS・Cloudflare が止まると依頼も結果も届かない。Bearer 鍵が漏れると、その bot として依頼を置ける（置かれた依頼は Mac の Human の承認と policy を通る）。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE, MAX_BODY_BYTES, NONCE_RE, TASK_REF_RE, openRecord, openStatus, sealRecord } from '../../scripts/lib/task-hub/wire.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const COMPONENT = 'edl-task-intake';

export const LIMITS = Object.freeze({
  skew_ms: 5 * MINUTE,
  queue_ttl_ms: 7 * DAY,
  board_ttl_ms: 14 * DAY,
  seen_ttl_ms: 14 * DAY,
  queue_total: 500,
  queue_per_source: 100,
  board_total: 2000,
  seen_total: 5000,
  submit_per_hour: 60,
  calls_per_hour: 600,
  pull_max: 50,
  status_batch: 20,
  ack_batch: 200,
  mcp_body_bytes: 64 * 1024,
  ack_body_bytes: 64 * 1024,
  status_body_bytes: 1024 * 1024, // 状態 20 件 × 16KiB の本文（JSON の escape で最大 2 倍）が入る大きさ。署名の検査の前に時刻で絞る
  summary_chars: 200,
  batch_requests: 10,
});
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = Object.freeze({ name: 'e-nexus-task-intake', version: '0.1.0' });
const KEY_RE = /^(?:[0-9a-f]{2}){32,}$/;
const IDEMPOTENCY_RE = TASK_REF_RE; // ^[A-Za-z0-9._:-]{8,128}$
const INTENT_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,3}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const defaultLog = (code, extra = {}) => { process.stderr.write(`${JSON.stringify({ component: COMPONENT, code, ...extra })}\n`); };

export const CAPABILITIES_TEXT = [
  'E-NEXUS Task Intake. Every task you submit is a PROPOSAL, not a command.',
  'Submitted tasks are stored and later reviewed on a private machine by a human-controlled workflow; nothing is executed here.',
  'Destructive or irreversible operations (deleting data, spending money, deploying, publishing, sending messages to third parties) are never executed automatically.',
  'Anything that needs approval is approved on that machine by the human operator, not through this interface.',
  'Tools: submit_task (propose a task with a stable idempotency_key), get_task_status (look up your own task by task_ref), list_capabilities.',
  'Do not put secrets, passwords or personal data in params or summary. You can only see tasks submitted with your own key.',
].join('\n');

export const TOOLS = Object.freeze([
  {
    name: 'submit_task',
    title: 'Submit a task proposal',
    description: 'Propose a task. It is stored for review and is never executed automatically. Resubmitting the same idempotency_key returns the existing task_ref.',
    inputSchema: {
      type: 'object',
      required: ['idempotency_key', 'business', 'intent'],
      properties: {
        idempotency_key: { type: 'string', description: 'Stable id for this request, 8-128 chars of A-Z a-z 0-9 . _ : - . It becomes the task_ref.' },
        business: { type: 'string', description: 'Lowercase business id, e.g. biz-a.' },
        intent: { type: 'string', description: 'Dotted lowercase intent name, e.g. report.summarize.' },
        params: { type: 'object', description: 'Intent specific parameters (JSON object). No secrets.' },
        summary: { type: 'string', description: 'Short human readable summary (max 200 chars).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_task_status',
    title: 'Get task status',
    description: 'Look up the status of a task you submitted, by task_ref. Returns state "unknown" if there is none.',
    inputSchema: { type: 'object', required: ['task_ref'], properties: { task_ref: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_capabilities',
    title: 'List capabilities',
    description: 'Explains what this intake does and does not do.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

/** sources の設定（{ id: { key_sha256, intents? } }）を検査して Map にする。形の違う項目・同じ hash の重複は捨てる（件数だけ返す） */
export function normalizeSources(raw) {
  const sources = new Map();
  let skipped = 0;
  const seenHash = new Set();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { sources, skipped: 1 };
  for (const [id, cfg] of Object.entries(raw)) {
    const hashOk = cfg && typeof cfg === 'object' && typeof cfg.key_sha256 === 'string' && /^[0-9a-f]{64}$/.test(cfg.key_sha256);
    const intents = cfg?.intents;
    const intentsOk = intents === undefined || (Array.isArray(intents) && intents.length <= 100 && intents.every((i) => typeof i === 'string' && /^[a-z][a-z0-9.*-]{0,95}$/.test(i)));
    if (!ID_RE.test(id) || !hashOk || !intentsOk || seenHash.has(cfg.key_sha256)) { skipped += 1; continue; }
    seenHash.add(cfg.key_sha256);
    sources.set(id, { hash: Buffer.from(cfg.key_sha256, 'hex'), intents: intents === undefined ? null : [...intents] });
  }
  return { sources, skipped };
}

/** 提示された Bearer を全 source の hash と同じ作業量で比べる。合えば source id、合わなければ null */
export function authenticate(header, sources) {
  const m = typeof header === 'string' ? /^Bearer ([^\s]{1,512})$/i.exec(header) : null;
  const digest = createHash('sha256').update(m ? m[1] : '').digest();
  let found = null;
  for (const [id, cfg] of sources) {
    if (timingSafeEqual(digest, cfg.hash) && m) found = id;
  }
  return found;
}

/** intent が source の許可に入るか。許可が無ければ全部可。`a.b.*` は前方一致 */
export function intentAllowed(intent, allow) {
  if (allow === null || allow === undefined) return true;
  return allow.some((a) => (a.endsWith('.*') ? intent.startsWith(a.slice(0, -1)) : a === intent));
}

/** submit_task の引数を検査して依頼の本文を作る。{ error: code } か { body, ref }。args の余計な項目（source 等）は捨てる */
export function buildTaskBody(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { error: 'invalid_arguments' };
  const { idempotency_key: key, business, intent, params, summary } = args;
  if (typeof key !== 'string' || !IDEMPOTENCY_RE.test(key)) return { error: 'invalid_idempotency_key' };
  if (typeof business !== 'string' || !ID_RE.test(business)) return { error: 'invalid_business' };
  if (typeof intent !== 'string' || intent.length > 96 || !INTENT_RE.test(intent)) return { error: 'invalid_intent' };
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return { error: 'invalid_params' };
  if (summary !== undefined && (typeof summary !== 'string' || [...summary].length > LIMITS.summary_chars || CONTROL_RE.test(summary))) return { error: 'invalid_summary' };
  const body = JSON.stringify({ v: 1, idempotency_key: key, business, intent, params: params ?? {}, summary: summary ?? '' });
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { error: 'too_large' };
  return { body, ref: key, intent };
}

/** 保存：tmp に書いて rename（0600）。失敗してもメモリで続ける（コードだけ出す） */
function saveJson(file, data, log) {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { unlinkSync(tmp); } catch { /* 残骸が無ければ何もしない */ }
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    log('state_unwritable', { reason: String(err?.code ?? 'error') });
    return false;
  }
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const pastOrNow = (v, now) => (Number.isSafeInteger(v) && v > 0 ? Math.min(v, now) : now); // 未来の保存時刻で消えなくなるのを防ぐ

/** 保存物の読み込み。壊れた物・署名が合わない物・形の違う物は捨てる（落ちない・未来の時刻を受け入れない） */
function loadState({ stateDir, keyFor, now, log, known = () => true }) {
  const q = readJson(path.join(stateDir, 'queue.json'));
  const queue = [];
  const seen = new Map();
  const nonces = new Set();
  let dropped = 0;
  if (q && Array.isArray(q.records)) {
    for (const w of q.records) {
      const opened = w && typeof w === 'object' ? openRecord(w.record, { keyFor, now, maxAgeMs: Number.POSITIVE_INFINITY }) : { ok: false };
      let ref = null;
      if (opened.ok) { try { ref = JSON.parse(opened.record.body).idempotency_key; } catch { ref = null; } }
      if (!opened.ok || typeof ref !== 'string' || !TASK_REF_RE.test(ref) || nonces.has(w.record.nonce) || !known(opened.record.source)) { dropped += 1; continue; } // 外した source の依頼は Mac へ渡さない
      nonces.add(w.record.nonce);
      queue.push({ ref, stored_at: pastOrNow(w.stored_at, now), record: w.record });
    }
  }
  let seenDropped = 0;
  if (q && Array.isArray(q.seen)) { // 今の設定に無い source の重複の印は持ち越さない（同じ id で source を足し直した時に古い「重複」で答えない）
    for (const s of q.seen) {
      if (!(Array.isArray(s) && ID_RE.test(s[0]) && TASK_REF_RE.test(s[1]))) continue;
      if (known(s[0])) seen.set(`${s[0]}\n${s[1]}`, pastOrNow(s[2], now)); else seenDropped += 1;
    }
  }
  for (const w of queue) if (!seen.has(`${w.record.source}\n${w.ref}`)) seen.set(`${w.record.source}\n${w.ref}`, w.stored_at);
  const b = readJson(path.join(stateDir, 'board.json'));
  const board = new Map();
  if (b && Array.isArray(b.entries)) {
    for (const e of b.entries) {
      const opened = e && typeof e === 'object' ? openStatus(e.status, { keyFor, now }) : { ok: false };
      let result;
      if (opened.ok) { try { result = JSON.parse(opened.status.body); } catch { result = undefined; } }
      if (!opened.ok || result === undefined || !known(opened.status.source)) { dropped += 1; continue; }
      const st = opened.status;
      const k = `${st.source}\n${st.task_ref}`;
      const prev = board.get(k);
      if (!prev || st.updated_at > prev.status.updated_at) board.set(k, { stored_at: pastOrNow(e.stored_at, now), status: e.status, result });
    }
  }
  const m = readJson(path.join(stateDir, 'mac.json'));
  const cap = now + LIMITS.skew_ms;
  const ts = (v) => (Number.isSafeInteger(v) && v >= 0 ? Math.min(v, cap) : 0); // 未来の last_ts で Mac を永久に締め出さない
  const mac = { pull: ts(m?.pull), ack: ts(m?.ack), status: ts(m?.status) };
  if (dropped) log('state_entries_dropped', { n: dropped });
  return { queue, seen, board, mac, seenDropped };
}

class BodyError extends Error {}
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cap) { reject(new BodyError('too_large')); return; }
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > cap) { over = true; chunks.length = 0; reject(new BodyError('too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', () => reject(new BodyError('aborted')));
    req.on('close', () => { if (!req.complete && !over) reject(new BodyError('aborted')); });
  });
}

const toolResult = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) });
const toolError = (code) => toolResult({ error: code }, true);

/**
 * 受け口の本体。clock を差し替えて test する。戻り値の tick を呼ぶと期限切れの掃除 1 回分。
 * sources は { id: { key_sha256, intents? } } か normalizeSources の Map。
 */
export function startIntake({ channelKey, channel, sources, stateDir, port = 8796, host = '127.0.0.1', clock = Date.now, log = defaultLog, limits = {} }) {
  if (!Buffer.isBuffer(channelKey) || channelKey.length < 32) throw new Error('channelKey must be a Buffer of 32 bytes or more');
  if (typeof channel !== 'string' || !ID_RE.test(channel)) throw new Error('channel is invalid');
  const L = { ...LIMITS, ...limits };
  const srcMap = sources instanceof Map ? sources : normalizeSources(sources).sources;
  const keyFor = (ch) => (ch === channel ? channelKey : null);
  const files = { queue: path.join(stateDir, 'queue.json'), board: path.join(stateDir, 'board.json'), mac: path.join(stateDir, 'mac.json') };
  const st = loadState({ stateDir, keyFor, now: clock(), log, known: (src) => srcMap.has(src) });
  const callHits = new Map();
  const submitHits = new Map();

  const persistQueue = () => saveJson(files.queue, { records: st.queue, seen: [...st.seen].map(([k, at]) => [...k.split('\n'), at]) }, log);
  const persistBoard = () => saveJson(files.board, { entries: [...st.board.values()].map((e) => ({ stored_at: e.stored_at, status: e.status })) }, log);
  const persistMac = () => saveJson(files.mac, st.mac, log);
  if (st.seenDropped) { log('seen_entries_dropped', { n: st.seenDropped }); persistQueue(); } // 外した source の印を保存物からも消す（再起動をまたいで残さない）

  /** 期限切れを落とす。変わった物だけ保存する */
  function sweep(now) {
    const before = st.queue.length;
    const keep = st.queue.filter((w) => now - w.stored_at < L.queue_ttl_ms);
    let qChanged = keep.length !== before;
    if (qChanged) {
      log('queue_expired', { n: before - keep.length });
      for (const w of st.queue) if (!keep.includes(w)) st.seen.delete(`${w.record.source}\n${w.ref}`); // 取りに来られなかった依頼は、置き直せるようにする
      st.queue = keep;
    }
    for (const [k, at] of st.seen) if (now - at >= L.seen_ttl_ms) { st.seen.delete(k); qChanged = true; }
    while (st.seen.size > L.seen_total) { st.seen.delete(st.seen.keys().next().value); qChanged = true; }
    let bChanged = false;
    for (const [k, e] of st.board) if (now - e.stored_at >= L.board_ttl_ms) { st.board.delete(k); bChanged = true; }
    if (qChanged) persistQueue();
    if (bChanged) persistBoard();
  }

  function hit(map, source, now, limit) {
    const arr = (map.get(source) ?? []).filter((t) => now - t < HOUR);
    if (arr.length >= limit) { map.set(source, arr); return false; }
    arr.push(now);
    map.set(source, arr);
    return true;
  }

  function statusOf(source, ref) {
    const e = st.board.get(`${source}\n${ref}`);
    if (e) return { task_ref: ref, state: e.status.state, updated_at: e.status.updated_at, result: e.result };
    if (st.seen.has(`${source}\n${ref}`)) return { task_ref: ref, state: 'received' };
    return { task_ref: ref, state: 'unknown' };
  }

  function submit(source, args, now) {
    const built = buildTaskBody(args);
    if (built.error) return toolError(built.error);
    if (!intentAllowed(built.intent, srcMap.get(source).intents)) return toolError('intent_not_allowed');
    const dupKey = `${source}\n${built.ref}`;
    if (st.seen.has(dupKey) || st.board.has(dupKey)) {
      const s = statusOf(source, built.ref);
      return toolResult({ accepted: true, task_ref: built.ref, state: s.state === 'unknown' ? 'received' : s.state, duplicate: true });
    }
    if (st.queue.length >= L.queue_total || st.queue.filter((w) => w.record.source === source).length >= L.queue_per_source) return toolError('queue_full');
    const record = sealRecord(channelKey, { channel, source, received_at: now, body: built.body });
    st.queue.push({ ref: built.ref, stored_at: now, record });
    st.seen.set(dupKey, now);
    persistQueue();
    return toolResult({ accepted: true, task_ref: built.ref, state: 'received' });
  }

  function callTool(source, name, args, now) {
    if (!hit(callHits, source, now, L.calls_per_hour)) return toolError('rate_limited');
    if (name === 'submit_task') {
      if (!hit(submitHits, source, now, L.submit_per_hour)) return toolError('rate_limited');
      return submit(source, args, now);
    }
    if (name === 'get_task_status') {
      const ref = args?.task_ref;
      if (typeof ref !== 'string' || !TASK_REF_RE.test(ref)) return toolError('invalid_task_ref');
      return toolResult(statusOf(source, ref));
    }
    if (name === 'list_capabilities') return { content: [{ type: 'text', text: CAPABILITIES_TEXT }] };
    return null;
  }

  /** JSON-RPC の 1 message → response（notification・応答は undefined） */
  function rpc(msg, source, now) {
    const isRequest = msg && typeof msg === 'object' && !Array.isArray(msg) && msg.id !== undefined && msg.id !== null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } } : { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    if (typeof msg.method !== 'string') return undefined; // クライアントからの応答など
    if (!isRequest) return undefined; // notifications/initialized 等
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: 'Tasks you submit are proposals. Nothing is executed automatically; approvals happen on a private machine.' });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') return fail(-32602, 'Invalid params');
        const r = callTool(source, name, msg.params?.arguments ?? {}, now);
        return r ? reply(r) : fail(-32602, 'Unknown tool');
      }
      default: return fail(-32601, 'Method not found');
    }
  }

  // ---- Mac 側の認証（channel の鍵の HMAC・時刻のずれと再送を拒む）----
  const macSig = (label, ts, tail) => createHmac('sha256', channelKey).update(`${label}\n${ts}\n${tail}`).digest();
  /** 署名の検査の前に見る：ts が数字で、ずれが範囲内か */
  function macTs(req, now) {
    const raw = req.headers['x-edl-ts'];
    if (typeof raw !== 'string' || !/^[0-9]{1,16}$/.test(raw)) return null;
    const ts = Number(raw);
    return Number.isSafeInteger(ts) && Math.abs(now - ts) <= L.skew_ms ? ts : null;
  }
  /** 署名と再送を検査し、通ったら last ts を進めて保存する */
  function macVerify(req, endpoint, label, ts, tail) {
    const sig = req.headers['x-edl-sig'];
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
    if (!timingSafeEqual(macSig(label, ts, tail), Buffer.from(sig, 'hex'))) return false;
    if (ts <= st.mac[endpoint]) return false;
    st.mac[endpoint] = ts;
    persistMac();
    return true;
  }

  async function handler(req, res) {
    const deny = () => { res.writeHead(404, { connection: 'close' }).end(() => req.destroy()); };
    const json = (status, obj) => {
      const text = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' }).end(text);
    };
    const tooLarge = () => { res.writeHead(413, { connection: 'close' }).end(() => req.destroy()); };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return deny(); }
    const now = clock();

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', connection: 'close' }).end(() => req.destroy()); return undefined; }
      const source = authenticate(req.headers.authorization, srcMap);
      if (source === null) { res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain', connection: 'close' }).end('unauthorized', () => req.destroy()); return undefined; }
      let raw;
      try { raw = await readBody(req, L.mcp_body_bytes); } catch (err) { return err instanceof BodyError && err.message === 'too_large' ? tooLarge() : deny(); }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      sweep(now);
      if (Array.isArray(msg)) {
        if (msg.length === 0 || msg.length > L.batch_requests) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        const out = msg.map((m) => rpc(m, source, now)).filter((r) => r !== undefined);
        return out.length ? json(200, out) : res.writeHead(202, { connection: 'close' }).end();
      }
      const out = rpc(msg, source, now);
      return out === undefined ? res.writeHead(202, { connection: 'close' }).end() : json(200, out);
    }

    if (req.method === 'GET' && url.pathname === '/pull') {
      const ts = macTs(req, now);
      // offset（Mac が残している封の後ろから読むため）と max は署名の対象。offset は 0..queue_total の整数だけ（それ以外は認証前に 404）
      const offRaw = url.searchParams.get('offset') ?? '0';
      if (ts === null || !/^[0-9]{1,4}$/.test(offRaw) || Number(offRaw) > L.queue_total) return deny();
      const offset = Number(offRaw);
      const n = Number(url.searchParams.get('max'));
      const max = Number.isInteger(n) && n >= 1 ? Math.min(n, L.pull_max) : L.pull_max;
      if (!macVerify(req, 'pull', 'edl-pull-v1', ts, `GET /pull?offset=${offset}&max=${max}`)) return deny();
      sweep(now);
      return json(200, { records: st.queue.filter((w) => srcMap.has(w.record.source)).slice(offset, offset + max).map((w) => w.record) });
    }

    if (req.method === 'POST' && (url.pathname === '/ack' || url.pathname === '/status')) {
      const isAck = url.pathname === '/ack';
      const ts = macTs(req, now);
      if (ts === null) return deny();
      let raw;
      try { raw = await readBody(req, isAck ? L.ack_body_bytes : L.status_body_bytes); } catch (err) { return err instanceof BodyError && err.message === 'too_large' ? tooLarge() : deny(); }
      if (!macVerify(req, isAck ? 'ack' : 'status', isAck ? 'edl-ack-v1' : 'edl-status-v1', ts, sha256hex(raw))) return deny();
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return json(400, { error: 'bad_json' }); }
      sweep(now);
      if (isAck) {
        const list = body?.nonces;
        if (!Array.isArray(list) || list.length > L.ack_batch || !list.every((x) => typeof x === 'string' && NONCE_RE.test(x))) return json(400, { error: 'bad_request' });
        const gone = new Set(list);
        const before = st.queue.length;
        st.queue = st.queue.filter((w) => !gone.has(w.record.nonce)); // seen は残す（取得済みの依頼を同じ鍵で置き直されても二重にしない）
        if (st.queue.length !== before) persistQueue();
        return json(200, { deleted: before - st.queue.length });
      }
      const list = body?.statuses;
      if (!Array.isArray(list) || list.length === 0 || list.length > L.status_batch) return json(400, { error: 'bad_request' });
      const results = list.map((raw1) => storeStatus(raw1, now));
      if (results.some((r) => r.ok && r.code === 'stored')) { persistBoard(); persistQueue(); }
      return json(200, { results });
    }

    return deny();
  }

  /** 状態 1 件：署名を検査して板へ。同じ (source, task_ref) では新しい updated_at が勝つ */
  function storeStatus(raw, now) {
    const opened = openStatus(raw, { keyFor, now, skewMs: L.skew_ms });
    if (!opened.ok) return { ok: false, code: opened.code };
    const s = opened.status;
    if (!srcMap.has(s.source)) return { ok: false, code: 'unknown_source' };
    let result;
    try { result = JSON.parse(s.body); } catch { return { ok: false, code: 'body_not_json' }; }
    const key = `${s.source}\n${s.task_ref}`;
    const prev = st.board.get(key);
    if (prev && prev.status.updated_at >= s.updated_at) return { ok: true, code: 'stale' };
    if (!prev && st.board.size >= L.board_total) {
      const oldest = [...st.board].sort((a, b) => a[1].stored_at - b[1].stored_at)[0];
      st.board.delete(oldest[0]);
    }
    st.board.set(key, { stored_at: now, status: raw, result });
    st.seen.set(key, st.seen.get(key) ?? now);
    return { ok: true, code: 'stored' };
  }

  const server = createServer({ connectionsCheckingInterval: 2000 }, (req, res) => {
    handler(req, res).catch(() => {
      log('handler_error');
      if (!res.headersSent) res.writeHead(500, { connection: 'close' }).end(() => req.destroy());
      else req.destroy();
    });
  });
  // 認証の前に接続を溜めさせない（Tunnel の先は公開）
  server.maxConnections = 64;
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 1;
  const tick = () => { sweep(clock()); };
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({
      server, tick, port: server.address().port,
      stats: () => ({ queue: st.queue.length, board: st.board.size, seen: st.seen.size, mac: { ...st.mac } }),
    }));
  });
}

// ---- source の管理（Human が VPS 上で使う）----
function sourcesFileWrite(file, obj) {
  const tmp = `${file}.tmp`;
  try { unlinkSync(tmp); } catch { /* なければ何もしない */ }
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
  renameSync(tmp, file);
  chmodSync(file, 0o640);
}

/** 新しい bot 鍵を作り、hash だけを sources へ書く。鍵は戻り値（呼び出し側が画面に 1 回だけ出す） */
export function addSource(file, id, intents) {
  if (!ID_RE.test(id)) throw new Error('source id is invalid');
  const current = readJson(file) ?? {};
  if (Object.hasOwn(current, id)) throw new Error('source already exists (remove it first to rotate)');
  const key = `etk_${randomBytes(32).toString('hex')}`;
  const entry = { key_sha256: sha256hex(key) };
  if (intents?.length) entry.intents = intents;
  const next = { ...current, [id]: entry };
  if (normalizeSources(next).sources.size !== Object.keys(next).length) throw new Error('sources file would become invalid (check intents)');
  sourcesFileWrite(file, next);
  return key;
}
export function removeSource(file, id) {
  const current = readJson(file) ?? {};
  if (!Object.hasOwn(current, id)) return false;
  delete current[id];
  sourcesFileWrite(file, current);
  return true;
}

function envConfig(env) {
  const hex = env.TASK_INTAKE_CHANNEL_KEY ?? '';
  const channel = env.TASK_INTAKE_CHANNEL ?? '';
  const sourcesFile = env.TASK_INTAKE_SOURCES ?? '';
  if (!KEY_RE.test(hex) || !ID_RE.test(channel) || !sourcesFile) return null;
  const raw = readJson(sourcesFile);
  if (raw === null) return null;
  const { sources, skipped } = normalizeSources(raw);
  return { channelKey: Buffer.from(hex, 'hex'), channel, sources, skipped, sourcesFile, stateDir: env.TASK_INTAKE_STATE ?? '/var/lib/e-nexus-task-intake', port: Number(env.TASK_INTAKE_PORT ?? 8796) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [flag, arg1, arg2] = process.argv.slice(2);
  if (flag === '--add-source' || flag === '--remove-source') {
    const file = process.env.TASK_INTAKE_SOURCES;
    if (!file || !arg1) { console.error('usage: TASK_INTAKE_SOURCES=<file> node intake.mjs --add-source <id> [intent,…] | --remove-source <id>'); process.exit(2); }
    try {
      if (flag === '--add-source') {
        // TASK_INTAKE_KEY_OUT（2026-11-11）：画面に出さず 0600 の新しい file へ書く（Mac の connect-from-mac.sh が ssh で取り、Keychain へ入れて消す）。
        // 先に file を作る（既にあれば登録しない＝誰も鍵を持たない source を残さない）
        const out = process.env.TASK_INTAKE_KEY_OUT;
        const fd = out ? openSync(out, 'wx', 0o600) : null;
        let key;
        try { key = addSource(file, arg1, arg2 ? arg2.split(',').filter(Boolean) : undefined); } catch (e) { if (fd !== null) { closeSync(fd); unlinkSync(out); } throw e; }
        if (fd !== null) {
          writeSync(fd, `${key}\n`);
          closeSync(fd);
          console.log(`source=${arg1}\nBearer key: written to the handoff file (not shown)`);
        } else {
          console.log(`source=${arg1}\nBearer key（この画面にだけ出ます。Grok Bot の MCP 設定へ貼り、控えは残さない）：\n${key}`);
        }
      } else {
        console.log(removeSource(file, arg1) ? `removed=${arg1}` : 'not_found');
      }
    } catch (err) {
      console.error(String(err?.message ?? 'error'));
      process.exit(1);
    }
    process.exit(0);
  }
  const cfg = envConfig(process.env);
  if (!cfg || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    console.error('TASK_INTAKE_CHANNEL_KEY (64+ hex), TASK_INTAKE_CHANNEL, TASK_INTAKE_SOURCES (readable JSON) are required');
    process.exit(2);
  }
  if (flag === '--check') {
    console.log(JSON.stringify({ component: COMPONENT, check: 'OK', sources: cfg.sources.size, skipped: cfg.skipped }));
    process.exit(cfg.skipped ? 1 : 0);
  }
  if (cfg.sources.size === 0) defaultLog('no_sources');
  if (cfg.skipped) defaultLog('sources_skipped', { n: cfg.skipped });
  const r = await startIntake({ channelKey: cfg.channelKey, channel: cfg.channel, sources: cfg.sources, stateDir: cfg.stateDir, port: cfg.port });
  setInterval(() => { try { r.tick(); } catch { defaultLog('tick_error'); } }, 5 * MINUTE);
  const stop = () => { r.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  defaultLog('listening');
}
