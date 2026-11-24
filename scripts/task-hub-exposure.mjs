#!/usr/bin/env node
/**
 * Task Hub の「届く範囲」の表（2026-11-24・MA-24）。依頼元 × business ごとに、どの intent が無人で動くか（auto・ai_check）、
 * どれが毎回 Human の承認か（human_required）、断るか（forbidden）を、台帳（intents.json）と local config だけから出す。読むだけ・通信なし・書かない。
 *
 *   node scripts/task-hub-exposure.mjs [--config <file>] [--source <id>] [--json]
 *
 * 使い道：EN司令塔に読むだけの機能を開く前と後で、案（config.*.PROPOSAL.json）と本番の config.json を比べる（docs/grok-bot.md §9）。
 * Dropbox の範囲は件数だけ出す（フォルダの名前は出さない＝画面・log に会社のフォルダ名を残さない）。
 * Gateway（Decision Layer）は無人の候補をさらに human_required へ厳しくすることがある（緩めることは無い）＝ここの auto は「無人で動きうる」の上限。
 * exit：0＝表を出した／2＝引数か config の誤り
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPolicy, loadCatalog, loadLocalConfig } from './lib/task-hub/policy.mjs';

const DEFAULT_CONFIG = path.join(homedir(), 'e-nexus-runtime', 'mac-runtime-state', 'task-hub', 'config.json');
const ORDER = ['auto', 'ai_check', 'human_required', 'forbidden'];

/** { rows: [{ source, business, classes: { auto: [...], ... }, dropbox }] }（純粋＝試験しやすい） */
export function exposure(config, { catalog = loadCatalog(), only = null } = {}) {
  const policy = createPolicy({ catalog, config, gateway: { decide: async () => ({}) } });
  const intents = Object.keys(catalog.intents).sort();
  const rows = [];
  for (const [source, s] of Object.entries(config.sources)) {
    if (only && source !== only) continue;
    for (const business of s.businesses) {
      const classes = Object.fromEntries(ORDER.map((c) => [c, []]));
      for (const intent of intents) {
        const r = policy.reach({ source, business, intent });
        if (r.ok) classes[r.class].push(intent);
      }
      const d = config.dropbox?.businesses?.[business];
      const n = (k) => (Array.isArray(d?.[k]) ? d[k].length : 0);
      rows.push({ source, business, classes, dropbox: d ? { read_only: d.read_only === true, read_roots: n('read_roots'), schedule_files: n('schedule_files'), estimate_roots: n('estimate_roots'), pdf_roots: n('pdf_roots'), deny_roots: n('deny_roots'), deny_names: n('deny_names') } : null });
    }
  }
  return { rows };
}

export function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  const a = { config: DEFAULT_CONFIG, source: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if ((k === '--config' || k === '--source') && argv[i + 1]) { a[k.slice(2)] = argv[i + 1]; i += 1; } else { err('usage: task-hub-exposure.mjs [--config <file>] [--source <id>] [--json]'); return 2; }
  }
  let config;
  try { config = loadLocalConfig(a.config); } catch (e) { err(`config を読めない（${String(e.message).slice(0, 120)}）`); return 2; }
  const r = exposure(config, { only: a.source });
  if (a.json) { out(JSON.stringify(r)); return 0; }
  for (const row of r.rows) {
    out(`${row.source} / ${row.business}`);
    out(`  無人で動きうる（auto）: ${row.classes.auto.join(', ') || 'なし'}`);
    out(`  無人で動きうる（ai_check）: ${row.classes.ai_check.join(', ') || 'なし'}`);
    out(`  毎回 Human の承認: ${row.classes.human_required.length} 個${row.classes.human_required.length <= 12 ? `（${row.classes.human_required.join(', ')}）` : ''}`);
    out(`  Dropbox: ${row.dropbox ? Object.entries(row.dropbox).map(([k, v]) => `${k}=${v}`).join(' ') : '設定なし（読めない）'}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
