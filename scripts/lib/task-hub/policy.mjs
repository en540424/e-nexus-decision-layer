/**
 * Task Hub の分類（2026-11-09・MA-24）。依頼を class（auto／ai_check／human_required／forbidden）に分け、Decision Layer の Gateway（executor-route）に聞いて「厳しくする方向にだけ」合成する。
 * Gateway は同じ process の SDK で呼ぶ（src/cli.mjs の gateway decide と同じ組み立て・通信なし・env は空＝EDL_ALLOW_NETWORK も環境の指定も読まない）。
 * Decision Layer は承認しない：candidate は「無人で走らせてよい候補」の読みであって許可ではない。許可は intents.json の class（人が決めた台帳）と Human の承認だけ。
 *
 * local config（repo に置かない）：{ sources: { <id>: { channels: [..], businesses: [..], intents?: [..] } }, businesses: [..], hermes_inbox?, brief_path?, utc_offset_minutes? }
 */
import { readFileSync, statSync } from 'node:fs';
import { createDecisionLayerEngine, createGateway, createMemoryMeter } from '../../../src/index.mjs';
import { interpretEnvelope } from '../../../consumer-kit/node/interpret.mjs';
import { DEFAULT_MAX_PARAMS_BYTES, INTENT_RE, checkSpec } from './envelope.mjs';
import { ID_RE } from './wire.mjs';

export const CLASSES = Object.freeze(['auto', 'ai_check', 'human_required', 'forbidden']);
const RANK = Object.freeze({ auto: 0, ai_check: 1, human_required: 2, forbidden: 3 });
const FLAG_BOOLS = ['touches_secrets', 'paid_api', 'external_send', 'production_change', 'irreversible'];
const WORK_CENTERS = ['implementation', 'design-judgment', 'reading-comparison-audit', 'operations'];
const MODES = ['interactive', 'long-running', 'scheduled'];
const ENVS = ['dev', 'staging', 'production'];
/** Gateway に使う ID。project_id は registries/projects.json にある「この repo 自身」（kind: platform）。Task Hub はこの repo の部品なので、他の project を名乗らない */
export const GATEWAY_APPLICATION_ID = 'task-hub';
export const GATEWAY_PROJECT_ID = 'e-nexus-decision-layer';
const GATEWAY_TIMEOUT_MS = 15_000;
const DEFAULT_CATALOG = new URL('../../../policies/task-hub/intents.json', import.meta.url);
const DEFAULT_FLAGS = Object.freeze({ work_center: 'operations', execution_mode: 'interactive', environment: 'dev', touches_secrets: false, paid_api: false, external_send: false, production_change: false, irreversible: false });
const tighter = (a, b) => (RANK[b] > RANK[a] ? b : a);

/** 台帳を読んで検査する。不正なら throw（黙って緩い台帳で動かない） */
export function loadCatalog(file = DEFAULT_CATALOG) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const bad = (m) => { throw new Error(`intents catalog invalid: ${m}`); };
  if (!Array.isArray(c.forbidden_prefixes) || c.forbidden_prefixes.some((p) => typeof p !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(p))) bad('forbidden_prefixes');
  if (!c.intents || typeof c.intents !== 'object') bad('intents');
  for (const [name, i] of Object.entries(c.intents)) {
    if (!INTENT_RE.test(name)) bad(`name ${name}`);
    if (!CLASSES.includes(i.class)) bad(`${name}.class`);
    if (i.handler !== null && typeof i.handler !== 'string') bad(`${name}.handler`);
    if ((i.class === 'auto' || i.class === 'ai_check') && !i.handler) bad(`${name}: ${i.class} needs a handler`);
    if (i.class === 'forbidden' && i.handler) bad(`${name}: forbidden has no handler`);
    const f = i.flags ?? {};
    if (!WORK_CENTERS.includes(f.work_center) || !MODES.includes(f.execution_mode) || !ENVS.includes(f.environment) || FLAG_BOOLS.some((k) => typeof f[k] !== 'boolean')) bad(`${name}.flags`);
    if ((i.class === 'auto' || i.class === 'ai_check') && FLAG_BOOLS.some((k) => f[k])) bad(`${name}: ${i.class} must have all risk flags false`);
    if (i.max_params_bytes !== undefined && !(Number.isInteger(i.max_params_bytes) && i.max_params_bytes <= 14_000)) bad(`${name}.max_params_bytes`);
  }
  return c;
}

