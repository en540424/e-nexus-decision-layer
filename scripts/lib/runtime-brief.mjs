/**
 * Hermes へ渡す整理済みの要約 runtime-brief/v1（2026-11-05・Batch B）。runtime-status-summary/v1 の隣に host-health が書く。AI／API なし。
 *
 * v1 の要約は水準と件数だけ。こちらは Human へ答えるのに要る整理まで済ませる：続いている異常の日数・誰が動くか（lib/ops-classify.mjs）・
 *   GitHub・バックアップ・生存信号・通知の Webhook・relay の未反映の件数。Hermes は terminal を持たないので、読むだけで答えられる形にする。
 * 渡さない：値・パス・repo 名・job 名・hash・回線名・Hermes を見張る項目（隔離・固定ファイル・常駐・監視の定義・user 範囲）。allowlist で、将来足した項目は既定で渡らない。
 * 書く前に入力境界の検査を通す（boundaryViolations）。1 つでも外れれば書かない（古いファイルは valid_until で切れる）。
 * Grok Bot など外部の読み手には externalView だけを渡す（§8。接続は Human の判断）。
 */
import { readFileSync } from 'node:fs';
import { classify, fixedTexts, OPS_CLASSES } from './ops-classify.mjs';
import { STALE_MS, buildStatusSummary } from './runtime-status-summary.mjs';

export const BRIEF_SCHEMA = 'runtime-brief/v1';
export const BRIEF_FILE = 'runtime-brief.json';
export const GUIDE_FILE = 'README.txt';
const DAY = 86_400_000;
/** 読む側の時計のずれの許容。これより先の時刻の要約は信じない */
const CLOCK_SKEW_MS = 5 * 60_000;
/** 名前を出してよい項目。repo・job・GitHub は群にまとめて件数だけ */
const NAMED = Object.freeze(['disk_free_gib', 'memory_pressure', 'swap_used_gib', 'load_15m', 'thermal', 'power', 'network_default_route', 'data_gib', 'hermes_rss_gib', 'hermes_service', 'backup_time_machine', 'backup_archive', 'backup_history', 'credential_backup_token', 'heartbeat', 'notify_channel', 'relay_outbox', 'github_api']);
const GROUPED = Object.freeze([['repos', (id) => id.startsWith('repo:')], ['jobs', (id) => id.startsWith('job:')], ['github', (id) => id.startsWith('github:')]]); // github_api は token の話なので群に混ぜない（担当が違う）
const GROUP_RULE = Object.freeze({ repos: 'repo:x', jobs: 'job:x', github: 'github:x' });
const LEVELS = ['ok', 'warn', 'crit', 'unknown'];
const HEARTBEAT = ['off', 'sent', 'failed', 'rejected', 'config_invalid', 'unknown'];
const CHANNEL = ['ok', 'gone', 'unreachable', 'config_invalid', 'unsupported', 'unknown'];
const HISTORY = ['history_ok', 'history_stale', 'history_failed', 'unknown'];
const daysLeft = (at, now) => {
  const ms = Date.parse(at) - now.getTime();
  return Number.isFinite(ms) ? Math.floor(ms / DAY) : null;
};
const sinceDays = (since, now) => {
  const ms = now.getTime() - Date.parse(since);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / DAY) : 0;
};
const numberOr = (v) => (Number.isInteger(v) ? v : null);

function backupFacts(items, facts) {
  const v = String(items.find((x) => x.id === 'backup_archive')?.value ?? '');
  const m = /^(-?\d+)d restore (never|\d+)d?$/.exec(v);
  return {
    age_days: m ? Number(m[1]) : null,
    restore_age_days: m && m[2] !== 'never' ? Number(m[2]) : null,
    failing: v.startsWith('failed '),
    history: HISTORY.includes(items.find((x) => x.id === 'backup_history')?.value) ? items.find((x) => x.id === 'backup_history').value : 'unknown',
    token_days_left: facts.backupTokenExpiresAt ? daysLeft(facts.backupTokenExpiresAt, facts.now) : null,
  };
}

