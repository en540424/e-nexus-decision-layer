/**
 * Task Hub の取り込み（2026-11-09・MA-24）。封（wire.mjs）→ nonce → envelope → 分類 → task、の順に通す。どこで外れても理由のコードだけ返す（値は返さない・audit にも書かない）。
 * source と channel は封から（封を作った側が鍵で認証した結果）。依頼の本文が何を名乗っても使わない（未知の field は envelope で拒否）。
 *
 * 初期の state：forbidden → blocked／human_required → awaiting_approval／auto・ai_check（Gateway が candidate と読んだもの）→ queued／params が台帳の形に合わない → rejected。
 * 外の依頼が approved 状態で入る道は無い（承認は approval.mjs の approve だけ）。
 */
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { contentDigest, parseEnvelope } from './envelope.mjs';
import { readSmallFile } from './safe-read.mjs';
import { HUMAN_SOURCE, StoreError } from './store.mjs';
import { openRecord } from './wire.mjs';

export const LOCAL_CHANNEL = 'local-cli';
const MAX_INBOX_FILE_BYTES = 32 * 1024;
/** 認証済みの依頼元へ「受け付けなかった」を返す理由（知らない source・channel には返さない＝返す先が無い） */
const NOTICE_CODES = new Set(['business_not_allowed']);
/** 形の検査に落ちた依頼から、返事の宛先にする鍵だけを拾う（拾えなければ返事なし） */
function looseKey(body) {
  try { const k = JSON.parse(body)?.idempotency_key; return typeof k === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(k) ? k : null; } catch { return null; }
}
const INITIAL = Object.freeze({ forbidden: 'blocked', human_required: 'awaiting_approval', auto: 'queued', ai_check: 'queued' });

async function admit({ source, channel, envelope, store, policy, now }) {
  let c;
  try { c = await policy.classify({ source, channel, envelope }); } catch { c = { ok: true, class: 'human_required', handler: null, reasons: ['classifier_failed'], catalog_class: 'human_required', gateway: { status: 'error', next: 'human', reason: 'classifier_failed' }, entry: null }; }
  if (!c.ok) {
    store.audit({ event: 'intake_rejected', code: c.code }, now);
    if (NOTICE_CODES.has(c.code)) store.rejectNotice({ source, channel, idempotency_key: envelope.idempotency_key, code: c.code }, now);
    return { ok: false, code: c.code };
  }
  const state = c.invalid ? 'rejected' : INITIAL[c.class];
  const code = c.invalid ?? (state === 'blocked' ? 'forbidden_intent' : null);
  const made = store.createTask({
    source, channel, business: envelope.business, intent: envelope.intent, idempotency_key: envelope.idempotency_key, params: envelope.params, summary: envelope.summary,
    class: c.class, handler: c.handler, decision: { reasons: c.reasons, catalog_class: c.catalog_class, gateway: c.gateway }, state, code,
    content_digest: contentDigest({ source, business: envelope.business, intent: envelope.intent, params: envelope.params }),
    timeout_ms: c.entry?.timeout_ms ?? 10_000,
  }, now);
  if (made.conflict) {
    store.audit({ task_id: made.task_id, event: 'intake_rejected', code: 'idempotency_conflict' }, now);
    return { ok: false, code: 'idempotency_conflict', task_id: made.task_id };
  }
  return { ok: true, task_id: made.task.task_id, state: made.task.state, class: made.task.class, duplicate: !made.created, ...(code ? { code } : {}) };
}

