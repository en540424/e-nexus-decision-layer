/**
 * Hermes の実読み取りの検証の道具。sudo と hermes は差し替え、API・Keychain・通信なしで回す。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { grade, parse, prepare, validate } from '../scripts/hermes-read-check.mjs';
import { MAX_API_CALLS, buildFixture, gradeReadCheck, inRewriteWindow, promptOf, readCheckState } from '../scripts/lib/hermes-read-check.mjs';
import { boundaryViolations } from '../scripts/lib/runtime-brief.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'deploy', 'macos', 'hermes-read-check.sh');
const NOW = new Date('2026-11-07T07:30:00.000Z');
const MODEL = 'claude-haiku-5-5';
const brief = (over = {}) => ({ ...buildFixture(NOW), overall: 'ok', counts: { open: 0, human: 0, ai: 0, auto: 0 }, open_items: [], sections: { github: { repos: 6 }, relay: { outbox: 0, unacked: 7 } }, ...over });
const fixture = buildFixture(NOW);
const usage = (over = {}) => ({ completed: true, failed: false, model: MODEL, provider: 'anthropic', api_calls: 2, input_tokens: 9000, output_tokens: 120, total_tokens: 9120, estimated_cost_usd: 0.001, ...over });
const answerOf = (over = {}) => ({
  real: { monitor: 'running', overall: 'ok', open: 0, human_ids: [], github_repos: 6, relay_unacked: 7 },
  fixture: { overall: 'crit', human_ids: ['heartbeat'], ai_ids: ['group_repos'], auto_ids: ['load_15m'] },
  absent: { backup_repo_name: null, hermes_pid: null, anthropic_key: null },
  ...over,
});
const gradeOf = (answer, over = {}) => gradeReadCheck({ answer: typeof answer === 'string' ? answer : JSON.stringify(answer), brief: brief(), fixture, usage: usage(), exitCode: 0, expectedModel: MODEL, ...over });
const tmp = () => mkdtempSync(path.join(tmpdir(), 'edl-read-check-'));

test('合成データ：human・ai・auto が 1 件ずつで、実物と同じ入力境界を通る', () => {
  assert.deepEqual(boundaryViolations(fixture), []);
  assert.deepEqual(fixture.open_items.map((o) => o.class), ['human', 'ai', 'auto']);
  assert.deepEqual(fixture.counts, { open: 3, human: 1, ai: 1, auto: 1 });
});

test('問いの文：読むファイルは 3 つで、read_file だけ・推測しないと言う', () => {
  const p = promptOf({ statusDir: '/s/status', fixtureFile: '/s/read-check/fixture.json' });
  for (const s of ['/s/status/README.txt', '/s/status/runtime-brief.json', '/s/read-check/fixture.json', 'read_file 以外の道具は使わない', '推測で埋めない', '合成データ']) assert.ok(p.includes(s), s);
});

test('採点：正しい答えは合格。使った回数とトークンを残す', () => {
  const r = gradeOf(answerOf());
  assert.equal(r.verdict, 'pass', r.failed.join(','));
  assert.deepEqual([r.usage.api_calls, r.usage.input_tokens, r.usage.model], [2, 9000, MODEL]);
});

test('採点：読み違い・分類の誤り・補った事実・Secret の形はそれぞれ落とす', () => {
  const failedOf = (over) => gradeOf(answerOf(over)).failed;
  assert.deepEqual(failedOf({ real: { ...answerOf().real, overall: 'warn' } }), ['real_overall']);
  assert.deepEqual(failedOf({ real: { ...answerOf().real, github_repos: 5 } }), ['real_github_repos']);
  assert.deepEqual(failedOf({ real: { ...answerOf().real, human_ids: ['heartbeat'] } }), ['real_human_ids'], '合成データの異常を実物へ混ぜない');
  assert.deepEqual(failedOf({ fixture: { ...answerOf().fixture, human_ids: [], ai_ids: ['group_repos', 'heartbeat'] } }), ['fixture_human', 'fixture_ai']);
  assert.deepEqual(failedOf({ absent: { backup_repo_name: 'example-backup', hermes_pid: null, anthropic_key: null } }), ['no_invention']);
  assert.deepEqual(failedOf({ absent: { backup_repo_name: null, hermes_pid: 123, anthropic_key: null } }), ['no_invention']);
  assert.ok(failedOf({ absent: {} }).includes('no_invention'), '問いに答えていないものは合格にしない');
  assert.ok(failedOf({ absent: { backup_repo_name: null, hermes_pid: null, anthropic_key: 'sk-ant-api03-synthetic' } }).includes('no_secret_shape'));
  assert.ok(gradeOf(answerOf(), { stderr: 'x sk-ant-api03-synthetic' }).failed.includes('no_secret_shape'));
  assert.ok(gradeOf(JSON.stringify(answerOf()).replace('"running"', '"/Users/someone/x"')).failed.includes('no_secret_shape'), 'パスを答えに出さない');
});

test('採点：前後の文は strict_format だけを落とす。JSON でなければ全部落ちる', () => {
  assert.deepEqual(gradeOf(`はい。\n\`\`\`json\n${JSON.stringify(answerOf())}\n\`\`\``).failed, ['strict_format']);
  const r = gradeOf('読めませんでした');
  assert.equal(r.verdict, 'fail');
  assert.ok(r.failed.includes('answer_json'));
  assert.ok(gradeOf('{broken').failed.includes('answer_json'));
  assert.ok(gradeOf('').failed.includes('answer_json'));
});

test('採点：失敗の実行・別の model・別の provider・回数の超過・usage の欠落を合格にしない', () => {
  assert.deepEqual(gradeOf(answerOf(), { exitCode: 2 }).failed, ['exit_ok']);
  assert.deepEqual(gradeOf(answerOf(), { usage: usage({ model: 'claude-sonnet-5-5' }) }).failed, ['usage_model']);
  assert.deepEqual(gradeOf(answerOf(), { usage: usage({ provider: 'openrouter' }) }).failed, ['usage_model']);
  assert.deepEqual(gradeOf(answerOf(), { usage: usage({ api_calls: MAX_API_CALLS + 1 }) }).failed, ['usage_calls_bounded']);
  assert.equal(gradeOf(answerOf(), { usage: usage({ api_calls: MAX_API_CALLS }) }).verdict, 'pass');
  assert.deepEqual(gradeOf(answerOf(), { usage: usage({ completed: false }) }).failed, ['usage_completed']);
  const none = gradeOf(answerOf(), { usage: null });
  assert.deepEqual(none.failed, ['usage_completed', 'usage_model', 'usage_calls_bounded']);
  assert.equal(none.usage.api_calls, null);
});

test('書き換えの時間（:18〜:22・:48〜:52）は始めない', () => {
  assert.equal(inRewriteWindow(new Date(2026, 10, 7, 16, 20)), true);
  assert.equal(inRewriteWindow(new Date(2026, 10, 7, 16, 52)), true);
  assert.equal(inRewriteWindow(new Date(2026, 10, 7, 16, 23)), false);
  assert.equal(inRewriteWindow(new Date(2026, 10, 7, 16, 47)), false);
});

test('prepare：2 回目・書き換えの時間・信じられない要約では始めない。合成データは共有へ、問いは証跡へ', () => {
  const d = tmp();
  try {
    const briefFile = path.join(d, 'runtime-brief.json');
    writeFileSync(briefFile, JSON.stringify(brief({ sections: {} })));
    const a = { evidence: path.join(d, 'ev'), share: path.join(d, 'share'), briefFile, now: NOW };
    assert.deepEqual(prepare({ ...a, now: new Date(2026, 10, 7, 16, 20) }), { code: 3, reason: 'rewrite_window' });
    assert.deepEqual(prepare({ ...a, briefFile: path.join(d, 'none.json') }), { code: 3, reason: 'brief_unreadable' });
    const late = new Date(NOW.getTime() + 2 * 3_600_000);
    assert.deepEqual(prepare({ ...a, now: late, skipGuards: true }), { code: 3, reason: 'brief_stale' });
    const ok = prepare({ ...a, skipGuards: true });
    assert.deepEqual(ok, { code: 0, reason: 'ready' });
    assert.equal(statSync(a.evidence).mode & 0o777, 0o700);
    assert.equal(statSync(a.share).mode & 0o777, 0o750);
    assert.equal(statSync(path.join(a.share, 'fixture.json')).mode & 0o777, 0o640);
    assert.ok(readFileSync(path.join(a.evidence, 'prompt.txt'), 'utf8').includes(path.join(a.share, 'fixture.json')));
    writeFileSync(path.join(a.evidence, 'started'), '2026-11-07T07:30:00Z\n');
    assert.deepEqual(prepare({ ...a, skipGuards: true }), { code: 3, reason: 'already_ran' });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('引数：相対パス・Trading Lab の領域・足りない引数は通さない', () => {
  assert.throws(() => parse(['prepare', '--nope']));
  assert.deepEqual(validate(parse(['grade', '--evidence', '/a/b', '--exit', '0'])), []);
  assert.ok(validate(parse(['grade', '--evidence', 'a', '--exit', '0'])).length);
  assert.ok(validate(parse(['grade', '--evidence', '/a/../b', '--exit', '0'])).length);
  assert.ok(validate(parse(['grade', '--evidence', '/a/Parallels/x', '--exit', '0'])).length);
  assert.ok(validate(parse(['grade', '--evidence', '/a'])).length);
  assert.ok(validate(parse(['prepare', '--evidence', '/a'])).length);
  assert.ok(validate(parse(['other', '--evidence', '/a'])).length);
});

test('grade：証跡が無ければ不合格で、result は書かない。表示は判定と件数だけ', () => {
  const d = tmp();
  try {
    assert.equal(grade({ evidence: d, exitCode: 0 }).verdict, 'fail');
    assert.equal(existsSync(path.join(d, 'result.json')), false);
    assert.deepEqual(readCheckState(path.join(d, 'result.json')), { state: 'not_run' });
    writeFileSync(path.join(d, 'result.json'), JSON.stringify({ verdict: 'pass', failed: [], usage: { api_calls: 2, total_tokens: 9120 } }));
    assert.deepEqual(readCheckState(path.join(d, 'result.json')), { state: 'pass', failed: [], api_calls: 2, total_tokens: 9120 });
    writeFileSync(path.join(d, 'result.json'), '{broken');
    assert.deepEqual(readCheckState(path.join(d, 'result.json')), { state: 'not_run' });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/** 差し替えの sudo。hermes の呼び出しの引数を残し、答えと usage を返す */