/** items は今回の項目（無い時＝DISABLED の回は sections が unknown）。facts は token の期限など state に無いもの */
export function buildBrief(state, { items = [], now = new Date(), paused = false, disabled = false, githubTokenExpiresAt = null, backupTokenExpiresAt = null } = {}) {
  const base = buildStatusSummary(state, { now, paused, disabled });
  const running = base.monitor === 'running' && items.length > 0;
  const seen = running ? items.filter((x) => x.kind === 'state') : [];
  const notOk = seen.filter((x) => x.level === 'warn' || x.level === 'crit');
  const open = [];
  const add = (id, level, since, rule) => open.push({ id, level, days: sinceDays(since, now), class: rule.class, cause: rule.cause, next: rule.next });
  // 送れなかった異常の通知の状態は ok の時のまま残るので、ok の since を異常の始まりと読まない
  const sinceOf = (id) => (state?.items?.[id]?.level && state.items[id].level !== 'ok' ? state.items[id].since : null);
  for (const it of notOk) if (NAMED.includes(it.id)) add(it.id, it.level, sinceOf(it.id), classify(it.id));
  for (const [group, match] of GROUPED) {
    const rows = notOk.filter((x) => match(x.id));
    if (!rows.length) continue;
    const worst = rows.some((x) => x.level === 'crit') ? 'crit' : 'warn';
    const oldest = rows.map((x) => sinceOf(x.id)).filter(Boolean).sort()[0];
    add(`group_${group}`, worst, oldest, classify(GROUP_RULE[group]));
  }
  open.sort((a, b) => (a.level === b.level ? b.days - a.days : a.level === 'crit' ? -1 : 1));
  const counts = { open: open.length, human: 0, ai: 0, auto: 0 };
  for (const o of open) counts[o.class] += 1;
  const github = seen.filter((x) => x.id.startsWith('github:'));
  const relayOutbox = seen.find((x) => x.id === 'relay_outbox')?.value;
  const heartbeat = state?.heartbeat?.code ?? 'unknown';
  const channel = state?.webhook_check?.code ?? 'unknown';
  // 群に入らない項目（token・古い世代・生存信号・Webhook）の異常も全体の水準に入れる
  const worstOf = (...levels) => (levels.includes('crit') ? 'crit' : levels.includes('warn') ? 'warn' : levels[0]);
  const backupExtra = notOk.filter((x) => ['backup_history', 'credential_backup_token'].includes(x.id));
  return {
    schema: BRIEF_SCHEMA,
    generated_at: now.toISOString(),
    source_updated_at: base.source_updated_at,
    valid_until: new Date(now.getTime() + STALE_MS).toISOString(), // これを過ぎた要約は信じない
    monitor: base.monitor,
    overall: running ? worstOf(base.overall, ...open.map((o) => o.level)) : base.overall,
    counts,
    sections: {
      host: base.groups.host,
      hermes: base.groups.hermes,
      jobs: base.groups.jobs,
      repos: base.groups.repos,
      github: { ...base.groups.github, repos: github.length, ci_failing: github.filter((x) => x.value === 'ci_failure' || x.value === 'ci_stuck').length, token_days_left: running && githubTokenExpiresAt ? daysLeft(new Date(githubTokenExpiresAt).toISOString(), now) : null },
      backup: { ...base.groups.backup, level: running ? worstOf(base.groups.backup.level, ...backupExtra.map((x) => x.level)) : base.groups.backup.level, not_ok: base.groups.backup.not_ok + backupExtra.length, ...(running ? backupFacts(seen, { backupTokenExpiresAt, now }) : { age_days: null, restore_age_days: null, failing: false, history: 'unknown', token_days_left: null }) },
      heartbeat: { state: running && HEARTBEAT.includes(heartbeat) ? heartbeat : 'unknown' },
      notify: { state: running && CHANNEL.includes(channel) ? channel : 'unknown' },
      relay: { outbox: running ? numberOr(relayOutbox) : null, unacked: running ? numberOr(state?.relay_unacked) : null },
    },
    open_items: open,
  };
}

