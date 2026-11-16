#!/usr/bin/env node
/**
 * Dropbox の資格情報を Keychain に入れる（2026-11-13・docs/dropbox-business.md §1）。**Human が Mac の Terminal で 1 回ずつ**（ブラウザで Dropbox に login して許可する）。
 *
 *   node scripts/dropbox-auth.mjs --role read  --app-key <読み取り専用の app の App key>
 *   node scripts/dropbox-auth.mjs --role write --app-key <App folder の app の App key>
 *
 * PKCE（client secret を使わない）・offline（refresh token）。許された scope を確かめる：
 *   read  ＝ files.content.write を持っていたら保存しない（read_app_can_write）＝読みの資格情報で書けないことを保証する
 *   write ＝ files.content.write が要る。App folder の app であることは App Console で Human が選ぶ（この script は y で確かめる）。
 *           読みの資格情報が先に入っていれば、自動でも確かめる（2026-11-16 監査）：Dropbox の一番上の項目を書きの token で引き、同じ id が見えたら
 *           Full Dropbox の app＝保存しない（write_app_not_app_folder）。**read を先に、write を後に**登録する
 * 保存：Keychain（E-NEXUS/edl/dropbox-<role>-app-key・-refresh-token・account e-nexus）。値は画面・引数に出さない（security -i の標準入力）
 * 確かめ：read は Dropbox の一番上の一覧の件数、write は App folder の一覧の件数だけを出す（名前は出さない）
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDropbox, KEYCHAIN_NAMES } from './lib/dropbox/client.mjs';
import { dropboxCredentials } from './lib/dropbox/keychain.mjs';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function pkce(rand = randomBytes) {
  const verifier = b64url(rand(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}
export function authorizeUrl(appKey, challenge) {
  const q = new URLSearchParams({ client_id: appKey, response_type: 'code', token_access_type: 'offline', code_challenge: challenge, code_challenge_method: 'S256' });
  return `https://www.dropbox.com/oauth2/authorize?${q}`;
}
/** 許された scope の検査（読み：書く scope を持たない・書き：書く scope を持つ） */
const ALLOWED_SCOPES = Object.freeze({
  read: new Set(['files.metadata.read', 'files.content.read', 'account_info.read']),
  write: new Set(['files.metadata.read', 'files.content.read', 'files.content.write', 'account_info.read']),
});
/** 許された scope の検査（allowlist：この表に無い scope〈削除・共有・file request など〉を 1 つでも持つ token は保存しない・監査 F8） */
export function checkScopes(role, scopeText) {
  const s = new Set(String(scopeText ?? '').split(/\s+/).filter(Boolean));
  if (!s.has('files.metadata.read') || !s.has('files.content.read')) return 'scope_read_missing';
  if (role === 'write' && !s.has('files.content.write')) return 'scope_write_missing';
  if ([...s].some((x) => !ALLOWED_SCOPES[role].has(x))) return role === 'read' ? 'read_app_too_broad' : 'write_app_too_broad';
  return null;
}
/**
 * 書きの app が App folder の app か（Dropbox 全体を見られないか）を確かめる。reader：読みの client（Full Dropbox）・writer：書きの client。
 * Dropbox の id は名前空間が違っても同じ物には同じ値：一番上の項目と同じ path を書きの token で引いて同じ id が返れば、書きの app も Dropbox 全体を見ている。
 * 'full_dropbox'（保存しない）／'app_folder'（1 件以上を引いて、どれも見えないか別の物）／'unverified'（一番上が空・引けなかった）。名前・id は返さない
 */
export async function writeAppNamespace(reader, writer, { max = 5 } = {}) {
  let top;
  try { top = await reader.list('', { limit: 20, ids: true }); } catch { return 'unverified'; }
  let checked = 0;
  for (const e of top.entries.filter((x) => typeof x.id === 'string' && typeof x.path === 'string').slice(0, max)) {
    let m;
    try { m = await writer.metadata(e.path, { ids: true }); } catch (err) {
      if (/_not_found$/.test(String(err?.code ?? ''))) { checked += 1; continue; }
      return 'unverified';
    }
    if (m.id === e.id) return 'full_dropbox';
    checked += 1;
  }
  return checked ? 'app_folder' : 'unverified';
}

