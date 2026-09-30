#!/usr/bin/env node
/**
 * E-NEXUS VPS staging の起動器（2026-09-30・PC 側）。Human が 1 コマンドで実行する（SSH を開始するのは Human＝VPS 台帳§0-3）：
 *
 *   node deploy/vps-staging/run.mjs --tailscale-name <VPS の Tailscale 名> [--ssh-user root] [--no-drill] [--skip-local-tests]
 *        [--no-store-token] [--python <exe>] [--dry-run]
 *
 * 1 回で行うこと：
 *   ローカル検証（git が clean・tests）→ bundle と kit の転送（ssh の標準入力・VPS に GitHub 資格情報を置かない）→
 *   read-only 監査（audit.sh）→ preflight（資源・既存 service・port・有料鍵が無いこと）→ staging deploy
 *   （release A → B → rollback で A → B の演習つき）→ Tailscale Serve HTTPS（Tailnet 限定・Funnel なし）→
 *   PC から HTTPS で health／smoke → failure 注入（設定誤り・kill・port 衝突・graceful restart）→
 *   E2E（MA-17・CRM の形・失敗系・Python transport）→ usage digest の systemd timer →
 *   事後比較（既存 service の PID・起動時刻・他の Serve・待受 port・有料 0）→
 *   staging token を Windows 資格情報マネージャー（E-NEXUS/edl/gateway-token-staging）へ・値は出さない → 要約
 *
 * 変更するのは staging だけ（stage.sh の冒頭）。Production・公開・有料 API・実 LINE 送信には触れない。
 * 全文の記録は %TEMP% の report（Secret なし・VPS の名前は PC ローカルにだけ残る）。コンソールは FAIL／WARN／RESULT／要約だけ。
 * --dry-run：ローカル検証と計画の表示だけ（ssh・tailscale を起動しない）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runE2E, minimalEnv } from './e2e.mjs';
import { readCredential } from '../../scripts/lib/env-file.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(KIT, '..', '..');
export const INBOX = '/root/e-nexus-staging-inbox';
export const KIT_FILES = Object.freeze(['audit.sh', 'stage.sh', 'vps-tool.mjs']);
export const CREDENTIAL_TARGET = 'E-NEXUS/edl/gateway-token-staging';
export const TOKEN_RE = /^[0-9a-f]{64}$/;
/** 段ごとの上限（止まったまま待ち続けない）。超えたら ssh を止めてその段を失敗にする */
export const PHASE_TIMEOUT_MS = Object.freeze({ audit: 180000, preflight: 240000, install: 420000, rollback: 420000, failure: 420000, digest: 300000, postflight: 240000, token: 60000, upload: 600000 });
const SHA_RE = /^[0-9a-f]{40}$/;

export function parseArgs(argv) {
  const a = { sshUser: 'root', drill: true, localTests: true, storeToken: true, dryRun: false, tailscaleName: null, python: 'python' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--tailscale-name') { a.tailscaleName = argv[i + 1]; i += 1; } else if (k === '--ssh-user') { a.sshUser = argv[i + 1]; i += 1; } else if (k === '--python') { a.python = argv[i + 1]; i += 1; } else if (k === '--no-drill') a.drill = false;
    else if (k === '--skip-local-tests') a.localTests = false;
    else if (k === '--no-store-token') a.storeToken = false;
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.tailscaleName || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(a.tailscaleName)) throw new Error('--tailscale-name <name> is required (letters, digits and -)');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(a.sshUser)) throw new Error('--ssh-user is not a valid user name');
  if (a.python !== null && !/^[\w.:\\/ -]{1,200}$/.test(a.python)) throw new Error('--python is not a valid executable name');
  return a;
}

