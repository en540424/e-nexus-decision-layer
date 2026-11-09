/**
 * Task Hub の digest 系の純粋な関数（2026-11-09・MA-24）。予定の重なり・重複の疑いの検出と、朝のまとめの文面。依存なし・fs なし・通信なし・AI なし。
 * 同じ入力は同じ出力（並びは時刻→id）。時刻は UTC のオフセット（分）で「その日」を決める（既定 0）。
 */
const MIN = 60_000;
const DAY = 86_400_000;
export const REPORT_MAX_CHARS = 3000;
/** 返信待ちのまま「開いている」と数える日数（返信済みの印は記録に無いので、取り込み直しで category が変わったら閉じる） */
export const REPLY_OPEN_DAYS = 14;

/** ISO の文字列を ms に。日付だけ＝その日の 0 時（offset の地域）・ゾーン無しの日時＝offset の地域の時刻。読めなければ NaN */
export function parseTime(s, offsetMin = 0) {
  if (typeof s !== 'string') return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`) - offsetMin * MIN;
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(s)) return Date.parse(`${s}Z`) - offsetMin * MIN;
  return Date.parse(s);
}
const localParts = (ms, offsetMin) => new Date(ms + offsetMin * MIN).toISOString(); // 'YYYY-MM-DDTHH:MM:SS.sssZ'（offset 分ずらした壁時計）
const hhmm = (ms, off) => localParts(ms, off).slice(11, 16);
const mmdd = (ms, off) => localParts(ms, off).slice(5, 10).replace('-', '/');
const dayStart = (ms, off) => Math.floor((ms + off * MIN) / DAY) * DAY - off * MIN;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 比較用の題名：NFKC・小文字・空白と記号を除く */
export const normTitle = (t) => String(t ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i += 1) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
  return m;
}
/** 正規化済みの 2 題名の Dice 係数（bx・by は bigrams）。どちらかが 2 文字未満なら一致か否か */
function dice(x, y, bx, by) {
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  let common = 0;
  for (const [k, n] of bx) common += Math.min(n, by.get(k) ?? 0);
  return (2 * common) / (x.length - 1 + (y.length - 1));
}
/** 2 つの題名の似ている度合い（0〜1・Dice 係数） */
export function titleSimilarity(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  return dice(x, y, bigrams(x), bigrams(y));
}

// ─── 保持（records/ を有限に保つ）。取り込みの最後に store.compactRecords へ渡す ───
export const RETENTION = Object.freeze({ mail_days: 30, event_past_days: 14, event_future_days: 120 });
/** メールは受信から 30 日まで（読めない日時の行は残さない） */
export const keepMail = (m, now, offsetMin = 0) => { const t = parseTime(m.received_at, offsetMin); return Number.isFinite(t) && now - t <= RETENTION.mail_days * DAY; };
/** 予定は終わって 14 日まで・始まりが 120 日先まで */
export const keepEvent = (e, now, offsetMin = 0) => { const s = span(e, offsetMin); return Boolean(s) && s.end >= now - RETENTION.event_past_days * DAY && s.start <= now + RETENTION.event_future_days * DAY; };

/** 予定を ms の区間にする。終わりが始まり以下なら（終日は 1 日・ほかは長さ 0）。読めない予定は null */
export function span(e, offsetMin = 0) {
  const start = parseTime(e.start, offsetMin);
  let end = parseTime(e.end, offsetMin);
  if (!Number.isFinite(start)) return null;
  if (!Number.isFinite(end) || end < start) end = start;
  if (e.all_day && end <= start) end = start + DAY;
  return { start, end };
}

/** analyzeEvents の入力・比較の上限（朝のまとめと取り込みが記録の量で遅くならないように。超えたら truncated: true） */
export const MAX_ANALYZE_EVENTS = 500;
export const MAX_PAIR_CHECKS = 50_000;

/**
 * 重なり・重複の疑いを見つける。focus（id の Set）があれば、それを含む組だけ。終日の予定は「重なり」から除く（重複の疑いには入れる）。
 * 重複の疑い：同じ題名（正規化）で始まりが同じ／長さのある 2 つが 90% 以上重なり題名が似ている（0.6 以上）。重複の疑いに入った組は「重なり」に数えない。
 * 入力は最大 maxEvents 件（始まりの順。focus があれば focus の予定を先に残す）・組の確かめは最大 maxPairs 回。超えたら truncated: true を足して返す。
 */
export function analyzeEvents(events, { focus = null, offsetMin = 0, maxEvents = MAX_ANALYZE_EVENTS, maxPairs = MAX_PAIR_CHECKS } = {}) {
  const order = (a, b) => a.s.start - b.s.start || a.e.id.localeCompare(b.e.id);
  let rows = events.map((e) => ({ e, s: span(e, offsetMin) })).filter((x) => x.s).sort(order);
  let truncated = false;
  if (rows.length > maxEvents) {
    truncated = true;
    if (focus) {
      const f = rows.filter((r) => focus.has(r.e.id));
      rows = [...f, ...rows.filter((r) => !focus.has(r.e.id))].slice(0, maxEvents).sort(order);
    } else rows = rows.slice(0, maxEvents);
  }
  for (const r of rows) { r.nt = normTitle(r.e.title); r.bg = bigrams(r.nt); } // 題名の正規化は 1 件 1 回
  const overlaps = [];
  const duplicates = [];
  let checks = 0;
  outer: for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (b.s.start > a.s.end) break; // 並びは始まりの順：以後は a と接しない
      if (focus && !focus.has(a.e.id) && !focus.has(b.e.id)) continue;
      if (++checks > maxPairs) { truncated = true; break outer; }
      const overlapMs = Math.min(a.s.end, b.s.end) - Math.max(a.s.start, b.s.start);
      const durA = a.s.end - a.s.start;
      const durB = b.s.end - b.s.start;
      const pair = [a.e.id, b.e.id];
      if (a.nt === b.nt && a.s.start === b.s.start) {
        duplicates.push({ a: pair[0], b: pair[1], reason: 'same_title_start' });
      } else if (durA > 0 && durB > 0 && overlapMs / Math.min(durA, durB) >= 0.9 && dice(a.nt, b.nt, a.bg, b.bg) >= 0.6) {
        duplicates.push({ a: pair[0], b: pair[1], reason: 'overlap_similar_title' });
      } else if (overlapMs > 0 && !a.e.all_day && !b.e.all_day) {
        overlaps.push({ a: pair[0], b: pair[1], minutes: Math.round(overlapMs / MIN) });
      }
    }
  }
  return { overlaps, duplicates, ...(truncated ? { truncated: true } : {}) };
}

const take = (rows, n) => rows.slice(0, n);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * 朝のまとめ。1 つの business の記録だけを渡すこと（呼ぶ側が business で絞る）。3000 字を超えたら切る。
 * mails／events は記録の行、awaiting は承認待ちの task の件数。
 */
export function morningReport({ business, mails, events, awaiting, now, offsetMin = 0 }) {
  const today = dayStart(now, offsetMin);
  const tomorrow = today + DAY;
  const date = localParts(now, offsetMin).slice(0, 10);
  const mailTime = (m) => parseTime(m.received_at, offsetMin);
  const reply = mails.filter((m) => m.category === 'reply_needed' && now - mailTime(m) <= REPLY_OPEN_DAYS * DAY).sort((a, b) => mailTime(b) - mailTime(a) || a.id.localeCompare(b.id));
  const important = mails.filter((m) => m.category === 'important' && now - mailTime(m) <= DAY && mailTime(m) <= now + 5 * MIN).sort((a, b) => mailTime(b) - mailTime(a) || a.id.localeCompare(b.id));
  const within = (from, to) => events.map((e) => ({ e, s: span(e, offsetMin) })).filter((x) => x.s && x.s.start < to && Math.max(x.s.end, x.s.start + 1) > from).sort((a, b) => a.s.start - b.s.start || a.e.id.localeCompare(b.e.id));
  const evToday = within(today, tomorrow);
  const evTomorrow = within(tomorrow, tomorrow + DAY);
  const ids = new Set([...evToday, ...evTomorrow].map((x) => x.e.id));
  const { overlaps, duplicates, truncated } = analyzeEvents(events.filter((e) => ids.has(e.id)), { offsetMin });
  const title = new Map(events.map((e) => [e.id, oneLine(e.title)]));
  const mailLine = (m) => `- ${clip(oneLine(m.from_label), 30)}「${clip(oneLine(m.subject), 50)}」${mmdd(mailTime(m), offsetMin)}${m.due ? ` 期限 ${oneLine(m.due).slice(0, 16)}` : ''}`;
  const evLine = ({ e, s }) => `- ${e.all_day ? '終日' : `${hhmm(s.start, offsetMin)}-${hhmm(s.end, offsetMin)}`} ${clip(oneLine(e.title), 50)}${e.case_ref ? `（${clip(oneLine(e.case_ref), 20)}）` : ''}`;
  const section = (head, rows, line, max = 10) => [head(rows.length), ...(rows.length ? [...take(rows, max).map(line), ...(rows.length > max ? [`- ほか ${rows.length - max} 件`] : [])] : ['- なし'])];
  const lines = [
    `【朝のまとめ】${business} ${date}`,
    ...section((n) => `■ 返信待ちのメール ${n} 件`, reply, mailLine),
    ...section((n) => `■ 重要なメール（24 時間以内）${n} 件`, important, mailLine),
    ...section((n) => `■ 今日の予定 ${n} 件`, evToday, evLine),
    ...section((n) => `■ 明日の予定 ${n} 件`, evTomorrow, evLine),
    `■ 予定の重なり・重複の疑い ${overlaps.length + duplicates.length} 件`,
    ...(truncated ? ['- （予定が多いので一部だけ照合した）'] : []),
    ...(overlaps.length + duplicates.length ? [...take(overlaps, 5).map((o) => `- 重なり ${o.minutes} 分：${clip(title.get(o.a) ?? o.a, 30)} ／ ${clip(title.get(o.b) ?? o.b, 30)}`), ...take(duplicates, 5).map((d) => `- 重複の疑い：${clip(title.get(d.a) ?? d.a, 30)} ／ ${clip(title.get(d.b) ?? d.b, 30)}`)] : ['- なし']),
    `■ 承認待ちのタスク ${awaiting} 件`,
  ];
  let text = lines.join('\n');
  if (text.length > REPORT_MAX_CHARS) text = `${text.slice(0, REPORT_MAX_CHARS - 8)}\n…(省略)`;
  return { text, counts: { reply_needed: reply.length, important: important.length, today: evToday.length, tomorrow: evTomorrow.length, overlaps: overlaps.length, duplicates: duplicates.length, awaiting, ...(truncated ? { analysis_truncated: true } : {}) } };
}
