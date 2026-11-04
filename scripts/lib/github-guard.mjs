/**
 * GitHub 側の見張り（2026-11-04・MA-22）。host-health の --github-owner を付けた時だけ動く。READ-ONLY（GraphQL の query だけ）・1 回 1 通信・AI／課金なし。
 *
 * 見るもの：repo の公開範囲の変化（private → public は CRIT）・archived／disabled・既定 branch の変化・既定 branch の先頭 commit の CI 結果・
 *   Mac の HEAD との差（値だけ。Windows の push で Mac が遅れるのは普通なので知らせない。未 push は runtime-guard の repo:<name> が知らせる）。
 * 見ないもの：Trading Lab の repo・issue・PR の本文・Secret。記録と通知に出すのは固定のコードと repo 名だけ（commit の hash は state にだけ残す）。
 * 認証：gh の既存のログインをそのまま使う（新しい鍵を作らない）。通信や認証の失敗は unknown で、続いた時だけ github_api を warn にする。
 */
import { existsSync } from 'node:fs';

export const GITHUB_BINS = Object.freeze(['/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
export const GITHUB_TIMEOUT_MS = 15_000;
/** Mac に clone が無くても公開範囲は見る repo */
export const GITHUB_EXTRA_REPOS = Object.freeze(['EN-Knowledge-Vault']);
export const GITHUB_LIMITS = Object.freeze({ api_fail_hours: 6 });
export const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const TRADING_LAB = /trading-?lab/i;
const HOUR = 3_600_000;

export function githubBin(exists = existsSync) {
  return GITHUB_BINS.find((b) => exists(b)) ?? null;
}

/** 読み取りだけの 1 通の query。名前は形を確かめてから埋める（query の組み立てに外の文字列を混ぜない） */
export function buildQuery(owner, repos) {
  if (!GITHUB_OWNER.test(owner)) throw new Error('invalid GitHub owner');
  const fields = 'visibility isArchived isDisabled defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { state } } } }';
  const parts = repos.map((name, i) => {
    if (!REPO_NAME.test(name)) throw new Error('invalid repo name');
    return `r${i}: repository(owner: "${owner}", name: "${name}") { ${fields} }`;
  });
  return `query { ${parts.join(' ')} }`;
}

/** repo が消えた・見えない時は gh が 0 以外で終わっても data に null が入る。data が読めなければ通信の失敗（null） */
export function parseGithub({ code, stdout, timedOut }, repos) {
  if (timedOut) return null;
  let data;
  try {
    data = JSON.parse(stdout)?.data;
  } catch {
    return null;
  }
  if (!data || (code !== 0 && Object.values(data).every((v) => v == null))) return null;
  const out = {};
  repos.forEach((name, i) => {
    const r = data[`r${i}`];
    if (r == null) { out[name] = { found: false }; return; }
    const target = r.defaultBranchRef?.target;
    out[name] = {
      found: true,
      visibility: r.visibility ?? null,
      archived: Boolean(r.isArchived),
      disabled: Boolean(r.isDisabled),
      default_branch: r.defaultBranchRef?.name ?? null,
      oid: target?.oid ?? null,
      ci: target?.statusCheckRollup?.state ?? null,
    };
  });
  return out;
}

/** gh が無い・名前が不正・通信の失敗は全部 null（github_api の unknown／warn になる。1 回分の失敗には数えない） */
export async function collectGithub({ run, bin, owner, repos }) {
  if (!bin) return null;
  const names = [...new Set([...repos, ...GITHUB_EXTRA_REPOS])].filter((n) => !TRADING_LAB.test(n));
  try {
    return parseGithub(await run(bin, ['api', 'graphql', '-f', `query=${buildQuery(owner, names)}`]), names);
  } catch {
    return null;
  }
}

/** 状態の項目。localRepos は runtime-guard の g.repos（oid・ahead）。Mac の HEAD との差は値に残すだけで知らせない */
export function evaluateGithub(gh, localRepos, prev, now) {
  const items = [];
  const add = (id, level, value) => items.push({ id, level, value, kind: 'state' });
  if (gh == null) {
    const since = prev?.fail_since ?? now;
    const old = Date.parse(now) - Date.parse(since) >= GITHUB_LIMITS.api_fail_hours * HOUR;
    add('github_api', old ? 'warn' : 'unknown', old ? 'unreachable' : null);
    return items;
  }
  add('github_api', 'ok', 'ok');
  for (const [name, r] of Object.entries(gh)) {
    const id = `github:${name}`;
    if (!r.found) { add(id, 'warn', 'not_found'); continue; }
    if (r.disabled || r.archived) { add(id, 'warn', r.disabled ? 'disabled' : 'archived'); continue; }
    if (r.ci === 'FAILURE' || r.ci === 'ERROR') { add(id, 'warn', 'ci_failure'); continue; }
    const local = localRepos?.[name]?.oid;
    add(id, 'ok', local && r.oid && local !== r.oid ? 'differs_from_mac' : 'ok');
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
export function nextGithubState(gh, prev, now, { keepEvents = false } = {}) {
  if (gh == null) return { ...(prev ?? {}), fail_since: prev?.fail_since ?? now };
  if (keepEvents) return { repos: prev?.repos ?? {} };
  const repos = { ...(prev?.repos ?? {}) };
  for (const [name, r] of Object.entries(gh)) if (r.found) repos[name] = { visibility: r.visibility, default_branch: r.default_branch };
  return { repos };
}
