#!/usr/bin/env node
/**
 * HTTP Gateway を常駐させる service 定義を生成する（2026-09-29・FB-05）。**生成するだけで、登録・起動はしない（Human-only）**。
 *
 *   node scripts/gateway-service.mjs --target <systemd|launchd|windows> --environment <staging|production>
 *        --dir <deploy先の repo の絶対パス> --env-file <env file の絶対パス> [--host 127.0.0.1] [--port 8787] [--node <node の絶対パス>] [--user <実行ユーザー>]
 *        [--path <launchd の PATH（コロン区切りの絶対パス）>]
 *
 * どの定義も `node scripts/run-gateway.mjs --env-file …` を起動する（Secret は env file の `credential:` 参照か、root だけが読める env file。
 * 定義ファイル自体に Secret を書かない）。停止は SIGTERM（Windows は Stop-ScheduledTask）→ graceful shutdown。再起動は失敗時のみ。
 * 実機依存の値（パス・ユーザー・node の場所・PATH）は引数で受け取り、推測で埋めない。launchd は `--node`（node の絶対パス）か `--path` が要る
 * （LaunchAgent の既定 PATH は /usr/bin:/bin:/usr/sbin:/sbin で node が見つからない。Homebrew の場所は機械で違う＝2026-09-29 固定値をやめた）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = ['systemd', 'launchd', 'windows'];
const ENVS = ['staging', 'production'];
const UNSAFE = /["'`$\n\r;&|<>]/;

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function validateServiceArgs(a) {
  const errors = [];
  if (!TARGETS.includes(a.target)) errors.push(`--target must be ${TARGETS.join('|')}`);
  if (!ENVS.includes(a.environment)) errors.push(`--environment must be ${ENVS.join('|')}（dev は常駐させない）`);
  for (const k of ['dir', 'envFile']) {
    if (typeof a[k] !== 'string' || !(path.isAbsolute(a[k]) || /^[A-Za-z]:[\\/]/.test(a[k]))) errors.push(`--${k === 'envFile' ? 'env-file' : k} must be an absolute path`);
    else if (/["'`$\n\r;&|<>]/.test(a[k])) errors.push(`--${k === 'envFile' ? 'env-file' : k} contains characters that are not allowed`);
  }
  if (a.node && /["'`$\n\r;&|<>]/.test(a.node)) errors.push('--node contains characters that are not allowed');
  if (a.user && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(a.user)) errors.push('--user is not a valid user name');
  if (a.path !== undefined && (typeof a.path !== 'string' || !a.path.split(':').every((d) => d.startsWith('/') && !UNSAFE.test(d)))) errors.push('--path must be colon-separated absolute directories');
  if (a.target === 'launchd' && !a.node && !a.path) errors.push('launchd needs --node <absolute path to node> or --path（実機で確定：`command -v node` の結果）');
  if (!/^(127\.0\.0\.1|::1|0\.0\.0\.0|localhost|[0-9.]{7,15})$/.test(a.host)) errors.push('--host must be an IP address or localhost');
  if (!Number.isInteger(Number(a.port)) || Number(a.port) < 1 || Number(a.port) > 65535) errors.push('--port must be 1-65535');
  return errors;
}

export function renderService(a) {
  const node = a.node ?? (a.target === 'windows' ? 'node.exe' : '/usr/bin/env node');
  const label = `com.e-nexus.decision-gateway.${a.environment}`;
  const argsList = ['scripts/run-gateway.mjs', '--env-file', a.envFile, '--host', a.host, '--port', String(a.port)];
  if (a.target === 'systemd') {
    return {
      filename: `e-nexus-decision-gateway-${a.environment}.service`,
      content: [
        '[Unit]',
        `Description=E-NEXUS Common Decision Gateway (${a.environment})`,
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${a.dir}`,
        `ExecStart=${node} ${argsList.join(' ')}`,
        ...(a.user ? [`User=${a.user}`] : []),
        'Restart=on-failure',
        'RestartSec=5',
        'KillSignal=SIGTERM',
        'TimeoutStopSec=20',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        'ProtectSystem=strict',
        `ReadWritePaths=${a.dir}/data`,
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n'),
      install: [`sudo cp e-nexus-decision-gateway-${a.environment}.service /etc/systemd/system/`, 'sudo systemctl daemon-reload', `sudo systemctl enable --now e-nexus-decision-gateway-${a.environment}`],
    };
  }
  if (a.target === 'launchd') {
    const programArgs = (a.node ? [a.node] : ['/usr/bin/env', 'node']).concat(argsList);
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
        ...programArgs.map((x) => `    <string>${xml(x)}</string>`),
        '  </array>',
        `  <key>WorkingDirectory</key><string>${xml(a.dir)}</string>`,
        '  <key>RunAtLoad</key><true/>',
        '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
        '  <key>ThrottleInterval</key><integer>5</integer>',
        '  <key>ExitTimeOut</key><integer>20</integer>',
        `  <key>StandardOutPath</key><string>${xml(`${a.dir}/data/gateway-${a.environment}.out.log`)}</string>`,
        `  <key>StandardErrorPath</key><string>${xml(`${a.dir}/data/gateway-${a.environment}.err.log`)}</string>`,
        ...(a.path ? [`  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(a.path)}</string></dict>`] : []),
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
      install: [`cp ${label}.plist ~/Library/LaunchAgents/`, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`, `launchctl print gui/$(id -u)/${label}`],
    };
  }
  // windows：Task Scheduler（ログオン時・current user）。登録用の PowerShell を生成する
  const taskName = `E-NEXUS Decision Gateway (${a.environment})`;
  const argLine = argsList.map((x) => (/\s/.test(x) ? `\\"${x}\\"` : x)).join(' ');
  return {
    filename: `register-decision-gateway-${a.environment}.ps1`,
    content: [
      '# E-NEXUS Common Decision Gateway の常駐登録（Human-only・current user・ログオン時）。生成：scripts/gateway-service.mjs',
      "$ErrorActionPreference = 'Stop'",
      `$action = New-ScheduledTaskAction -Execute '${node}' -Argument "${argLine}" -WorkingDirectory '${a.dir}'`,
      '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
      '$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
      `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Description 'E-NEXUS Common Decision Gateway (${a.environment})'`,
      `Start-ScheduledTask -TaskName '${taskName}'`,
      '',
    ].join('\r\n'),
    install: [`powershell -ExecutionPolicy Bypass -File register-decision-gateway-${a.environment}.ps1`, `Get-ScheduledTask -TaskName '${taskName}'`],
  };
}

function parse(argv) {
  const a = { host: '127.0.0.1', port: 8787 };
  const map = { '--target': 'target', '--environment': 'environment', '--dir': 'dir', '--env-file': 'envFile', '--host': 'host', '--port': 'port', '--node': 'node', '--user': 'user', '--path': 'path' };
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
    const errors = validateServiceArgs(a);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 2;
    } else {
      const r = renderService(a);
      process.stdout.write(`# ${r.filename}\n${r.content}\n# 登録（Human-only）：\n${r.install.map((l) => `#   ${l}`).join('\n')}\n`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
