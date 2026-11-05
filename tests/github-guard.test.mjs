/**
 * GitHub の見張り（2026-11-04・MA-22。2026-11-05 H3：専用の読み取り token）。GET だけ・Trading Lab の repo を見ない・token を外へ出さない・
 * token が無ければ何もしない・通信の失敗で悪化も回復も作らない。GitHub には接続せず fetch を差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GITHUB_LIMITS, ciOf, collectGithub, evaluateGithub, evaluateGithubEvents, nextGithubState, verifyMonitorToken } from '../scripts/lib/github-guard.mjs';
import { decide, parseArgs, runHostHealth, validateArgs } from '../scripts/host-health.mjs';

const NOW = '2026-11-04T09:00:00.000Z';
const TOKEN = 'github_pat_SYNTHETIC0000';
const parsed = (over = {}) => ({ found: true, visibility: 'PRIVATE', archived: false, disabled: false, default_branch: 'master', oid: 'aaa', ci: null, ...over });
const response = (status, json = {}, headers = {}) => ({ status, json: async () => json, headers: { get: (k) => headers[k] ?? null } });

/** repo ごとの応答を返す fetch。calls に [method, url, authorization] を残す */
function fakeGithub({ repos = {}, runs = [], statusJson = { total_count: 0, state: 'pending' }, headers = {}, calls = [], fail = null } = {}) {
  return async (url, opts = {}) => {
    calls.push([opts.method ?? 'GET', url, opts.headers?.authorization]);
    if (fail) { const r = fail(url, opts); if (r) return r; }
    const m = /\/repos\/[^/]+\/([^/]+)(\/.*)?$/.exec(url);
    const name = m?.[1];
    const tail = m?.[2] ?? '';
    const repo = repos[name] === undefined ? { visibility: 'private', default_branch: 'master' } : repos[name];
    if (repo == null) return response(404);
    if (tail === '') return response(200, repo, headers);
    if (tail.startsWith('/git/ref/')) return response(200, { object: { sha: 'aaa' } });
    if (tail.endsWith('/status')) return response(200, statusJson);
    if (tail.startsWith('/actions/runs')) return response(200, { workflow_runs: runs });
    return response(404);
  };
}
const collect = (over = {}) => collectGithub({ credential: 'E-NEXUS/edl/github-monitor-token', owner: 'example-org', repos: ['a'], now: NOW, read: async () => TOKEN, fetchImpl: fakeGithub(), ...over });

test('collect：GET だけ・宛先は api.github.com だけ・Trading Lab の repo を除く・token は header だけ', async () => {
  const calls = [];
  const r = await collect({ repos: ['a', 'ai-trading-lab-runtime'], fetchImpl: fakeGithub({ calls }) });
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.repos), ['a']);
  assert.ok(calls.length && calls.every(([method, url, auth]) => method === 'GET' && url.startsWith('https://api.github.com/repos/example-org/a') && auth === `Bearer ${TOKEN}` && !url.includes(TOKEN)));
  assert.ok(!calls.some(([, url]) => /trading/i.test(url)));
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test('collect：token が無ければ通信しない（off）。fine-grained 以外の token は使わない', async () => {
  const calls = [];
  const fetchImpl = fakeGithub({ calls });
  assert.equal((await collect({ read: async () => null, fetchImpl })).status, 'off');
  for (const t of ['gho_broadlogin', 'ghp_classic', 'plain']) assert.equal((await collect({ read: async () => t, fetchImpl })).status, 'auth', t);
  assert.equal(calls.length, 0);
  assert.equal((await collect({ read: async () => { throw new Error('locked'); } })).status, 'failed');
});

test('collect：失敗の分類（401・権限不足＝auth／rate limit・5xx・通信＝failed）・消えた repo は found: false', async () => {
  const at = (res) => collect({ fetchImpl: fakeGithub({ fail: () => res }) });
  assert.equal((await at(response(401))).status, 'auth');
  assert.equal((await at(response(403))).status, 'auth');
  assert.equal((await at(response(403, {}, { 'x-ratelimit-remaining': '0' }))).status, 'failed');
  assert.equal((await at(response(429))).status, 'failed');
  assert.equal((await at(response(403, {}, { 'retry-after': '60' }))).status, 'failed', 'secondary rate limit は権限の失敗ではない');
  assert.equal((await at(response(502))).status, 'failed');
  assert.equal((await collect({ fetchImpl: async () => { throw new Error(`boom ${TOKEN}`); } })).status, 'failed');
  assert.deepEqual((await collect({ fetchImpl: fakeGithub({ repos: { a: null } }) })).repos.a, { found: false });
  assert.equal((await collect({ owner: 'bad owner' })).status, 'failed');
  assert.equal((await collect({ repos: ['bad name'] })).status, 'failed');
});