// ─── 入力境界 ───

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEYS = new Set(['schema', 'generated_at', 'source_updated_at', 'valid_until', 'monitor', 'overall', 'counts', 'open', 'human', 'ai', 'auto', 'sections', 'host', 'hermes', 'jobs', 'repos', 'github', 'backup', 'heartbeat', 'notify', 'relay', 'level', 'not_ok', 'ci_failing', 'token_days_left', 'age_days', 'restore_age_days', 'failing', 'history', 'state', 'outbox', 'unacked', 'open_items', 'id', 'days', 'class', 'cause', 'next', 'groups', 'attention', 'group']);
const WORDS = new Set([BRIEF_SCHEMA, 'runtime-status-summary/v1', 'running', 'paused', 'stale', 'disabled', ...LEVELS, ...HEARTBEAT, ...CHANNEL, ...HISTORY, ...OPS_CLASSES, ...NAMED, 'group_repos', 'group_jobs', 'group_github', 'host', 'hermes', 'backup', 'jobs', 'repos', 'github']);
/** 許す文字列に紛れても出さない形（二重の防御）。パス・IP・メール・Secret・Trading Lab */
export const DENY_SHAPES = Object.freeze([/\/(?:Users|home|private|var|Volumes|etc)\//i, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /[\w.+-]+@[\w-]+\.[\w.-]+/, /\bgithub_pat_|\bgh[pousr]_|\bsk-[A-Za-z0-9]|discord(?:app)?\.com\/api|xai-[A-Za-z0-9]/i, /trading[\s._-]*lab|parallels/i]);

/**
 * 渡してよい形かを確かめる。戻り値は外れた場所の一覧（値は入れない＝ここからも漏らさない）。空なら通す。
 * allowlist：鍵・文字列（固定の語・固定の文・時刻）・数の範囲。知らないものは全部外れる。
 */
export function boundaryViolations(doc, { texts = fixedTexts() } = {}) {
  const bad = [];
  const walk = (v, at, depth) => {
    if (depth > 6) { bad.push(`${at}:depth`); return; }
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isInteger(v) || Math.abs(v) > 100_000) bad.push(`${at}:number`); return; }
    if (typeof v === 'string') { if (!WORDS.has(v) && !ISO.test(v) && !texts.has(v)) bad.push(`${at}:string`); return; }
    if (Array.isArray(v)) {
      if (v.length > 64) bad.push(`${at}:length`);
      v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1));
      return;
    }
    if (typeof v !== 'object') { bad.push(`${at}:type`); return; }
    for (const [k, x] of Object.entries(v)) {
      if (!KEYS.has(k)) bad.push(`${at}:key`);
      else walk(x, `${at}.${k}`, depth + 1);
    }
  };
  walk(doc, '$', 0);
  const text = JSON.stringify(doc) ?? '';
  if (DENY_SHAPES.some((p) => p.test(text))) bad.push('$:shape');
  return bad;
}

// ─── 読む側（Hermes・将来の読み手の手順。API なしで同じ判定を確かめる）───

/** 要約の中の矛盾。形は正しくても数が合わなければ、書き手の不具合か差し替えの疑いなので内容を信じない。戻り値は場所の名前だけ */
export function briefInconsistencies(doc) {
  const bad = [];
  const open = Array.isArray(doc.open_items) ? doc.open_items : [];
  const c = doc.counts ?? {};
  if (c.open !== open.length) bad.push('counts_open');
  if (OPS_CLASSES.some((k) => c[k] !== open.filter((o) => o.class === k).length)) bad.push('counts_class');
  if (doc.monitor === 'running') {
    if (open.some((o) => o.level === 'crit') && doc.overall !== 'crit') bad.push('overall_below_crit');
    if (open.some((o) => o.level === 'warn') && doc.overall === 'ok') bad.push('overall_below_warn');
  }
  const life = Date.parse(doc.valid_until) - Date.parse(doc.generated_at);
  if (!(life > 0 && life <= STALE_MS)) bad.push('valid_until');
  return bad;
}