/** local config を読んで検査する。file は他のユーザーが書ける権限だと拒否 */
export function loadLocalConfig(file) {
  const st = statSync(file);
  if (st.mode & 0o022) throw new Error('config is writable by group/others');
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')));
}
export function validateConfig(c) {
  const bad = (m) => { throw new Error(`config invalid: ${m}`); };
  if (!c || typeof c !== 'object' || !c.sources || typeof c.sources !== 'object') bad('sources');
  if (!Array.isArray(c.businesses) || c.businesses.some((b) => typeof b !== 'string' || !ID_RE.test(b))) bad('businesses');
  for (const [id, s] of Object.entries(c.sources)) {
    if (!ID_RE.test(id)) bad(`source ${id}`);
    if (!Array.isArray(s.channels) || !s.channels.length || s.channels.some((x) => !ID_RE.test(x))) bad(`${id}.channels`);
    if (!Array.isArray(s.businesses) || !s.businesses.length || s.businesses.some((b) => !c.businesses.includes(b))) bad(`${id}.businesses`);
    if (s.intents !== undefined && (!Array.isArray(s.intents) || s.intents.some((x) => !INTENT_RE.test(x)))) bad(`${id}.intents`);
  }
  for (const k of ['hermes_inbox', 'brief_path']) if (c[k] !== undefined && (typeof c[k] !== 'string' || !c[k].startsWith('/'))) bad(k);
  if (c.utc_offset_minutes !== undefined && !(Number.isInteger(c.utc_offset_minutes) && c.utc_offset_minutes >= -720 && c.utc_offset_minutes <= 840)) bad('utc_offset_minutes');
  return c;
}

/** 既定の Gateway：in-process・rules だけで答える executor-route・env 空（engine にも Gateway にも渡す＝process.env の EDL_ENVIRONMENT・EDL_GATEWAY_* が分類を変えない）・メモリの meter（repo の data/ に書かない） */
export function defaultGateway() {
  return createGateway({ env: {}, engine: createDecisionLayerEngine({ mode: 'production', env: {}, meter: createMemoryMeter() }) });
}

/** Gateway の答えを task に残す要約へ。文・本文は残さない */
function summarize(envelope, interp) {
  const d = envelope?.decision;
  return { status: envelope?.ok === true ? 'ok' : 'error', next: interp.next, reason: interp.reason, tier: d?.tier ?? null, executor: d?.outcome?.recommended_executor ?? null, rule: typeof d?.rationale === 'string' ? d.rationale.slice(0, 80) : null };
}

async function askGateway(gateway, intent, flags) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GATEWAY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const request = {
      contract_version: '1', decision_type: 'executor-route', application_id: GATEWAY_APPLICATION_ID, project_id: GATEWAY_PROJECT_ID,
      // input は構造情報だけ。依頼の summary・params は入れない（intent の名前が作業の説明）
      input: { work_center: flags.work_center, execution_mode: flags.execution_mode, environment: flags.environment, ...Object.fromEntries(FLAG_BOOLS.map((k) => [k, flags[k]])), summary: intent },
    };
    const envelope = await Promise.race([
      gateway.decide(request, { via: 'sdk', signal: ac.signal }),
      new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('gateway_timeout')))),
    ]);
    return summarize(envelope, interpretEnvelope(envelope));
  } catch {
    return { status: 'error', next: 'human', reason: 'gateway_unavailable', tier: null, executor: null, rule: null };
  } finally { clearTimeout(timer); }
}

