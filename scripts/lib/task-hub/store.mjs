/**
 * Task Hub の保存先（2026-11-09・MA-24）。1 つのフォルダ（dir 0700・file 0600）に、task・重複の印・nonce・監査 log・outbox・business ごとの記録を置く。依存なし・通信なし。
 *
 *   tasks/<task_id>.json        task 1 件（state は wire.STATES）
 *   keys/<sha256(source|key)>   (source, idempotency_key) の重複の印（link で中身ごと作る＝先着 1 つ）
 *   hermes-collected/<task_id>  Hermes の結果を取り込んだ印（O_EXCL・以後その task の結果の file を読まない）
 *   nonces/<nonce>              封の再送の印（7 日以上残す）。中身は「取った時刻\npending」→ 取り込みが終わると「取った時刻\ndone」。1 行だけの古い形は終わった印として扱う
 *   audit.jsonl / audit.tip     追記だけの監査 log。各行に前の行の sha256（prev）。値・params は書かない
 *   outbox/ outbox-sent/        依頼元（人以外）へ返す結果。配る側は別の部品で、配ったら outbox-sent へ移す
 *   records/<business>/*.jsonl  handler が残す business ごとの記録（mail・calendar・notes）
 *   run.lock/                   runner の単独実行の印（owner.json を中に持つフォルダ。pid が居なければ古い）
 *   locks/<name>.lock/          短い排他（audit・task ごと）。同じ作り
 *   breaker.json                想定外の失敗の連続回数（runner の回をまたいで数える。成功で 0）
 *   PAUSE                       中身は理由のコード。あれば runner は走らない
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { BUSINESS_RE } from './envelope.mjs';
import { openPlain, readJsonSafe, readSmallFile } from './safe-read.mjs';
import { MAX_BODY_BYTES, RECORD_MAX_AGE_MS, STATES } from './wire.mjs';

export const TASK_ID_RE = /^t-\d{14}-[0-9a-f]{8}$/;
export const HUMAN_SOURCE = 'human-cli';
/** nonce は封が受け付けられる間（RECORD_MAX_AGE_MS）より長く残す。短いと古い封の再送が prune のあとに通る */
export const NONCE_RETENTION_MS = RECORD_MAX_AGE_MS + 86_400_000;
const TASK_FILE_MAX = 256 * 1024;
const OUTBOX_FILE_MAX = 64 * 1024;
const RECORDS_FILE_MAX = 32 * 1024 * 1024;
export const AUDIT_FILE_MAX = 256 * 1024 * 1024;
/** 記録の保持の上限（件）。retention（日数）とは別に、file を有限に保つ */
export const RECORD_MAX_ROWS = Object.freeze({ mail: 5000, calendar: 5000, notes: 2000 });
export const LOCK_STALE_MS = 60_000; // owner.json が無い lock（普通は作れない形）と、短い排他（audit・task ごと）の持ち主の最長
/** run.lock の持ち主の最長（本物の runner がこれ以上持つことはない）。pid が再利用されて「生きて見える」lock をこれで古いとする */
export const RUN_LOCK_MAX_AGE_MS = 30 * 60_000;
export const RECORD_KINDS = Object.freeze(['mail', 'calendar', 'notes']);
/** 終わった state（もう動かない）。stopped は Human が新しい依頼を出し直す */
export const TERMINAL = Object.freeze(['succeeded', 'failed', 'rejected', 'blocked', 'expired', 'stopped']);
/** 依頼元へ返す state（待っていることも伝える） */
const OUTBOX_STATES = new Set([...TERMINAL, 'awaiting_approval']);
const TRANSITIONS = Object.freeze({
  received: ['awaiting_approval', 'queued', 'blocked', 'rejected'],
  awaiting_approval: ['queued', 'rejected', 'expired'],
  queued: ['running', 'awaiting_approval', 'blocked', 'stopped', 'failed', 'expired'],
  running: ['succeeded', 'retry_wait', 'failed', 'stopped', 'queued'],
  retry_wait: ['running', 'queued', 'awaiting_approval', 'blocked', 'stopped', 'failed'],
  stopped: ['failed'], // Human の dismiss だけ（approval.dismiss）。再実行はしない
});
const ZERO = '0'.repeat(64);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export class StoreError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeExcl(file, text) {
  const fd = openSync(file, 'wx', 0o600);
  try { writeSync(fd, text); } catch (e) {
    // 書けなかった（disk full など）：作った空・途中の file を残さない（nonce の印が空のまま残ると、次の回の取り込みが replay として捨てる）
    try { closeSync(fd); } catch { /* 済 */ }
    try { unlinkSync(file); } catch { /* 済 */ }
    throw e;
  }
  closeSync(fd);
}
/** tmp に書いて rename（途中の中身を見せない）。tmp は O_EXCL */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeExcl(tmp, text);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* 残さない努力 */ } throw e; }
}
/** 無い時だけ作る（tmp に書いて link。既にあれば false で、既にある file は変えない） */
function writeNew(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeExcl(tmp, text);
  try { linkSync(tmp, file); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally { try { unlinkSync(tmp); } catch { /* 済 */ } }
}
/** file・フォルダを disk へ（fsync を拒む環境〈EINVAL・EPERM・ENOTSUP〉と無い file は飛ばす。本当の I/O エラーは投げる） */
function fsyncPath(p) {
  let fd;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if (['ENOENT', 'ELOOP', 'ENXIO'].includes(e?.code)) return;
    throw e;
  }
  try { fsyncSync(fd); } catch (e) {
    if (!['EINVAL', 'EPERM', 'ENOTSUP', 'EBADF'].includes(e?.code)) throw e;
  } finally { closeSync(fd); }
}
const readJson = (file, max) => readJsonSafe(file, max); // symlink・FIFO・巨大な file は読まない（safe-read.mjs）
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
/**
 * 監査の鎖を頭から確かめる（store を開かずに読む側＝runtime-ops も使う）。{ ok, lines, code?, line? }。
 * 途中の編集・削除・入れ替え（chain_broken）、2 つの書き手が同じ前の行に続けた分岐（chain_broken）、tip より短い（末尾の削除）を見つける
 */
