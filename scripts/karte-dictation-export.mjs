#!/usr/bin/env node
/**
 * 現場の口述の記録（Task Hub の note.record kind "dictation"）を、APP 側（karte-adapter の dictation-diff）の入力の形 `dictation-input-v1` の JSONL に書き出す
 * （2026-11-24・Human 決定 E）。読むだけ（Task Hub の記録）・通信なし・Dropbox に書かない。
 *
 *   node scripts/karte-dictation-export.mjs --business <b> (--out <file.jsonl> | --out-dir <dir>) [--since YYYY-MM-DD] [--store <dir>]
 *
 * --out-dir（2026-11-24）：1 つの口述＝1 つの <input_id>.json（APP 側の dictation-diff の --input は 1 file に 1 つの JSON を読む＝JSONL は読めない）。
 * 同じ名前の file が在れば書かない（上書きしない・前に書き出した口述はそのまま）
 *
 * - Mac は構造化しない・確定しない（寸法の候補・出所の段階・確認は APP 側と Human）。原文はそのまま渡す
 *   （ただし Task Hub の受け口は文字を NFKC に揃える＝全角の数字・記号は半角になっている。台帳 task-hub-nfkc-text）
 * - case_id：Human が言った case_ref があればそれ、無ければ現場名（H-17 の現場ID の形が決まるまでの仮。APP 側で照合する）
 * - input_id：Mac の記録の ID から作った固定の値（同じ口述を何度書き出しても同じ＝APP 側の重複の判定に使える）。Task Hub の task の ID そのものは出さない
 * - 置き場所（H-3・H-15）は決まっていない＝出力は Human が指定した手元の file だけ（0600）
 * exit：0＝書いた／2＝引数・記録の誤り
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './lib/task-hub/store.mjs';

const DEFAULT_STORE = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub');
const CHANNELS = new Set(['typed', 'voice_transcript', 'unknown']);

/** 記録の 1 行 → dictation-input-v1（形が合わない行は null） */
export function toDictationInput(r) {
  const caseId = typeof r.case_ref === 'string' && r.case_ref ? r.case_ref : typeof r.site === 'string' && r.site ? r.site : null;
  if (typeof r.id !== 'string' || typeof r.text !== 'string' || !r.text || !caseId) return null;
  return {
    schema: 'dictation-input-v1',
    input_id: `mac-${createHash('sha256').update(`dictation|${r.id}`, 'utf8').digest('hex').slice(0, 24)}`,
    case_id: caseId,
    text: r.text,
    recorded_on: typeof r.recorded_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.recorded_on) ? r.recorded_on : null,
    channel: CHANNELS.has(r.channel) ? r.channel : 'unknown',
    speaker: null,
  };
}

export function exportDictations(store, business, { since = null } = {}) {
  const rows = [...store.readRecords(business, 'dictation').values()].filter((r) => !since || String(r.recorded_on ?? r.at ?? '').slice(0, 10) >= since);
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const out = [];
  let skipped = 0;
  for (const r of rows) { const x = toDictationInput(r); if (x) out.push(x); else skipped += 1; }
  return { inputs: out, skipped };
}

export function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  const a = { business: null, out: null, 'out-dir': null, since: null, store: DEFAULT_STORE };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--business', '--out', '--out-dir', '--since', '--store'].includes(k) || v === undefined) { err('usage: karte-dictation-export.mjs --business <b> (--out <file.jsonl> | --out-dir <dir>) [--since YYYY-MM-DD] [--store <dir>]'); return 2; }
    a[k.slice(2)] = v;
  }
  if (!a.business || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(a.business) || Boolean(a.out) === Boolean(a['out-dir']) || (a.since && !/^\d{4}-\d{2}-\d{2}$/.test(a.since))) { err('usage: karte-dictation-export.mjs --business <b> (--out <file.jsonl> | --out-dir <dir>) [--since YYYY-MM-DD] [--store <dir>]'); return 2; }
  const store = openStore(a.store);
  const r = exportDictations(store, a.business, { since: a.since });
  if (a.out) writeFileSync(a.out, r.inputs.map((x) => `${JSON.stringify(x)}\n`).join(''), { mode: 0o600 });
  else {
    mkdirSync(a['out-dir'], { recursive: true, mode: 0o700 });
    let kept = 0;
    for (const x of r.inputs) { const f = path.join(a['out-dir'], `${x.input_id}.json`); if (existsSync(f)) { kept += 1; continue; } writeFileSync(f, `${JSON.stringify(x, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
    if (kept) out(`前に書き出した ${kept} 件はそのまま（上書きしない）`);
  }
  out(`書き出し ${r.inputs.length} 件${r.skipped ? `（形の合わない記録 ${r.skipped} 件は飛ばした）` : ''}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
