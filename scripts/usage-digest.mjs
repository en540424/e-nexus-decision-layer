#!/usr/bin/env node
/**
 * Decision Gateway の内部の異常 digest（2026-09-29・Full Autonomous Build FB-18）。READ-ONLY・課金なし。
 *
 *   node scripts/usage-digest.mjs [--hours 24 | --since <ISO>] [--environment dev|staging|production] [--usage <path>]
 *        [--access-log <file>] [--cost-alert-usd-micros <n>] [--json] [--fail-on-anomaly]
 *        [--webhook credential:E-NEXUS/edl/<name> [--webhook-format json|slack|discord] [--webhook-always]]
 *
 * 読むもの（新しい計測機構は作らない：MA-30 正本 §18-8）：
 *   - usage.jsonl（1 判定 1 行）：consumer（application_id）ごとの件数・final tier・Human 率・resolved_by・Jev attempt の成否と
 *     unavailable の理由・aborted（timeout・切断・shutdown）とその理由・既知の費用・usage 不明の attempt
 *   - access log（任意・`gateway serve` の stderr を保存した JSONL）：status・error code（ENVIRONMENT_MISMATCH・GATEWAY_BUSY 等、
 *     usage に行が残らない失敗）
 * 出すもの：件数と理由の集計だけ。input・outcome・rationale・correlation_id・request_id は持ち出さない（usage にも input は無い）。
 *
 * 通知（任意・既定 OFF）：`--webhook credential:E-NEXUS/edl/<name>` のときだけ、異常があれば（`--webhook-always` なら毎回）digest を
 * POST する。URL は OS 資格情報ストアからだけ読む（引数・環境変数に URL を置かない＝token 入りの URL を shell 履歴・ps に残さない）。
 * https 必須。webhook 先の登録（資格情報ストアへの保存）は Human。共通通知 package は作らない（consumer ごとに持つ決定・MA-30）。
 * 定期実行（systemd timer・launchd・Task Scheduler）の登録も Human（docs/deploy-production-gateway.md §5・docs/gateway.md §8）。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultUsagePath, attemptsOf } from '../src/usage/metering.mjs';
import { RUNTIME_ENVIRONMENTS } from '../src/core/environment.mjs';
import { readCredential, EDL_CREDENTIAL_PATTERN } from './lib/env-file.mjs';

/** 異常とみなす既定の基準（件数が少ない時は率で騒がない） */
export const DEFAULT_ALERTS = Object.freeze({
  human_rate_min: 0.9,
  human_rate_min_decisions: 5,
  jev_unavailable_share_min: 0.5,
  jev_unavailable_min_attempts: 3,
  aborted_min: 1,
  gateway_5xx_min: 1,
  unauthorized_min: 5,
  rate_limited_min: 1,
  cost_usd_micros_min: null,
});

const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const r3 = (x) => Math.round(x * 1000) / 1000;