test('CI の窓口だけの障害で公開範囲の見張りを止めない・権限の失敗はそのまま・Keychain の待ちも時間の予算に入る', async () => {
  const onCi = (res) => fakeGithub({ fail: (url) => (/\/status$|actions\/runs/.test(url) ? res : null) });
  const r = await collect({ fetchImpl: onCi(response(502)) });
  assert.deepEqual([r.status, r.repos.a.visibility, r.repos.a.ci], ['ok', 'PRIVATE', null]);
  assert.equal((await collect({ fetchImpl: onCi(response(403)) })).status, 'auth');
  assert.equal((await collect({ read: () => new Promise(() => {}), timeoutMs: 20 })).status, 'failed');
  assert.equal((await collect({ fetchImpl: () => new Promise(() => {}), timeoutMs: 20 })).status, 'failed');
});

test('collect：公開範囲は大文字へそろえ、token の期限を拾う', async () => {
  const r = await collect({ fetchImpl: fakeGithub({ repos: { a: { visibility: 'public', default_branch: 'main' } }, headers: { 'github-authentication-token-expiration': '2026-11-10 00:00:00 UTC' } }) });
  assert.deepEqual(r.repos.a, parsed({ visibility: 'PUBLIC', default_branch: 'main' }));
  assert.equal(r.expires_at, Date.parse('2026-11-10 00:00:00 UTC'));
});

test('CI：workflow ごとの最新の run で判定（古い失敗を引きずらない）・commit status の失敗・長く終わらない run', () => {
  const run = (workflow_id, status, conclusion, created_at = NOW) => ({ workflow_id, status, conclusion, created_at });
  const old = '2026-11-04T01:00:00.000Z';
  assert.equal(ciOf(null, null, NOW), null);
  assert.equal(ciOf({ total_count: 0, state: 'pending' }, { workflow_runs: [] }, NOW), null, 'CI の無い repo は異常にしない');
  assert.equal(ciOf({ total_count: 1, state: 'failure' }, null, NOW), 'FAILURE');
  assert.equal(ciOf({ total_count: 1, state: 'error' }, null, NOW), 'FAILURE');
  assert.equal(ciOf(null, { workflow_runs: [run(1, 'completed', 'failure')] }, NOW), 'FAILURE');
  assert.equal(ciOf(null, { workflow_runs: [run(1, 'completed', 'timed_out')] }, NOW), 'FAILURE');
  assert.equal(ciOf(null, { workflow_runs: [run(1, 'completed', 'failure', old), run(1, 'completed', 'success')] }, NOW), null, '再実行で直った');
  assert.equal(ciOf(null, { workflow_runs: [run(1, 'completed', 'cancelled')] }, NOW), null);
  assert.equal(ciOf(null, { workflow_runs: [run(1, 'in_progress', null)] }, NOW), null);
  assert.equal(ciOf(null, { workflow_runs: [run(1, 'queued', null, old)] }, NOW), 'STUCK');
});

test('判定：CI の失敗・archived は warn・disabled・見えない repo は crit。Mac の HEAD との差は値だけで ok', () => {
  const gh = { a: parsed(), b: parsed({ ci: 'FAILURE' }), c: parsed({ ci: 'STUCK' }), d: parsed({ archived: true }), e: parsed({ disabled: true }), f: { found: false }, g: parsed({ oid: 'bbb' }) };
  const items = evaluateGithub(gh, { a: { oid: 'aaa' }, g: { oid: 'ccc' } }, null, NOW);
  assert.deepEqual(Object.fromEntries(items.map((x) => [x.id, [x.level, x.value]])), {
    github_api: ['ok', 'ok'],
    'github:a': ['ok', 'ok'],
    'github:b': ['warn', 'ci_failure'],
    'github:c': ['warn', 'ci_stuck'],
    'github:d': ['warn', 'archived'],
    'github:e': ['crit', 'disabled'],
    'github:f': ['crit', 'not_found'],
    'github:g': ['ok', 'differs_from_mac'],
  });
});

