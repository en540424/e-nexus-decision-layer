#!/usr/bin/env node
/**
 * Mac Runtime の暗号化バックアップ（2026-11-05・H5）。保存先は GitHub の専用 Private repo。AI／課金なし。Time Machine の代わりではない（Mac 全体は戻らない）。
 *
 *   node scripts/backup-run.mjs plan --deny-file <abs> [--json]                  選別の結果だけ（送らない・Keychain に触れない）
 *   node scripts/backup-run.mjs check --owner <o> --repo <r> --deny-file <abs>   送る条件を全部確かめる（送らない）
 *   node scripts/backup-run.mjs run   --owner <o> --repo <r> --deny-file <abs>   1 回分（条件が全部揃った時だけ送る）
 *   node scripts/backup-run.mjs verify --owner <o> --repo <r> --deny-file <abs>  保存済みのアーカイブ（最新と最古）を読み直して検証する（送らない・平文を画面へ出さない）
 *   node scripts/backup-run.mjs attest-key   標準入力の passphrase が Keychain と同じなら、Mac の外の控えがあると記録する（connect-backup.sh から）
 *   node scripts/backup-run.mjs restore --archive <file> --target <空のフォルダ>   標準入力の passphrase で復元する（Keychain を使わない。どの PC でも）
 *
 * 本番データを外へ送る条件（**1 つでも欠ければ送らない**・毎回確かめる）：
 *   1. 保存先が Private（API の private と visibility）
 *   2. token が fine-grained で、見える private repo が保存先だけ（一覧と、管理対象の private repo の個別の確認の両方）・公開の repo へ書けない・Administration の権限が無い（書けないことの確かめは run と check だけ。verify は送らないので確かめない）
 *   3. passphrase が Keychain にあり、Mac の外の控えの確認が済んでいる（passphrase を変えると確認も無効）
 *   4. 合成データの予行が通り、今回のアーカイブを手元で復元して全ファイルが一致する
 * 届いたことの実証：送った後に GitHub から読み直し、hash の一致と復号を確かめてから受領票（~/.enexus/backup/last.json）に restore_verified_at を書く。
 * 失敗は受領票に数え、host-health の backup_archive が知らせる（2 回続けば CRIT。ここからは Discord へ送らない）。
 * 保存済みの検証：VERIFY_EVERY_MS ごとに定期の回の中で最古の世代も読み直す（復号・全ファイルの hash・改ざんと鍵の誤りが拒まれること・除外の方針）。失敗は受領票の history_failure で host-health が知らせる。
 * token の期限：応答の header を受領票の token_expires_at に残す（host-health が事前に知らせる）。
 * 世代：lib/backup-plan.mjs の retentionPlan。消したものも Git の履歴に残る。repo が size_limit_kib を超えたら止めて知らせる（消すのは Human）。
 * 記録に出すのは件数・大きさ・コードだけ。パス・中身・鍵は出さない。
 * exit：0＝成功／1＝失敗／2＝引数／3＝条件が揃っていない（送っていない）
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BYTES, manifestOf, pack, restore, unpack } from './lib/backup-archive.mjs';
import { backupSources, planBackup, policyViolations, retentionPlan } from './lib/backup-plan.mjs';
import { readCredential } from './lib/env-file.mjs';
import { GITHUB_API, GITHUB_OWNER, GITHUB_TOKEN_PREFIX, isRateLimited } from './lib/github-guard.mjs';
import { BACKUP_RECEIPT_SCHEMA, defaultGuard } from './lib/runtime-guard.mjs';
import { runDrill } from './backup-drill.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASSPHRASE_CREDENTIAL = 'E-NEXUS/edl/backup-passphrase';
export const TOKEN_CREDENTIAL = 'E-NEXUS/edl/backup-token';
export const MIN_PASSPHRASE = 20;
export const MAX_ARCHIVE_BYTES = 20 * 1024 ** 2;
export const SIZE_LIMIT_KIB = 800 * 1024;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_DELETES = 5;
const HTTP_TIMEOUT_MS = 30_000;
const STALE_WORK_MS = 3_600_000;
/** 古い世代の読み直しの間隔（host-health の GUARD_LIMITS.history_days より短く） */
export const VERIFY_EVERY_MS = 30 * 24 * 3_600_000;
const backupDir = (home) => path.join(home, '.enexus', 'backup');
/** 平文の写しを置く場所。0700。強制終了の残骸は 1 時間たったものだけ消す（別の process の回の写しを消さない）。各回は下に自分の一時フォルダを作る */
export function workRoot(home, now = Date.now()) {
  const dir = path.join(backupDir(home), 'work');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    try {
      if (now - statSync(p).mtimeMs > STALE_WORK_MS) rmSync(p, { recursive: true, force: true });
    } catch { /* 別の回が消した */ }
  }
  return dir;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

