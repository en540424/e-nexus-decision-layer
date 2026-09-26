/**
 * E-NEXUS Consumer Integration Kit：Node 用 CLI transport の reference implementation（2026-09-26）。
 *
 * 既存 2 consumer（en-generate-hub `src/decision-gateway-client.mjs`・en-sns-hub `src/growth-decision.mjs`）で
 * 同じ形に書かれていた「別 process の Gateway CLI を呼ぶ部分」だけを抽出したもの。新機能は足していない。
 * 標準（何を consumer が持ち、何を持たないか）は docs/gateway.md §9。挙動の合否は consumer-kit/conformance/ の
 * 言語非依存 cases で決める（Python 等の他言語 adapter も同じ cases を通す）。
 *
 * 持つもの（transport 契約）：
 *   - `gateway decide --stdin` を子 process で起動し、request は stdin で渡す（argv に載せない）
 *   - 子 process の env は allowlist：OS の最低限 + EDL_* + Gateway repo の policies/gateway/engine-env.json の名前
 *     （Decision Engine 固有の env 名はこのファイルに書かない。engine を替えるときは manifest だけ変わる）
 *   - consumer 自身の Secret は manifest に関係なく渡さない（neverForward は consumer が指定する）
 *   - timeout（既定 35s＝Gateway 側 30s より長く、Gateway の構造化 envelope を先に受け取る）
 *   - 起動失敗・timeout・stdout 不正・非 v1 envelope は throw せず fail-closed の envelope（human-required）
 *   - local CLI transport は PERSONAL / DEV 専用：expected_environment は `dev` だけ。envelope の gateway.environment を照合
 * 持たないもの（consumer 固有）：input の組み立て・outcome の正規化・表示・Decision Point の検出・承認系
 *
 * 使い方：新しい Node consumer はこのファイルをコピーして持つ（repo をまたぐ runtime import はしない。
 * consumer 側の Secret を Gateway repo のコードへ見せないため）。コピー元の版はファイル先頭の KIT_VERSION で示す。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const KIT_VERSION = '1';
export const CONTRACT_VERSION = '1';
export const DEFAULT_TIMEOUT_MS = 35000;
export const RUNTIME_ENVIRONMENTS = Object.freeze(['dev', 'staging', 'production']);
/** local CLI / SDK の同居実行が名乗れる環境（docs/gateway.md §12） */
export const LOCAL_TRANSPORT_ENVIRONMENTS = Object.freeze(['dev']);
export const ENGINE_ENV_MANIFEST = path.join('policies', 'gateway', 'engine-env.json');
export const OS_ENV_KEYS = Object.freeze(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG']);
const GATEWAY_NAMESPACE_PREFIX = 'EDL_';

// ------------------------------------------------------------------ 場所・env

/** Gateway repo の場所：env EDL_HOME → 呼び出し側の既定値 */
export function resolveEdlHome(env = process.env, defaultEdlHome) {
  const v = env.EDL_HOME && env.EDL_HOME.trim() !== '' ? env.EDL_HOME : defaultEdlHome;
  if (!v) return null;
  return path.resolve(v);
}

/** engine-env manifest（env の「名前」だけ）を読む。読めない・形が違えば空（= EDL_* のみ → engine は human へ倒れる） */
export function loadEngineEnvSpec(edlHome) {
  const empty = { prefixes: [], names: [] };
  if (!edlHome) return empty;
  try {
    const doc = JSON.parse(readFileSync(path.join(edlHome, ENGINE_ENV_MANIFEST), 'utf8'));
    const prefixes = doc?.forward?.prefixes;
    const names = doc?.forward?.names;
    if (!Array.isArray(prefixes) || !Array.isArray(names)) return empty;
    if (!prefixes.every((p) => typeof p === 'string' && /^[A-Z][A-Z0-9]*_$/.test(p))) return empty;
    if (!names.every((n) => typeof n === 'string' && /^[A-Z][A-Z0-9_]*$/.test(n))) return empty;
    return { prefixes, names };
  } catch {
    return empty;
  }
}

/** 子 process へ渡す env（allowlist）。neverForward（consumer 自身の Secret）は manifest より優先して落とす */
export function buildChildEnv(env = process.env, spec = { prefixes: [], names: [] }, neverForward = null) {
  const out = {};
  const prefixes = [GATEWAY_NAMESPACE_PREFIX, ...spec.prefixes];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (neverForward && neverForward.test(k)) continue;
    if (OS_ENV_KEYS.includes(k) || spec.names.includes(k) || prefixes.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ fail-closed envelope・環境

export function unavailableEnvelope(code, request, { kind = 'gateway_unreachable', retryable } = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    ok: false,
    request_id: request?.request_id ?? null,
    correlation_id: request?.correlation_id ?? null,
    decision: null,
    error: { code, kind, retryable: retryable ?? (code !== 'GATEWAY_NOT_FOUND') },
    failure: { policy: 'human-required', human_required: true, proceed_automatically: false },
    gateway: null,
  };
}

/** local CLI transport で接続してよい環境か。ok:false は Gateway を呼ばずに fail-closed にする */
export function resolveLocalTransportEnvironment(requested = 'dev') {
  if (!RUNTIME_ENVIRONMENTS.includes(requested)) {
    return { ok: false, code: 'ENVIRONMENT_UNKNOWN', message: `environment=${JSON.stringify(requested)} は dev|staging|production のどれでもありません` };
  }
  if (!LOCAL_TRANSPORT_ENVIRONMENTS.includes(requested)) {
    return { ok: false, code: 'ENVIRONMENT_NOT_SUPPORTED_BY_TRANSPORT', message: `${requested} は local CLI（PERSONAL / DEV）の Gateway へは接続しません（${requested} 用 Gateway は Human Required）` };
  }
  return { ok: true, environment: requested };
}

/**
 * Gateway が返した envelope を consumer が信じてよいかの最終確認。
 * ok:true でも gateway.environment が期待と違う／欠けていれば ENVIRONMENT_MISMATCH の fail-closed へ置き換える。
 */
export function verifyEnvelope(envelope, expectedEnvironment, request = null) {
  if (!envelope || typeof envelope !== 'object' || envelope.contract_version !== CONTRACT_VERSION || typeof envelope.ok !== 'boolean') {
    return unavailableEnvelope('GATEWAY_BAD_RESPONSE', request);
  }
  if (!envelope.ok) return envelope;
  if (!envelope.decision || typeof envelope.decision !== 'object') return unavailableEnvelope('GATEWAY_BAD_RESPONSE', request);
  if (envelope.gateway?.environment !== expectedEnvironment) {
    return unavailableEnvelope('ENVIRONMENT_MISMATCH', envelope, { kind: 'environment_mismatch', retryable: false });
  }
  return envelope;
}

// ------------------------------------------------------------------ transport

/**
 * @param {object} opts
 * @param {string} [opts.defaultEdlHome] EDL_HOME が無いときの Gateway repo の場所
 * @param {RegExp} [opts.neverForward] consumer 自身の Secret 名（例 /^(FAL_|WAVESPEED_)/）
 * @param {string} [opts.environment] 期待する実行環境（local CLI は 'dev' のみ）
 * @param {number} [opts.timeoutMs]
 */
export function createCliTransport({ defaultEdlHome, neverForward = null, environment = 'dev', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /**
   * request（Contract v1）を送り、検証済みの envelope を返す。失敗時も envelope（throw しない）。
   * request.expected_environment はこの transport の環境で上書きする（consumer が別の値を混ぜない）。
   */
  function call(request, { env = process.env, spawnImpl = spawn, timeoutMs: t = timeoutMs } = {}) {
    const resolved = resolveLocalTransportEnvironment(environment);
    if (!resolved.ok) {
      return Promise.resolve(unavailableEnvelope(resolved.code, request, { kind: 'environment_config', retryable: false }));
    }
    const req = { ...request, contract_version: CONTRACT_VERSION, expected_environment: resolved.environment };
    const edlHome = resolveEdlHome(env, defaultEdlHome);
    const cli = edlHome ? path.join(edlHome, 'src', 'cli.mjs') : null;
    if (!cli || !existsSync(cli)) return Promise.resolve(unavailableEnvelope('GATEWAY_NOT_FOUND', req));
    const childEnv = buildChildEnv(env, loadEngineEnvSpec(edlHome), neverForward);

    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      let child;
      try {
        child = spawnImpl(process.execPath, [cli, 'gateway', 'decide', '--stdin'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        return done(unavailableEnvelope('GATEWAY_SPAWN_FAILED', req));
      }
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        done(unavailableEnvelope('GATEWAY_TIMEOUT', req));
      }, t);
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', () => {}); // stderr は捨てる（表示・保存しない）
      child.on('error', () => done(unavailableEnvelope('GATEWAY_SPAWN_FAILED', req)));
      child.on('close', () => {
        let envelope = null;
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* fall through */ }
        // Gateway は ok:false でも envelope を返す（非0終了でも stdout を読む）
        done(verifyEnvelope(envelope, resolved.environment, req));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(req));
    });
  }
  return { call, environment };
}