/** Keychain に入れる（値は security -i の標準入力・引数に置かない） */
export function storeKeychain(name, value, run = spawnSync) {
  if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(value)) return false;
  const r = run('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a e-nexus -s E-NEXUS/edl/${name} -w ${value}\n`, encoding: 'utf8', timeout: 20_000, stdio: ['pipe', 'ignore', 'ignore'] });
  return r.status === 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const role = opt('--role');
  const appKey = opt('--app-key');
  if (!['read', 'write'].includes(role) || !/^[a-z0-9]{8,40}$/.test(appKey ?? '')) { console.error('usage: node scripts/dropbox-auth.mjs --role read|write --app-key <App key>'); process.exit(2); }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) { console.error('端末で実行してください'); process.exit(2); }
  const { verifier, challenge } = pkce();
  console.log(`1. ブラウザでこの URL を開き、Dropbox に login して「許可」を押す：\n${authorizeUrl(appKey, challenge)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question('2. 表示された「アクセス コード」を貼って Enter：')).trim();
  if (role === 'write') {
    const yes = (await rl.question('3. この app は App Console で「App folder」を選んだ app ですか（y/N）：')).trim();
    if (yes !== 'y') { console.log('止めました（write は App folder の app だけ）'); process.exit(1); }
  }
  rl.close();
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: verifier, client_id: appKey }), signal: AbortSignal.timeout(30_000) });
  let j = null;
  try { j = await res.json(); } catch { /* 空 */ }
  if (!res.ok || typeof j?.refresh_token !== 'string') { console.log(`止めました：token を受け取れなかった（HTTP ${res.status}）`); process.exit(1); }
  const bad = checkScopes(role, j.scope);
  if (bad) { console.log(`止めました：${bad}（App Console の Permissions を docs/dropbox-business.md §1 のとおりにして Submit → もう一度）`); process.exit(1); }
  if (role === 'write') {
    // 保存の前に：App folder の app であることを、読みの資格情報があれば自動で確かめる
    const readCreds = dropboxCredentials('read');
    if (!readCreds) console.log('注意：読みの資格情報がまだ無いので、App folder の app であることを自動では確かめられない（上の y の答えだけ）。--role read を先に登録してから、もう一度 --role write を実行すると確かめられる');
    else {
      const v = await writeAppNamespace(createDropbox({ role: 'read', credentials: readCreds }), createDropbox({ role: 'write', credentials: { appKey, refreshToken: j.refresh_token } }));
      if (v === 'full_dropbox') { console.log('止めました：write_app_not_app_folder（この app は Dropbox 全体が見える。App Console で Access type が「App folder」の app を作り直す。docs/dropbox-business.md §1）'); process.exit(1); }
      if (v === 'unverified') { console.log('止めました：App folder の app であることを確かめられなかった（通信・Dropbox の一番上が空）。もう一度実行する（続くなら Claude Code に伝える）'); process.exit(1); }
      console.log('確かめ：書きの app からは Dropbox の一番上の項目が見えない（App folder の app）');
    }
  }
  const n = KEYCHAIN_NAMES[role];
  if (!storeKeychain(n.appKey, appKey) || !storeKeychain(n.refreshToken, j.refresh_token)) { console.log('止めました：Keychain に入れられなかった'); process.exit(1); }
  try {
    const c = createDropbox({ role, credentials: { appKey, refreshToken: j.refresh_token } });
    const r = await c.list('', { limit: 200 });
    console.log(`OK：${role} の資格情報を Keychain に入れた。確かめ：${role === 'read' ? 'Dropbox の一番上' : 'App folder'} の項目 ${r.entries.length}${r.truncated ? '+' : ''} 件（名前は出さない）`);
  } catch (e) {
    console.log(`Keychain には入れた。確かめの一覧で失敗：${e?.code ?? 'error'}（Claude Code に伝える）`);
    process.exitCode = 1;
  }
}