test('remote との差：続いた時だけ warn。未 push（ahead）は repo:<name> の担当で数えない・揃えば数え直す', () => {
  const gh = { a: parsed({ oid: 'bbb' }) };
  const local = { a: { oid: 'ccc', ahead: 0 } };
  const s1 = nextGithubState(gh, null, NOW, { localRepos: local });
  assert.equal(s1.differ_since.a, NOW);
  const later = new Date(Date.parse(NOW) + GITHUB_LIMITS.differs_days * 86_400_000).toISOString();
  assert.equal(nextGithubState(gh, s1, later, { localRepos: local }).differ_since.a, NOW, '始まりの時刻を保つ');
  assert.equal(evaluateGithub(gh, local, s1, later).find((x) => x.id === 'github:a').level, 'warn');
  assert.equal(evaluateGithub(gh, { a: { oid: 'ccc', ahead: 2 } }, s1, later).find((x) => x.id === 'github:a').level, 'ok');
  assert.deepEqual(nextGithubState(gh, s1, later, { localRepos: { a: { oid: 'bbb', ahead: 0 } } }).differ_since, {});
  assert.equal(nextGithubState(gh, s1, later, { localRepos: local, keepEvents: true }).differ_since.a, NOW, '送れなかった回も時刻を失わない');
});

test('監視自体の失敗：通信はしばらく unknown・続けば unreachable・認証の失敗は待たない・期限が近ければ token_expiring', () => {
  const first = evaluateGithub(null, {}, null, NOW);
  assert.deepEqual(first.map((x) => [x.id, x.level]), [['github_api', 'unknown']]);
  const s1 = nextGithubState(null, { repos: { a: { visibility: 'PRIVATE' } } }, NOW);
  assert.equal(s1.fail_since, NOW);
  assert.deepEqual(s1.repos, { a: { visibility: 'PRIVATE' } }, '失敗の回は基準を消さない');
  const later = new Date(Date.parse(NOW) + GITHUB_LIMITS.api_fail_hours * 3_600_000).toISOString();
  assert.equal(nextGithubState(null, s1, later).fail_since, NOW, '始まりの時刻を保つ');
  assert.deepEqual(evaluateGithub(null, {}, s1, later).map((x) => [x.level, x.value]), [['warn', 'unreachable']]);
  assert.equal(nextGithubState({ a: parsed() }, s1, later).fail_since, undefined);
  assert.deepEqual(evaluateGithub(null, {}, null, NOW, { failure: 'auth' }).map((x) => [x.level, x.value]), [['warn', 'auth_failed']]);
  const soon = Date.parse(NOW) + 3 * 86_400_000;
  assert.deepEqual(evaluateGithub({}, {}, null, NOW, { expiresAt: soon }).map((x) => [x.level, x.value]), [['warn', 'token_expiring']]);
  assert.equal(evaluateGithub({}, {}, null, NOW, { expiresAt: soon + 30 * 86_400_000 })[0].level, 'ok');
});

test('見張りの失敗の値が変われば知らせ直す（token_expiring を知らせた後の失効を黙らない）', () => {
  const at = (h) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
  const item = (value) => ({ id: 'github_api', level: 'warn', value, kind: 'state' });
  let prev = null;
  const notes = [];
  for (const [h, v] of [[0, 'token_expiring'], [24, 'token_expiring'], [24.5, 'token_expiring'], [25, 'auth_failed'], [26, 'auth_failed']]) {
    const d = decide([item(v)], prev, { now: at(h) });
    prev = { items: d.items };
    notes.push(...d.notify.map((n) => [h, n.value]));
  }
  assert.deepEqual(notes, [[24, 'token_expiring'], [25, 'auth_failed']]);
});