/** 実行計画。check は PC から Tailnet の HTTPS で smoke／E2E（token は preflight 後の最初の check の前に取る） */
export function buildPlan({ drill, shaA, shaB }) {
  const plan = [{ kind: 'remote', phase: 'audit' }, { kind: 'remote', phase: 'preflight' }];
  const install = (sha, label) => [{ kind: 'remote', phase: 'install', sha, label }, { kind: 'check', release: sha, smokeOnly: true, label }];
  if (drill) {
    plan.push(...install(shaA, 'release A'), ...install(shaB, 'release B'));
    plan.push({ kind: 'remote', phase: 'rollback', label: 'rollback -> A' }, { kind: 'check', release: shaA, smokeOnly: true, label: 'rollback -> A' });
    plan.push(...install(shaB, 'roll forward -> B'));
  } else {
    plan.push(...install(shaB, 'release B'));
  }
  plan.push(
    { kind: 'remote', phase: 'failure', label: 'failure injection' },
    { kind: 'check', release: shaB, smokeOnly: true, label: 'after failure injection' },
    { kind: 'check', release: shaB, smokeOnly: false, label: 'full E2E' },
    { kind: 'remote', phase: 'digest', label: 'usage digest timer' },
    { kind: 'remote', phase: 'postflight', sha: shaB, label: 'postflight' },
    { kind: 'store-token', label: 'store staging token' },
  );
  return plan;
}

export function stepLabel(step) {
  if (step.kind === 'remote') return `${step.phase}${step.sha ? ` ${step.sha.slice(0, 12)}` : ''}${step.label && step.phase !== 'postflight' ? ` (${step.label})` : ''}`;
  if (step.kind === 'check') return `check ${step.smokeOnly ? 'smoke' : 'E2E'} ${step.release.slice(0, 12)} (${step.label})`;
  return step.label ?? step.kind;
}

/** コンソールへ出す行（詳細は report にだけ） */
export function consoleLine(line) {
  return /^(FAIL|WARN|ABORT|RESULT|SUMMARY|STATE)\b/.test(line);
}

/**
 * 計画を実行する。deps は差し替え可能（tests は ssh を起動しない）：
 *   remote(phase, args) → { code, lines }／fetchToken() → string|null／check({release, smokeOnly, label, token, servePort}) → { pass, results }
 *   storeToken(token) → { ok, note }／say(line)（コンソール）／record(line)（report）
 * preflight が落ちたら何も変えずに止める。install／rollback／deploy 中の smoke が落ちたら、残りを飛ばして postflight（診断）だけ行う。
 */
export async function execute(plan, deps) {
  const outcome = [];
  let mode = 'normal';
  let token = null;
  const state = {};
  for (const step of plan) {
    const label = stepLabel(step);
    if (mode === 'abort' || (mode === 'diagnose' && step.phase !== 'postflight')) { outcome.push({ label, pass: null, detail: 'skipped' }); continue; }
    if (step.kind === 'remote') {
      deps.say(`== ${label}`);
      const r = await deps.remote(step.phase, step.sha ? [step.sha] : []);
      for (const line of r.lines) {
        const m = /^STATE (\w+)=(\S+)$/.exec(line);
        if (m) state[m[1]] = m[2];
      }
      const pass = r.code === 0;
      const passes = r.lines.filter((l) => l.startsWith('PASS')).length;
      const fails = r.lines.filter((l) => l.startsWith('FAIL') || l.startsWith('ABORT')).length;
      outcome.push({ label, pass: step.phase === 'audit' ? (pass ? true : null) : pass, detail: step.phase === 'audit' ? `${r.lines.length} lines in the report` : `${passes} PASS / ${fails} FAIL` });
      if (!pass && step.phase === 'preflight') mode = 'abort';
      else if (!pass && (step.phase === 'install' || step.phase === 'rollback')) mode = 'diagnose';
      continue;
    }
    if (step.kind === 'check') {
      if (!token) {
        const t = await deps.fetchToken();
        if (typeof t !== 'string' || !TOKEN_RE.test(t)) { outcome.push({ label: 'fetch staging token', pass: false, detail: 'no valid token' }); mode = 'diagnose'; continue; }
        token = t;
      }
      deps.say(`== ${label}`);
      const r = await deps.check({ release: step.release, smokeOnly: step.smokeOnly, label: step.label, token, servePort: state.serve_port });
      for (const x of r.results) {
        const line = `${x.pass ? 'PASS' : x.warn ? 'WARN' : 'FAIL'}  ${x.name}${x.detail ? `  (${x.detail})` : ''}`;
        deps.record(`[check] ${line}`);
        if (!x.pass) deps.say(line);
      }
      const ok = r.results.filter((x) => x.pass).length;
      outcome.push({ label, pass: r.pass, detail: `${ok}/${r.results.length} PASS` });
      if (!r.pass && step.smokeOnly && step.label !== 'after failure injection') mode = 'diagnose';
      continue;
    }
    if (step.kind === 'store-token') {
      if (outcome.some((o) => o.pass === false) || !token) { outcome.push({ label, pass: null, detail: 'skipped (not everything passed)' }); continue; }
      const s = await deps.storeToken(token);
      outcome.push({ label, pass: s.ok === null ? null : Boolean(s.ok), detail: s.note });
    }
  }
  token = null;
  const pass = mode === 'normal' && outcome.every((o) => o.pass !== false);
  return { outcome, pass, state };
}

