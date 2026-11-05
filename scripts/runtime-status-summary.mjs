#!/usr/bin/env node
/**
 * Hermes 用の状態の要約を手で見る（2026-11-04・A2）。READ-ONLY。既定は標準出力、--out は一時フォルダの中だけ。本番のファイルは host-health の 1 回分が書く（lib/runtime-status-summary.mjs）。
 *
 *   node scripts/runtime-status-summary.mjs [--state-dir <abs>] [--out <一時フォルダの中のファイル>]
 *
 * exit：0＝出した／2＝引数・書き先が許可の外
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STATE_DIR, pauseState, validateArgs } from './host-health.mjs';
import { assertMockOut, buildStatusSummary } from './lib/runtime-status-summary.mjs';

export function main(argv, { log = console.log, now = new Date() } = {}) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--state-dir', '--out'].includes(argv[i]) || argv[i + 1] === undefined) { console.error(`unknown argument: ${argv[i]}`); return 2; }
    a[argv[i]] = argv[i + 1];
  }
  const errors = validateArgs({ dataDirs: [], stateDir: a['--state-dir'] });
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  const dir = a['--state-dir'] ?? DEFAULT_STATE_DIR;
  let state = null;
  try {
    state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch { /* 無ければ stale の要約を出す */ }
  const summary = buildStatusSummary(state, { now, paused: pauseState(dir, now.toISOString()).paused, disabled: existsSync(path.join(dir, 'DISABLED')) });
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (!a['--out']) { log(text.trimEnd()); return 0; }
  try {
    writeFileSync(assertMockOut(a['--out']), text, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    console.error(err.code ?? err.message); // message にはパスが入る（assertMockOut の文言には入らない）
    return 2;
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