export function createPolicy({ catalog = loadCatalog(), config, gateway = defaultGateway() }) {
  const prefixMatch = (intent) => catalog.forbidden_prefixes.some((p) => (p.endsWith('.') ? intent.startsWith(p) : intent === p || intent.startsWith(`${p}.`)));
  const entryOf = (intent) => catalog.intents[intent] ?? null;

  /** 台帳と local config だけで決まる部分（Gateway なし）。{ ok:false, code } か { ok:true, class, handler, reasons, entry } */
  function base({ source, channel, envelope }) {
    const s = config.sources[source];
    if (!Object.hasOwn(config.sources, source) || !s) return { ok: false, code: 'unknown_source' };
    if (!s.channels.includes(channel)) return { ok: false, code: 'channel_not_allowed' };
    if (!config.businesses.includes(envelope.business) || !s.businesses.includes(envelope.business)) return { ok: false, code: 'business_not_allowed' };
    const entry = entryOf(envelope.intent);
    const reasons = [];
    if (prefixMatch(envelope.intent) || entry?.class === 'forbidden') return { ok: true, class: 'forbidden', handler: null, reasons: ['forbidden_intent'], entry };
    let cls = entry?.class ?? 'human_required';
    if (!entry) reasons.push('unknown_intent');
    if (s.intents && !s.intents.includes(envelope.intent)) { cls = tighter(cls, 'human_required'); reasons.push('intent_not_in_source_allowlist'); }
    return { ok: true, class: cls, handler: entry?.handler ?? null, reasons, entry };
  }

  return {
    catalog,
    config,
    entry: entryOf,
    /** 無人で走らせる時にもう一度（Gateway なしで）確かめる：config／台帳が変わっていたら止める */
    recheck(task) {
      const b = base({ source: task.source, channel: task.channel, envelope: { business: task.business, intent: task.intent } });
      if (!b.ok) return { ok: false, code: 'policy_changed' };
      if (b.class === 'forbidden') return { ok: false, code: 'forbidden_intent' };
      if ((b.handler ?? null) !== (task.handler ?? null)) return { ok: false, code: 'policy_changed' };
      if (RANK[b.class] > RANK[task.class]) return { ok: false, code: 'policy_changed' };
      return { ok: true };
    },
    /** 依頼を分類する。reject は task を作らない。params が台帳の形に合わない時は ok:true・invalid（intake が rejected の task にする） */
    async classify({ source, channel, envelope }) {
      const b = base({ source, channel, envelope });
      if (!b.ok) return b;
      if (b.class === 'forbidden') return { ok: true, class: 'forbidden', handler: null, reasons: b.reasons, catalog_class: b.entry?.class ?? 'forbidden', gateway: { status: 'skipped', reason: 'forbidden' }, entry: b.entry };
      const reasons = [...b.reasons];
      const max = b.entry?.max_params_bytes ?? DEFAULT_MAX_PARAMS_BYTES;
      let invalid = null;
      if (Buffer.byteLength(JSON.stringify(envelope.params), 'utf8') > max) invalid = 'params_too_large';
      else if (b.entry?.params_schema && checkSpec(b.entry.params_schema, envelope.params)) invalid = 'params_invalid';
      const catalogClass = b.entry?.class ?? 'human_required';
      if (invalid) return { ok: true, class: b.class, handler: b.handler, reasons: [...reasons, invalid], catalog_class: catalogClass, gateway: { status: 'skipped', reason: invalid }, invalid, entry: b.entry };
      const flags = b.entry?.flags ?? DEFAULT_FLAGS;
      const g = await askGateway(gateway, envelope.intent, flags);
      let cls = b.class;
      if (g.next === 'review') {
        // auto は全部の flag が false の時だけ残れる。ai_check は review なら Human
        if (!(cls === 'auto' && FLAG_BOOLS.every((k) => !flags[k]))) cls = tighter(cls, 'human_required');
      } else if (g.next !== 'candidate') cls = tighter(cls, 'human_required'); // human／stop／失敗は少なくとも Human
      if (cls !== b.class) reasons.push(`gateway_${g.next}`);
      return { ok: true, class: cls, handler: b.handler, reasons, catalog_class: catalogClass, gateway: g, entry: b.entry };
    },
  };
}
