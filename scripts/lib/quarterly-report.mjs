/**
 * 3 か月ごとの運用要約（2026-11-05 Human 決定・MA-22）。暦四半期（1・4・7・10 月）に前の四半期を 1 通だけ。host-health の既定の job の中で動く（常駐を増やさない）。
 * 本文は集計の数だけ。項目名・値・パスは載せない（詳細は内部の記録にある）。日本時間で区切る（Mac の時刻設定に左右されない）。
 */
import { RECOVER_RUNS, ruleOf } from './alert-policy.mjs';
import { EVENT_IDS } from './runtime-guard.mjs';

const JST_MS = 9 * 3_600_000;
const SLOT_MS = 30 * 60_000;
/** 朝に届くように、四半期の最初の日の 9 時より後に送る */
export const QUARTERLY_SEND_HOUR = 9;
/** 送れない時は 6 時間あけて 8 回まで（約 2 日）。それでも送れなければその四半期は諦める（再送を積み上げない） */
export const QUARTERLY_RETRY = Object.freeze({ interval_ms: 6 * 3_600_000, max_attempts: 8 });
const PERIOD = /^(\d{4})Q([1-4])$/;

export function periodOf(ms) {
  const d = new Date(ms + JST_MS);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
export function previousPeriod(period) {
  const [, y, q] = PERIOD.exec(period);
  return Number(q) === 1 ? `${Number(y) - 1}Q4` : `${y}Q${Number(q) - 1}`;
}
export function isPeriod(s) {
  return PERIOD.test(String(s));
}
/** 四半期の始まりと終わり（ms）。終わりは含まない */
export function periodBounds(period) {
  const [, y, q] = PERIOD.exec(period);
  const month = (Number(q) - 1) * 3;
  return { from: Date.UTC(Number(y), month, 1) - JST_MS, to: Date.UTC(Number(y), month + 3, 1) - JST_MS };
}

/** 今送るべき四半期（無ければ null）。last が無い＝初めて：今の前の四半期までは済んだことにする（state を失っても同じ四半期を二度送らない） */
export function duePeriod(state, at) {
  const ms = Date.parse(at);
  const target = previousPeriod(periodOf(ms));
  if ((state?.last_period ?? target) >= target) return null;
  const started = ms - periodBounds(periodOf(ms)).from >= QUARTERLY_SEND_HOUR * 3_600_000;
  return started ? target : null;
}
export function canAttempt(state, at) {
  const since = Date.parse(at) - Date.parse(state?.last_attempt_at);
  return !state?.last_attempt_at || since < 0 || since >= QUARTERLY_RETRY.interval_ms; // 未来の印では黙らない
}

/** host-health の YYYY-MM.jsonl の行から期間の集計。数だけ返す。now は期間の途中で見る時（要約の下見）だけ */
export function summarizeQuarter(lines, period, { now = Infinity } = {}) {
  const { from, to } = periodBounds(period);
  const rows = [];
  let earlier = false;
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      const t = Date.parse(r?.at);
      if (t < from) earlier = true;
      if (t >= from && t < to) rows.push({ ...r, t });
    } catch { /* 壊れた行は数えない */ }
  }
  rows.sort((a, b) => a.t - b.t);
  const open = new Map();
  const lastEvent = new Map();
  const s = { records: rows.length, availability: null, crit: 0, resolved: 0, unresolved: 0, warn: 0, events: 0, gaps: 0, notified: 0 };
  const close = (e) => {
    if (!e.crit) { s.warn += 1; return; }
    s.crit += 1;
    s.resolved += 1;
  };
  rows.forEach((r, i) => {
    if (i && r.t - rows[i - 1].t > SLOT_MS * 1.5) s.gaps += 1;
    if (r.notify_code === 'SENT') s.notified += 1;
    for (const it of r.items ?? []) {
      if (EVENT_IDS.includes(it.id)) {
        // 送れなかった出来事は次の回にまた記録される。続きの行は 1 件に数える
        const p = lastEvent.get(it.id);
        if (!ruleOf(it.id).burst && !(p?.value === it.value && p.row === i - 1)) s.events += 1;
        lastEvent.set(it.id, { value: it.value, row: i });
        continue;
      }
      const e = open.get(it.id);
      if (it.level === 'warn' || it.level === 'crit') {
        open.set(it.id, { crit: Boolean(e?.crit) || it.level === 'crit', ok_runs: 0 });
      } else if (it.level === 'ok' && e) {
        e.ok_runs += 1;
        if (e.ok_runs >= RECOVER_RUNS) { close(e); open.delete(it.id); }
      }
    }
    // 記録の水準は warn のまま重大として知らせた項目（続いた Hermes の停止）
    for (const n of r.notify ?? []) if (n.level === 'crit' && open.has(n.id)) open.get(n.id).crit = true;
  });
  const last = new Set((rows.at(-1)?.items ?? []).map((x) => x.id));
  for (const [id, e] of open) {
    if (!last.has(id)) close(e); // 見なくなった項目（外した repo など）は続いていない
    else if (e.crit) { s.crit += 1; s.unresolved += 1; } else s.warn += 1;
  }
  if (rows.length) {
    // 監視を始めた四半期だけ最初の記録から数える（途中の四半期の前半の欠落を隠さない）
    const slots = Math.max(1, Math.round((Math.min(to, now) - (earlier ? from : rows[0].t)) / SLOT_MS));
    s.availability = Math.min(100, Math.round((rows.length / slots) * 1000) / 10);
  }
  return s;
}

export function quarterlyText(period, s) {
  const [, y, q] = PERIOD.exec(period);
  const start = (Number(q) - 1) * 3 + 1;
  const head = `[E-NEXUS Mac Runtime host] 運用要約 ${y}年${start}〜${start + 2}月`;
  if (!s.records) return `${head}\n記録なし（監視が動いていません）\n対応：要確認`;
  return [
    head,
    `監視の稼働率：${s.availability}%（欠落 ${s.gaps} 回）`,
    `重大：${s.crit} 件（対応済み ${s.resolved}・未解決 ${s.unresolved}）`,
    `軽微な警告：${s.warn} 件`,
    `出来事：${s.events} 件`,
    `host-health の通知：${s.notified} 回`,
    `対応：${s.unresolved ? '未解決の確認が必要' : '不要'}`,
  ].join('\n');
}
