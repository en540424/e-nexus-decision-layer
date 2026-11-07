/**
 * GitHub 側の見張り（2026-11-04・MA-22。2026-11-05 H3：無人 job は専用の読み取り token だけを使う形へ）。host-health の --github-owner と --github-credential を
 * 両方付けた時だけ動く。GET だけ・AI／課金なし。
 *
 * 見るもの：repo の公開範囲の変化（private → public は CRIT）・archived／disabled・既定 branch の変化・既定 branch の先頭 commit の Actions と commit status・
 *   Mac の HEAD との差（別の PC の push で Mac が遅れるのは普通なので、GITHUB_LIMITS.differs_days 続いた時だけ warn）。未 push は runtime-guard の repo:<name> が知らせる。
 * 見ないもの：Trading Lab の repo・issue・PR の本文・Secret・ファイルの中身。記録と通知に出すのは固定のコードと repo 名だけ（commit の hash は記録しない）。
 * 認証：Keychain の fine-grained PAT（github_pat_）だけ。gh のログインや classic token は読み書きの範囲が広いので受け取らない。
 *   Keychain に無ければ何もしない（項目も通信もなし＝Human が token を入れた次の回から動く）。token は Authorization の header だけに使い、記録・通知・例外に出さない。
 * 認証の失敗は github_api=auth_failed、期限が近ければ token_expiring、通信の失敗は unknown で、続いた時だけ unreachable。
 */
import { readCredential } from './env-file.mjs';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_TIMEOUT_MS = 20_000;
export const GITHUB_TOKEN_PREFIX = 'github_pat_';
export const GITHUB_LIMITS = Object.freeze({ api_fail_hours: 6, differs_days: 7, ci_stuck_hours: 6, token_expiry_days: 14 });
export const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TRADING_LAB = /trading-?lab/i;
const FAILED_RUN = ['failure', 'timed_out', 'startup_failure'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

class GithubFailure extends Error {
  constructor(status) {
    super(status);
    this.status = status;
  }
}

/** レート制限の応答か。403 でも権限の答えではないので、「書けない」の証拠に数えない */
export const isRateLimited = (res) => res.status === 429 || (res.status === 403 && (res.headers?.get?.('x-ratelimit-remaining') === '0' || Boolean(res.headers?.get?.('retry-after'))));

/** token を閉じ込めた GET。宛先は api.github.com の固定、redirect に従わない。読めない応答は投げる（token を含む文は作らない） */
export function makeGithubGet({ token, fetchImpl = globalThis.fetch, signal }) {
  return async (resource) => {
    let res;
    try {
      res = await fetchImpl(`${GITHUB_API}${resource}`, { method: 'GET', redirect: 'error', signal, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'e-nexus-host-health' } });
    } catch {
      throw new GithubFailure('failed');
    }
    if (res.status === 401) throw new GithubFailure('auth');
    if (isRateLimited(res)) throw new GithubFailure('failed');
    if (res.status === 403) throw new GithubFailure('auth'); // 権限の足りない token
    if (res.status >= 500) throw new GithubFailure('failed');
    let json = null;
    try {
      json = await res.json();
    } catch {
      if (res.status === 200) throw new GithubFailure('failed');
    }
    return { status: res.status, json, expires: res.headers?.get?.('github-authentication-token-expiration') ?? null };
  };
}

/** Actions の workflow ごとの最新の run と commit status から、先頭 commit の状態。無ければ null */
export function ciOf(statusJson, runsJson, now) {
  if (statusJson?.total_count > 0 && ['failure', 'error'].includes(statusJson.state)) return 'FAILURE';
  const latest = new Map();
  for (const r of runsJson?.workflow_runs ?? []) {
    const at = Date.parse(r.created_at);
    if (!latest.has(r.workflow_id) || at > latest.get(r.workflow_id).at) latest.set(r.workflow_id, { ...r, at });
  }
  const runs = [...latest.values()];
  if (runs.some((r) => r.status === 'completed' && FAILED_RUN.includes(r.conclusion))) return 'FAILURE';
  if (runs.some((r) => r.status !== 'completed' && Date.parse(now) - r.at >= GITHUB_LIMITS.ci_stuck_hours * HOUR)) return 'STUCK';
  return null;
}

async function repoState(get, owner, name, now) {
  const base = `/repos/${owner}/${name}`;
  const r = await get(base);
  if (r.status === 404) return { found: false };
  if (r.status !== 200) throw new GithubFailure('failed');
  const branch = r.json.default_branch ?? null;
  const ref = branch ? await get(`${base}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`) : null;
  const oid = ref?.status === 200 ? (ref.json?.object?.sha ?? null) : null; // 空の repo は 404／409
  // CI の窓口だけの障害で公開範囲の見張りまで止めない（権限の失敗はそのまま上げる）
  const optional = (resource) => get(resource).catch((err) => { if (err.status === 'auth') throw err; return null; });
  const [status, runs] = oid ? await Promise.all([optional(`${base}/commits/${oid}/status`), optional(`${base}/actions/runs?head_sha=${oid}&per_page=30&exclude_pull_requests=true`)]) : [null, null];
  return {
    found: true,
    visibility: String(r.json.visibility ?? (r.json.private ? 'private' : 'public')).toUpperCase(),
    archived: Boolean(r.json.archived),
    disabled: Boolean(r.json.disabled),
    default_branch: branch,
    oid,
    ci: ciOf(status?.json, runs?.json, now),
    expires: r.expires,
  };
}