class Stop extends Error {
  constructor(code, exit = 1) {
    super(code);
    this.code = code;
    this.exit = exit;
  }
}
const notReady = (code) => new Stop(code, 3);

/** Mac の外の控えの確認を記録する。passphrase そのものは残さず、変えたら無効になる指紋だけ */
export function attestKey({ home, typed, stored, at }) {
  if (!stored || typed !== stored) return false;
  const salt = randomBytes(16);
  const dir = backupDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'key-offsite.json'), `${JSON.stringify({ confirmed_at: at, salt: salt.toString('hex'), fingerprint: scryptSync(stored, salt, 32).toString('hex') })}\n`, { mode: 0o600 });
  return true;
}
export function keyAttested({ home, passphrase }) {
  try {
    const a = JSON.parse(readFileSync(path.join(backupDir(home), 'key-offsite.json'), 'utf8'));
    return timingSafeEqual(scryptSync(passphrase, Buffer.from(a.salt, 'hex'), 32), Buffer.from(a.fingerprint, 'hex'));
  } catch {
    return false;
  }
}

/** 宛先は api.github.com の固定。redirect に従わない。token は header だけ */
function makeApi({ token, fetchImpl, timeoutMs = HTTP_TIMEOUT_MS }) {
  let expires = null;
  const api = async (method, resource, { body = null, accept = 'application/vnd.github+json', raw = false } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${GITHUB_API}${resource}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'e-nexus-backup', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const seen = Date.parse(res.headers?.get?.('github-authentication-token-expiration'));
      if (Number.isFinite(seen)) expires = new Date(seen).toISOString();
      if (raw) return { status: res.status, bytes: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null };
      return { status: res.status, limited: isRateLimited(res), json: await res.json().catch(() => null) };
    } catch {
      throw new Stop('github_unreachable');
    } finally {
      clearTimeout(timer);
    }
  };
  api.tokenExpiresAt = () => expires;
  return api;
}

/**
 * 条件 1・2・3。戻り値は送るのに使うもの。揃わなければ notReady を投げる。
 * 公開の repo へ書けないことは、必ず失敗する要求でしか確かめられない（実測 2026-11-07：GET の permissions は token でなく人の権限を返す。fine-grained の権限は値を変えずに編集できる）。
 * 送らない回（verify）は writeProbe: false で、公開の repo へ要求を出さない。
 */