test('出来事：private → public は CRIT・既定 branch の変化は warn・最初の回は基準を取るだけ・送れなかった回は基準を残す', () => {
  assert.deepEqual(evaluateGithubEvents({ a: parsed({ visibility: 'PUBLIC' }) }, null), []);
  const prev = nextGithubState({ a: parsed(), b: parsed({ visibility: 'PUBLIC' }) }, null, NOW);
  assert.deepEqual(evaluateGithubEvents({ a: parsed(), b: parsed({ visibility: 'PUBLIC' }) }, prev), []);
  const ev = evaluateGithubEvents({ a: parsed({ visibility: 'PUBLIC', default_branch: 'main' }), b: parsed({ visibility: 'PRIVATE' }) }, prev);
  assert.deepEqual(ev.map((e) => [e.id, e.level, e.value]), [
    ['github_visibility_changed', 'crit', 'a:PRIVATE->PUBLIC'],
    ['github_default_branch_changed', 'warn', 'a:master->main'],
    ['github_visibility_changed', 'warn', 'b:PUBLIC->PRIVATE'],
  ]);
  assert.deepEqual(nextGithubState({ a: parsed({ visibility: 'PUBLIC' }) }, prev, NOW, { keepEvents: true }).repos, prev.repos);
  assert.deepEqual(evaluateGithubEvents({ a: { found: false } }, prev), [], '見えない回は変化にしない');
});

const hostRun = async () => ({ code: 1, stdout: '', timedOut: false });
const github = (fetchImpl, read = async () => TOKEN) => ({ credential: 'E-NEXUS/edl/github-monitor-token', owner: 'o', repos: ['a'], read, fetchImpl });