// ───────────────────────── real dependencies (ssh・tailscale・credential store) ─────────────────────────

function sshArgs(ctx, remoteCommand) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', `${ctx.sshUser}@${ctx.ip}`, remoteCommand];
}

function runSsh(ctx, remoteCommand, { input = null, onLine = null, capture = false, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs(ctx, remoteCommand), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctx.say(`FAIL  ssh step timed out after ${Math.round(timeoutMs / 1000)}s`); child.kill(); }, timeoutMs);
    const lines = [];
    let buf = '';
    const out = [];
    child.stdout.on('data', (c) => {
      if (capture) { out.push(c); return; }
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        lines.push(line);
        onLine?.(line);
      }
    });
    child.stderr.on('data', (c) => { if (!capture) ctx.record(`[ssh stderr] ${c.toString('utf8').trimEnd()}`); });
    child.on('error', (err) => { ctx.say(`FAIL  ssh could not start: ${err.message}`); resolve({ code: 255, lines, captured: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf) { lines.push(buf); onLine?.(buf); }
      resolve({ code: timedOut ? 124 : (code ?? 255), lines, captured: capture ? Buffer.concat(out).toString('utf8') : '' });
    });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

export function createRealDeps(ctx) {
  return {
    say: ctx.say,
    record: ctx.record,
    async remote(phase, args) {
      const script = phase === 'audit' ? 'audit.sh' : 'stage.sh';
      const cmd = `bash ${INBOX}/kit/${script}${phase === 'audit' ? '' : ` ${phase}`}${args.length ? ` ${args.join(' ')}` : ''}`;
      return runSsh(ctx, cmd, {
        timeoutMs: PHASE_TIMEOUT_MS[phase] ?? 300000,
        onLine: (line) => {
          ctx.record(`[${phase}] ${line}`);
          if (phase !== 'audit' && consoleLine(line)) ctx.say(line);
        },
      });
    },
    async fetchToken() {
      const r = await runSsh(ctx, `bash ${INBOX}/kit/stage.sh token`, { capture: true, timeoutMs: PHASE_TIMEOUT_MS.token });
      const t = r.code === 0 ? r.captured.trim() : '';
      return TOKEN_RE.test(t) ? t : null;
    },
    async check({ release, smokeOnly, token, servePort }) {
      if (!/^\d{2,5}$/.test(String(servePort ?? ''))) return { pass: false, results: [{ name: 'serve port known from preflight', pass: false }] };
      return runE2E({ url: `https://${ctx.dns}:${servePort}`, token, release, smokeOnly, python: smokeOnly ? null : ctx.python });
    },
    storeToken: (token) => storeWindowsCredential(CREDENTIAL_TARGET, token),
  };
}

function credWriteScript(target) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$secret = [Console]::In.ReadToEnd().Trim()',
    "if (-not ('EnxEdlCredW' -as [type])) { Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class EnxEdlCredW {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);',
    '}',
    "'@ }",
    '$bytes = [Text.Encoding]::Unicode.GetBytes($secret)',
    '$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)',
    'try {',
    '  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)',
    `  $c = New-Object EnxEdlCredW+CREDENTIAL; $c.Type = 1; $c.TargetName = '${target}'; $c.UserName = 'e-nexus'; $c.CredentialBlobSize = $bytes.Length; $c.CredentialBlob = $ptr; $c.Persist = 2`,
    '  if (-not [EnxEdlCredW]::CredWriteW([ref]$c, 0)) { exit 1 }',
    '} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr); $secret = $null }',
  ].join('\n');
}