const RELAY_ID = /^\d{8}T\d{6}Z-[a-z0-9-]{1,40}-[0-9a-f]{6}$/;
/** devlog relay の受領（acks branch のファイル名だけ。中身は読まない）。読めなければ null（数えない） */
async function relayAcks(get, owner, { repo, prefix }) {
  const r = await get(`/repos/${owner}/${repo}/git/trees/acks?recursive=1`);
  if (r.status !== 200 || r.json?.truncated || !Array.isArray(r.json?.tree)) return null;
  return r.json.tree.map((e) => String(e?.path ?? '')).filter((p) => p.startsWith(prefix) && p.endsWith('.json')).map((p) => p.slice(p.lastIndexOf('/') + 1, -'.json'.length)).filter((id) => RELAY_ID.test(id));
}

/**
 * 1 回分。戻り値 status：off＝token が無い（動かない）／ok／auth＝token が使えない／failed＝通信の失敗。
 * read・fetchImpl は test で差し替える。例外は投げない（1 回分の監視を失敗にしない）。
 */
export async function collectGithub({ credential, owner, repos, now, relay = null, read = readCredential, fetchImpl = globalThis.fetch, timeoutMs = GITHUB_TIMEOUT_MS }) {
  let token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); // Keychain の待ちも同じ予算に入れる
  const aborted = new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(new GithubFailure('failed'))); });
  aborted.catch(() => {});
  try {
    token = await Promise.race([read(credential), aborted]);
  } catch {
    clearTimeout(timer);
    return { status: 'failed' };
  }
  if (!token) { clearTimeout(timer); return { status: 'off' }; }
  if (!token.startsWith(GITHUB_TOKEN_PREFIX)) { clearTimeout(timer); return { status: 'auth' }; }
  const names = repos.filter((n) => !TRADING_LAB.test(n));
  if (!GITHUB_OWNER.test(owner) || !names.every((n) => REPO_NAME.test(n))) { clearTimeout(timer); return { status: 'failed' }; }
  try {
    const get = makeGithubGet({ token, fetchImpl, signal: controller.signal });
    const rows = await Promise.race([Promise.all(names.map(async (n) => [n, await repoState(get, owner, n, now)])), aborted]);
    const expires = rows.map(([, r]) => Date.parse(r.expires)).find(Number.isFinite) ?? null;
    const relayAcked = relay ? await relayAcks(get, owner, relay).catch(() => null) : null;
    return { status: 'ok', repos: Object.fromEntries(rows.map(([n, { expires: _e, ...r }]) => [n, r])), expires_at: expires, ...(relay ? { relay_acked: relayAcked } : {}) };
  } catch (err) {
    return { status: err instanceof GithubFailure && err.status === 'auth' ? 'auth' : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** 状態の項目。localRepos は runtime-guard の g.repos（oid・ahead）。failure は collectGithub の status、expiresAt は token の期限（ms） */
export function evaluateGithub(gh, localRepos, prev, now, { failure = null, expiresAt = null } = {}) {
  const items = [];
  const add = (id, level, value) => items.push({ id, level, value, kind: 'state' });
  const t = Date.parse(now);
  if (gh == null) {
    if (failure === 'auth') { add('github_api', 'warn', 'auth_failed'); return items; } // 待っても直らない。§2 の猶予の後に 1 回
    const since = prev?.fail_since ?? now;
    const old = t - Date.parse(since) >= GITHUB_LIMITS.api_fail_hours * HOUR;
    add('github_api', old ? 'warn' : 'unknown', old ? 'unreachable' : null);
    return items;
  }
  const expiring = expiresAt != null && expiresAt - t < GITHUB_LIMITS.token_expiry_days * DAY;
  add('github_api', expiring ? 'warn' : 'ok', expiring ? 'token_expiring' : 'ok');
  for (const [name, r] of Object.entries(gh)) {
    const id = `github:${name}`;
    if (!r.found) { add(id, 'crit', 'not_found'); continue; } // 消えた・無効にされた repo は CI の失敗より重い。続いている WARN に隠さない
    if (r.disabled) { add(id, 'crit', 'disabled'); continue; }
    if (r.archived) { add(id, 'warn', 'archived'); continue; }
    if (r.ci === 'FAILURE' || r.ci === 'ERROR') { add(id, 'warn', 'ci_failure'); continue; }
    if (r.ci === 'STUCK') { add(id, 'warn', 'ci_stuck'); continue; }
    const local = localRepos?.[name];
    const differs = Boolean(local?.oid && r.oid && local.oid !== r.oid && !local.ahead);
    const since = prev?.differ_since?.[name];
    const old = differs && since && t - Date.parse(since) >= GITHUB_LIMITS.differs_days * DAY;
    add(id, old ? 'warn' : 'ok', differs ? 'differs_from_mac' : 'ok');
  }
  return items;
}

/** 出来事（前回からの変化）。最初の回は基準を取るだけで知らせない */
export function evaluateGithubEvents(gh, prev) {
  const ev = [];
  for (const [name, r] of Object.entries(gh ?? {})) {
    const p = prev?.repos?.[name];
    if (!r.found || !p) continue;
    if (p.visibility && r.visibility && p.visibility !== r.visibility) ev.push({ id: 'github_visibility_changed', level: r.visibility === 'PRIVATE' ? 'warn' : 'crit', value: `${name}:${p.visibility}->${r.visibility}`, kind: 'event' });
    if (p.default_branch && r.default_branch && p.default_branch !== r.default_branch) ev.push({ id: 'github_default_branch_changed', level: 'warn', value: `${name}:${p.default_branch}->${r.default_branch}`, kind: 'event' });
  }
  return ev;
}

/** 次の state。keepEvents＝出来事を送れなかった回は前の値を残し、次の回にもう一度判定させる */
export function nextGithubState(gh, prev, now, { keepEvents = false, localRepos = null, failure = null } = {}) {
  if (gh == null) return failure === 'auth' ? { ...(prev ?? {}) } : { ...(prev ?? {}), fail_since: prev?.fail_since ?? now }; // 認証の失敗の間は通信の失敗の時間を進めない
  const differSince = {};
  for (const [name, r] of Object.entries(gh)) {
    const local = localRepos?.[name];
    if (r.found && local?.oid && r.oid && local.oid !== r.oid && !local.ahead) differSince[name] = prev?.differ_since?.[name] ?? now;
  }
  if (keepEvents) return { repos: prev?.repos ?? {}, differ_since: differSince };
  const repos = { ...(prev?.repos ?? {}) };
  for (const [name, r] of Object.entries(gh)) if (r.found) repos[name] = { visibility: r.visibility, default_branch: r.default_branch };
  return { repos, differ_since: differSince };
}

/** token の検収（connect-github-monitor.sh から）。範囲は見える private repo の一覧で、書き込みの権限が無いことは必ず失敗する要求への応答で確かめる（不正な ref は 422 で、何も作られない） */
export async function verifyMonitorToken({ token, owner, repos, now, fetchImpl = globalThis.fetch, timeoutMs = GITHUB_TIMEOUT_MS }) {
  if (!token?.startsWith(GITHUB_TOKEN_PREFIX)) return { ok: false, code: 'NOT_FINE_GRAINED' };
  const r = await collectGithub({ credential: 'E-NEXUS/edl/x', owner, repos, now, read: async () => token, fetchImpl, timeoutMs });
  if (r.status !== 'ok') return { ok: false, code: r.status === 'auth' ? 'TOKEN_REJECTED' : 'GITHUB_UNREACHABLE' };
  const missing = Object.entries(r.repos).filter(([, x]) => !x.found || !x.oid).map(([n]) => n);
  if (missing.length) return { ok: false, code: 'REPO_NOT_READABLE', repos: missing };
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'e-nexus-host-health' };
  const call = (resource, init = {}) => fetchImpl(`${GITHUB_API}${resource}`, { method: 'GET', redirect: 'error', signal, headers, ...init });
  try {
    const list = await call('/user/repos?visibility=private&per_page=100');
    const seen = list.status === 200 ? await list.json() : null;
    if (!Array.isArray(seen)) return { ok: false, code: 'SCOPE_UNVERIFIED' };
    if (seen.length === 0) return { ok: false, code: 'SCOPE_UNVERIFIED' }; // 6 repo に private があるので、空は確かめられていない
    if (seen.some((x) => !repos.includes(x?.name))) return { ok: false, code: 'TOKEN_TOO_BROAD' };
    const keys = (await call(`/repos/${owner}/${repos[0]}/keys`)).status; // Administration の権限
    if (keys === 200) return { ok: false, code: 'TOKEN_TOO_BROAD' };
    if (keys !== 403 && keys !== 404) return { ok: false, code: 'SCOPE_UNVERIFIED' };
    const probe = await call(`/repos/${owner}/${repos[0]}/git/refs`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'invalid', sha: '0'.repeat(40) }) });
    if (probe.status >= 500 || isRateLimited(probe)) return { ok: false, code: 'GITHUB_UNREACHABLE' };
    if (![403, 404].includes(probe.status)) return { ok: false, code: 'TOKEN_CAN_WRITE' };
  } catch {
    return { ok: false, code: 'GITHUB_UNREACHABLE' };
  }
  return { ok: true, code: 'OK', repos: Object.keys(r.repos).length, expires_at: r.expires_at };
}