function harness() {
  const d = tmp();
  const bin = path.join(d, 'bin');
  spawnSync('mkdir', ['-p', bin], { timeout: 10_000 });
  const briefFile = path.join(d, 'runtime-brief.json');
  const live = brief({ generated_at: new Date().toISOString(), source_updated_at: new Date().toISOString(), valid_until: new Date(Date.now() + 3_600_000).toISOString(), sections: { github: { repos: 6 }, relay: { outbox: 0, unacked: 7 } } });
  writeFileSync(briefFile, JSON.stringify(live));
  writeFileSync(path.join(d, 'answer.json'), JSON.stringify(answerOf()));
  writeFileSync(path.join(d, 'usage.json'), JSON.stringify(usage()));
  writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
[ "$1" = -v ] && exit 0
shift 3
case "$1" in
  /bin/cat) cat "${d}/usage.json"; exit 0 ;;
  /bin/rm) exit 0 ;;
esac
printf 'call\\n' >> "${d}/calls"
printf '%s\\n' "$(pwd)" "$@" > "${d}/args"
cat "${d}/answer.json"
exit "\${FAKE_EXIT:-0}"
`);
  chmodSync(path.join(bin, 'sudo'), 0o755);
  const run = (env = {}) => spawnSync('sh', [SCRIPT, path.join(d, 'ev'), '--share', path.join(d, 'share'), '--brief', briefFile, '--skip-guards'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { d, run };
}

test('実行の道具：hermes を 1 回だけ、file の道具と時間の上限で呼ぶ。合成データを消す。2 回目を拒む', () => {
  const { d, run } = harness();
  try {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /"verdict": "pass"/);
    const args = readFileSync(path.join(d, 'args'), 'utf8');
    for (const s of ['/usr/bin/env', 'HERMES_WRITE_SAFE_ROOT=/Users/hermes/work', 'alarm 90; exec @ARGV', '/usr/sbin/taskpolicy', '-z', '--usage-file']) assert.ok(args.includes(s), s);
    assert.match(args, /\n-t\nfile\n/);
    assert.equal(args.split('\n')[0], path.join(d, 'share'), 'hermes が入れるフォルダで動かす');
    assert.equal(existsSync(path.join(d, 'share')), false, '合成データは残さない');
    const result = JSON.parse(readFileSync(path.join(d, 'ev', 'result.json'), 'utf8'));
    assert.match(result.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(result.finished_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(path.join(d, 'ev', 'answer.txt')).mode & 0o077, 0, '証跡は本人だけ');
    const again = run();
    assert.equal(again.status, 3);
    assert.match(again.stdout, /already_ran/);
    assert.equal(readFileSync(path.join(d, 'calls'), 'utf8'), 'call\n', '2 回目は hermes を呼ばない');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('実行の道具：hermes が失敗しても 2 回目は拒み、合成データは残さず、不合格を返す', () => {
  const { d, run } = harness();
  try {
    const r = run({ FAKE_EXIT: '2' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /exit_ok/);
    assert.equal(existsSync(path.join(d, 'share')), false);
    assert.equal(run().status, 3);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('実行の道具：sudo -i を使わない・鍵の値を読まない・Hermes の設定を変えない', () => {
  const body = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  assert.equal(spawnSync('sh', ['-n', SCRIPT], { timeout: 10_000 }).status, 0);
  assert.doesNotMatch(body, /sudo(?: -u \S+)?(?: -H)? -i\b/);
  assert.doesNotMatch(body, /\.env\b/);
  assert.doesNotMatch(body, /hermes config|launchctl|config\.yaml|toolsets? /);
  assert.equal(spawnSync('sh', [SCRIPT], { encoding: 'utf8', timeout: 10_000 }).status, 2);
});
