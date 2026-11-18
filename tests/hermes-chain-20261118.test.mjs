/**
 * 模擬 E2E（本番の code の通り道・本物の sandbox・Hermes の形の偽物）：Task Hub → 承認 → inbox → 本番の macSys の確かめ（業務の home を整える・
 * sandbox の規則・launcher・無効な鍵の起動）→ 実行 → outbox → 取り込み → 板 → Bot が task.status で読む。初回・2 回目・時間切れの後のやり直し・
 * 常駐が業務の home に書き足した時の止まり、を通す（2026-11-18 夜）。
 *
 * 本物：scripts/hermes-work.mjs の macSys・prepareWorkHome・classifyProbe・inProcessCommand・LOADER・sandbox の profile（sandbox-exec）・
 *       Task Hub の store・runner・承認・取り込み・task.status。
 * 模擬：hermes ユーザー（今の user で動かす＝sudo なし）・Hermes 本体（hermes_cli.main の形の偽物：起動の初めの段・in-process の -z・401・結果の書き）・
 *       常駐の gateway の確かめ（hostCheck）。Hermes の依存・通信・Anthropic は使わない（課金なし）。
 * 実行は taskpolicy -b と perl の alarm で上限つき。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionParams, runtimeBootstrap, WORK_HOME_NAME, WORK_LOCKED_DIRS, WORK_SOUL_MD } from '../scripts/lib/hermes-sandbox.mjs';
import { layoutParams, macSys, productionLayout } from '../scripts/hermes-work.mjs';
import { approve, confirmCodeOf } from '../scripts/lib/task-hub/approval.mjs';
import { ingestInbox } from '../scripts/lib/task-hub/intake.mjs';
import { runWork } from '../scripts/lib/task-hub/hermes-work.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const isMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;
const noWait = async () => null;

/** hermes_cli.main の形の偽物（v0.22.4 の _run_and_exit_oneshot の引数・起動の初めの段・in-process の 401 の文・write_file の代わり） */
const FAKE_MAIN = String.raw`import json, os, re, sys, time
from pathlib import Path
SUBDIRS = ['cron', 'sessions', 'logs', 'logs/curator', 'memories', 'pairing', 'hooks', 'image_cache', 'audio_cache', 'skills']
MODE = (Path(__file__).resolve().parent.parent / 'fake_mode').read_text().strip()
def _init_home():
    home = Path(os.environ['HERMES_HOME'])
    for s in SUBDIRS:
        (home / s).mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(home / s, 0o700)
        except OSError:
            pass
    soul = home / 'SOUL.md'
    if not soul.exists():
        soul.write_text('default soul')
    (home / 'state.db').touch()
    (home / 'sessions' / ('s-%d.json' % os.getpid())).write_text('{}')
    tries = {}
    for rel in ('hooks/planted.py', 'cron/jobs.json', 'skills/x/SKILL.md', 'memories/MEMORY.md', 'SOUL.md', 'config.yaml', 'cwd/AGENTS.md'):
        try:
            p = home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, 'a') as f:
                f.write('x')
            tries[rel] = 'written'
        except OSError:
            tries[rel] = 'denied'
    try:
        (Path(os.environ['HOME']) / '.hermes' / '.env').read_text()
        tries['root .env'] = 'read'
    except OSError:
        tries['root .env'] = 'denied'
    return tries
def _usage(path, d):
    if path:
        Path(path).write_text(json.dumps(d))
def _run_and_exit_oneshot(prompt, *, model=None, provider=None, toolsets=None, skills=None, usage_file=None, resume=None, reasoning=None):
    tries = _init_home()
    sys.stderr.write('tries=' + json.dumps(tries, sort_keys=True) + '\n')
    if MODE == 'crash':
        (Path(os.environ['HERMES_HOME']) / 'logs' / 'agent.log').write_text('agent: boom while building tools\n')
        raise RuntimeError('boom')
    if 'invalid' in os.environ.get('ANTHROPIC_API_KEY', ''):
        _usage(usage_file, {'completed': False, 'failed': True, 'api_calls': 1, 'session_id': '20261118_140155_ab'})
        sys.stdout.write("Anthropic rejected your API key, so the model can't be reached. Update it in Settings.\n")
        sys.stdout.flush()
        os._exit(2)
    if MODE == 'hang':
        time.sleep(60)
    m_in = re.search(r'read_file to read (\S+) \.', prompt)
    m_out = re.search(r'create (\S+/(t-[0-9]{14}-[0-9a-f]{8})\.json) containing', prompt)
    body = json.loads(Path(m_in.group(1)).read_text())
    summary = 'done: ' + str(body.get('title', ''))
    Path(m_out.group(1)).write_text(json.dumps({'v': 1, 'task_id': m_out.group(2), 'status': 'done', 'summary': summary}, ensure_ascii=False))
    _usage(usage_file, {'model': 'claude-haiku-5-5', 'api_calls': 1, 'input_tokens': 12, 'output_tokens': 7, 'completed': True})
    sys.stdout.write('done\n')
    sys.stdout.flush()
    os._exit(0)
def _run_oneshot_from_args(args):
    sys.stderr.write('Error: Gateway inaccessible: authorization\n')
    sys.exit(1)
def main():
    import argparse
    p = argparse.ArgumentParser(prog='hermes')
    p.add_argument('-z', '--oneshot')
    p.add_argument('-t', '--toolsets')
    p.add_argument('--usage-file')
    p.add_argument('-r', '--resume')
    a = p.parse_args(sys.argv[1:])
    if a.oneshot is not None:
        _run_oneshot_from_args(a)
    return 0
`;