test('host-health の 1 回分：token が無い間は項目も通信も無い・入った回から動く・hash と token を記録しない', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-gh-'));
  try {
    const calls = [];
    const base = { stateDir: dir, dataDirs: [], run: hostRun, uid: 501 };
    const off = await runHostHealth({ ...base, github: github(fakeGithub({ calls }), async () => null), now: () => new Date(NOW) });
    assert.equal(off.code, 0);
    assert.ok(!off.items.some((x) => x.id.startsWith('github')));
    assert.equal(calls.length, 0);
    const on = await runHostHealth({ ...base, github: github(fakeGithub({ calls })), now: () => new Date(Date.parse(NOW) + 60_000) });
    assert.equal(on.items.find((x) => x.id === 'github_api').level, 'ok');
    const records = readFileSync(path.join(dir, '2026-11.jsonl'), 'utf8') + readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.ok(!records.includes('aaa') && !records.includes(TOKEN), 'commit の hash と token を残さない');
    const none = await runHostHealth({ ...base, now: () => new Date(Date.parse(NOW) + 120_000) });
    assert.ok(!none.items.some((x) => x.id.startsWith('github')), '既定は通信しない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('読めない回は基準を消さない・公開範囲の変化は戻った回に知らせる', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-gh-'));
  try {
    const base = { stateDir: dir, dataDirs: [], run: hostRun, uid: 501 };
    const at = (ms) => () => new Date(Date.parse(NOW) + ms);
    await runHostHealth({ ...base, github: github(fakeGithub()), now: at(0) });
    const down = await runHostHealth({ ...base, github: github(async () => { throw new Error('offline'); }), now: at(60_000) });
    assert.equal(down.items.find((x) => x.id === 'github_api').level, 'unknown', '読めない回を ok にしない');
    const flipped = await runHostHealth({ ...base, github: github(fakeGithub({ repos: { a: { visibility: 'public', default_branch: 'master' } } })), now: at(120_000) });
    assert.deepEqual(flipped.notify.map((n) => [n.id, n.level]), [['github_visibility_changed', 'crit']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub が読めない回は github:<name> の状態を消さない（通信の揺れで同じ WARN を出し直さない）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-gh-'));
  try {
    const base = { stateDir: dir, dataDirs: [], run: hostRun, uid: 501 };
    const good = github(fakeGithub({ statusJson: { total_count: 1, state: 'failure' } }));
    const down = github(async () => { throw new Error('offline'); });
    const at = (ms) => () => new Date(Date.parse(NOW) + ms);
    const r1 = await runHostHealth({ ...base, github: good, now: at(0) });
    assert.ok(!r1.notify.some((n) => n.id === 'github:a'), 'WARN はまず記録だけ');
    await runHostHealth({ ...base, github: down, now: at(60_000) });
    const r3 = await runHostHealth({ ...base, github: good, now: at(24 * 3_600_000) });
    assert.ok(r3.notify.some((n) => n.id === 'github:a'), '読めない回を挟んでも続いた時間を失わない');
    await runHostHealth({ ...base, github: down, now: at(24 * 3_600_000 + 60_000) });
    const r5 = await runHostHealth({ ...base, github: good, now: at(24 * 3_600_000 + 120_000) });
    assert.ok(!r5.notify.some((n) => n.id === 'github:a'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引数：owner と credential は両方必要（gh のログインへ落ちる道を残さない）', () => {
  const v = (argv) => validateArgs(parseArgs(argv));
  assert.deepEqual(v(['--github-owner', 'o', '--github-credential', 'credential:E-NEXUS/edl/github-monitor-token']), []);
  assert.ok(v(['--github-owner', 'o']).some((e) => e.includes('両方必要')));
  assert.ok(v(['--github-credential', 'credential:E-NEXUS/edl/x']).some((e) => e.includes('両方必要')));
  assert.ok(v(['--github-owner', 'o', '--github-credential', 'github_pat_x']).some((e) => e.includes('--github-credential must')));
  const source = readFileSync(new URL('../scripts/lib/github-guard.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../scripts/host-health.mjs', import.meta.url), 'utf8');
  assert.ok(!/opt\/homebrew\/bin\/gh|'gh'/.test(source), 'gh を起動しない');
});

test('token の検収：範囲が 6 repo の中で、読める・書けない token だけ合格。広い token・書ける token・足りない token・classic は落とす', async () => {
  const verify = (fetchImpl, token = TOKEN) => verifyMonitorToken({ token, owner: 'o', repos: ['a'], now: NOW, fetchImpl });
  const scoped = (status, { list = [{ name: 'a' }], listStatus = 200, keys = 403, ...over } = {}) => fakeGithub({ ...over, fail: (url, opts) => {
    if (opts.method === 'POST') return response(status);
    if (url.includes('/user/repos')) return response(listStatus, list);
    if (url.endsWith('/keys')) return response(keys, []);
    return null;
  } });
  const calls = [];
  const good = await verify(scoped(403, { calls }));
  assert.deepEqual([good.ok, good.code, good.repos], [true, 'OK', 1]);
  assert.deepEqual(calls.filter(([m]) => m !== 'GET').map(([m, u]) => [m, u]), [['POST', 'https://api.github.com/repos/o/a/git/refs']]);
  assert.equal((await verify(scoped(422))).code, 'TOKEN_CAN_WRITE');
  assert.equal((await verify(scoped(201))).code, 'TOKEN_CAN_WRITE');
  assert.equal((await verify(scoped(503))).code, 'GITHUB_UNREACHABLE', '5xx を書けると言わない');
  assert.equal((await verify(scoped(403, { list: [{ name: 'a' }, { name: 'other-private' }] }))).code, 'TOKEN_TOO_BROAD', 'All repositories の token');
  assert.equal((await verify(scoped(403, { keys: 200 }))).code, 'TOKEN_TOO_BROAD', 'Administration の権限');
  assert.equal((await verify(scoped(403, { listStatus: 403 }))).code, 'SCOPE_UNVERIFIED', '確かめられなければ合格にしない');
  assert.equal((await verify(scoped(403), 'gho_x')).code, 'NOT_FINE_GRAINED');
  assert.equal((await verify(scoped(403), null)).code, 'NOT_FINE_GRAINED');
  assert.deepEqual((await verify(scoped(403, { repos: { a: null } }))).repos, ['a']);
  assert.equal((await verify(fakeGithub({ fail: () => response(401) }))).code, 'TOKEN_REJECTED');
  assert.equal((await verify(async () => { throw new Error('x'); })).code, 'GITHUB_UNREACHABLE');
});

test('接続の道具（Human が実行）：端末でなければ何もしない・token を引数で受けない・不合格の token を残さない', () => {
  const file = new URL('../deploy/macos/connect-github-monitor.sh', import.meta.url);
  assert.ok(existsSync(file));
  const body = readFileSync(file, 'utf8');
  assert.ok(!/github_pat_/.test(body));
  assert.match(body, /keychain-edl\.sh set "\$NAME"/);
  assert.match(body, /delete-generic-password/);
  assert.equal(spawnSync('bash', ['-n', file.pathname], { timeout: 10_000 }).status, 0);
  assert.equal(spawnSync('bash', [file.pathname, 'example-org'], { input: '', timeout: 10_000, encoding: 'utf8' }).status, 2, '端末でなければ Keychain に触れない');
});