export function verifyAuditLines(lines, tip) {
  let prev = ZERO;
  for (let i = 0; i < lines.length; i += 1) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { return { ok: false, lines: lines.length, code: 'unparseable', line: i + 1 }; }
    if (o?.prev !== prev) return { ok: false, lines: lines.length, code: 'chain_broken', line: i + 1 };
    prev = sha(lines[i]);
  }
  if (tip) {
    if (!Number.isInteger(tip.n) || lines.length < tip.n) return { ok: false, lines: lines.length, code: 'truncated', line: lines.length };
    if (tip.n >= 1 && sha(lines[tip.n - 1]) !== tip.hash) return { ok: false, lines: lines.length, code: 'tip_mismatch', line: tip.n };
  } else if (lines.length) return { ok: false, lines: lines.length, code: 'tip_missing', line: lines.length };
  return { ok: true, lines: lines.length };
}

/** owner.json の持ち主が古いか。pid が居ない／started_at からの経過が maxAgeMs を超える（pid の再利用・固まった持ち主）／owner.json が読めない lock は mtime で LOCK_STALE_MS */
function lockIsStale(owner, lockPath, at, maxAgeMs) {
  if (Number.isInteger(owner?.pid)) {
    if (!pidAlive(owner.pid)) return true;
    // started_at が未来に大きくずれていたら信用せず mtime を見る（時計が戻っても生きた持ち主から奪わない一方、壊れた値で永久に居座らせない）
    if (Number.isFinite(owner.started_at) && owner.started_at - at <= maxAgeMs) return at - owner.started_at > maxAgeMs;
    try { return Date.now() - statSync(lockPath).mtimeMs > maxAgeMs; } catch { return false; }
  }
  try { return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}
/**
 * フォルダの lock を取る。owner.json を入れた一時フォルダを lockPath へ rename する＝取れた瞬間に owner が書かれている（空の lock を見て古いと誤認しない）。
 * 空でないフォルダへの rename は失敗する（ENOTEMPTY／EEXIST）ので先着 1 つ。取れれば release 関数（.owns() で今も自分の lock か確かめられる）、他が持っていれば null。
 * 古い lock を取り除くのは「owner の pid が居ない」か「started_at から maxAgeMs を超えた」時だけ。owner.json が無い lock は LOCK_STALE_MS 以上古い時だけ。
 * 取り除く手順：lockPath を unique な trash へ rename → trash の owner が「古いと見た持ち主」と同じ時だけ消す。違えば（見た後に取り直された生きた lock を動かしてしまった）rename で戻す。
 * 戻せない（もう新しい lock がある）時は二重の持ち主になりうるので、片方を消さずに lock_conflict を投げる（持ち主は書く前に owns() で確かめて lock_lost で止まる）。
 */
function tryLockDir(lockPath, at, { maxAgeMs = LOCK_STALE_MS, hooks = {}, onConflict } = {}) {
  const token = randomBytes(8).toString('hex');
  const tmp = `${lockPath}.${process.pid}.${token}.tmp`;
  mkdirSync(tmp, { mode: 0o700 });
  writeExcl(path.join(tmp, 'owner.json'), JSON.stringify({ pid: process.pid, token, started: new Date(at).toISOString(), started_at: at }));
  const owns = () => readJson(path.join(lockPath, 'owner.json'))?.token === token;
  const release = () => {
    // 自分の lock の時だけ消す（奪われた後に他人の lock を消さない）。消せたら true
    if (!owns()) return false;
    try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* 済 */ }
    return true;
  };
  release.owns = owns;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { renameSync(tmp, lockPath); return release; } catch (e) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(e.code)) { rmSync(tmp, { recursive: true, force: true }); throw e; }
    }
    const owner = readJson(path.join(lockPath, 'owner.json'));
    if (!lockIsStale(owner, lockPath, at, maxAgeMs)) { if (existsSync(lockPath)) break; continue; } // 見ている間に解放されていたら取り直す
    hooks.decided?.(); // 試験用：「古い」と決めた直後（ここで他の process が奪い直す競合を再現する）
    const trash = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.stale.tmp`;
    try { renameSync(lockPath, trash); } catch { continue; } // 先に誰かが片づけた
    hooks.trashed?.(); // 試験用：trash へ動かした直後
    const seen = readJson(path.join(trash, 'owner.json'));
    if (seen?.token === owner?.token && seen?.pid === owner?.pid) { rmSync(trash, { recursive: true, force: true }); continue; }
    // 古いと見た持ち主ではない＝生きた lock を動かした：戻す
    try { renameSync(trash, lockPath); } catch {
      rmSync(tmp, { recursive: true, force: true });
      try { onConflict?.(lockPath); } catch { /* 記録できなくても止める */ }
      throw new StoreError('lock_conflict'); // trash は残す（pruneTmp が片づける）
    }
    break;
  }
  rmSync(tmp, { recursive: true, force: true });
  return null;
}
/** 短い排他。待っても取れなければ lock_timeout（持ち主が生きている限り奪わない）。fn には owns()（今も自分の lock か）を渡す。終わりに自分の lock でなければ lock_lost */
function withLock(lockPath, fn, { timeoutMs = 4000, hooks, onConflict } = {}) {
  const until = Date.now() + timeoutMs;
  let release;
  for (;;) {
    release = tryLockDir(lockPath, Date.now(), { maxAgeMs: LOCK_STALE_MS, hooks, onConflict });
    if (release) break;
    if (Date.now() > until) throw new StoreError('lock_timeout');
    sleepMs(5);
  }
  let result;
  let held = true;
  try { hooks?.acquired?.(lockPath); result = fn(release.owns); } finally { held = release(); } // acquired：試験用（取れた直後に lock を差し替える競合を再現する）
  if (!held) throw new StoreError('lock_lost'); // 終わる前に lock を失っていた（書いた内容の確かめは verify-audit）
  return result;
}

export function newTaskId(ms) {
  return `t-${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
}