function world() {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-chain-')));
  const U = path.join(R, 'Users');
  const H = path.join(U, 'hermes');
  const root = path.join(H, '.hermes');
  const code = path.join(root, 'hermes-agent');
  const d = (p) => { mkdirSync(p, { recursive: true, mode: 0o700 }); return p; };
  for (const p of [path.join(code, 'hermes_cli'), path.join(root, 'tools/python-3.14.7+20260901-darwin-arm64/bin'), path.join(root, 'installs'), path.join(root, 'plugins'), path.join(root, 'profiles/work/cron'), path.join(H, '.local/bin'), path.join(H, 'work'), path.join(R, 'vf')]) d(p);
  writeFileSync(path.join(code, 'hermes_bootstrap.py'), '');
  writeFileSync(path.join(code, 'hermes_cli/__init__.py'), '');
  writeFileSync(path.join(code, 'hermes_cli/main.py'), FAKE_MAIN);
  writeFileSync(path.join(code, 'fake_mode'), 'ok');
  symlinkSync(PYTHON, path.join(root, 'tools/python-3.14.7+20260901-darwin-arm64/bin/python3'));
  writeFileSync(path.join(root, '.env'), `ANTHROPIC_API_KEY=sk-ant-${'k'.repeat(40)}\n`, { mode: 0o600 });
  writeFileSync(path.join(root, 'state.db'), 'gateway state');
  writeFileSync(path.join(root, 'config.yaml'), '{}');
  writeFileSync(path.join(root, 'profiles/work/SOUL.md'), 'old'); // 前の home（常駐が serve していた）
  const py = path.join(root, 'tools/python-3.14.7+20260901-darwin-arm64/bin/python3');
  writeFileSync(path.join(H, '.local/bin/rc.json'), `${JSON.stringify([py, '-I', '-c', runtimeBootstrap(root)])}\n`);
  writeFileSync(path.join(H, '.local/bin/hermes'), '#!/bin/sh\n[ "$1" = "--print-runtime-command" ] && exec /bin/cat "$(dirname "$0")/rc.json"\necho "Error: Gateway inaccessible: authorization" >&2\nexit 1\n', { mode: 0o755 });
  const shared = d(path.join(U, 'Shared/w'));
  const inbox = d(path.join(shared, 'inbox'));
  const outbox = d(path.join(shared, 'outbox'));
  writeFileSync(path.join(shared, 'brief.json'), '{}');
  const layout = {
    ...productionLayout(),
    user: process.env.USER, home: H, root, workHome: path.join(root, WORK_HOME_NAME), bin: path.join(H, '.local/bin/hermes'),
    usage: path.join(H, 'work/run-usage.json'), probeUsage: path.join(H, 'work/probe-usage.json'),
    usersRoot: U, systemTmp: path.join(R, 'vf'), probeSeconds: 20, runSeconds: 3, keepDenials: false, legacyWaitSeconds: 0, legacyPollSeconds: 1,
    asUser: (sh) => (args, opts) => sh('/usr/sbin/taskpolicy', ['-b', ...args], opts),
    hostCheck: () => null,
    boundary: [],
  };
  return { R, U, H, root, layout, inbox, outbox, shared, mode: (m) => writeFileSync(path.join(root, 'hermes-agent/fake_mode'), m) };
}

