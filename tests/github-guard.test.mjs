/**
 * GitHub の見張り（2026-11-04・MA-22）。読み取りの query だけ・1 回 1 通信・Trading Lab の repo を見ない・HEAD の差は知らせない・
 * 通信の失敗で悪化も回復も作らない。gh は実行せず fixture で差し替える。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GITHUB_BINS, GITHUB_EXTRA_REPOS, GITHUB_LIMITS, buildQuery, collectGithub, evaluateGithub, evaluateGithubEvents, githubBin, nextGithubState, parseGithub,
} from '../scripts/lib/github-guard.mjs';
import { makeRunner, runHostHealth } from '../scripts/host-health.mjs';

const NOW = '2026-11-04T09:00:00.000Z';
const repo = (over = {}) => ({ visibility: 'PRIVATE', isArchived: false, isDisabled: false, defaultBranchRef: { name: 'master', target: { oid: 'aaa', statusCheckRollup: null } }, ...over });
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ data }), timedOut: false });
const parsed = (over = {}) => ({ found: true, visibility: 'PRIVATE', archived: false, disabled: false, default_branch: 'master', oid: 'aaa', ci: null, ...over });

test('query：読み取りだけ・repo ごとに別名・外の文字列を混ぜない', () => {
  const q = buildQuery('example-org', ['a', 'b.c']);
  assert.match(q, /^query \{ r0: repository\(owner: "example-org", name: "a"\)/);
  assert.match(q, /r1: repository\(owner: "example-org", name: "b\.c"\)/);
  assert.ok(!/mutation/i.test(q));
  assert.throws(() => buildQuery('a") { x } mutation {', ['a']), /owner/);
  assert.throws(() => buildQuery('o', ['a") {']), /repo/);
});

test('読み取り：成功・repo が見えない（gh は 1 で終わるが data はある）・通信の失敗・時間切れ', () => {
  const r = parseGithub(ok({ r0: repo({ defaultBranchRef: { name: 'main', target: { oid: 'bbb', statusCheckRollup: { state: 'FAILURE' } } } }) }), ['a']);
  assert.deepEqual(r.a, parsed({ default_branch: 'main', oid: 'bbb', ci: 'FAILURE' }));
  const part = parseGithub({ code: 1, stdout: JSON.stringify({ data: { r0: repo(), r1: null }, errors: [{}] }) }, ['a', 'b']);
  assert.deepEqual(part.b, { found: false });
  assert.equal(part.a.found, true);
  assert.equal(parseGithub({ code: 1, stdout: '' }, ['a']), null);
  assert.equal(parseGithub({ code: 1, stdout: JSON.stringify({ data: { r0: null } }) }, ['a']), null, '全部 null で失敗は認証・通信の問題');
  assert.equal(parseGithub({ code: 0, stdout: 'not json' }, ['a']), null);
  assert.equal(parseGithub({ code: -1, stdout: '', timedOut: true }, ['a']), null);
});

test('collect：gh api graphql を 1 回だけ・固定の argv・Vault の公開範囲も見る・Trading Lab の repo を除く', async () => {
  const calls = [];
  const run = async (bin, args) => { calls.push([bin, ...args]); return ok({ r0: repo(), r1: repo() }); };
  const g = await collectGithub({ run, bin: GITHUB_BINS[0], owner: 'example-org', repos: ['a', 'ai-trading-lab-runtime'] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), [GITHUB_BINS[0], 'api', 'graphql', '-f']);
  assert.ok(!calls[0].join(' ').toLowerCase().includes('trading'));
  assert.deepEqual(Object.keys(g), ['a', ...GITHUB_EXTRA_REPOS]);
});

test('判定：CI の失敗・archived・disabled・見えない repo は warn。Mac の HEAD との差は値だけで ok', () => {
  const gh = { a: parsed(), b: parsed({ ci: 'FAILURE' }), c: parsed({ ci: 'ERROR' }), d: parsed({ archived: true }), e: parsed({ disabled: true }), f: { found: false }, g: parsed({ ci: 'PENDING', oid: 'bbb' }) };
  const items = evaluateGithub(gh, { a: { oid: 'aaa' }, g: { oid: 'ccc' } }, null, NOW);
  const by = Object.fromEntries(items.map((x) => [x.id, [x.level, x.value]]));
  assert.deepEqual(by, {
    github_api: ['ok', 'ok'],
    'github:a': ['ok', 'ok'],
    'github:b': ['warn', 'ci_failure'],
    'github:c': ['warn', 'ci_failure'],
    'github:d': ['warn', 'archived'],
    'github:e': ['warn', 'disabled'],
    'github:f': ['warn', 'not_found'],
    'github:g': ['ok', 'differs_from_mac'],
  });
});

test('通信の失敗：しばらくは unknown（悪化も回復も作らない）・続けば github_api を warn・直れば消える', () => {
  const first = evaluateGithub(null, {}, null, NOW);
  assert.deepEqual(first.map((x) => [x.id, x.level]), [['github_api', 'unknown']]);
  const s1 = nextGithubState(null, { repos: { a: { visibility: 'PRIVATE' } } }, NOW);
  assert.equal(s1.fail_since, NOW);
  assert.deepEqual(s1.repos, { a: { visibility: 'PRIVATE' } }, '失敗の回は基準を消さない');
  const later = new Date(Date.parse(NOW) + GITHUB_LIMITS.api_fail_hours * 3_600_000).toISOString();
  assert.equal(nextGithubState(null, s1, later).fail_since, NOW, '始まりの時刻を保つ');
  assert.deepEqual(evaluateGithub(null, {}, s1, later).map((x) => [x.level, x.value]), [['warn', 'unreachable']]);
  assert.equal(nextGithubState({ a: parsed() }, s1, later).fail_since, undefined);
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

test('host-health の 1 回分：--github-owner の時だけ通信する・HOME は gh の runner にだけ渡す・hash を記録しない', async () => {
  const seen = [];
  const gh = makeRunner({ allowed: GITHUB_BINS, env: { HOME: '/Users/x' }, execFileImpl: (bin, args, opts, cb) => { seen.push(opts); cb(null, JSON.stringify({ data: { r0: repo({ visibility: 'PUBLIC' }) } })); } });
  await gh(GITHUB_BINS[0], ['api', 'graphql']);
  assert.equal(seen[0].env.HOME, '/Users/x');
  await assert.rejects(gh('/usr/bin/git', ['status']), /not allowed/);
  const other = makeRunner({ execFileImpl: (bin, args, opts, cb) => { seen.push(opts); cb(null, ''); } });
  await other('/bin/df', ['-k', '/']);
  assert.ok(!('HOME' in seen[1].env), '他のコマンドの env は最小のまま');

  const dir = mkdtempSync(path.join(tmpdir(), 'edl-gh-'));
  try {
    const run = async () => ({ code: 1, stdout: '', timedOut: false });
    const ghRun = async () => ok({ r0: repo({ visibility: 'PUBLIC' }), r1: repo() });
    const opts = { stateDir: dir, dataDirs: [], run, uid: 501, github: { run: ghRun, bin: GITHUB_BINS[0], owner: 'example-org', repos: ['a'] } };
    const r = await runHostHealth({ ...opts, now: () => new Date(NOW) });
    assert.equal(r.code, 0);
    assert.equal(r.items.find((x) => x.id === 'github_api').level, 'ok');
    assert.ok(!readFileSync(path.join(dir, '2026-11.jsonl'), 'utf8').includes('aaa'), 'commit の hash を記録に残さない');
    const none = await runHostHealth({ stateDir: dir, dataDirs: [], run, uid: 501, now: () => new Date(Date.parse(NOW) + 60_000) });
    assert.ok(!none.items.some((x) => x.id.startsWith('github')), '既定は通信しない');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh の場所：許可した絶対パスだけ。無ければ null', () => {
  assert.equal(githubBin((p) => p === GITHUB_BINS[1]), GITHUB_BINS[1]);
  assert.equal(githubBin(() => false), null);
});

test('gh が無い・名前が不正・例外は 1 回分の失敗にしない（null＝github_api）。その回も基準を消さない', async () => {
  const run = async () => { throw new Error('boom'); };
  assert.equal(await collectGithub({ run, bin: null, owner: 'o', repos: ['a'] }), null);
  assert.equal(await collectGithub({ run, bin: GITHUB_BINS[0], owner: 'o', repos: ['a'] }), null);
  assert.equal(await collectGithub({ run: async () => ok({}), bin: GITHUB_BINS[0], owner: 'o', repos: ['bad name'] }), null);
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-gh-'));
  try {
    const base = { stateDir: dir, dataDirs: [], run: async () => ({ code: 1, stdout: '', timedOut: false }), uid: 501 };
    const gh = (visibility, bin = GITHUB_BINS[0]) => ({ run: async () => ok({ r0: repo({ visibility }), r1: repo() }), bin, owner: 'o', repos: ['a'] });
    await runHostHealth({ ...base, github: gh('PRIVATE'), now: () => new Date(NOW) });
    const missing = await runHostHealth({ ...base, github: gh('PRIVATE', null), now: () => new Date(Date.parse(NOW) + 60_000) });
    assert.equal(missing.items.find((x) => x.id === 'github_api').level, 'unknown', 'gh が消えた回を ok にしない');
    const flipped = await runHostHealth({ ...base, github: gh('PUBLIC'), now: () => new Date(Date.parse(NOW) + 120_000) });
    assert.deepEqual(flipped.notify.map((n) => [n.id, n.level]), [['github_visibility_changed', 'crit']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub が読めない回は github:<name> の状態を消さない（通信の揺れで同じ WARN を出し直さない）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edl-gh-'));
  try {
    const base = { stateDir: dir, dataDirs: [], run: async () => ({ code: 1, stdout: '', timedOut: false }), uid: 501 };
    const fail = repo({ defaultBranchRef: { name: 'master', target: { oid: 'a', statusCheckRollup: { state: 'FAILURE' } } } });
    const good = { run: async () => ok({ r0: fail, r1: repo() }), bin: GITHUB_BINS[0], owner: 'o', repos: ['a'] };
    const down = { ...good, run: async () => ({ code: 1, stdout: '', timedOut: false }) };
    const r1 = await runHostHealth({ ...base, github: good, now: () => new Date(NOW) });
    assert.ok(r1.notify.some((n) => n.id === 'github:a'));
    await runHostHealth({ ...base, github: down, now: () => new Date(Date.parse(NOW) + 60_000) });
    const r3 = await runHostHealth({ ...base, github: good, now: () => new Date(Date.parse(NOW) + 120_000) });
    assert.ok(!r3.notify.some((n) => n.id === 'github:a'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