/** 封 1 つを取り込む。{ ok, code?, task_id?, state?, duplicate? } */
export async function ingestRecord(raw, { keyFor, now = Date.now(), store, policy }) {
  const opened = openRecord(raw, { keyFor, now });
  if (!opened.ok) {
    store.audit({ event: 'intake_rejected', code: opened.code }, now);
    return { ok: false, code: opened.code };
  }
  const { record } = opened;
  if (!store.claimNonce(record.nonce, now)) {
    store.audit({ event: 'intake_rejected', code: 'replay' }, now);
    return { ok: false, code: 'replay' };
  }
  let result;
  try {
    const parsed = parseEnvelope(record.body);
    if (!parsed.ok) {
      store.audit({ event: 'intake_rejected', code: `envelope_${parsed.code}` }, now);
      if (policy.config?.sources?.[record.source]?.channels?.includes(record.channel)) store.rejectNotice({ source: record.source, channel: record.channel, idempotency_key: looseKey(record.body), code: `envelope_${parsed.code}`.replace(/[^a-z0-9_]/g, '_').slice(0, 48) }, now);
      result = { ok: false, code: `envelope_${parsed.code}` };
    } else {
      result = await admit({ source: record.source, channel: record.channel, envelope: parsed.envelope, store, policy, now });
    }
  } catch (e) {
    // nonce を取った後の失敗（lock_timeout・I/O）：印を外して投げ直す＝inbox に残った file が次の回で取り込まれる（外さないと replay として捨てられ、依頼が消える）
    try { store.releaseNonce(record.nonce, now); } catch { /* 外せなくても元の失敗を返す */ }
    throw e;
  }
  // 終わった印にする。書けなければ印は「途中」のまま＝60 秒の後の回が引き継いで取り込み直す（task は (source, key) の印で 1 件に収まるが、
  // task にならなかった封は今の policy でもう一度判定される）。黙らない：監査に残して投げる＝file は inbox に残り（inbox_error・CLI は exit 1）、次の回で印を終わらせ直す
  if (!store.finishNonce(record.nonce, now)) {
    try { store.audit({ event: 'intake_warning', code: 'nonce_finish_failed' }, now); } catch { /* 投げる方を優先 */ }
    throw new StoreError('nonce_finish_failed');
  }
  return result;
}

/** Human の CLI の依頼（封なし）。source は human-cli 固定で、local config に宣言されていなければ拒否 */
export async function submitLocal(input, { store, policy, now = Date.now(), source = HUMAN_SOURCE } = {}) {
  const parsed = parseEnvelope(input);
  if (!parsed.ok) {
    store.audit({ event: 'intake_rejected', code: `envelope_${parsed.code}` }, now);
    return { ok: false, code: `envelope_${parsed.code}` };
  }
  return admit({ source, channel: LOCAL_CHANNEL, envelope: parsed.envelope, store, policy, now });
}

/** 呼び出し側は run.lock を持つこと（scripts/task-hub.mjs の intake が持つ）。inbox の *.json（1 file ＝ 1 封）を順に取り込み、done/ か rejected/ へ移す（残す＝監査）。普通の file 以外（symlink・FIFO）・大きすぎる file は読まずに rejected へ（開く時に O_NOFOLLOW・O_NONBLOCK で確かめる＝lstat の後の差し替えで止まらない） */
export async function ingestInbox(dir, { keyFor, now = Date.now(), store, policy }) {
  const out = [];
  const move = (name, to) => {
    const dst = path.join(dir, to);
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    let target = path.join(dst, name);
    try { lstatSync(target); target = path.join(dst, `${name}.${now}`); } catch { /* 空き */ }
    renameSync(path.join(dir, name), target);
  };
  for (const name of readdirSync(dir).filter((f) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$/.test(f)).sort()) {
    let res;
    try {
      let text;
      try { text = readSmallFile(path.join(dir, name), MAX_INBOX_FILE_BYTES); } catch (e) { if (e?.code !== 'bad_file') throw e; text = null; }
      if (text === null) res = { ok: false, code: 'bad_file' };
      else {
        let raw;
        try { raw = JSON.parse(text); } catch { raw = undefined; }
        res = raw === undefined ? { ok: false, code: 'bad_json' } : await ingestRecord(raw, { keyFor, now, store, policy });
        if (res.code === 'bad_json') store.audit({ event: 'intake_rejected', code: 'bad_json' }, now);
      }
      if (res.code === 'bad_file') {
        store.audit({ event: 'intake_rejected', code: 'bad_file' }, now);
      }
      store.syncIntake(res.ok ? res.task_id : null); // 元の写しを手放す前に、作った物を disk へ（監査 F7）
      move(name, res.ok ? 'done' : 'rejected');
    } catch {
      res = { ok: false, code: 'inbox_error' };
    }
    out.push({ file: name, ...res });
  }
  return out;
}
