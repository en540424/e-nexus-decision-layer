/**
 * VPS staging kit（deploy/vps-staging・2026-09-30）。実 VPS・ssh・tailscale・ネットワーク・実 Jev に触れずに検証できる部分：
 * shell の安全な書き方（staging 以外の unit を変えない・funnel なし・Secret を出さない）・Serve 設定の解析・usage の有料 0 判定・
 * 起動器の計画と止まり方（preflight 失敗なら何も変えない・install 失敗なら診断だけ）・token を記録に出さない・E2E の期待値。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/core/paths.mjs';
import { createGateway } from '../src/gateway/gateway.mjs';
import { createDecisionLayerEngine } from '../src/gateway/engine.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { parseServeStatus, formatServe, jsonGet, checkUsage } from '../deploy/vps-staging/vps-tool.mjs';
import { E2E_CASES, checkCase, minimalEnv } from '../deploy/vps-staging/e2e.mjs';
import { parseArgs, buildPlan, execute, consoleLine, releaseSupportsStaging, storeWindowsCredential, TOKEN_RE } from '../deploy/vps-staging/run.mjs';

const KIT = join(ROOT, 'deploy', 'vps-staging');
const read = (f) => readFileSync(join(KIT, f), 'utf8');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TOKEN = 'f'.repeat(64);

test('shell scripts: ASCII only, LF only, bash syntax ok (bash -n from stdin when bash exists)', () => {
  for (const f of ['audit.sh', 'stage.sh']) {
    const s = read(f);
    assert.ok(![...s].some((c) => c.charCodeAt(0) > 127), `${f} is ASCII only (piped through Windows shells)`);
    assert.ok(!s.includes('\r'), `${f} has no CR`);
    const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === 'ok') {
      const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  }
});

test('stage.sh: changes only staging (systemctl through the staging-only wrapper, no funnel/apt/reboot, protected services never targeted)', () => {
  const s = read('stage.sh');
  const code = s.split('\n').filter((l) => !l.trim().startsWith('#'));
  const mutating = /\bsystemctl\s+(start|stop|restart|enable|disable|kill|reset-failed|mask|unmask|reload|edit|set-property|isolate|daemon-reexec)\b/;
  assert.deepEqual(code.filter((l) => mutating.test(l)), [], 'no direct state-changing systemctl (use sctl)');
  assert.ok(code.some((l) => l.includes('systemctl "$verb" "$@"')), 'the wrapper is the only place that runs a mutating verb');
  assert.match(s, /e-nexus-\*-staging\|e-nexus-\*-staging\.service\|e-nexus-\*-staging\.timer\) ;;/);
  assert.ok(!/tailscale\s+funnel/.test(s), 'never touches funnel');
  assert.ok(code.filter((l) => /tailscale serve --/.test(l)).every((l) => l.includes('--https="$SP"')), 'serve only on the staging port');
  assert.ok(!/\b(apt|apt-get|reboot|shutdown|iptables -[AIDF]|ufw (allow|deny|enable|disable)|docker (stop|restart|rm|kill|compose))\b/.test(code.join('\n')), 'no package upgrades, reboots, firewall or container changes');
  assert.ok(!/set -x|set -o xtrace/.test(s), 'no xtrace (secrets would be printed)');
  for (const p of ['en-product-hub', 'audio-processor', 'cloudflared']) {
    assert.ok(!code.some((l) => /\bsctl\b/.test(l) && l.includes(p)), `${p} is never passed to sctl`);
  }
  assert.match(s, /grep -Eq '\^\(EDL_ALLOW_NETWORK\|JEV_API_KEY/, 'paid/network keys abort the run');
  assert.match(s, /RESERVED_PORTS="22 80 443 4188 5678 5679 8443 8444 8787 18789"/, 'existing ports are reserved');
  assert.match(s, /trap 'restore_after_failure "\$bk"' EXIT/, 'failure tests restore the env file even when interrupted');
  assert.ok(/printf '%s\\n' "\$tok"/.test(s) && /token\(\) \{/.test(s), 'the token leaves the host only through the token phase (stdout, captured by run.mjs)');
});

test('vps-tool: serve status parsing keeps other entries and sees funnel; usage check counts networked/paid attempts', () => {
  const json = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 8444: { HTTPS: true } },
    Web: {
      'vps.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18789' } } },
      'vps.tail.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5679' } } },
      'vps.tail.ts.net:8444': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4188' } } },
    },
    AllowFunnel: { 'vps.tail.ts.net:8443': true },
  };
  const lines = formatServe(parseServeStatus(JSON.stringify(json))).split('\n');
  assert.deepEqual(lines, [
    'PORT 443 https=1 proxy=http://127.0.0.1:18789 funnel=0',
    'PORT 8443 https=1 proxy=http://127.0.0.1:5679 funnel=1',
    'PORT 8444 https=1 proxy=http://127.0.0.1:4188 funnel=0',
  ]);
  assert.deepEqual(parseServeStatus('not json'), []);
  assert.deepEqual(parseServeStatus('{}'), []);
  assert.equal(jsonGet({ release: { commit: SHA_A } }, 'release.commit'), SHA_A);
  assert.equal(jsonGet(null, 'a.b'), '');
  const usage = [
    JSON.stringify({ resolved_by: 'rules', estimated_cost_usd_micros: 0, attempts: [{ networked: false }] }),
    JSON.stringify({ resolved_by: 'human', attempts: [] }),
  ].join('\n');
  assert.deepEqual(checkUsage(usage), { lines: 2, networked: 0, cost_usd_micros: 0 });
  assert.deepEqual(checkUsage(`${usage}\n${JSON.stringify({ attempts: [{ networked: true, estimated_cost_usd_micros: 120 }] })}`), { lines: 3, networked: 1, cost_usd_micros: 120 });
});

test('E2E cases hold against a staging Gateway with Jev off (no network, no paid call)', async () => {
  const meter = createMemoryMeter();
  const gw = createGateway({ engine: createDecisionLayerEngine({ env: {}, meter }), env: { EDL_ENVIRONMENT: 'staging' } });
  for (const c of E2E_CASES) {
    const env = await gw.decide({ ...c.request, contract_version: '1', expected_environment: 'staging' });
    assert.equal(checkCase(env, c.expect), null, c.name);
  }
  assert.equal(checkCase({ ok: true, gateway: { environment: 'production' }, decision: { tier: 'auto', resolved_by: 'rules' } }, E2E_CASES[0].expect), 'environment=production');
  const env = minimalEnv({ PATH: '/bin', JEV_API_KEY: 'x', EDL_ALLOW_NETWORK: 'true', ANTHROPIC_API_KEY: 'y' });
  assert.deepEqual(env, { PATH: '/bin' }, 'child processes never inherit Jev / paid provider keys');
});

test('run.mjs: arguments, plan order (audit -> preflight -> A -> B -> rollback A -> B -> failure -> E2E -> digest -> postflight -> token)', () => {
  assert.throws(() => parseArgs([]), /--tailscale-name/);
  assert.throws(() => parseArgs(['--tailscale-name', 'bad name;rm']), /--tailscale-name/);
  assert.throws(() => parseArgs(['--tailscale-name', 'vm-1', '--ssh-user', 'root;x']), /--ssh-user/);
  const a = parseArgs(['--tailscale-name', 'vm-e91671a7-18', '--dry-run']);
  assert.deepEqual([a.tailscaleName, a.sshUser, a.drill, a.dryRun, a.storeToken], ['vm-e91671a7-18', 'root', true, true, true]);
  const steps = buildPlan({ drill: true, shaA: SHA_A, shaB: SHA_B }).map((s) => (s.kind === 'remote' ? `${s.phase}${s.sha ? `:${s.sha[0]}` : ''}` : s.kind === 'check' ? `check:${s.release[0]}${s.smokeOnly ? '' : ':e2e'}` : s.kind));
  assert.deepEqual(steps, ['audit', 'preflight', 'install:a', 'check:a', 'install:b', 'check:b', 'rollback', 'check:a', 'install:b', 'check:b', 'failure', 'check:b', 'check:b:e2e', 'digest', 'postflight:b', 'store-token']);
  assert.ok(consoleLine('FAIL  x') && consoleLine('RESULT preflight PASS') && !consoleLine('PASS  x') && !consoleLine('INFO  x'));
  assert.equal(releaseSupportsStaging((p) => (p.endsWith('gateway-service.mjs') ? "'RestartPreventExitStatus=2' --memory-max" : "['launchd', 'windows', 'systemd']")), true);
  assert.equal(releaseSupportsStaging(() => 'old'), false, 'an old release A cannot run the drill');
});

function fakeDeps({ fail = {}, token = TOKEN } = {}) {
  const calls = [];
  const said = [];
  const recorded = [];
  return {
    calls, said, recorded,
    say: (l) => said.push(l),
    record: (l) => recorded.push(l),
    async remote(phase, args) {
      calls.push(`${phase}${args.length ? `:${args[0][0]}` : ''}`);
      const code = fail[phase] ? 3 : 0;
      const lines = phase === 'preflight' ? ['PASS  x', 'STATE serve_port=8446', code ? 'ABORT y' : 'RESULT preflight PASS'] : [code ? 'ABORT boom' : `RESULT ${phase} PASS`];
      return { code, lines };
    },
    async fetchToken() { calls.push('token'); return token; },
    async check({ release, smokeOnly, token: t, servePort }) {
      calls.push(`check:${release[0]}${smokeOnly ? '' : ':e2e'}`);
      assert.equal(t, TOKEN);
      assert.equal(servePort, '8446');
      return { pass: !fail.check, results: [{ name: 'smoke: health 200', pass: !fail.check }] };
    },
    async storeToken(t) { calls.push('store'); assert.equal(t, TOKEN); return { ok: true, note: 'stored' }; },
  };
}

test('execute: full plan passes; token fetched once, never said or recorded', async () => {
  const d = fakeDeps();
  const r = await execute(buildPlan({ drill: true, shaA: SHA_A, shaB: SHA_B }), d);
  assert.equal(r.pass, true);
  assert.equal(d.calls.filter((c) => c === 'token').length, 1);
  assert.ok(d.calls.includes('store'));
  assert.ok(![...d.said, ...d.recorded, JSON.stringify(r)].some((l) => l.includes(TOKEN)), 'the token never reaches the console, the report or the result');
});

test('execute: a failed preflight changes nothing (no install, no token, no postflight)', async () => {
  const d = fakeDeps({ fail: { preflight: true } });
  const r = await execute(buildPlan({ drill: true, shaA: SHA_A, shaB: SHA_B }), d);
  assert.equal(r.pass, false);
  assert.deepEqual(d.calls, ['audit', 'preflight']);
});

test('execute: a failed install stops the deploy and runs postflight for diagnosis only; token is not stored', async () => {
  const d = fakeDeps({ fail: { install: true } });
  const r = await execute(buildPlan({ drill: true, shaA: SHA_A, shaB: SHA_B }), d);
  assert.equal(r.pass, false);
  assert.deepEqual(d.calls, ['audit', 'preflight', 'install:a', 'postflight:b']);
  const d2 = fakeDeps({ fail: { check: true } });
  await execute(buildPlan({ drill: true, shaA: SHA_A, shaB: SHA_B }), d2);
  assert.deepEqual(d2.calls, ['audit', 'preflight', 'install:a', 'token', 'check:a', 'postflight:b'], 'a failing smoke during deploy stops the drill');
  const d3 = fakeDeps({ token: 'not-a-token' });
  const r3 = await execute(buildPlan({ drill: false, shaA: SHA_A, shaB: SHA_B }), d3);
  assert.equal(r3.pass, false);
  assert.ok(!d3.calls.includes('store'));
});

test('credential store: Windows only, value only through stdin, read back to verify', async () => {
  assert.equal(TOKEN_RE.test(TOKEN), true);
  const notWin = await storeWindowsCredential('E-NEXUS/edl/gateway-token-staging', TOKEN, { platform: 'darwin' });
  assert.equal(notWin.ok, null);
  let seen = null;
  const ok = await storeWindowsCredential('E-NEXUS/edl/gateway-token-staging', TOKEN, {
    platform: 'win32',
    spawnSyncImpl: (exe, args, opts) => { seen = { exe, args, opts }; return { status: 0 }; },
    readCredentialImpl: async () => TOKEN,
  });
  assert.equal(ok.ok, true);
  assert.ok(!seen.args.join(' ').includes(TOKEN), 'the value is not on the command line');
  assert.equal(seen.opts.input, `${TOKEN}\n`);
  assert.ok(!Object.values(seen.opts.env).includes(TOKEN), 'nor in the environment');
  const mismatch = await storeWindowsCredential('E-NEXUS/edl/gateway-token-staging', TOKEN, { platform: 'win32', spawnSyncImpl: () => ({ status: 0 }), readCredentialImpl: async () => 'other' });
  assert.equal(mismatch.ok, false);
});
