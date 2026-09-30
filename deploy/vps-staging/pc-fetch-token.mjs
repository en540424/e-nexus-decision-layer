#!/usr/bin/env node
/**
 * 2 台目以降の Windows PC（会社PC 等）：VPS staging Gateway の token を表示せずに資格情報マネージャーへ（2026-09-30）。
 * mac-fetch-token.sh の Windows 版。run.mjs（deploy 演習つき・staging service を入れ替える）を流さずに token だけを取る。
 * Human が実行する（SSH を開始するのは Human＝VPS 台帳§0-3。鍵でも password でもよい。ssh の確認・入力はこの端末にそのまま出る）：
 *
 *   node deploy/vps-staging/pc-fetch-token.mjs --tailscale-name <VPS の Tailscale 名> [--ssh-user root] [--identity <鍵ファイル>]
 *
 * 保存先は run.mjs と同じ E-NEXUS/edl/gateway-token-staging・同じ書き方（storeWindowsCredential：値は標準入力で渡し、読み戻して一致を確かめる）。
 * 表示するのは stored／failed と staging URL だけ。VPS で変えるものは無い（stage.sh token と serve_port を読むだけ・ssh は 1 回）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INBOX, CREDENTIAL_TARGET, TOKEN_RE, resolveTailnet, storeWindowsCredential } from './run.mjs';

export const SERVE_PORT_FILE = '/var/lib/e-nexus-staging/state/serve_port';
export const REMOTE_COMMAND = `bash ${INBOX}/kit/stage.sh token && cat ${SERVE_PORT_FILE}`;

export function parseArgs(argv) {
  const a = { tailscaleName: null, sshUser: 'root', identity: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--tailscale-name') a.tailscaleName = argv[++i] ?? null;
    else if (k === '--ssh-user') a.sshUser = argv[++i] ?? '';
    else if (k === '--identity') a.identity = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(a.tailscaleName ?? '')) throw new Error('usage: pc-fetch-token.mjs --tailscale-name <VPS> [--ssh-user root] [--identity <key file>]');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(a.sshUser)) throw new Error('--ssh-user: invalid user name');
  if (a.identity !== null && !fs.existsSync(a.identity)) throw new Error('--identity: file not found');
  return a;
}

/** ssh の出力（token の行・port の行）を分ける。形が違えば両方 null（token を半端に扱わない） */
export function parseRemoteOutput(out) {
  const lines = String(out ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length !== 2 || !TOKEN_RE.test(lines[0]) || !/^\d{2,5}$/.test(lines[1])) return { token: null, port: null };
  return { token: lines[0], port: lines[1] };
}

export function sshArgs({ sshUser, identity }, ip) {
  return [...(identity ? ['-i', identity] : []), '-o', 'ConnectTimeout=15', `${sshUser}@${ip}`, REMOTE_COMMAND];
}

async function main(argv) {
  if (process.platform !== 'win32') { console.log('Windows only (Mac: deploy/vps-staging/mac-fetch-token.sh)'); return 2; }
  let args;
  try { args = parseArgs(argv); } catch (err) { console.log(err.message); return 2; }
  let tailnet;
  try { tailnet = resolveTailnet(args.tailscaleName); } catch (err) { console.log(err.message); return 1; }
  // stdin・stderr は端末へ（host key 確認・password 入力を Human がする）。stdout だけを受け取り、表示しない。
  const r = spawnSync('ssh', sshArgs(args, tailnet.ip), { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', timeout: 180000 });
  let { token, port } = parseRemoteOutput(r.status === 0 ? r.stdout : '');
  if (!token) { console.log(`could not read the staging token (ssh exit ${r.status ?? 'timeout'})`); return 1; }
  const s = await storeWindowsCredential(CREDENTIAL_TARGET, token);
  token = null;
  console.log(s.ok ? `stored: ${CREDENTIAL_TARGET} (value not shown)` : `store failed: ${s.note}`);
  if (!s.ok) return 1;
  console.log(`staging URL: https://${tailnet.dns}:${port}  (environment=staging; consumer-kit: HttpTransport(url, credential:${CREDENTIAL_TARGET}, "staging"))`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.log(`ABORT ${err.message}`); process.exitCode = 1; });
