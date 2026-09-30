// deploy/vps-staging/pc-fetch-token.mjs（2 台目以降の Windows PC で staging token を表示せずに資格情報マネージャーへ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs, parseRemoteOutput, sshArgs, REMOTE_COMMAND } from '../deploy/vps-staging/pc-fetch-token.mjs';
import { CREDENTIAL_TARGET } from '../deploy/vps-staging/run.mjs';

const TOK = 'a'.repeat(64);

test('pc-fetch-token: arguments (name required and validated, ssh user default root)', () => {
  assert.deepEqual(parseArgs(['--tailscale-name', 'vps-example-1']), { tailscaleName: 'vps-example-1', sshUser: 'root', identity: null });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--tailscale-name', 'bad;name']), /usage/);
  assert.throws(() => parseArgs(['--tailscale-name', 'vps-example-1', '--ssh-user', 'root;x']), /ssh-user/);
  assert.throws(() => parseArgs(['--tailscale-name', 'vps-example-1', '--identity', 'no-such-key-file']), /identity/);
  assert.throws(() => parseArgs(['--tailscale-name', 'vps-example-1', '--x']), /unknown/);
});

test('pc-fetch-token: remote output must be exactly token + port, otherwise nothing is used', () => {
  assert.deepEqual(parseRemoteOutput(`${TOK}\n8446\n`), { token: TOK, port: '8446' });
  assert.deepEqual(parseRemoteOutput(`${TOK}\r\n8446\r\n`), { token: TOK, port: '8446' });
  assert.deepEqual(parseRemoteOutput('ABORT no staging token\n'), { token: null, port: null });
  assert.deepEqual(parseRemoteOutput(`${TOK}\n`), { token: null, port: null });
  assert.deepEqual(parseRemoteOutput(`noise\n${TOK}\n8446\n`), { token: null, port: null });
});

test('pc-fetch-token: one read-only ssh (token phase + serve port), no BatchMode so a password prompt works', () => {
  const a = sshArgs({ sshUser: 'root', identity: null }, '100.64.0.1');
  assert.equal(a.at(-1), REMOTE_COMMAND);
  assert.equal(REMOTE_COMMAND, 'bash /root/e-nexus-staging-inbox/kit/stage.sh token && cat /var/lib/e-nexus-staging/state/serve_port');
  assert.ok(!a.includes('BatchMode=yes'));
  assert.deepEqual(sshArgs({ sshUser: 'root', identity: 'k' }, '100.64.0.1').slice(0, 2), ['-i', 'k']);
});

test('pc-fetch-token: the token is never printed; stored under the same target as run.mjs', () => {
  const s = readFileSync(new URL('../deploy/vps-staging/pc-fetch-token.mjs', import.meta.url), 'utf8');
  const code = s.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
  assert.ok(!code.some((l) => /console\.(log|error)\([^)]*\$\{token\}/.test(l)), 'never logs the token');
  assert.ok(code.some((l) => l.includes('storeWindowsCredential(CREDENTIAL_TARGET, token)')));
  assert.ok(code.some((l) => /^\s*token = null;/.test(l)), 'the variable is cleared after use');
  assert.ok(code.some((l) => l.includes("stdio: ['inherit', 'pipe', 'inherit']")), 'stdout (token) is captured, never inherited');
  assert.equal(CREDENTIAL_TARGET, 'E-NEXUS/edl/gateway-token-staging');
});