export function openStore(dir, { now = () => Date.now(), lockHooks } = {}) {
  const root = path.resolve(dir);
  const p = (...a) => path.join(root, ...a);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (statSync(root).mode & 0o077) chmodSync(root, 0o700);
  for (const d of ['tasks', 'keys', 'nonces', 'outbox', 'outbox-sent', 'records', 'locks']) mkdirSync(p(d), { recursive: true, mode: 0o700 });

  const taskFile = (id) => {
    if (!TASK_ID_RE.test(id)) throw new StoreError('bad_task_id');
    return p('tasks', `${id}.json`);
  };
  const iso = (ms) => new Date(ms).toISOString();
  const lastAuditLine = () => {
    const file = p('audit.jsonl');
    if (!existsSync(file)) return null;
    const fd = openPlain(file);
    try {
      const size = fstatSync(fd).size;
      if (!size) return null;
      const len = Math.min(size, 16_384);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      return lines.at(-1) ?? null;
    } finally { closeSync(fd); }
  };

  /** lock 競合の記録（audit.lock 自身の競合は audit に書けない＝投げるだけ） */
  const onConflict = (lockPath) => {
    if (path.basename(lockPath) === 'audit.lock') return;
    store.audit({ event: 'lock_conflict', code: 'lock_conflict' });
  };
  const locked = (lockPath, fn, opts = {}) => withLock(lockPath, fn, { hooks: lockHooks, onConflict, ...opts });

  const store = {
    dir: root,
    now,
    path: p,

    // ─── 監査 log ───
    /** 追記だけ。prev ＝ 直前の行の sha256。params の値・Secret は渡さない（id・state・code だけ） */
    audit({ task_id = null, event, state = null, code = null }, at = now()) {
      return locked(p('locks', 'audit.lock'), (owns) => {
        if (!owns()) throw new StoreError('lock_lost'); // 追記の直前に確かめる（奪われていたら書かない＝鎖が分岐しない）
        const last = lastAuditLine();
        const line = JSON.stringify({ at: iso(at), task_id, event, state, ...(code ? { code } : {}), prev: last ? sha(last) : ZERO });
        // 行の数（2026-11-10 監査 F1）：tip が最後の行を指していれば tip.n を使う。指していない時、強制終了で tip だけ遅れた形
        // （file の頭の tip.n 行が tip と一致し、後ろに行が足されている）なら数え直して直す。それ以外（file が tip より短い・tip の位置の行が違う
        // ＝末尾の削除・改ざん）は直さない＝verify-audit の異常を消さない
        const tip = readJson(p('audit.tip'));
        let base;
        if (Number.isInteger(tip?.n) && last && tip.hash === sha(last)) base = tip.n;
        else {
          const lines = this._auditLines();
          const lagging = Number.isInteger(tip?.n) && tip.n >= 1 && lines.length > tip.n && sha(lines[tip.n - 1]) === tip.hash;
          base = lagging || !tip ? lines.length : (Number.isInteger(tip?.n) ? tip.n : lines.length);
        }
        appendFileSync(p('audit.jsonl'), `${line}\n`, { mode: 0o600 });
        const n = base + 1;
        writeAtomic(p('audit.tip'), JSON.stringify({ n, hash: sha(line) }));
        return line;
      });
    },
    _auditLines() {
      try { return readSmallFile(p('audit.jsonl'), AUDIT_FILE_MAX).split('\n').filter(Boolean); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
    },
    _countAudit() {
      return this._auditLines().length;
    },
    /** 鎖を頭から確かめる。{ ok, lines, code?, line? }。途中の編集・削除・入れ替えと、tip より短い（末尾の削除）を見つける */
    verifyAudit() {
      // tip を先に読む（行を読んだ後に書き手が足した行の tip を見て、末尾の削除と誤らない）
      const tip = readJson(p('audit.tip'));
      let lines;
      try { lines = this._auditLines(); } catch { return { ok: false, lines: 0, code: 'audit_unreadable', line: 0 }; }
      return verifyAuditLines(lines, tip);
    },

    // ─── 再送（nonce）───
    /** 初めて見る nonce なら true（O_EXCL）。見たことがあれば false */
    /** claimNonce の後で取り込みに失敗した時に、自分の印だけ外す（ファイルを inbox に残して次の回で取り込み直せるように）。中身が自分の at（終わっていない印）の時だけ消す */
    releaseNonce(nonce, at = now()) {
      if (!/^[0-9a-f]{32}$/.test(nonce)) throw new StoreError('bad_nonce');
      try {
        if (readSmallFile(p('nonces', nonce), 64) !== `${at}\npending`) return false;
        unlinkSync(p('nonces', nonce));
        return true;
      } catch { return false; }
    },
    /**
     * 初めて見る nonce なら true（O_EXCL）。取り込みが終わった（done の）nonce なら false＝replay。
     * 終わっていない印（前の回が task を書き終える前に強制終了した）は replay にしない（2026-11-10）：
     * 取った時刻から LOCK_STALE_MS 未満なら nonce_busy（取り込みの最中かもしれない＝file を inbox に残して次の回へ）、
     * それより古ければ引き継いで true（取り込み直しは (source, key) の印で重複にならない）。
     * 呼び出し側は run.lock を持つこと（CLI の intake が持つ。同時の 2 つの取り込みが同じ封を引き継ぎ合わないように）。1 行だけの古い形の印は終わった印（replay）
     */
    claimNonce(nonce, at = now()) {
      if (!/^[0-9a-f]{32}$/.test(nonce)) throw new StoreError('bad_nonce');
      const file = p('nonces', nonce);
      try { writeExcl(file, `${at}\npending`); return true; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let text;
      try { text = readSmallFile(file, 64); } catch (e) {
        if (e?.code === 'ENOENT') return this.claimNonce(nonce, at); // 読む直前に消えた（prune）：取り直す
        throw new StoreError('nonce_unreadable'); // 権限・I/O・大きすぎる：replay の守りを開けない（file は inbox に残る）
      }
      const [first, mark] = text.split('\n');
      // done・古い形（1 行の時刻）だけが replay。それ以外の中身（途中で切れた・NUL で埋まった・知らない形）は印が壊れている：
      // replay として捨てず、nonce_unreadable で止める（file は inbox に残る。2026-11-10 監査 F3）
      if (/^[0-9]{1,16}\ndone$/.test(text) || /^[0-9]{1,16}$/.test(text)) return false;
      if (text !== '' && !/^[0-9]{1,16}\npending$/.test(text)) throw new StoreError('nonce_unreadable');
      // 途中の印：取った時刻から 60 秒未満は busy。空の印（作った直後・書く前）は file の時刻で同じく待つ
      let t0 = mark === 'pending' && /^[0-9]{1,16}$/.test(first) ? Number(first) : NaN;
      if (text === '') { try { t0 = statSync(file).mtimeMs; } catch { t0 = at; } }
      if (!Number.isFinite(t0) || at - t0 < LOCK_STALE_MS) throw new StoreError('nonce_busy');
      writeAtomic(file, `${at}\npending`); // 前の回が途中で止まった印を引き継ぐ
      return true;
    },
    /** 取り込みが終わった印にする（task ができた・拒否が決まった）。中身が自分の at の時だけ。以後の同じ封は replay */
    finishNonce(nonce, at = now()) {
      if (!/^[0-9a-f]{32}$/.test(nonce)) throw new StoreError('bad_nonce');
      try {
        if (readSmallFile(p('nonces', nonce), 64) !== `${at}\npending`) return false;
        writeAtomic(p('nonces', nonce), `${at}\ndone`);
        return true;
      } catch { return false; }
    },
    pruneNonces(at = now(), retentionMs = NONCE_RETENTION_MS) {
      let n = 0;
      for (const f of readdirSync(p('nonces'))) {
        try {
          if (at - statSync(p('nonces', f)).mtimeMs > retentionMs) { unlinkSync(p('nonces', f)); n += 1; }
        } catch { /* 消えた */ }
      }
      return n;
    },

    // ─── task ───
    readTask(id) {
      return readJson(taskFile(id), TASK_FILE_MAX);
    },
    listTasks({ state = null, business = null } = {}) {
      const out = [];
      for (const f of readdirSync(p('tasks'))) {
        if (!f.endsWith('.json')) continue;
        const t = readJson(p('tasks', f), TASK_FILE_MAX);
        if (t && (!state || t.state === state) && (!business || t.business === business)) out.push(t);
      }
      return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.task_id.localeCompare(b.task_id));
    },
    findByKey(source, key) {
      const m = readJson(p('keys', sha(`${source}|${key}`)));
      return m && TASK_ID_RE.test(m.task_id) ? this.readTask(m.task_id) : null;
    },
    /**
     * 依頼を 1 件作る。(source, key) は先着 1 つ。戻り値：{ created: true, task } ／ { created: false, task }（同じ内容の重複）／ { conflict: true, task_id }（同じ key で内容が違う）
     * t：{ source, channel, business, intent, idempotency_key, params, summary, class, handler, decision, state, content_digest, timeout_ms, max_attempts?, code? }
     */
    createTask(t, at = now()) {
      const marker = p('keys', sha(`${t.source}|${t.idempotency_key}`));
      const id = newTaskId(at);
      const tmp = `${marker}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeExcl(tmp, JSON.stringify({ task_id: id, content_digest: t.content_digest, created_at: iso(at) }));
      let taken = null;
      try { linkSync(tmp, marker); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        taken = readJson(marker);
      } finally { try { unlinkSync(tmp); } catch { /* 済 */ } }
      if (taken) {
        if (taken.content_digest !== t.content_digest) return { conflict: true, task_id: taken.task_id };
        const existing = TASK_ID_RE.test(taken.task_id) ? this.readTask(taken.task_id) : null;
        if (existing) {
          // 作った直後のまま（何も起きていない）なら、結果の板への知らせを書き直す（前の回が outbox を書く前に止まっていても、依頼元が状態を知れる。同じ名前の file を上書きするだけ）
          // 時刻は task の updated_at（取り込みの開始の時刻ではない）＝並んで起きた Human の承認・却下の知らせより新しくならない
          if (existing.history?.length === 1) { const t = Date.parse(existing.updated_at); this._outbox(existing, Number.isFinite(t) ? t : at); }
          return { created: false, task: existing };
        }
        // 印だけ残って task が無い（作る途中で止まった）：同じ内容なので、印の id で作り直す
        return { created: true, task: this._create(this._build(t, taken.task_id, at), at, 'recovered'), recovered: true };
      }
      return { created: true, task: this._create(this._build(t, id, at), at) };
    },
    /**
     * 新しい task を書く。監査の「created」を先に書いてから task の file を書く（2026-11-10 再検証）：監査が書けなければ task は無い＝
     * 取り込みは nonce を外して失敗し、次の回に印の id で作り直す（監査の無い task を残さない）。task の file が書けなかった時も同じ道（監査は 2 行になりうる）
     */
    _create(task, at, code = null) {
      this.audit({ task_id: task.task_id, event: 'created', state: task.state, code }, at);
      // 無い時だけ作る（2026-11-10 監査 F4）：止まっていた古い取り込みが再開して、終わった task を created の形で上書きし、もう一度実行させない
      if (!writeNew(taskFile(task.task_id), `${JSON.stringify(task)}\n`)) {
        const existing = this.readTask(task.task_id);
        if (!existing) throw new StoreError('task_unreadable');
        return existing;
      }
      this._outbox(task, at);
      return task;
    },
    /**
     * 取り込みの結果を disk へ（2026-11-10 監査 F7）。inbox の file を done/ へ移す＝元の写しを手放す前に、task・印・監査を fsync する
     * （電源断で rename だけ残り task が空・無い形を作らない）。macOS の fsync は F_FULLFSYNC ではない（vps-client と同じ注）
     */
    syncIntake(taskId = null) {
      if (taskId && TASK_ID_RE.test(taskId)) fsyncPath(taskFile(taskId));
      for (const f of [p('audit.jsonl'), p('audit.tip'), p('tasks'), p('keys'), p('nonces'), root]) fsyncPath(f);
    },
    _build(t, id, at) {
      return {
        task_id: id, source: t.source, channel: t.channel, business: t.business, intent: t.intent, idempotency_key: t.idempotency_key,
        params: t.params, summary: t.summary ?? '', class: t.class, handler: t.handler ?? null,
        decision: t.decision ?? { reasons: [], gateway: null }, state: t.state, content_digest: t.content_digest,
        attempts: 0, max_attempts: t.max_attempts ?? 3, next_try_at: null, timeout_ms: t.timeout_ms ?? 10_000, lease_until: null,
        checkpoint: null, result: null, error: t.code ? { code: t.code } : null, approval: null,
        history: [{ at: iso(at), state: t.state, event: 'created', ...(t.code ? { code: t.code } : {}) }], created_at: iso(at), updated_at: iso(at),
      };
    },
    _write(task, event, at, code = null) {
      writeAtomic(taskFile(task.task_id), `${JSON.stringify(task)}\n`);
      this.audit({ task_id: task.task_id, event, state: task.state, code }, at);
      this._outbox(task, at);
      return task;
    },
    /** 読み直して・排他で・state を変えて書く。許されない遷移は bad_transition。patch は task の field を上書きする */
    transition(id, state, { event = `to_${state}`, code = null, patch = {}, at = now() } = {}) {
      if (!STATES.includes(state)) throw new StoreError('bad_state');
      return locked(p('locks', `${id}.lock`), () => {
        const task = this.readTask(id);
        if (!task) throw new StoreError('not_found');
        if (!(TRANSITIONS[task.state] ?? []).includes(state)) throw new StoreError('bad_transition');
        const next = { ...task, ...patch, state, updated_at: iso(at), history: [...task.history, { at: iso(at), state, event, ...(code ? { code } : {}) }].slice(-50) };
        if (code) next.error = { code };
        return this._write(next, event, at, code);
      });
    },

    // ─── outbox（依頼元＝人以外へ返す）───
    _outbox(task, at) {
      if (task.source === HUMAN_SOURCE || !OUTBOX_STATES.has(task.state)) return null;
      const make = (withResult) => JSON.stringify({ task_id: task.task_id, state: task.state, intent: task.intent, ...(task.error?.code && task.state !== 'succeeded' ? { code: task.error.code } : {}), ...(withResult && task.state === 'succeeded' ? { result: task.result } : { ...(task.state === 'succeeded' ? { result_truncated: true } : {}) }) });
      let body = make(true);
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) body = make(false);
      const file = p('outbox', `${sha(`${task.source}|${task.idempotency_key}|${task.state}`)}.json`);
      writeAtomic(file, `${JSON.stringify({ task_ref: task.idempotency_key, source: task.source, channel: task.channel, business: task.business, state: task.state, updated_at: at, body })}\n`);
      return file;
    },
    /**
     * Hermes の結果を依頼元（人以外）の結果の板へ返す（2026-11-11）。hermes.task は「渡した」で succeeded になっているので、同じ task_ref に
     * 新しい updated_at の知らせを足す（板は新しい方が勝つ）。summary は collect-hermes が envelope の関所で検査済みの文だけ
     */
    hermesNotice(task, { status, text }, at) {
      if (task.source === HUMAN_SOURCE || task.state !== 'succeeded') return null;
      const body = JSON.stringify({ task_id: task.task_id, state: 'succeeded', intent: task.intent, result: { delivered: true, hermes: { status, summary: text } } });
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;
      const file = p('outbox', `${sha(`${task.source}|${task.idempotency_key}|hermes`)}.json`);
      writeAtomic(file, `${JSON.stringify({ task_ref: task.idempotency_key, source: task.source, channel: task.channel, business: task.business, state: 'succeeded', updated_at: at, body })}\n`);
      return file;
    },
    /** task にならなかった依頼の「受け付けなかった」を依頼元へ返す（認証済みの封で、依頼の鍵が読めた時だけ・理由はコードだけ） */
    rejectNotice({ source, channel, idempotency_key: key, business = null, code }, at) {
      if (source === HUMAN_SOURCE || typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key) || !/^[a-z0-9_]{1,48}$/.test(String(code))) return null;
      const file = p('outbox', `${sha(`${source}|${key}|rejected`)}.json`);
      writeAtomic(file, `${JSON.stringify({ task_ref: key, source, channel, business, state: 'rejected', updated_at: at, body: JSON.stringify({ state: 'rejected', code }) })}\n`);
      return file;
    },
    listOutbox() {
      return readdirSync(p('outbox')).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).sort().map((f) => ({ file: f, ...readJson(p('outbox', f), OUTBOX_FILE_MAX) }));
    },
    /** 配ったら outbox-sent へ移す（名前だけ受ける＝パスをたどらせない） */
    markDelivered(file) {
      if (!/^[0-9a-f]{64}\.json$/.test(file)) throw new StoreError('bad_outbox_name');
      renameSync(p('outbox', file), p('outbox-sent', file));
    },
    pruneOutboxSent(at = now(), retentionMs = 30 * 86_400_000) {
      let n = 0;
      for (const f of readdirSync(p('outbox-sent'))) {
        try { if (at - statSync(p('outbox-sent', f)).mtimeMs > retentionMs) { unlinkSync(p('outbox-sent', f)); n += 1; } } catch { /* 済 */ }
      }
      return n;
    },

    // ─── 単独実行の lock・PAUSE ───
    /** 取れれば release 関数、他の runner が居れば null。owner の pid が居ない lock は古いので取り除く（取る瞬間に owner が書かれている） */
    acquireRunLock(at = now()) {
      return tryLockDir(p('run.lock'), at, { maxAgeMs: RUN_LOCK_MAX_AGE_MS, hooks: lockHooks, onConflict });
    },
    /** 今ある run.lock の経過 ms（started_at から）。無い・読めない時は null。runner が「取れなかった lock が古い」を知らせるのに使う */
    runLockAgeMs(at = now()) {
      const started = readJson(p('run.lock', 'owner.json'))?.started_at;
      return Number.isFinite(started) ? at - started : null;
    },
    // ─── 回路遮断の連続回数（runner の回をまたぐ）───
    breakerCount() {
      const n = readJson(p('breaker.json'))?.consecutive;
      return Number.isInteger(n) && n >= 0 && n < 1000 ? n : 0;
    },
    setBreakerCount(n) {
      if (n === this.breakerCount() && (n > 0 || !existsSync(p('breaker.json')))) return;
      if (n === 0) { try { unlinkSync(p('breaker.json')); } catch { /* 無い */ } return; }
      writeAtomic(p('breaker.json'), JSON.stringify({ consecutive: n }));
    },
    isPaused() {
      return existsSync(p('PAUSE'));
    },
    pauseCode() {
      try { return readSmallFile(p('PAUSE'), 4096).trim().slice(0, 40); } catch { return null; }
    },
    pause(code, at = now()) {
      try { writeExcl(p('PAUSE'), `${code}\n`); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      this.audit({ event: 'paused', code }, at);
    },
    clearPause(at = now()) {
      if (lstatSync(p('PAUSE'), { throwIfNoEntry: false })) { unlinkSync(p('PAUSE')); this.audit({ event: 'pause_cleared' }, at); return true; }
      return false;
    },

    // ─── business ごとの記録 ───
    _recordFile(business, kind) {
      if (!BUSINESS_RE.test(business) || !RECORD_KINDS.includes(kind)) throw new StoreError('bad_record_target');
      return p('records', business, `${kind}.jsonl`);
    },
    /** id ごとに最後の行を採る（同じ id の取り込み直しは更新）。壊れた行は飛ばす。symlink・FIFO・巨大な file は空として扱う。Map(id → row) */
    readRecords(business, kind) {
      const m = new Map();
      let text;
      try { text = readSmallFile(this._recordFile(business, kind), RECORDS_FILE_MAX); } catch (e) { if (e instanceof StoreError) throw e; return m; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (typeof r?.id === 'string') m.set(r.id, r); } catch { /* 壊れた行 */ }
      }
      return m;
    },
    appendRecords(business, kind, rows) {
      if (!rows.length) return 0;
      const file = this._recordFile(business, kind);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      return locked(p('locks', `rec-${business}-${kind}.lock`), (owns) => {
        if (!owns()) throw new StoreError('lock_lost');
        appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
        return rows.length;
      });
    },
    /**
     * 保持：keep(row) が false の行と、同じ id の古い行を落とし、新しい方から RECORD_MAX_ROWS[kind] 件までにして書き直す（tmp → rename）。
     * 落とした件数を返す。変える物が無ければ書かない。
     */
    compactRecords(business, kind, keep = () => true) {
      const file = this._recordFile(business, kind);
      return locked(p('locks', `rec-${business}-${kind}.lock`), (owns) => {
        if (!owns()) throw new StoreError('lock_lost');
        let text;
        try { text = readSmallFile(file, RECORDS_FILE_MAX); } catch { return 0; }
        const lines = text.split('\n').filter(Boolean).length;
        const rows = [...this.readRecords(business, kind).values()].filter((r) => keep(r));
        const kept = rows.slice(-RECORD_MAX_ROWS[kind]);
        if (kept.length === lines) return 0;
        writeAtomic(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
        return lines - kept.length;
      });
    },
    recordBusinesses() {
      return readdirSync(p('records'), { withFileTypes: true }).filter((e) => e.isDirectory() && BUSINESS_RE.test(e.name)).map((e) => e.name);
    },
    /** 途中で止まった tmp（lock の一時フォルダ・tombstone）を消す。LOCK_STALE_MS 以上古い物だけ */
    pruneTmp(at = now()) {
      let n = 0;
      for (const dir of [root, p('locks')]) {
        for (const f of readdirSync(dir).filter((x) => /\.tmp$/.test(x))) {
          try { if (at - lstatSync(path.join(dir, f)).mtimeMs > LOCK_STALE_MS) { rmSync(path.join(dir, f), { recursive: true, force: true }); n += 1; } } catch { /* 済 */ }
        }
      }
      return n;
    },
  };
  return store;
}