/** 読む時の判定。信じてよい時だけ brief を返す。reason：unreadable／schema／boundary／inconsistent／future／stale／monitor_<状態> */
export function readBrief(text, { now = new Date() } = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (doc?.schema !== BRIEF_SCHEMA) return { ok: false, reason: 'schema' };
  if (boundaryViolations(doc).length) return { ok: false, reason: 'boundary' };
  if (briefInconsistencies(doc).length) return { ok: false, reason: 'inconsistent' };
  if (Date.parse(doc.generated_at) - now.getTime() > CLOCK_SKEW_MS) return { ok: false, reason: 'future' };
  if (!(now.getTime() <= Date.parse(doc.valid_until))) return { ok: false, reason: 'stale' };
  if (doc.monitor !== 'running') return { ok: false, reason: `monitor_${doc.monitor}` };
  return { ok: true, brief: doc };
}
export function readBriefFile(file, opts) {
  try {
    return readBrief(readFileSync(file, 'utf8'), opts);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

const CLASS_LABEL = { human: 'Human', ai: 'Claude Code', auto: '監視が対応' };

/** Human への答えの形。readBrief を通った brief だけを渡す */
export function renderReply(b) {
  const s = b.sections;
  const lines = [b.open_items.length ? `要確認 ${b.counts.open} 件（Human ${b.counts.human}・Claude Code ${b.counts.ai}・監視が対応 ${b.counts.auto}）` : '異常はありません'];
  for (const o of b.open_items) lines.push(`- ${o.level === 'crit' ? '重大' : '警告'}（${o.days} 日）${o.cause} → ${o.next}［${CLASS_LABEL[o.class]}］`);
  lines.push(`GitHub：${s.github.repos} repo・要確認 ${s.github.not_ok}・CI の失敗 ${s.github.ci_failing}${s.github.token_days_left == null ? '' : `・token 残り ${s.github.token_days_left} 日`}`);
  lines.push(`バックアップ：${s.backup.age_days == null ? '記録なし' : `${s.backup.age_days} 日前`}・復元の確認 ${s.backup.restore_age_days == null ? 'なし' : `${s.backup.restore_age_days} 日前`}${s.backup.token_days_left == null ? '' : `・token 残り ${s.backup.token_days_left} 日`}`);
  lines.push(`生存信号：${s.heartbeat.state}／通知の Webhook：${s.notify.state}`);
  lines.push(`作業ログ：未送信 ${s.relay.outbox ?? '不明'}・Vault の受領待ち ${s.relay.unacked ?? '不明'}`);
  return lines.join('\n');
}

/** 外部の読み手（Grok Bot など）へ渡してよい最小の形。文も日数も渡さない。接続は Human の判断 */
export function externalView(b) {
  return { schema: 'runtime-brief-external/v1', generated_at: b.generated_at, valid_until: b.valid_until, monitor: b.monitor, overall: b.overall, counts: b.counts };
}

/** status フォルダの読み方（固定の文）。Hermes に「status の README を読んで」と言えば足りるように */
export const GUIDE_TEXT = `E-NEXUS Mac Runtime の状態（host-health が 30 分ごとに書く。読むだけ）

runtime-brief.json：整理済みの要約（runtime-brief/v1）。まずこれを読む
runtime-status.json：水準と件数だけの要約（runtime-status-summary/v1）

読み方：
1. valid_until を過ぎていたら内容を信じず「監視の要約が古い」と答える
2. monitor が running 以外なら overall を使わず、その状態だけを答える
3. open_items の class が human なら Human に確認を求める。ai は Claude Code の作業、auto は対応不要
4. counts と open_items の数が合わない時は内容を信じず「要約に矛盾がある」と答える
5. ここに無いこと（値・パス・repo 名）は推測しない。承認・実行・再起動の判断はしない
`;