/** staging token を Windows 資格情報マネージャーへ（値は標準入力で渡す・引数・環境変数・ファイルに置かない）→ 読み戻して一致を確かめる */
export async function storeWindowsCredential(target, secret, { platform = process.platform, spawnSyncImpl = spawnSync, readCredentialImpl = readCredential } = {}) {
  if (platform !== 'win32') return { ok: null, note: `not Windows: store ${target} on this machine yourself (Keychain: deploy/macos/keychain-edl.sh)` };
  const encoded = Buffer.from(credWriteScript(target), 'utf16le').toString('base64');
  const r = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { input: `${secret}\n`, windowsHide: true, timeout: 30000, env: minimalEnv() });
  if (r.status !== 0) return { ok: false, note: `CredWrite failed (exit ${r.status})` };
  const back = await readCredentialImpl(target);
  return back === secret ? { ok: true, note: `stored as ${target} (value not shown)` } : { ok: false, note: 'stored value did not read back' };
}

function git(args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

/** release A（HEAD~1）が staging の生成器を持つか（無いと演習の A が起動できない） */
export function releaseSupportsStaging(showFile) {
  const svc = showFile('scripts/gateway-service.mjs');
  const job = showFile('scripts/scheduled-job-service.mjs');
  return /RestartPreventExitStatus=2/.test(svc ?? '') && /--memory-max/.test(svc ?? '') && /'systemd'/.test(job ?? '');
}

export function resolveTailnet(name) {
  const ipR = spawnSync('tailscale', ['ip', '-4', name], { encoding: 'utf8', windowsHide: true });
  const ip = (ipR.stdout || '').trim().split(/\s+/)[0];
  if (ipR.status !== 0 || !/^100\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`tailscale ip -4 ${name} failed (is this PC on the tailnet?)`);
  const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  let dns = null;
  try {
    const j = JSON.parse(st.stdout);
    const lower = name.toLowerCase();
    const peer = Object.values(j.Peer ?? {}).find((p) => String(p.HostName ?? '').toLowerCase() === lower || String(p.DNSName ?? '').toLowerCase().startsWith(`${lower}.`));
    dns = peer?.DNSName ? String(peer.DNSName).replace(/\.$/, '') : null;
  } catch { dns = null; }
  if (!dns || !/^[a-z0-9.-]+\.ts\.net$/i.test(dns)) throw new Error(`could not find the MagicDNS name of ${name} (tailscale status --json)`);
  return { ip, dns };
}

function localTests(ctx) {
  const r = spawnSync(process.execPath, ['--test', 'tests/**/*.test.mjs'], { cwd: ROOT, encoding: 'utf8', env: minimalEnv(), timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const line of out.split('\n')) ctx.record(`[local tests] ${line}`);
  const num = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out) ?? [])[1] ?? NaN);
  return { ok: r.status === 0, pass: num('pass'), tests: num('tests') };
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (err) { console.error(err.message); return 2; }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  const report = path.join(os.tmpdir(), `e-nexus-staging-report-${ts}.txt`);
  const record = (line) => fs.appendFileSync(report, `${line}\n`);
  const say = (line) => { console.log(line); record(line); };
  say('== E-NEXUS VPS staging (one command) ==');

  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) { say('ABORT the repo has uncommitted tracked changes (deploy only committed code)'); return 1; }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const shaB = git(['rev-parse', 'HEAD']);
  const shaA = git(['rev-parse', 'HEAD~1']);
  if (!SHA_RE.test(shaA) || !SHA_RE.test(shaB)) { say('ABORT could not resolve release A/B'); return 1; }
  const showA = (p) => { const r = spawnSync('git', ['-C', ROOT, 'show', `${shaA}:${p}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
  if (args.drill && !releaseSupportsStaging(showA)) { say(`ABORT release A ${shaA.slice(0, 12)} lacks the staging unit/timer generators; use --no-drill or add a commit`); return 1; }
  const upstream = spawnSync('git', ['-C', ROOT, 'rev-parse', '@{u}'], { encoding: 'utf8' });
  if (upstream.status === 0 && upstream.stdout.trim() !== shaB) say(`WARN HEAD ${shaB.slice(0, 12)} is not the pushed upstream`);
  say(`local: ${branch} clean, release A ${shaA.slice(0, 12)} -> B ${shaB.slice(0, 12)}${args.drill ? '' : ' (no drill)'}`);
  if (args.localTests) {
    const t = localTests({ record });
    if (!t.ok) { say(`ABORT local tests failed (${t.pass}/${t.tests}); nothing was sent`); return 1; }
    say(`local tests: ${t.pass}/${t.tests} PASS`);
  }
  const plan = buildPlan({ drill: args.drill, shaA, shaB });
  if (args.dryRun) {
    say('dry-run: no ssh, no tailscale. Plan:');
    for (const s of plan) say(`  - ${stepLabel(s)}`);
    say(`report: ${report}`);
    return 0;
  }

  let tailnet;
  try { tailnet = resolveTailnet(args.tailscaleName); } catch (err) { say(`ABORT ${err.message}`); return 1; }
  record(`tailnet: ssh ${args.sshUser}@${tailnet.ip}  https host ${tailnet.dns}`);
  say('tailnet: VPS resolved (name and address are in the report only)');
  const ctx = { sshUser: args.sshUser, ip: tailnet.ip, dns: tailnet.dns, python: args.python, say, record };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e-nexus-staging-'));
  const bundle = path.join(tmp, 'edl.bundle');
  git(['bundle', 'create', bundle, 'HEAD', branch]);
  const prep = await runSsh(ctx, `mkdir -p ${INBOX}/kit && chmod 700 ${INBOX}`);
  if (prep.code !== 0) { say(`ABORT ssh to the VPS failed (exit ${prep.code}); nothing was changed`); return 1; }
  // 小さい kit を先に短い上限で送る：ssh の標準入力の終わりが届かない環境なら、ここで数十秒で分かる（bundle の 10 分を待たない）
  const uploads = [
    ...KIT_FILES.map((f) => [`${INBOX}/kit/${f}`, Buffer.from(fs.readFileSync(path.join(KIT, f), 'utf8').replace(/\r\n/g, '\n'), 'utf8'), 30000]),
    [`${INBOX}/edl.bundle`, fs.readFileSync(bundle), PHASE_TIMEOUT_MS.upload],
  ];
  for (const [dest, body, timeoutMs] of uploads) {
    const r = await runSsh(ctx, `cat > ${dest}`, { input: body, timeoutMs });
    if (r.code !== 0) { say(`ABORT uploading ${path.posix.basename(dest)} failed; nothing was changed`); return 1; }
  }
  // 転送経路（Windows の ssh の標準入力）でバイナリが崩れていないことを確かめる
  const sums = await runSsh(ctx, `sha256sum ${uploads.map(([d]) => d).join(' ')}`, { timeoutMs: 60000 });
  const remoteSum = new Map(sums.lines.map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([h, p]) => [p, h]));
  const broken = uploads.filter(([d, body]) => remoteSum.get(d) !== createHash('sha256').update(body).digest('hex'));
  if (sums.code !== 0 || broken.length) { say(`ABORT upload integrity check failed (${broken.map(([d]) => path.posix.basename(d)).join(', ') || 'sha256sum'}); nothing was changed`); return 1; }
  const bundleKb = Math.round(fs.statSync(bundle).size / 1024);
  fs.rmSync(tmp, { recursive: true, force: true });
  say(`upload: bundle ${bundleKb} KiB + kit (${KIT_FILES.join(', ')})`);

  const result = await execute(plan, { ...createRealDeps(ctx), ...(args.storeToken ? {} : { storeToken: async () => ({ ok: null, note: 'skipped (--no-store-token)' }) }) });

  say('');
  say('== SUMMARY ==');
  for (const o of result.outcome) say(`${o.pass === true ? 'PASS' : o.pass === false ? 'FAIL' : 'SKIP'}  ${o.label}${o.detail ? `  (${o.detail})` : ''}`);
  if (result.state.serve_port) {
    record(`staging URL: https://${tailnet.dns}:${result.state.serve_port}  (token: ${CREDENTIAL_TARGET} on this PC)`);
    say(`staging URL: https://<vps>.<tailnet>.ts.net:${result.state.serve_port} (full URL in the report)`);
  }
  say(result.pass ? 'OVERALL PASS' : 'OVERALL FAIL');
  say(`report: ${report}`);
  return result.pass ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`ABORT ${err.message}`); process.exitCode = 1; });