export function parseJsonl(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function inWindow(ts, since, until) {
  const t = Date.parse(ts ?? '');
  if (Number.isNaN(t)) return false;
  return t >= since.getTime() && t < until.getTime();
}

function emptyApp() {
  return { decisions: 0, tiers: {}, resolved_by: {}, human_rate: null, jev_attempts: 0, jev_ok: 0, jev_failed_reasons: {}, aborted: 0, abort_reasons: {}, known_cost_usd_micros: 0, unknown_usage_attempts: 0, decision_types: {} };
}

/**
 * @param {object[]} rows usage.jsonl の行
 * @param {{since: Date, until: Date, accessLines?: object[], alerts?: object}} o
 */
export function buildDigest(rows, { since, until, accessLines = [], alerts = DEFAULT_ALERTS }) {
  const a = { ...DEFAULT_ALERTS, ...alerts };
  const apps = {};
  for (const r of rows) {
    if (!inWindow(r.timestamp, since, until)) continue;
    const g = (apps[r.application_id ?? '(none)'] ??= emptyApp());
    inc(g.decision_types, r.decision_type ?? '(none)');
    if (r.aborted === true) {
      g.aborted += 1;
      inc(g.abort_reasons, r.abort_reason ?? '(none)');
    } else {
      g.decisions += 1;
      inc(g.tiers, r.tier ?? '(none)');
      inc(g.resolved_by, r.resolved_by ?? '(none)');
    }
    for (const t of attemptsOf(r)) {
      if (t.usage_known === true) g.known_cost_usd_micros += t.estimated_cost_usd_micros ?? 0;
      else g.unknown_usage_attempts += 1;
      if (t.adapter !== 'jev') continue;
      g.jev_attempts += 1;
      if (t.status === 'ok') g.jev_ok += 1;
      else inc(g.jev_failed_reasons, t.reason ?? t.status ?? '(none)');
    }
  }
  for (const g of Object.values(apps)) g.human_rate = g.decisions ? r3((g.tiers.human ?? 0) / g.decisions) : null;

  const access = { requests: 0, status: {}, error_codes: {} };
  for (const l of accessLines) {
    if (l?.component !== 'edl-gateway-http' || !l.ts || !inWindow(l.ts, since, until) || !l.method) continue;
    access.requests += 1;
    inc(access.status, String(l.status ?? '(none)'));
    if (l.error_code) inc(access.error_codes, l.error_code);
  }

  const anomalies = [];
  for (const [app, g] of Object.entries(apps)) {
    if (g.decisions >= a.human_rate_min_decisions && g.human_rate >= a.human_rate_min) anomalies.push({ kind: 'high_human_rate', application_id: app, value: g.human_rate, threshold: a.human_rate_min, note: 'Human へ回る判定が多い（Jev の不調・入力の欠け・閾値の見直し候補。recalibration-report で詳しく見る）' });
    const failed = g.jev_attempts - g.jev_ok;
    if (g.jev_attempts >= a.jev_unavailable_min_attempts && failed / g.jev_attempts >= a.jev_unavailable_share_min) anomalies.push({ kind: 'jev_unavailable', application_id: app, value: r3(failed / g.jev_attempts), threshold: a.jev_unavailable_share_min, reasons: g.jev_failed_reasons });
    if (g.aborted >= a.aborted_min) anomalies.push({ kind: 'aborted_decisions', application_id: app, value: g.aborted, threshold: a.aborted_min, reasons: g.abort_reasons });
  }
  const totalCost = Object.values(apps).reduce((s, g) => s + g.known_cost_usd_micros, 0);
  if (Number.isSafeInteger(a.cost_usd_micros_min) && totalCost >= a.cost_usd_micros_min) anomalies.push({ kind: 'cost', value: totalCost, threshold: a.cost_usd_micros_min });
  const count = (pred) => Object.entries(access.status).filter(([s]) => pred(Number(s))).reduce((n, [, c]) => n + c, 0);
  if (count((s) => s >= 500 && s < 600) >= a.gateway_5xx_min) anomalies.push({ kind: 'gateway_5xx', value: count((s) => s >= 500 && s < 600), threshold: a.gateway_5xx_min });
  if (count((s) => s === 401 || s === 403) >= a.unauthorized_min) anomalies.push({ kind: 'unauthorized', value: count((s) => s === 401 || s === 403), threshold: a.unauthorized_min, note: 'token の誤設定か、許可していない呼び出し' });
  if (count((s) => s === 429) >= a.rate_limited_min) anomalies.push({ kind: 'rate_limited', value: count((s) => s === 429), threshold: a.rate_limited_min });

  return {
    schema: 'edl-usage-digest-v1',
    window: { since: since.toISOString(), until: until.toISOString() },
    decisions: Object.values(apps).reduce((s, g) => s + g.decisions, 0),
    known_cost_usd_micros: totalCost,
    by_application: apps,
    access: accessLines.length ? access : null,
    anomalies,
  };
}

export function formatDigest(d, { environment = null } = {}) {
  const lines = [`E-NEXUS Decision Gateway digest${environment ? ` (${environment})` : ''} ${d.window.since} → ${d.window.until}`, `判定 ${d.decisions} 件・既知の費用 ${d.known_cost_usd_micros} µUSD`];
  for (const [app, g] of Object.entries(d.by_application)) {
    const tiers = Object.entries(g.tiers).map(([k, v]) => `${k} ${v}`).join(' / ') || '-';
    lines.push(`- ${app}: ${g.decisions} 件（${tiers}・Human 率 ${g.human_rate ?? '-'}）・Jev ${g.jev_ok}/${g.jev_attempts} ok${g.aborted ? `・中断 ${g.aborted}` : ''}`);
  }
  if (d.access) lines.push(`HTTP ${d.access.requests} 件：${Object.entries(d.access.status).map(([k, v]) => `${k}×${v}`).join(' ')}${Object.keys(d.access.error_codes).length ? `・error ${Object.entries(d.access.error_codes).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}`);
  lines.push(d.anomalies.length ? `異常 ${d.anomalies.length} 件：${d.anomalies.map((x) => `${x.kind}${x.application_id ? `(${x.application_id})` : ''}=${x.value}`).join('、')}` : '異常なし');
  return lines.join('\n');
}

/** webhook の body（件数と理由だけ。format は受け手の形） */
export function webhookBody(d, format, environment) {
  const text = formatDigest(d, { environment });
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text.slice(0, 1900) };
  return { environment, ...d };
}

/**
 * 通知。URL は credential:E-NEXUS/edl/<name> からだけ。https 必須。失敗しても digest 自体は成功（exit code は anomaly で決める）
 * @returns {Promise<{sent: boolean, code: string}>}
 */
export async function postWebhook(d, { spec, format = 'json', environment = null, always = false, readCredentialImpl = readCredential, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (!always && d.anomalies.length === 0) return { sent: false, code: 'NO_ANOMALY' };
  if (typeof spec !== 'string' || !spec.startsWith('credential:')) return { sent: false, code: 'WEBHOOK_MUST_BE_CREDENTIAL' };
  const target = spec.slice('credential:'.length);
  if (!EDL_CREDENTIAL_PATTERN.test(target)) return { sent: false, code: 'WEBHOOK_CREDENTIAL_TARGET_INVALID' };
  if (!['json', 'slack', 'discord'].includes(format)) return { sent: false, code: 'WEBHOOK_FORMAT_INVALID' };
  let url;
  try {
    const v = await readCredentialImpl(target);
    if (!v) return { sent: false, code: 'WEBHOOK_CREDENTIAL_MISSING' };
    url = new URL(v);
  } catch {
    return { sent: false, code: 'WEBHOOK_CREDENTIAL_UNREADABLE' };
  }
  if (url.protocol !== 'https:') return { sent: false, code: 'WEBHOOK_URL_INSECURE' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookBody(d, format, environment)), signal: controller.signal });
    return res.ok ? { sent: true, code: 'SENT' } : { sent: false, code: `WEBHOOK_HTTP_${res.status}` };
  } catch (err) {
    return { sent: false, code: err?.name === 'AbortError' ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

export function resolveWindow(argv, now = new Date()) {
  const since = arg(argv, '--since');
  if (since) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) throw new Error('--since must be an ISO date');
    return { since: new Date(t), until: now };
  }
  const hours = Number(arg(argv, '--hours') ?? 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw new Error('--hours must be 1-2160');
  return { since: new Date(now.getTime() - hours * 3_600_000), until: now };
}

async function main(argv) {
  const environment = arg(argv, '--environment');
  if (environment !== null && !RUNTIME_ENVIRONMENTS.includes(environment)) {
    console.error(`--environment must be one of ${RUNTIME_ENVIRONMENTS.join('|')}`);
    return 2;
  }
  let window;
  try { window = resolveWindow(argv); } catch (e) { console.error(e.message); return 2; }
  // 環境ごとの usage の場所は metering と同じ規則（この process の env は変えない）
  const usagePath = arg(argv, '--usage') ?? defaultUsagePath(environment ? { EDL_ENVIRONMENT: environment } : {});
  const rows = existsSync(usagePath) ? parseJsonl(readFileSync(usagePath, 'utf8')) : [];
  const accessPath = arg(argv, '--access-log');
  const accessLines = accessPath && existsSync(accessPath) ? parseJsonl(readFileSync(accessPath, 'utf8')) : [];
  const costAlert = arg(argv, '--cost-alert-usd-micros');
  const d = buildDigest(rows, { ...window, accessLines, alerts: costAlert ? { cost_usd_micros_min: Number(costAlert) } : {} });
  if (argv.includes('--json')) console.log(JSON.stringify({ usage: usagePath, environment, ...d }, null, 2));
  else console.log(formatDigest(d, { environment }));
  const spec = arg(argv, '--webhook');
  if (spec) {
    const r = await postWebhook(d, { spec, format: arg(argv, '--webhook-format') ?? 'json', environment, always: argv.includes('--webhook-always') });
    console.error(JSON.stringify({ component: 'edl-usage-digest', webhook: r.code }));
  }
  return argv.includes('--fail-on-anomaly') && d.anomalies.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