export async function checkGates({ owner, repo, home, otherRepos, read = readCredential, fetchImpl = globalThis.fetch, writeProbe = true }) {
  const passphrase = await read(PASSPHRASE_CREDENTIAL).catch(() => null);
  if (!passphrase) throw notReady('no_passphrase');
  if (passphrase.length < MIN_PASSPHRASE) throw notReady('weak_passphrase');
  if (!keyAttested({ home, passphrase })) throw notReady('key_not_attested');
  const token = await read(TOKEN_CREDENTIAL).catch(() => null);
  if (!token) throw notReady('no_token');
  if (!token.startsWith(GITHUB_TOKEN_PREFIX)) throw notReady('token_not_fine_grained');
  const api = makeApi({ token, fetchImpl });
  const r = await api('GET', `/repos/${owner}/${repo}`);
  if (r.status === 401 || r.status === 403) throw notReady('token_rejected');
  if (r.status !== 200) throw notReady('repo_not_found');
  if (r.json?.private !== true || r.json?.visibility !== 'private') throw notReady('repo_not_private');
  if (!otherRepos?.length) throw notReady('scope_unverified');
  // 見える repo の一覧で確かめる（標本の確認だけでは他の repo が見える token を通す）。読めなければ確かめられないので送らない
  const list = await api('GET', '/user/repos?visibility=private&per_page=100');
  if (list.status !== 200 || !Array.isArray(list.json) || !list.json.some((x) => x?.name === repo)) throw notReady('scope_unverified');
  if (list.json.some((x) => x?.name !== repo)) throw notReady('token_too_broad');
  for (const name of otherRepos) {
    const other = await api('GET', `/repos/${owner}/${name}`);
    if (other.status === 200 && other.json?.private === false) {
      if (!writeProbe) continue;
      // 公開の repo は誰でも見えるので、書けないことを確かめる（不正な ref は 422 で、何も作られない。token の範囲の外なら 403／404。レート制限の 403 は答えでない）
      const probe = await api('POST', `/repos/${owner}/${name}/git/refs`, { body: { ref: 'invalid', sha: '0'.repeat(40) } });
      if (probe.status >= 500 || probe.limited) throw notReady('scope_unverified');
      if (![403, 404].includes(probe.status)) throw notReady('token_too_broad');
      continue;
    }
    if (other.status === 200) throw notReady('token_too_broad');
    if (other.status !== 404) throw notReady('scope_unverified'); // 確かめられなければ送らない
  }
  const keys = (await api('GET', `/repos/${owner}/${repo}/keys`)).status; // Administration の権限
  if (keys === 200) throw notReady('token_too_broad');
  if (keys !== 403 && keys !== 404) throw notReady('scope_unverified');
  if (r.json.size > SIZE_LIMIT_KIB) throw new Stop('repo_too_large');
  return { passphrase, api, branch: r.json.default_branch ?? 'main', empty: !r.json.pushed_at || r.json.size === 0 };
}

