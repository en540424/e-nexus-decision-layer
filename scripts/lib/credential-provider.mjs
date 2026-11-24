/**
 * 資格情報の provider の選び（2026-11-24・将来の 1Password の入口。**1Password は未接続・未有効化**）。
 *
 * 既定は今の OS の資格情報ストア（macOS Keychain・Windows 資格情報マネージャー）。何も設定が無ければ、今までとまったく同じに動く。
 * 対応表（~/.enexus/credential-provider.json・Secret を含まない）に書いた target だけを 1Password の参照（op://…）から読む＝サービス単位で段階的に移せる。
 *
 *   { "v": 1, "onepassword": { "references": { "E-NEXUS/edl/<name>": "op://<vault>/<item>/<field>" } } }
 *
 * - 対応表に無い target は Keychain のまま（後方互換）。対応表に有る target は 1Password だけ（Keychain に黙って戻らない＝移したつもりで古い値を使わない）
 * - 1Password の CLI（op）が無い・sign-in していない・読めない時は ProviderError（code だけ・値も参照も出さない）
 * - 値は返すだけ。log・例外・結果に出さない。子 process の env は最低限（OP_SERVICE_ACCOUNT_TOKEN を親から継がない＝使う時は Human が決めた形で渡す）
 * - 承認（Task Hub の Human Gate）と資格情報の取り出しは別：ここは「許された処理が実行の時に読む」だけで、承認の判断をしない
 * - 1Password の 1 日の読みの上限（個人の account は 1 日 1,000 回など）があるので、5 分ごとの job が毎回読む資格情報は Keychain のまま置く
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_PROVIDER_FILE = path.join(homedir(), '.enexus', 'credential-provider.json');
const TARGET_RE = /^E-NEXUS\/edl\/[a-z0-9-]{1,64}$/;
// op://<vault>/<item>/<field>（[section/] を含めて 3〜4 部分）。空白・引用符・制御文字・.. は受けない
const OP_REF_RE = /^op:\/\/[A-Za-z0-9 _.-]{1,64}(?:\/[A-Za-z0-9 _.-]{1,64}){2,3}$/;
export const OP_BIN_CANDIDATES = ['/opt/homebrew/bin/op', '/usr/local/bin/op'];

export class ProviderError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** 対応表を読む。無ければ {}（＝全部 Keychain）。形が悪ければ ProviderError（黙って Keychain に戻らない） */
export function loadProviderMap({ file = DEFAULT_PROVIDER_FILE, read = (p) => readFileSync(p, 'utf8') } = {}) {
  let text;
  try { text = read(file); } catch (e) { if (e?.code === 'ENOENT') return {}; throw new ProviderError('provider_config_unreadable'); }
  let j;
  try { j = JSON.parse(text); } catch { throw new ProviderError('provider_config_invalid'); }
  if (!j || j.v !== 1 || typeof j !== 'object') throw new ProviderError('provider_config_invalid');
  const refs = j.onepassword?.references ?? {};
  if (typeof refs !== 'object' || Array.isArray(refs)) throw new ProviderError('provider_config_invalid');
  const out = {};
  for (const [target, ref] of Object.entries(refs)) {
    if (!TARGET_RE.test(target) || typeof ref !== 'string' || !OP_REF_RE.test(ref) || ref.includes('..')) throw new ProviderError('provider_config_invalid');
    out[target] = ref;
  }
  return out;
}

/** target をどこから読むか：{ provider: 'keychain' } か { provider: '1password', ref } */
export function routeOf(target, map) {
  if (!TARGET_RE.test(String(target))) throw new ProviderError('credential_target_invalid');
  return Object.hasOwn(map, target) ? { provider: '1password', ref: map[target] } : { provider: 'keychain' };
}

/** op の場所（無ければ null）。PATH は見ない（決まった場所だけ） */
export function findOp({ exists }) { return OP_BIN_CANDIDATES.find((p) => exists(p)) ?? null; }

const minimalEnv = () => { const e = {}; for (const k of ['HOME', 'PATH', 'TMPDIR', 'LANG']) if (process.env[k] !== undefined) e[k] = process.env[k]; return e; };

/** op read の結果の扱い（同期と非同期で共通）。値は返すだけ */
function fromOp({ error, status, stdout }) {
  if (error?.code === 'ENOENT') throw new ProviderError('provider_not_connected');
  if (error && error.code === 'ETIMEDOUT') throw new ProviderError('provider_timeout');
  if (error || status !== 0) throw new ProviderError('provider_read_failed'); // sign-in していない・参照が無い・権限が無い（区別は出さない）
  const v = String(stdout ?? '').replace(/\n$/, '');
  if (!v) throw new ProviderError('provider_read_failed');
  return v;
}

/** 1Password から 1 つ（同期・spawnSync）。Dropbox の資格情報の読み（同期）から使う */
export function readOnePasswordSync(ref, { spawn, opPath }) {
  if (!opPath) throw new ProviderError('provider_not_connected');
  const r = spawn(opPath, ['read', '--no-newline', ref], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], env: minimalEnv() });
  return fromOp({ error: r.error, status: r.status, stdout: r.stdout });
}

/** 1Password から 1 つ（非同期・execFile）。env file・監視の資格情報の読みから使う */
export function readOnePassword(ref, { execFileImpl, opPath, timeoutMs = 15_000 }) {
  if (!opPath) return Promise.reject(new ProviderError('provider_not_connected'));
  return new Promise((resolve, reject) => {
    execFileImpl(opPath, ['read', '--no-newline', ref], { env: minimalEnv(), timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => {
      try { resolve(fromOp({ error: err ? { code: err.killed ? 'ETIMEDOUT' : err.code } : null, status: err ? 1 : 0, stdout })); } catch (e) { reject(e); }
    });
  });
}
