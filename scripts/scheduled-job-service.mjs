#!/usr/bin/env node
/**
 * 定期実行の定義を生成する（2026-09-29・Human Last-Mile Activation）。**生成するだけで、登録はしない（Human-only）**。
 * 常駐 service の生成（scripts/gateway-service.mjs）と同じ形で、1 日 1 回の job を作る。
 *
 *   node scripts/scheduled-job-service.mjs --job <usage-digest|rotate-logs> --target <launchd|windows|systemd> --dir <この repo の絶対パス>
 *        [--hour 7] [--minute 30] [--node <node の絶対パス>] [--path <launchd の PATH>]
 *        usage-digest：[--environment dev|staging|production] [--webhook credential:E-NEXUS/edl/<name>] [--on-anomaly fail|report]
 *        systemd（2026-09-30・VPS staging）：--environment・--user・--node が必須。.service（oneshot）と .timer（毎日・Persistent）の 2 ファイル。
 *        webhook は使えない（Linux に OS 資格情報ストアが無い）
 *        rotate-logs ：--base <repo を並べた親フォルダの絶対パス>（launchd のみ）
 *        knowledge-refresh（2026-10-03）：--dir は e-nexus-knowledge-layer の絶対パス。[--every-hours 6]（24 の約数 1〜12）[--vault <Vault の絶対パス>]
 *        launchd・systemd は --path 必須（executor の CLI を探す PATH。既定の PATH には npm／Homebrew の global が無く、全 executor が not_installed になる）
 *
 * job：
 *   usage-digest＝`node scripts/usage-digest.mjs --hours 24 --fail-on-anomaly`（FB-18。READ-ONLY・課金なし。webhook は資格情報ストアの名前だけ）
 *   rotate-logs ＝`/bin/sh deploy/macos/rotate-logs.sh --base <base>`（Mac mini の常駐ログ）
 *   knowledge-refresh＝`node sync/cli.mjs refresh-state`（Knowledge Layer の実測だけを集め直す。canonical は書かない・AI／ネットワーク／課金なし）。
 *     executor の local 実測（health.local.*）は ttl 1 日で、同じ値は ttl/2 を過ぎるまで書き直さない（design.md §5）。
 *     既定 6 時間ごと＝書き直しは観測から 12〜18 時間後、stale まで 6 時間以上の余裕（1 回の取りこぼしに耐える）。
 *     PC が止まっていた間の分は起動後に 1 回走る（Windows StartWhenAvailable・systemd Persistent・launchd は wake 後に実行）
 * --on-anomaly report：`--fail-on-anomaly` を付けない（異常は出力するが exit 0）。Jev を切った staging は Human 率が設計上 100% で、
 * 毎日「異常」扱いになるため（既定は fail）。
 * 実機依存の値（パス・node の場所・PATH・時刻）は引数で受け取り、推測で埋めない。定義に Secret を書かない。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JOBS = ['usage-digest', 'rotate-logs', 'watcher-cycle', 'knowledge-refresh'];
const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12]; // 24 の約数だけ（毎日同じ時刻に揃う）
const TARGETS = ['launchd', 'windows', 'systemd'];
const UNSAFE = /["'`$\n\r;&|<>]/;
const WEBHOOK = /^credential:E-NEXUS\/edl\/[a-z0-9-]{1,64}$/;

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const isAbs = (p) => typeof p === 'string' && (path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p));

export function validateJobArgs(a) {
  const errors = [];
  if (!JOBS.includes(a.job)) errors.push(`--job must be ${JOBS.join('|')}`);
  if (!TARGETS.includes(a.target)) errors.push(`--target must be ${TARGETS.join('|')}`);
  for (const k of ['dir', 'base', 'node', 'watcherDir', 'vault']) {
    if (a[k] === undefined) continue;
    if (!isAbs(a[k])) errors.push(`--${k} must be an absolute path`);
    else if (UNSAFE.test(a[k])) errors.push(`--${k} contains characters that are not allowed`);
  }
  if (!a.dir) errors.push('--dir is required');
  if (a.path !== undefined && !String(a.path).split(':').every((d) => d.startsWith('/') && !UNSAFE.test(d))) errors.push('--path must be colon-separated absolute directories');
  for (const [k, max] of [['hour', 23], ['minute', 59]]) {
    const n = Number(a[k]);
    if (!Number.isInteger(n) || n < 0 || n > max) errors.push(`--${k} must be 0-${max}`);
  }
  if (a.job === 'usage-digest') {
    if (a.environment !== undefined && !['dev', 'staging', 'production'].includes(a.environment)) errors.push('--environment must be dev|staging|production');
    if (a.webhook !== undefined && !WEBHOOK.test(a.webhook)) errors.push('--webhook must be credential:E-NEXUS/edl/<name>（URL を引数に置かない）');
    if (a.target === 'launchd' && !a.node && !a.path) errors.push('launchd needs --node <absolute path to node> or --path（実機で確定）');
    if (a.onAnomaly !== undefined && !['fail', 'report'].includes(a.onAnomaly)) errors.push('--on-anomaly must be fail|report');
  }
  if (a.target === 'systemd') {
    if (!['dev', 'staging', 'production'].includes(a.environment)) errors.push('systemd needs --environment dev|staging|production（unit 名に入る）');
    if (!a.user || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(a.user)) errors.push('systemd needs --user <実行ユーザー>（root で動かさない）');
    if (!a.node) errors.push('systemd needs --node <absolute path to node>（実機で確定）');
    if (a.webhook !== undefined) errors.push('systemd cannot use --webhook（Linux に OS 資格情報ストアが無い）');
  }
  if (a.job === 'rotate-logs') {
    if (a.target !== 'launchd') errors.push('rotate-logs is for the Mac mini (launchd) only');
    if (!a.base) errors.push('rotate-logs needs --base');
  }
  if (a.job === 'watcher-cycle') {
    // MA-33-6（2026-10-02）：AI Infrastructure Watcher の 1 サイクル（scripts/watcher-cycle.mjs）。Watcher の置き場（e-nexus-knowledge-layer）は実機の絶対パスで受ける
    if (!a.watcherDir) errors.push('watcher-cycle needs --watcher-dir <absolute path to e-nexus-knowledge-layer>');
    if (a.target === 'launchd' && !a.node && !a.path) errors.push('launchd needs --node <absolute path to node> or --path（実機で確定）');
    if (a.webhook !== undefined) errors.push('watcher-cycle has no webhook（通知は SessionStart の 1 行と proposals/）');
  }
  if (a.everyHours !== undefined && a.job !== 'knowledge-refresh') errors.push('--every-hours is for knowledge-refresh only');
  if (a.vault !== undefined && a.job !== 'knowledge-refresh') errors.push('--vault is for knowledge-refresh only');
  if (a.job === 'knowledge-refresh') {
    // 2026-10-03：Knowledge Layer の実測（executor の local availability 等）の鮮度を保つ定期 refresh。--dir は e-nexus-knowledge-layer
    if (!EVERY_HOURS.includes(Number(a.everyHours ?? 6))) errors.push(`--every-hours must be one of ${EVERY_HOURS.join('|')}`);
    if ((a.target === 'launchd' || a.target === 'systemd') && !a.path) errors.push(`${a.target} needs --path（executor の CLI がある PATH を実機で確定。無いと全 executor が not_installed になる）`);
    if (a.webhook !== undefined) errors.push('knowledge-refresh has no webhook');
  }
  return errors;
}

function commandOf(a) {
  if (a.job === 'knowledge-refresh') {
    const args = ['sync/cli.mjs', 'refresh-state', ...(a.vault ? ['--vault', a.vault] : [])];
    const node = a.node ?? (a.target === 'windows' ? 'node.exe' : null);
    return node ? [node, ...args] : ['/usr/bin/env', 'node', ...args];
  }
  if (a.job === 'usage-digest') {
    const args = ['scripts/usage-digest.mjs', '--hours', '24', ...(a.onAnomaly === 'report' ? [] : ['--fail-on-anomaly'])];
    if (a.environment) args.push('--environment', a.environment);
    if (a.webhook) args.push('--webhook', a.webhook);
    const node = a.node ?? (a.target === 'windows' ? 'node.exe' : null);
    return node ? [node, ...args] : ['/usr/bin/env', 'node', ...args];
  }
  if (a.job === 'watcher-cycle') {
    const args = ['scripts/watcher-cycle.mjs', '--watcher-dir', a.watcherDir];
    const node = a.node ?? (a.target === 'windows' ? 'node.exe' : null);
    return node ? [node, ...args] : ['/usr/bin/env', 'node', ...args];
  }
  return ['/bin/sh', 'deploy/macos/rotate-logs.sh', '--base', a.base];
}

export function renderJob(a) {
  const hour = Number(a.hour);
  const minute = Number(a.minute);
  const cmd = commandOf(a);
  const every = a.job === 'knowledge-refresh' ? Number(a.everyHours ?? 6) : null; // null＝毎日 1 回（従来の job）
  const firstHour = every ? hour % every : hour;
  if (a.target === 'systemd') {
    const unit = `e-nexus-${a.job}-${a.environment}`;
    const service = [
      '[Unit]',
      `Description=E-NEXUS ${a.job} (${a.environment})`,
      '',
      '[Service]',
      'Type=oneshot',
      `WorkingDirectory=${a.dir}`,
      `ExecStart=${cmd.join(' ')}`,
      `User=${a.user}`,
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=strict',
      `ProtectHome=${a.job === 'knowledge-refresh' ? 'read-only' : 'true'}`, // knowledge-refresh は home 配下の Vault・repo の git 状態を読む
      ...(a.job === 'watcher-cycle' ? [`ReadWritePaths=${a.watcherDir}`] : []), // Watcher の観測・proposal と Knowledge の実測（data/state）だけ書ける
      ...(a.job === 'knowledge-refresh' ? [`ReadWritePaths=${a.dir}/data/state`, `Environment=PATH=${a.path}`] : []), // 書けるのは実測（gitignore）だけ。Vault・各 repo は読むだけ
      'TimeoutStartSec=600',
      '',
    ].join('\n');
    const timer = [
      '[Unit]',
      `Description=${every ? `Every ${every}h` : 'Daily'} E-NEXUS ${a.job} (${a.environment})`,
      '',
      '[Timer]',
      `OnCalendar=*-*-* ${String(firstHour).padStart(2, '0')}${every ? `/${every}` : ''}:${String(minute).padStart(2, '0')}:00`,
      'Persistent=true',
      `Unit=${unit}.service`,
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n');
    return {
      filename: `${unit}.service`,
      content: service,
      files: [{ filename: `${unit}.service`, content: service }, { filename: `${unit}.timer`, content: timer }],
      install: [`sudo cp ${unit}.service ${unit}.timer /etc/systemd/system/`, 'sudo systemctl daemon-reload', `sudo systemctl enable --now ${unit}.timer`],
    };
  }
  if (a.target === 'launchd') {
    const label = `com.e-nexus.${a.job}`;
    return {
      filename: `${label}.plist`,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `  <key>Label</key><string>${xml(label)}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...cmd.map((x) => `    <string>${xml(x)}</string>`),
        '  </array>',
        `  <key>WorkingDirectory</key><string>${xml(a.dir)}</string>`,
        ...(every
          ? [`  <key>StartInterval</key><integer>${every * 3600}</integer>`, '  <key>RunAtLoad</key><true/>'] // ログイン直後にも 1 回（止まっていた間に stale になった実測を戻す）
          : [`  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`, '  <key>RunAtLoad</key><false/>']),
        `  <key>StandardOutPath</key><string>${xml(`${a.dir}/data/${a.job}.out.log`)}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(`${a.dir}/data/${a.job}.err.log`)}</string>`,
        ...(a.path ? [`  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(a.path)}</string></dict>`] : []),
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
      install: [`cp ${label}.plist ~/Library/LaunchAgents/`, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`, `launchctl print gui/$(id -u)/${label}`],
    };
  }
  const taskName = `E-NEXUS ${a.job}`;
  const [exe, ...rest] = cmd;
  const argLine = rest.map((x) => (/\s/.test(x) ? `\\"${x}\\"` : x)).join(' ');
  const at = `${String(firstHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return {
    filename: `register-${a.job}.ps1`,
    content: [
      `# E-NEXUS ${a.job} の定期実行の登録（Human-only・current user・${every ? `${at} から ${every} 時間ごと` : `毎日 ${at}`}）。生成：scripts/scheduled-job-service.mjs`,
      "$ErrorActionPreference = 'Stop'",
      `$action = New-ScheduledTaskAction -Execute '${exe}' -Argument "${argLine}" -WorkingDirectory '${a.dir}'`,
      every
        ? `$trigger = New-ScheduledTaskTrigger -Once -At '${at}' -RepetitionInterval (New-TimeSpan -Hours ${every})` // 期間の指定なし＝無期限に繰り返す
        : `$trigger = New-ScheduledTaskTrigger -Daily -At '${at}'`,
      '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
      `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Description 'E-NEXUS ${a.job}'`,
      '',
    ].join('\r\n'),
    install: [`powershell -ExecutionPolicy Bypass -File register-${a.job}.ps1`, `Get-ScheduledTask -TaskName '${taskName}'`],
  };
}

function parse(argv) {
  const a = { hour: 7, minute: 30 };
  const map = { '--job': 'job', '--target': 'target', '--dir': 'dir', '--base': 'base', '--hour': 'hour', '--minute': 'minute', '--node': 'node', '--path': 'path', '--environment': 'environment', '--webhook': 'webhook', '--user': 'user', '--on-anomaly': 'onAnomaly', '--watcher-dir': 'watcherDir', '--every-hours': 'everyHours', '--vault': 'vault' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!map[argv[i]]) throw new Error(`unknown argument: ${argv[i]}`);
    a[map[argv[i]]] = argv[i + 1];
  }
  return a;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const a = parse(process.argv.slice(2));
    const errors = validateJobArgs(a);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 2;
    } else {
      const r = renderJob(a);
      process.stdout.write(`# ${r.filename}\n${r.content}\n# 登録（Human-only）：\n${r.install.map((l) => `#   ${l}`).join('\n')}\n`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