/** 選別したファイルを一時フォルダへ写してアーカイブにし、手元で復元して一致を確かめる（条件 4）。files は planBackup の結果 */
export function buildArchive({ files, passphrase, tmpRoot, drill = runDrill }) {
  if (!drill().ok) throw notReady('drill_failed');
  const root = mkdtempSync(path.join(tmpRoot, 'run-'));
  try {
    const stage = path.join(root, 'stage');
    for (const f of files) {
      const dst = path.join(stage, f.id, f.rel);
      mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      writeFileSync(dst, f.body, { mode: 0o600 }); // 検査した本文そのもの
    }
    const archive = pack(stage, passphrase);
    if (archive.length > MAX_ARCHIVE_BYTES || archive.length > MAX_BYTES) throw new Stop('archive_too_large');
    const out = path.join(root, 'restored');
    restore(archive, passphrase, out);
    const restored = manifestOf(out);
    if (restored.length !== files.length || JSON.stringify(manifestOf(stage)) !== JSON.stringify(restored)) throw notReady('local_restore_mismatch');
    return archive;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const archiveName = (at) => `${at.slice(0, 10)}T${at.slice(11, 13)}${at.slice(14, 16)}Z.edlbk`;

async function upload({ api, owner, repo, name, archive, passphrase }) {
  const file = `/repos/${owner}/${repo}/contents/archives/${name}`;
  const put = await api('PUT', file, { body: { message: `backup ${name.slice(0, 10)}`, content: archive.toString('base64'), committer: { name: 'E-NEXUS backup', email: 'noreply@users.noreply.github.com' } } });
  if (put.status !== 201 && put.status !== 200) throw new Stop(put.status === 403 ? 'token_cannot_write' : 'upload_failed');
  const back = await api('GET', file, { accept: 'application/vnd.github.raw+json', raw: true });
  if (back.status !== 200 || sha256(back.bytes) !== sha256(archive)) throw new Stop('read_back_mismatch');
  unpack(back.bytes, passphrase); // 改ざん・鍵の違いはここで投げる
}

const STORED_FAILURES = Object.freeze(['read_back_mismatch', 'archive_unreadable', 'file_hash_mismatch', 'tamper_not_detected', 'wrong_key_not_refused', 'policy_violation', 'nothing_stored']);

/** Git の blob の hash（一覧の sha と読み直した中身の照合） */
const blobSha = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

/**
 * 保存済みの 1 世代の検証。平文はメモリの上だけ（除外の方針の grep だけ work の一時フォルダを使う）。戻り値は件数だけ。
 * 確かめること：復号できる・全ファイルの hash が合う・1 byte 変えると拒まれる・別の passphrase で拒まれる・除外の方針に反するファイルが無い。
 */
export function verifyArchive({ bytes, passphrase, scan }) {
  const files = unpack(bytes, passphrase);
  for (const f of files) {
    if (sha256(Buffer.from(f.data, 'base64')) !== f.sha256) throw new Stop('file_hash_mismatch');
  }
  const refused = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const flipped = Buffer.from(bytes);
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  if (!refused(() => unpack(flipped, passphrase))) throw new Stop('tamper_not_detected');
  if (!refused(() => unpack(bytes, `${passphrase}x`))) throw new Stop('wrong_key_not_refused');
  let violations;
  try {
    // 名前は plan の時と同じ形（先頭の対象の id を除く）で見る
    violations = scan(files.map((f) => ({ rel: f.path.slice(f.path.indexOf('/') + 1), body: Buffer.from(f.data, 'base64') })));
  } catch {
    throw new Stop('policy_scan_failed'); // deny を読めないなど手元の問題。保存物の異常ではない
  }
  if (violations) throw new Stop('policy_violation');
  return { files: files.length, bytes: bytes.length };
}

async function storedArchives({ api, owner, repo }) {
  const list = await api('GET', `/repos/${owner}/${repo}/contents/archives`);
  if (list.status !== 200 || !Array.isArray(list.json)) throw new Stop('archives_unreadable');
  return list.json.filter((e) => /^\d{4}-\d{2}-\d{2}T\d{4}Z\.edlbk$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
}

async function verifyStored({ api, owner, repo, entry, passphrase, scan }) {
  const back = await api('GET', `/repos/${owner}/${repo}/contents/archives/${entry.name}`, { accept: 'application/vnd.github.raw+json', raw: true });
  if (back.status !== 200 || blobSha(back.bytes) !== entry.sha) throw new Stop('read_back_mismatch');
  try {
    return verifyArchive({ bytes: back.bytes, passphrase, scan });
  } catch (err) {
    throw err instanceof Stop ? err : new Stop('archive_unreadable'); // 改ざん・鍵の違い
  }
}

/** 最新と最古を検証する（同じなら 1 つ）。受領票の history_verified_at を進める。失敗は history_failure に残す（毎日の回の成否は変えない） */
export async function verifyBackups({ owner, repo, home, otherRepos, scan, read = readCredential, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const receipt = path.join(backupDir(home), 'last.json');
  const at = now().toISOString();
  try {
    const { passphrase, api } = await checkGates({ owner, repo, home, otherRepos, read, fetchImpl, writeProbe: false });
    const stored = await storedArchives({ api, owner, repo });
    if (!stored.length) throw new Stop('nothing_stored');
    const picks = [...new Set([stored.at(-1), stored[0]])];
    const rows = [];
    for (const entry of picks) rows.push({ archive: entry.name, ...(await verifyStored({ api, owner, repo, entry, passphrase, scan })) });
    writeReceipt(receipt, { ...readReceipt(receipt), history_verified_at: at, history_failure: null, token_expires_at: api.tokenExpiresAt() });
    return { code: 0, status: 'verified', stored: stored.length, rows, tamper_detected: true, wrong_key_refused: true, policy_violations: 0 };
  } catch (err) {
    const code = err instanceof Stop ? err.code : 'verify_failed';
    // 保存物の異常だけ受領票へ。Keychain を読めない・通信の失敗で正常な受領票を壊さない（定期の回は次の日にもう一度）
    const prev = readReceipt(receipt);
    if (prev && STORED_FAILURES.includes(code)) writeReceipt(receipt, { ...prev, history_failure: code });
    return { code: err instanceof Stop ? err.exit : 1, status: 'failed', failure: code };
  }
}

/** 世代の整理。失敗しても 1 回分は成功のまま（次の回にもう一度） */
async function prune({ api, owner, repo, current }) {
  const list = await api('GET', `/repos/${owner}/${repo}/contents/archives`);
  if (list.status !== 200 || !Array.isArray(list.json)) return 0;
  const sha = new Map(list.json.map((e) => [e.name, e.sha]));
  let deleted = 0;
  for (const name of retentionPlan([...sha.keys()], { keep: current }).slice(0, MAX_DELETES)) {
    const d = await api('DELETE', `/repos/${owner}/${repo}/contents/archives/${name}`, { body: { message: `prune ${name.slice(0, 10)}`, sha: sha.get(name), committer: { name: 'E-NEXUS backup', email: 'noreply@users.noreply.github.com' } } });
    if (d.status === 200) deleted += 1;
  }
  return deleted;
}

function readReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function writeReceipt(file, body) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: BACKUP_RECEIPT_SCHEMA, ...body }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** 毎回の受領票へ持ち越す項目（古い世代の検証と token の期限） */
const keptFields = (prev) => Object.fromEntries(['history_verified_at', 'history_failure', 'token_expires_at'].filter((k) => prev?.[k] != null).map((k) => [k, prev[k]]));

/** 1 回分。plan・read・fetchImpl・now を差し替えて test する（実データも GitHub も使わずに回せる） */
export async function runBackup({ owner, repo, home, otherRepos, planFiles, scan = null, read = readCredential, fetchImpl = globalThis.fetch, now = () => new Date(), drill = runDrill }) {
  const at = now().toISOString();
  const receipt = path.join(backupDir(home), 'last.json');
  const prev = readReceipt(receipt);
  try {
    const tmpRoot = workRoot(home); // 残骸の掃除は条件より先（条件が落ち続ける間も平文を残さない）
    const { passphrase, api } = await checkGates({ owner, repo, home, otherRepos, read, fetchImpl });
    const plan = planFiles(tmpRoot);
    if (!plan.files.length) throw new Stop('nothing_to_back_up');
    const archive = buildArchive({ files: plan.files, passphrase, tmpRoot, drill });
    const name = archiveName(at);
    await upload({ api, owner, repo, name, archive, passphrase });
    const pruned = await prune({ api, owner, repo, current: name }).catch(() => 0);
    const done = now().toISOString();
    writeReceipt(receipt, { ...keptFields(prev), finished_at: done, restore_verified_at: done, archive: name, bytes: archive.length, files: plan.files.length, excluded: plan.excluded, consecutive_failures: 0, last_failure_code: null, token_expires_at: api.tokenExpiresAt() }); // header のとおり（期限なしの token へ替えた時に古い期限を残さない）
    // 古い世代も戻せることの定期の確かめ。失敗しても今回の回は成功のまま（受領票の history_failure で host-health が知らせる）
    const last = Date.parse(prev?.history_verified_at);
    const due = scan && !(Date.parse(at) - last < VERIFY_EVERY_MS);
    const history = due ? await verifyBackups({ owner, repo, home, otherRepos, scan: (rows) => scan(tmpRoot, rows), read, fetchImpl, now }) : null;
    return { code: 0, status: 'ok', archive: name, bytes: archive.length, files: plan.files.length, excluded: plan.excluded, pruned, ...(history ? { history: history.status } : {}) };
  } catch (err) {
    const code = err instanceof Stop ? err.code : 'backup_failed'; // message にはパスが入る。記録へ出さない
    writeReceipt(receipt, { ...keptFields(prev), finished_at: prev?.finished_at ?? null, restore_verified_at: prev?.restore_verified_at ?? null, consecutive_failures: (prev?.consecutive_failures ?? 0) + 1, last_failure_code: code, failed_at: at });
    return { code: err instanceof Stop ? err.exit : 1, status: 'failed', failure: code };
  }
}

function parse(argv) {
  const a = { command: argv[0] };
  const map = { '--owner': 'owner', '--repo': 'repo', '--deny-file': 'denyFile', '--archive': 'archive', '--target': 'target' };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--json') { a.json = true; continue; }
    if (!map[argv[i]] || argv[i + 1] === undefined) throw new Error(`unknown argument: ${argv[i]}`);
    a[map[argv[i]]] = argv[i + 1];
    i += 1;
  }
  return a;
}

export function validate(a) {
  const errors = [];
  if (!['plan', 'check', 'run', 'verify', 'attest-key', 'restore'].includes(a.command)) errors.push('command must be plan|check|run|verify|attest-key|restore');
  if (['check', 'run', 'verify'].includes(a.command)) {
    if (!GITHUB_OWNER.test(a.owner ?? '')) errors.push('--owner is required');
    if (!REPO_NAME.test(a.repo ?? '')) errors.push('--repo is required');
  }
  if (['plan', 'check', 'run', 'verify'].includes(a.command) && !path.isAbsolute(a.denyFile ?? '')) errors.push('--deny-file must be an absolute path');
  if (a.command === 'restore' && (!a.archive || !a.target)) errors.push('restore needs --archive and --target');
  return errors;
}

const readStdin = () => readFileSync(0, 'utf8').replace(/\r?\n$/, '');

async function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validate(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  const home = homedir();
  const log = (o) => console.log(JSON.stringify({ component: 'edl-backup', ...o }));
  if (a.command === 'restore') {
    try {
      log({ status: 'restored', files: restore(readFileSync(a.archive), readStdin(), a.target) });
      return 0;
    } catch {
      log({ status: 'failed', failure: 'restore_failed' }); // 改ざん・passphrase の誤り・空でない先
      return 1;
    }
  }
  if (a.command === 'attest-key') {
    const ok = attestKey({ home, typed: readStdin(), stored: await readCredential(PASSPHRASE_CREDENTIAL).catch(() => null), at: new Date().toISOString() });
    log({ status: ok ? 'attested' : 'mismatch' });
    return ok ? 0 : 1;
  }
  const g = defaultGuard(REPO);
  const planFiles = (tmpRoot) => planBackup({ sources: backupSources({ base: g.base, home, repoRoot: REPO }), denyText: readFileSync(a.denyFile, 'utf8'), tmpRoot });
  if (a.command === 'plan') {
    const p = planFiles(workRoot(home));
    log({ status: 'planned', files: p.files.length, bytes: p.bytes, excluded: p.excluded, by_source: Object.fromEntries(Object.entries(Object.groupBy(p.files, (f) => f.id)).map(([k, v]) => [k, v.length])), ...(a.json ? { rels: p.files.map((f) => `${f.id}/${f.rel}`) } : {}) });
    return 0;
  }
  const otherRepos = g.repos.filter((r) => r !== a.repo);
  if (a.command === 'check') {
    try {
      await checkGates({ owner: a.owner, repo: a.repo, home, otherRepos });
      const p = planFiles(workRoot(home));
      log({ status: 'ready', files: p.files.length, bytes: p.bytes, excluded: p.excluded });
      return 0;
    } catch (err) {
      log({ status: 'not_ready', failure: err instanceof Stop ? err.code : 'check_failed' });
      return err instanceof Stop ? err.exit : 1;
    }
  }
  const scan = (tmpRoot, rows) => policyViolations(rows, readFileSync(a.denyFile, 'utf8'), tmpRoot);
  if (a.command === 'verify') {
    const tmpRoot = workRoot(home);
    const v = await verifyBackups({ owner: a.owner, repo: a.repo, home, otherRepos, scan: (rows) => scan(tmpRoot, rows) });
    log(Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'code')));
    return v.code;
  }
  const r = await runBackup({ owner: a.owner, repo: a.repo, home, otherRepos, planFiles, scan });
  log(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'code')));
  return r.code;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