async function fromBot(env, intent, params) {
  const e = envelope({ intent, params });
  dropInbox(env.inbox, `r-${Math.random().toString(36).slice(2)}.json`, seal(e));
  const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
  return { id: r.task_id, key: e.idempotency_key };
}
const cycle = (env, config) => runOnce({ store: env.store, policy: { ...env.policy, config }, handlers: env.handlers, now: env.tick(1000) });
const approveNow = (env, id) => approve(env.store, id, { confirm: confirmCodeOf(env.store.readTask(id)), isTTY: true, now: env.clock.t, actor: 'operator' });

test('本番の layout は前と同じ sandbox の path（productionParams と一致・業務の home は profiles/ の外）', () => {
  const L = productionLayout();
  const q = { request: '/Users/Shared/w/inbox/t.json', brief: '/Users/Shared/w/b.json', result: '/Users/Shared/w/outbox/t.json', usage: '/Users/hermes/work/u.json' };
  assert.deepEqual(layoutParams(L, q), productionParams(q));
  assert.equal(L.workHome, '/Users/hermes/.hermes/e-nexus-work');
  assert.equal(L.runSeconds, null, '本番は依頼の時間（120 秒）');
  assert.equal(L.keepDenials, true);
});

test('模擬 E2E（本番の確かめと実行の code・本物の sandbox）：初回の --check-only → 2 回目も同じに通る → 有料の道（偽の Hermes）→ 取り込み → 板 → Bot が読む・時間切れの後のやり直し・常駐が書き足せば止まる', { skip: !isMac || !PYTHON }, async () => {
  const x = world();
  const env = makeEnv();
  const logs = [];
  try {
    const config = { ...env.config, hermes_inbox: x.inbox, hermes_outbox: x.outbox, brief_path: path.join(x.shared, 'brief.json') };
    const sysFor = () => macSys({ store: env.store, log: (m) => logs.push(m), outbox: x.outbox, layout: x.layout });
    const work = x.layout.workHome;

    const { id, key } = await fromBot(env, 'hermes.task', { title: '週報', body: 'notes を要約する' });
    approveNow(env, id);
    await cycle(env, config);
    assert.deepEqual(readdirSync(x.inbox), [`${id}.json`]);

    // 1) 初回の --check-only：業務の home を作り、sandbox の規則・launcher・無効な鍵の起動（401）まで通る。実行も記録もしない
    let r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok', JSON.stringify(r) + readLogs(env));
    assert.equal(env.store.readHermesJob(id), null, '試行に数えない');
    assert.equal(readFileSync(path.join(work, 'SOUL.md'), 'utf8'), `${WORK_SOUL_MD}\n`);
    for (const dname of WORK_LOCKED_DIRS) assert.deepEqual(readdirSync(path.join(work, dname)), [], `${dname} は空のまま`);
    assert.ok(readdirSync(path.join(work, 'sessions')).length >= 1, 'Hermes の形の偽物が sandbox の中で業務の home に書けた（sessions）');
    const probeLog = readFileSync(env.store.path(`hermes-work-logs/${id}-probe.txt`), 'utf8');
    assert.match(probeLog, /rejected your API key/);
    const tries = JSON.parse(probeLog.match(/tries=(\{.*\})/)[1]);
    assert.deepEqual(tries, { 'SOUL.md': 'denied', 'config.yaml': 'denied', 'cron/jobs.json': 'denied', 'cwd/AGENTS.md': 'denied', 'hooks/planted.py': 'denied', 'memories/MEMORY.md': 'denied', 'root .env': 'denied', 'skills/x/SKILL.md': 'denied' });
    assert.ok(!existsSync(x.layout.probeUsage), 'probe の usage は片付ける');
    assert.ok(logs.some((l) => /前の業務の home.*gateway\.parked を置いた/.test(l)), '前の home は parked にする（常駐の記録が無いので移すのは次）');
    assert.equal(readFileSync(path.join(x.root, 'profiles/work/gateway.parked'), 'utf8'), '');
    // 確かめの結果と途中の知らせは毎回 file に残る（Human に表示を聞き直さない）
    const trace = readTrace(env, id);
    assert.deepEqual(trace.result, { ok: true });
    assert.ok(trace.notes.some((n) => /^legacy_isolation: \{"state":"parked","reason":"state_unreadable"\}$/.test(n)), JSON.stringify(trace.notes));
    assert.equal(readFileSync(path.join(x.root, 'profiles/work/SOUL.md'), 'utf8'), 'old', '前の home の中身は変えない');

    // 2) 2 回目の --check-only：前の回の物（sessions・state.db・logs）が在っても同じに通る＝確かめ自身が作った物を次に拒まない
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok', JSON.stringify(r));

    // 2b) 常駐が再走査で前の home を serve から外した（記録は印より新しく work を含まない）→ 次の確かめで e-nexus-legacy へ移す（中身はそのまま）
    const st = path.join(x.root, 'gateway_state.json');
    writeFileSync(st, JSON.stringify({ served_profiles: ['default'] }));
    const later = Date.now() / 1000 + 5;
    utimesSync(st, later, later);
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok');
    assert.equal(existsSync(path.join(x.root, 'profiles/work')), false);
    const [moved] = readdirSync(path.join(x.root, 'e-nexus-legacy'));
    assert.match(moved, /^profiles-work-/);
    assert.equal(readFileSync(path.join(x.root, 'e-nexus-legacy', moved, 'SOUL.md'), 'utf8'), 'old', '消さずに移した');
    assert.ok(readdirSync(path.join(x.root, 'e-nexus-legacy', moved, 'cron')), '中のフォルダもそのまま');

    // 2c) 常駐が root の config.yaml に multiplex_profiles: true を書いていれば、読むだけで知らせる（変えない）
    writeFileSync(path.join(x.root, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n');
    logs.length = 0;
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok');
    assert.ok(logs.some((l) => /multiplex_profiles: true が在る/.test(l)));
    assert.equal(readFileSync(path.join(x.root, 'config.yaml'), 'utf8'), 'gateway:\n  multiplex_profiles: true\n', '常駐の設定は変えない');

    // 3) 時間切れ（偽の Hermes が止まらない）→ 自動ではやり直さない → --retry で done
    x.mode('hang');
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), paidOk: true, waitRunLock: noWait });
    assert.equal(r.code, 'timeout', JSON.stringify(r));
    assert.deepEqual([env.store.readHermesJob(id).state, env.store.readHermesJob(id).attempts], ['timeout', 1]);
    assert.equal(spawnSync('/usr/bin/pgrep', ['-f', `${id}`]).status, 1, '時間切れの後に Hermes の process が残らない');
    assert.equal((await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), paidOk: true, waitRunLock: noWait })).code, 'nothing', '時間切れは自動でやり直さない');
    x.mode('ok');
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), paidOk: true, taskId: id, retry: true, waitRunLock: noWait });
    assert.equal(r.code, 'done', JSON.stringify(r) + readLogs(env));
    const job = env.store.readHermesJob(id);
    assert.deepEqual([job.state, job.attempts], ['done', 2]);
    assert.deepEqual(job.usage, { model: 'claude-haiku-5-5', api_calls: 1, input_tokens: 12, output_tokens: 7 });
    assert.equal(env.store.readRecords('biz-a', 'notes').get(`hermes:${id}`)?.text, 'done: 週報');
    for (const dname of WORK_LOCKED_DIRS) assert.deepEqual(readdirSync(path.join(work, dname)), [], `実行の後も ${dname} は空`);

    // 4) Bot（Grok の代わり）が task.status で結果を読む
    const q = await fromBot(env, 'task.status', { task_ref: key });
    await cycle(env, config);
    assert.equal(env.store.readTask(q.id).result.hermes.summary, 'done: 週報');

    // 5) 業務の home に sandbox の外から物が置かれた（前の home で常駐がしたこと）→ 次の確かめは課金の前で止まる・片付ければ通る
    const second = await fromBot(env, 'hermes.task', { title: '二件目', body: 'x' });
    approveNow(env, second.id);
    await cycle(env, config);
    writeFileSync(path.join(work, 'cron/jobs.json'), '{}');
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'preflight_work_home_has_cron');
    rmSync(path.join(work, 'cron/jobs.json'));
    mkdirSync(path.join(work, 'plugins'));
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'preflight_work_home_has_plugins');
    rmSync(path.join(work, 'plugins'), { recursive: true });
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok');

    // 5b) root の active_profile が default でなければ止める（custom の home では Hermes が読んで profile を切り替え得る）
    writeFileSync(path.join(x.root, 'active_profile'), 'work\n');
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'preflight_hermes_active_profile_set');
    writeFileSync(path.join(x.root, 'active_profile'), 'default\n');
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok');

    // 5c) 起動の途中で Hermes が落ちた → probe_hermes_crashed・業務の home の一覧と Hermes の log の末尾を残す・前の回の probe の記録は消えている
    writeFileSync(env.store.path(`hermes-work-logs/${second.id}-probe-denials.txt`), 'stale');
    x.mode('crash');
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'preflight_probe_hermes_crashed', JSON.stringify(r));
    const diag = readFileSync(env.store.path(`hermes-work-logs/${second.id}-probe-diag.txt`), 'utf8');
    assert.match(diag, /^at=/);
    assert.match(diag, /== tail logs\/agent\.log\nagent: boom while building tools/);
    assert.match(diag, /== sessions/);
    assert.equal(existsSync(env.store.path(`hermes-work-logs/${second.id}-probe-denials.txt`)), false, '前の回の記録は確かめの初めに消す（今回は拒否の行を読まない layout）');
    x.mode('ok');
    for (const dname of WORK_LOCKED_DIRS) assert.deepEqual(readdirSync(path.join(work, dname)), [], `落ちた後も ${dname} は空`);
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'check_ok', '落ちた後の再実行も同じに通る');

    // 6) Hermes が gateway へ渡す形に戻った（差し替えが効かない launcher）→ 鍵の 401 と読まずに止まる
    writeFileSync(path.join(x.H, '.local/bin/rc.json'), `${JSON.stringify([path.join(x.root, 'tools/python-3.14.7+20260901-darwin-arm64/bin/python3'), '-I', '-c', `${runtimeBootstrap(x.root)}; x`])}\n`);
    r = await runWork({ store: env.store, config, sys: sysFor(), now: () => env.tick(10), checkOnly: true, waitRunLock: noWait });
    assert.equal(r.code, 'preflight_hermes_launcher_unexpected');
    assert.equal(readTrace(env, second.id).result.code, 'hermes_launcher_unexpected', '止まった段も file に残る');
    assert.equal(env.store.verifyAudit().ok, true);
  } finally {
    rmSync(x.R, { recursive: true, force: true });
    rmSync(env.root, { recursive: true, force: true });
  }
});

function readLogs(env) {
  try { const dir = env.store.path('hermes-work-logs'); return readdirSync(dir).map((n) => `\n== ${n}\n${readFileSync(path.join(dir, n), 'utf8')}`).join(''); } catch { return ''; }
}

/** 確かめの記録（1 行目は at=<時刻>・残りは JSON） */
function readTrace(env, taskId) {
  const t = readFileSync(env.store.path(`hermes-work-logs/${taskId}-preflight.txt`), 'utf8');
  assert.match(t, /^at=\d{4}-\d\d-\d\dT/);
  return JSON.parse(t.split('\n').slice(1).join('\n'));
}
