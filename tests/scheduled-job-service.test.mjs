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
  assert.ok(validateJobArgs({ ...MAC, target: 'systemd' }).some((e) => e.includes('--environment')), 'systemd needs --environment / --user');
  assert.ok(validateJobArgs({ ...MAC, dir: 'relative/dir' }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, dir: '/x; rm -rf /' }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, hour: 24 }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, minute: -1 }).length > 0);
  assert.ok(validateJobArgs({ ...MAC, node: undefined }).some((e) => e.includes('--node')));
  assert.deepEqual(validateJobArgs({ ...MAC, node: undefined, path: '/opt/homebrew/bin:/usr/bin:/bin' }), []);
  assert.ok(validateJobArgs({ ...MAC, environment: 'prod' }).length > 0);
});

test('usage-digest（systemd・2026-09-30 VPS staging）：oneshot の .service と毎日・Persistent の .timer・専用ユーザー・環境名入りの unit・report なら --fail-on-anomaly を付けない', () => {
  const a = { job: 'usage-digest', target: 'systemd', dir: '/opt/e-nexus-staging/e-nexus-decision-layer', node: '/usr/bin/node', environment: 'staging', user: 'edl-staging', onAnomaly: 'report', hour: 6, minute: 5 };
  assert.deepEqual(validateJobArgs(a), []);
  const r = renderJob(a);
  assert.deepEqual(r.files.map((f) => f.filename), ['e-nexus-usage-digest-staging.service', 'e-nexus-usage-digest-staging.timer']);
  const [service, timer] = r.files.map((f) => f.content);
  assert.match(service, /Type=oneshot/);
  assert.match(service, /User=edl-staging/);
  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/usage-digest\.mjs --hours 24 --environment staging/);
  assert.ok(!/--fail-on-anomaly/.test(service), 'report mode: anomalies are printed, the unit does not fail every day while Jev is off');
  assert.match(service, /ProtectSystem=strict/);
  assert.match(timer, /OnCalendar=\*-\*-\* 06:05:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=e-nexus-usage-digest-staging\.service/);
  assert.match(renderJob({ ...a, onAnomaly: undefined }).files[0].content, /--fail-on-anomaly/, 'default stays fail');
  assert.ok(!/TOKEN=|KEY=|Bearer/.test(service + timer));
  assert.ok(validateJobArgs({ ...a, user: undefined }).some((e) => e.includes('--user')), 'never as root by default');
  assert.ok(validateJobArgs({ ...a, node: undefined }).some((e) => e.includes('--node')));
  assert.ok(validateJobArgs({ ...a, webhook: 'credential:E-NEXUS/edl/digest-webhook' }).some((e) => e.includes('--webhook')), 'no credential store on Linux');
  assert.ok(validateJobArgs({ ...a, onAnomaly: 'ignore' }).some((e) => e.includes('--on-anomaly')));
});

test('watcher-cycle（MA-33-6・2026-10-02）：3 target で同じ scripts/watcher-cycle.mjs --watcher-dir・systemd は ReadWritePaths に Watcher の置き場・webhook 不可・--watcher-dir 必須', () => {
  const mac = { job: 'watcher-cycle', target: 'launchd', dir: MAC.dir, node: MAC.node, watcherDir: '/Users/x/e-nexus/e-nexus-knowledge-layer', hour: 6, minute: 15 };
  assert.deepEqual(validateJobArgs(mac), []);
  const r = renderJob(mac);
  assert.equal(r.filename, 'com.e-nexus.watcher-cycle.plist');
  assert.match(r.content, /<string>scripts\/watcher-cycle\.mjs<\/string>\s*<string>--watcher-dir<\/string>\s*<string>\/Users\/x\/e-nexus\/e-nexus-knowledge-layer<\/string>/);
  assert.ok(!/credential:|token=|api[_-]?key|EDL_GATEWAY_TOKEN|JEV_API_KEY/i.test(r.content), 'Secret・資格情報の名前も値も定義に無い');
  const win = renderJob({ job: 'watcher-cycle', target: 'windows', dir: 'C:\\edl', watcherDir: 'C:\\kl', hour: 6, minute: 15 });
  assert.match(win.content, /node\.exe/);
  assert.match(win.content, /scripts\/watcher-cycle\.mjs --watcher-dir C:\\kl/);
  const sys = renderJob({ job: 'watcher-cycle', target: 'systemd', dir: '/opt/e-nexus-staging/e-nexus-decision-layer', node: '/usr/bin/node', environment: 'staging', user: 'edl-staging', watcherDir: '/opt/e-nexus-staging/e-nexus-knowledge-layer', hour: 6, minute: 15 });
  const service = sys.files[0].content;
  assert.match(service, /ExecStart=\/usr\/bin\/node scripts\/watcher-cycle\.mjs --watcher-dir \/opt\/e-nexus-staging\/e-nexus-knowledge-layer/);
  assert.match(service, /ReadWritePaths=\/opt\/e-nexus-staging\/e-nexus-knowledge-layer/);
  assert.match(service, /ProtectSystem=strict/);
  assert.ok(validateJobArgs({ ...mac, watcherDir: undefined }).some((e) => /--watcher-dir/.test(e)));
  assert.ok(validateJobArgs({ ...mac, watcherDir: 'relative' }).some((e) => /absolute/.test(e)));
  assert.ok(validateJobArgs({ ...mac, watcherDir: '/x; rm -rf /' }).some((e) => /not allowed/.test(e)));
  assert.ok(validateJobArgs({ ...mac, webhook: 'credential:E-NEXUS/edl/x' }).some((e) => /webhook/.test(e)));
  assert.ok(validateJobArgs({ ...mac, node: undefined }).some((e) => /launchd needs --node/.test(e)));
});
