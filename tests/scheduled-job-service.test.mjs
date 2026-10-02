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

// knowledge-refresh（2026-10-03）：Knowledge Layer の実測（executor の local availability 等・ttl 1 日）の鮮度を保つ定期 refresh。
// 新しい scheduler を作らず、この生成器に job を 1 つ足す（Vault MA-32 構想正本 §12）。登録は Human 1 操作のまま
test('knowledge-refresh：3 target とも refresh-state だけ・既定 6 時間ごと・止まっていた分は起動後に 1 回・Secret／URL なし', () => {
  const win = { job: 'knowledge-refresh', target: 'windows', dir: 'C:\\Users\\x\\e-nexus-knowledge-layer', node: 'C:\\Program Files\\nodejs\\node.exe', hour: 7, minute: 30 };
  assert.deepEqual(validateJobArgs(win), []);
  const w = renderJob(win);
  assert.equal(w.filename, 'register-knowledge-refresh.ps1');
  assert.match(w.content, /-Argument "sync\/cli\.mjs refresh-state" -WorkingDirectory 'C:\\Users\\x\\e-nexus-knowledge-layer'/);
  assert.match(w.content, /New-ScheduledTaskTrigger -Once -At '01:30' -RepetitionInterval \(New-TimeSpan -Hours 6\)/, '7:30 起点の 6 時間ごと＝01:30 から');
  assert.match(w.content, /-StartWhenAvailable/, 'PC が止まっていた間の分は起動後に 1 回');
  assert.ok(!/-RepetitionDuration/.test(w.content), '期間なし＝無期限');

  const sd = { job: 'knowledge-refresh', target: 'systemd', dir: '/home/en/e-nexus-knowledge-layer', environment: 'staging', user: 'en', node: '/usr/bin/node', path: '/home/en/.npm-global/bin:/usr/bin:/bin', hour: 7, minute: 30 };
  assert.deepEqual(validateJobArgs(sd), []);
  const s = renderJob(sd);
  const [service, timer] = s.files.map((f) => f.content);
  assert.match(service, /ExecStart=\/usr\/bin\/node sync\/cli\.mjs refresh-state/);
  assert.match(service, /ProtectHome=read-only/, 'Vault・repo は読むだけ');
  assert.match(service, /ReadWritePaths=\/home\/en\/e-nexus-knowledge-layer\/data\/state/, '書けるのは実測（gitignore）だけ');
  assert.ok(!/ReadWritePaths=\/home\/en\/e-nexus-knowledge-layer\n/.test(service), 'repo 全体（canonical）は書けない');
  assert.match(service, /Environment=PATH=\/home\/en\/\.npm-global\/bin:\/usr\/bin:\/bin/);
  assert.match(timer, /OnCalendar=\*-\*-\* 01\/6:30:00/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Description=Every 6h E-NEXUS knowledge-refresh/);
  assert.equal(s.install[0], 'mkdir -p /home/en/e-nexus-knowledge-layer/data/state', 'ReadWritePaths の data/state は clone 直後に無い（gitignore）。無いと unit が起動しない');
  assert.ok(!/sudo/.test(s.install[0]), '実行ユーザーで作る（root 所有にしない）');

  const mac = { job: 'knowledge-refresh', target: 'launchd', dir: '/Users/x/e-nexus-knowledge-layer', node: '/opt/homebrew/bin/node', path: '/opt/homebrew/bin:/usr/bin:/bin', everyHours: '4', hour: 7, minute: 30 };
  assert.deepEqual(validateJobArgs(mac), []);
  const m = renderJob(mac);
  assert.match(m.content, /<string>sync\/cli\.mjs<\/string>\s*<string>refresh-state<\/string>/);
  assert.match(m.content, /<key>StartInterval<\/key><integer>14400<\/integer>/);
  assert.match(m.content, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!/StartCalendarInterval/.test(m.content));

  for (const c of [w.content, service, timer, m.content]) {
    assert.ok(!/https?:\/\/(?!www\.apple\.com)/.test(c), 'no URL');
    assert.ok(!/TOKEN=|KEY=|Bearer|--webhook/.test(c), 'no Secret');
    assert.ok(!/\bsync\b(?!\/cli\.mjs)[^\n]*--dry-run|cli\.mjs sync\b/.test(c), 'canonical を書く sync は呼ばない');
  }
});

test('knowledge-refresh：--every-hours は 24 の約数（1〜12）だけ・launchd／systemd は --path 必須（推測しない）・--vault は絶対パス・他の job には付けられない', () => {
  const base = { job: 'knowledge-refresh', target: 'windows', dir: 'C:\\kl', hour: 7, minute: 30 };
  for (const n of ['1', '2', '3', '4', '6', '8', '12']) assert.deepEqual(validateJobArgs({ ...base, everyHours: n }), [], n);
  for (const n of ['0', '5', '7', '24', '-6', 'x']) assert.ok(validateJobArgs({ ...base, everyHours: n }).length > 0, n);
  assert.ok(validateJobArgs({ ...base, target: 'launchd', node: '/n' }).some((e) => /--path/.test(e)), 'launchd の既定 PATH では executor が見つからない');
  assert.ok(validateJobArgs({ ...base, target: 'systemd', dir: '/kl', environment: 'dev', user: 'en', node: '/n' }).some((e) => /--path/.test(e)));
  assert.deepEqual(validateJobArgs({ ...base, vault: 'C:\\Obsidian\\Vault' }), []);
  assert.match(renderJob({ ...base, vault: 'C:\\Obsidian\\Vault' }).content, /refresh-state --vault C:\\Obsidian\\Vault/);
  assert.ok(validateJobArgs({ ...base, vault: 'relative' }).length > 0);
  assert.ok(validateJobArgs({ ...base, vault: 'C:\\a;b' }).length > 0);
  assert.ok(validateJobArgs({ ...base, webhook: 'credential:E-NEXUS/edl/x' }).length > 0);
  assert.ok(validateJobArgs({ job: 'usage-digest', target: 'windows', dir: 'C:\\edl', hour: 6, minute: 5, everyHours: '6' }).length > 0, '従来の毎日 job の挙動は変えない');
  assert.ok(validateJobArgs({ job: 'watcher-cycle', target: 'windows', dir: 'C:\\edl', watcherDir: 'C:\\kl', hour: 6, minute: 5, vault: 'C:\\v' }).length > 0);
  // 従来の job は毎日 1 回のまま
  assert.match(renderJob({ job: 'usage-digest', target: 'windows', dir: 'C:\\edl', hour: 6, minute: 5 }).content, /-Daily -At '06:05'/);
});
