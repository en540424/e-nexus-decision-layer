/**
 * 本番接続の部品の試験（2026-11-11・MA-24）：Hermes の結果を依頼元の板へ返す・Task Hub の回・回の見張り・VPS の鍵の受け渡し・保守の script の形。
 * 合成の id だけ。通信なし・Keychain なし・sudo なし。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve } from '../scripts/lib/task-hub/approval.mjs';
import { ingestInbox, submitLocal } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { collectHermesResults } from '../scripts/lib/task-hub/hermes-results.mjs';
import { taskHubCycleItem } from '../scripts/lib/task-hub/audit-watch.mjs';
import { CYCLE_LAST_FILE, cycle, step } from '../scripts/task-hub-cycle.mjs';
import { safeValue } from '../scripts/host-health.mjs';
import { ruleOf } from '../scripts/lib/alert-policy.mjs';
import { NOW, dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanup = (env) => rmSync(env.root, { recursive: true, force: true });
const outbox = (env) => env.store.listOutbox().map((o) => ({ ...o, body: JSON.parse(o.body) }));

test('Hermes の結果：依頼元が bot なら結果の板へ新しい updated_at で返す（summary 入り）。人の依頼・やり直しでは増やさない', async () => {
  const env = makeEnv();
  const inbox = path.join(env.root, 'h-in');
  const out = path.join(env.root, 'h-out');
  mkdirSync(inbox, { mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  const e = envelope({ intent: 'hermes.task', params: { title: '要約', body: 'brief を要約する' } });
  dropInbox(env.inbox, 'a.json', seal(e));
  const [r] = await ingestInbox(env.inbox, { keyFor, now: NOW, store: env.store, policy: env.policy });
  assert.equal(r.state, 'awaiting_approval');
  const t = env.store.readTask(r.task_id);
  approve(env.store, t.task_id, { confirm: t.content_digest.slice(0, 12), isTTY: true, now: NOW });
  const policy = { ...env.policy, config: { ...env.config, hermes_inbox: inbox } };
  await runOnce({ store: env.store, policy, handlers: env.handlers, now: NOW + 1000 });
  const delivered = outbox(env).find((o) => o.task_ref === e.idempotency_key && o.state === 'succeeded');
  assert.deepEqual(delivered.body.result, { delivered: true, hermes: { status: 'waiting' } }, '渡した直後は waiting（実行・結果は hermes-jobs の知らせで続く・2026-11-13）');
  for (const o of env.store.listOutbox()) env.store.markDelivered(o.file);
  writeFileSync(path.join(out, `${t.task_id}.json`), JSON.stringify({ v: 1, task_id: t.task_id, status: 'done', summary: '全体は ok・要確認 0 件' }));
  const c = collectHermesResults({ store: env.store, config: { hermes_outbox: out }, now: NOW + 5000 });
  assert.equal(c.recorded, 1);
  const [n] = outbox(env);
  assert.deepEqual([n.task_ref, n.source, n.state, n.body.result.hermes], [e.idempotency_key, 'bot-front', 'succeeded', { status: 'done', summary: '全体は ok・要確認 0 件' }]);
  assert.ok(n.updated_at > delivered.updated_at, '板では新しい方が勝つ');
  // やり直し（印があるので読まない）でも増えない
  collectHermesResults({ store: env.store, config: { hermes_outbox: out }, now: NOW + 6000 });
  assert.equal(env.store.listOutbox().length, 1);
  // 人の依頼（human-cli）は板へ返さない
  const h = await submitLocal(envelope({ intent: 'hermes.task', params: { title: 'x', body: 'y' } }), { store: env.store, policy: env.policy, now: NOW });
  const ht = env.store.readTask(h.task_id);
  approve(env.store, ht.task_id, { confirm: ht.content_digest.slice(0, 12), isTTY: true, now: NOW });
  await runOnce({ store: env.store, policy, handlers: env.handlers, now: NOW + 7000 });
  writeFileSync(path.join(out, `${ht.task_id}.json`), JSON.stringify({ v: 1, task_id: ht.task_id, status: 'done', summary: 'ok' }));
  collectHermesResults({ store: env.store, config: { hermes_outbox: out }, now: NOW + 8000 });
  assert.equal(env.store.listOutbox().length, 1);
  assert.equal(env.store.verifyAudit().ok, true);
  cleanup(env);
});

test('Task Hub の回：config.json が無ければ何もしない。段の結果を集め、pull が not_configured なら push しない。最後の結果を 0600 で残す', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cycle-'));
  assert.deepEqual(cycle({ store: root }), { code: 'not_configured', exit: 0, steps: [] });
  assert.equal(existsSync(path.join(root, CYCLE_LAST_FILE)), false);
  writeFileSync(path.join(root, 'config.json'), '{}', { mode: 0o600 });
  const calls = [];
  const fake = (code, status = 0) => (node, args) => { calls.push(args.slice(0, 2).map((a) => path.basename(a)).join(' ')); return { status, stdout: `${JSON.stringify({ code })}\n` }; };
  let r = cycle({ store: root, run: fake('not_configured') });
  assert.deepEqual(r.steps.map((s) => s.step), ['pull', 'intake', 'run', 'collect_hermes']);
  assert.equal(r.exit, 0);
  assert.ok(calls.every((c) => !c.includes('push')));
  const last = JSON.parse(readFileSync(path.join(root, CYCLE_LAST_FILE), 'utf8'));
  assert.deepEqual([r.code, last.code, last.failed], ['not_configured', 'not_configured', []], 'Keychain に鍵が無い休眠は ok と区別する');
  assert.equal(statSync(path.join(root, CYCLE_LAST_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(root, 'inbox', 'vps-intake')).mode & 0o077, 0);
  r = cycle({ store: root, run: (node, args) => (args[1] === 'run' ? { status: 1, stdout: '' } : { status: 0, stdout: '{"code":"pulled","pulled":2}\n' }) });
  assert.deepEqual(r.steps.map((s) => s.step), ['pull', 'intake', 'run', 'collect_hermes', 'business', 'push'], '業務の段（2026-11-13）は休眠・時刻前でない時だけ残る');
  assert.deepEqual([r.code, r.exit, r.steps[0].pulled], ['problem', 1, 2]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, CYCLE_LAST_FILE), 'utf8')).failed, ['run']);
  const dormant = cycle({ store: root, run: (node, args) => ({ status: 0, stdout: `${JSON.stringify({ code: path.basename(args[0]) === 'business-cycle.mjs' ? 'not_due' : 'pulled' })}\n` }) });
  assert.deepEqual(dormant.steps.map((s) => s.step), ['pull', 'intake', 'run', 'collect_hermes', 'push'], '週の時刻前の業務の段は残さない');
  // PAUSE の間は run を呼ばない（失敗に数えない）
  writeFileSync(path.join(root, 'PAUSE'), '');
  calls.length = 0;
  r = cycle({ store: root, run: fake('pulled') });
  assert.deepEqual([r.code, r.exit, r.steps.map((x) => x.step).includes('run')], ['paused', 0, false]);
  // runner の回路遮断は Human の PAUSE と分けて知らせる
  writeFileSync(path.join(root, 'PAUSE'), 'circuit_open\n');
  assert.equal(cycle({ store: root, run: fake('pulled') }).code, 'paused_breaker');
  rmSync(path.join(root, 'PAUSE'));
  // Hermes の 1 件実行の間（印がある間）は collect-hermes を呼ばない。10 分より古い印は無視
  writeFileSync(path.join(root, 'hermes-run.active'), '');
  assert.equal(cycle({ store: root, run: fake('pulled') }).steps.some((x) => x.step === 'collect_hermes'), false);
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(path.join(root, 'hermes-run.active'), old, old);
  assert.equal(cycle({ store: root, run: fake('pulled') }).steps.some((x) => x.step === 'collect_hermes'), true);
  rmSync(path.join(root, 'hermes-run.active'));
  // run の段だけ長い時間切れ・既定の件数は 5
  const seen = [];
  cycle({ store: root, run: (node, args, o) => { seen.push([args[1], o.timeout, args[2] === '--max' ? args[3] : null]); return { status: 0, stdout: '{"code":"pulled"}\n' }; } });
  assert.deepEqual(seen.find((x) => x[0] === 'run'), ['run', 120_000, '5']);
  assert.equal(seen.find((x) => x[0] === 'intake')[1], 45_000);
  // 時間切れ・起動の失敗はコードだけ
  assert.deepEqual(step('pull', 'x.mjs', [], { run: () => ({ error: { code: 'ETIMEDOUT' } }) }), { step: 'pull', exit: 1, code: 'timeout' });
  rmSync(root, { recursive: true, force: true });
});

test('回の見張り：無い→項目なし・ok・problem <段>・古い（定期の job がある時だけ stale）。値は host-health の形に合い、通知の規則がある', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cyclew-'));
  const at = Date.parse('2026-11-11T08:00:00Z');
  assert.equal(taskHubCycleItem(root, at), null);
  const put = (o) => writeFileSync(path.join(root, CYCLE_LAST_FILE), JSON.stringify(o));
  put({ at: '2026-11-11T07:58:00Z', code: 'ok', failed: [] });
  assert.deepEqual(taskHubCycleItem(root, at), { id: 'task_hub_cycle', level: 'ok', value: 'ok', kind: 'state' });
  put({ at: '2026-11-11T07:58:00Z', code: 'problem', failed: ['pull', 'push', '../x'] });
  assert.equal(taskHubCycleItem(root, at).value, 'problem pull,push');
  put({ at: '2026-11-11T07:00:00Z', code: 'ok', failed: [] });
  assert.equal(taskHubCycleItem(root, at), null, '手で回すだけの間は古くても知らせない');
  assert.equal(taskHubCycleItem(root, at, { scheduled: true }).value, 'stale');
  put({ at: '2026-11-11T08:30:00Z', code: 'ok', failed: [] });
  assert.equal(taskHubCycleItem(root, at, { scheduled: true }).value, 'stale', '未来の時刻も古いと同じ扱い');
  put({ at: '2026-11-11T07:58:00Z', code: 'paused', failed: [] });
  assert.deepEqual(taskHubCycleItem(root, at, { scheduled: true }), { id: 'task_hub_cycle', level: 'ok', value: 'paused', kind: 'state' });
  put({ at: '2026-11-11T07:58:00Z', code: 'paused_breaker', failed: [] });
  assert.deepEqual([taskHubCycleItem(root, at).level, taskHubCycleItem(root, at).value], ['warn', 'paused_breaker']);
  put({ at: '2026-11-11T07:58:00Z', code: 'not_configured', failed: [] });
  assert.equal(taskHubCycleItem(root, at), null);
  assert.deepEqual([taskHubCycleItem(root, at, { scheduled: true }).level, taskHubCycleItem(root, at, { scheduled: true }).value], ['warn', 'not_configured']);
  writeFileSync(path.join(root, CYCLE_LAST_FILE), '{broken');
  assert.equal(taskHubCycleItem(root, at), null);
  for (const v of ['ok', 'paused', 'paused_breaker', 'not_configured', 'stale', 'problem', 'problem pull,push']) assert.equal(safeValue('task_hub_cycle', v), v);
  assert.equal(safeValue('task_hub_cycle', 'problem /Users/x'), '[redacted]');
  assert.ok(ruleOf('task_hub_cycle'));
  assert.equal(taskHubCycleItem('relative/path', at), null);
  rmSync(root, { recursive: true, force: true });
});

test('VPS の鍵の受け渡し：TASK_INTAKE_KEY_OUT があれば bot の鍵は画面に出さず 0600 の新しい file へ（既にある file は上書きしない）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'keyout-'));
  const sources = path.join(root, 'sources.json');
  writeFileSync(sources, '{}\n');
  const out = path.join(root, 'bot.key');
  const run = (id) => spawnSync(process.execPath, [path.join(REPO, 'deploy/vps-task-intake/intake.mjs'), '--add-source', id, 'status.query,note.record'], { env: { PATH: process.env.PATH, TASK_INTAKE_SOURCES: sources, TASK_INTAKE_KEY_OUT: out }, encoding: 'utf8', timeout: 20_000 });
  const r = run('grok-commander');
  assert.equal(r.status, 0, r.stderr);
  const key = readFileSync(out, 'utf8').trim();
  assert.match(key, /^etk_[0-9a-f]{64}$/);
  assert.ok(!r.stdout.includes(key) && !r.stdout.includes('etk_'), '鍵は画面に出ない');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(sources, 'utf8'))['grok-commander'].intents, ['status.query', 'note.record']);
  const r2 = run('second-bot');
  assert.notEqual(r2.status, 0, '既にある受け渡しの file は上書きしない');
  assert.equal(readFileSync(out, 'utf8').trim(), key);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(sources, 'utf8'))), ['grok-commander'], '鍵を渡せない source は登録しない');
  // 登録できない（同じ id）時は作った受け渡しの file を消す
  rmSync(out);
  assert.notEqual(run('grok-commander').status, 0);
  assert.equal(existsSync(out), false);
  rmSync(root, { recursive: true, force: true });
});

test('保守の script の形：構文・vps-apply が再起動するのは e-nexus-heartbeat だけ（受け口は install.sh）・鍵を画面や引数に出さない・Hermes の 1 件実行は --paid-ok が無ければ課金の前で止まる', () => {
  for (const f of ['deploy/vps-task-intake/vps-apply.sh', 'deploy/vps-task-intake/connect-from-mac.sh', 'deploy/macos/connect-task-hub.sh', 'deploy/vps-task-intake/install.sh']) {
    assert.equal(spawnSync('/bin/bash', ['-n', path.join(REPO, f)], { timeout: 10_000 }).status, 0, f);
  }
  assert.equal(spawnSync('/bin/sh', ['-n', path.join(REPO, 'deploy/macos/hermes-work-run.sh')], { timeout: 10_000 }).status, 0);
  const apply = readFileSync(path.join(REPO, 'deploy/vps-task-intake/vps-apply.sh'), 'utf8');
  const restarts = [...apply.matchAll(/systemctl\s+(restart|stop|start|reload|disable|enable)\s+(\S+)/g)].map((m) => m[2]);
  assert.ok(restarts.length > 0 && restarts.every((u) => u === '"$HB_UNIT"'), restarts.join(','));
  assert.doesNotMatch(apply, /\b(reboot|apt(-get)?\s|ufw|iptables|cloudflared\s+(service|tunnel))\b/);
  // 受け口が入った後は受け渡しの file を消さない（前の回の鍵を Mac が取る前に消さない）・古い受け口の版では bot の鍵を作らない・--intents は必須
  assert.match(apply, /\[ -f \/etc\/e-nexus\/task-intake\.env \] \|\| rm -f "\$ch_out"/);
  assert.match(apply, /cmp -s "\$SRC\/deploy\/vps-task-intake\/intake\.mjs" \/opt\/e-nexus-task-intake/);
  assert.doesNotMatch(apply, /grep -q/, 'pipefail の下で grep -q は SIGPIPE で偽の失敗になる');
  const mac = readFileSync(path.join(REPO, 'deploy/vps-task-intake/connect-from-mac.sh'), 'utf8');
  for (const t of [apply, mac]) assert.match(t, /--source には --intents が要ります/);
  assert.match(mac, /store [^\n]*&& drop /, 'VPS の file は Keychain に入ったのを確かめた後だけ消す');
  assert.doesNotMatch(mac, /echo[^\n]*\$(ch|bk|v)\b/, '鍵の変数を echo しない');
  assert.match(mac, /security -i/, '鍵は security -i の標準入力で');
  assert.doesNotMatch(mac, /add-generic-password[^\n|]*-w\s+"\$/, '鍵を引数に置かない');
  const hw = readFileSync(path.join(REPO, 'deploy/macos/hermes-work-run.sh'), 'utf8');
  // 2026-11-13：中身は scripts/hermes-work.mjs（流れと記録は tests/hermes-work.test.mjs・sandbox は tests/hermes-sandbox.test.mjs）
  assert.match(hw, /exec "\$NODE" "\$REPO\/scripts\/hermes-work\.mjs" run "\$@"/);
  const hwm = readFileSync(path.join(REPO, 'scripts/hermes-work.mjs'), 'utf8');
  assert.match(hwm, /HERMES_WRITE_SAFE_ROOT=\$\{ctx\.outbox\}/);
  assert.match(hwm, /'-t', 'file'/);
  assert.match(hwm, /'\/usr\/bin\/sandbox-exec', \.\.\.sandboxArgs\(/, 'Hermes は sandbox の中で動く');
  assert.match(hwm, /HERMES_HOME=\$\{WORK_HOME\}/, '業務は profile の home（.env を置かない）');
  assert.match(hwm, /HERMES_DISABLE_LAZY_INSTALLS=1/, '実行の中で依存を同期しない（download しない）');
  assert.match(hwm, /KEY_PROBE=invalid/, '課金なしの起動の確かめ');
  const plist = spawnSync('/bin/bash', [path.join(REPO, 'deploy/macos/connect-task-hub.sh')], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(plist.status, 0);
  assert.match(plist.stdout, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(plist.stdout, /<string>Background<\/string>/);
  assert.doesNotMatch(plist.stdout, /KeepAlive|RunAtLoad<\/key>\s*<true/);
});
