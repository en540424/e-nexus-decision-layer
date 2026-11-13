/**
 * ドコモメールの読み取り（docomo-mail-lab の bin/dml-fetch.mjs）の見張り（2026-11-13・読むだけ）。fetch-last.json が無ければ項目なし（休眠）。
 * 値はコードだけ（件名・差出人・件数の中身は出さない）。連続 3 回の失敗で warn。docs/runtime-monitoring.md。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readJsonSafe } from './task-hub/safe-read.mjs';

export const DOCOMO_WATCH_ID = 'docomo_fetch';
export const FAILURES_TO_WARN = 3;

/** { id, level, value, kind } か null。投げない */
export function docomoFetchItem(dir) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !existsSync(path.join(dir, 'fetch-last.json'))) return null;
    const j = readJsonSafe(path.join(dir, 'fetch-last.json'), 4096);
    if (!j) return { id: DOCOMO_WATCH_ID, level: 'warn', value: 'unreadable', kind: 'state' };
    if (j.ok === true) return { id: DOCOMO_WATCH_ID, level: 'ok', value: 'ok', kind: 'state' };
    const code = typeof j.code === 'string' && /^[a-z_]{1,40}$/.test(j.code) ? j.code : 'error';
    return { id: DOCOMO_WATCH_ID, level: Number.isInteger(j.failures) && j.failures >= FAILURES_TO_WARN ? 'warn' : 'ok', value: `failed ${code}`, kind: 'state' };
  } catch {
    return { id: DOCOMO_WATCH_ID, level: 'warn', value: 'unreadable', kind: 'state' };
  }
}
