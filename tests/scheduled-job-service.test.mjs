/**
 * 定期実行の定義の生成（2026-09-29・Human Last-Mile Activation）。生成だけ・登録しない・Secret を書かない・実機依存の値は引数だけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJobArgs, renderJob } from '../scripts/scheduled-job-service.mjs';

const MAC = { job: 'usage-digest', target: 'launchd', dir: '/Users/x/e-nexus/e-nexus-decision-layer', node: '/opt/homebrew/bin/node', hour: 7, minute: 30 };

test('usage-digest（launchd）：毎日の StartCalendarInterval・READ-ONLY の digest・webhook は資格情報ストアの名前だけ・Secret なし', () => {
  const a = { ...MAC, environment: 'production', webhook: 'credential:E-NEXUS/edl/digest-webhook' };
  assert.deepEqual(validateJobArgs(a), []);
  const r = renderJob(a);
  assert.equal(r.filename, 'com.e-nexus.usage-digest.plist');
  assert.match(r.content, /<string>scripts\/usage-digest\.mjs<\/string>/);
  assert.match(r.content, /<string>--fail-on-anomaly<\/string>/);
  assert.match(r.content, /<key>Hour<\/key><integer>7<\/integer><key>Minute<\/key><integer>30<\/integer>/);
  assert.match(r.content, /<string>credential:E-NEXUS\/edl\/digest-webhook<\/string>/);
  assert.ok(!/<key>PATH<\/key>/.test(r.content), 'no guessed PATH');
  assert.ok(!/https?:\/\/(?!www\.apple\.com)/.test(r.content), 'no URL in the definition');
  assert.ok(!/TOKEN=|KEY=|Bearer/.test(r.content));
  assert.ok(r.install.every((l) => !/sudo/.test(l)), 'user LaunchAgent (no sudo)');
});

test('usage-digest（windows）：Task Scheduler の毎日 trigger・10 分で打ち切り', () => {
  const a = { job: 'usage-digest', target: 'windows', dir: 'C:\\edl', node: 'C:\\Program Files\\nodejs\\node.exe', hour: 6, minute: 5 };
  assert.deepEqual(validateJobArgs(a), []);
  const r = renderJob(a);
  assert.match(r.content, /New-ScheduledTaskTrigger -Daily -At '06:05'/);
  assert.match(r.content, /-Execute 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(r.content, /ExecutionTimeLimit \(New-TimeSpan -Minutes 10\)/);
});

test('rotate-logs：Mac mini（launchd）だけ・--base 必須・sh で rotate-logs.sh を呼ぶ', () => {
  const a = { job: 'rotate-logs', target: 'launchd', dir: MAC.dir, base: '/Users/x/e-nexus', hour: 3, minute: 0 };
  assert.deepEqual(validateJobArgs(a), []);
  const r = renderJob(a);
  assert.match(r.content, /<string>\/bin\/sh<\/string>\s*<string>deploy\/macos\/rotate-logs\.sh<\/string>\s*<string>--base<\/string>\s*<string>\/Users\/x\/e-nexus<\/string>/);
  assert.ok(validateJobArgs({ ...a, target: 'windows' }).length > 0);
  assert.ok(validateJobArgs({ ...a, base: undefined }).length > 0);
});

test('拒否：URL の webhook・一覧外の job／target・相対パス・危険な文字・時刻の範囲外・launchd で node の場所が無い', () => {
  assert.ok(validateJobArgs({ ...MAC, webhook: 'https://hooks.example/abc' }).some((e) => e.includes('--webhook')));
  assert.ok(validateJobArgs({ ...MAC, job: 'send-line' }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, target: 'systemd' }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, dir: 'relative/dir' }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, dir: '/x; rm -rf /' }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, hour: 24 }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, minute: -1 }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, node: undefined }).some((e) => e.includes('--node')));
  assert.deepEqual(validateJobArgs({ ...MAC, node: undefined, path: '/opt/homebrew/bin:/usr/bin:/bin' }), []);
  assert.ok(validateJobArgs({ ...MAC, environment: 'prod' }).length > 0);
});
