/**
 * E-NEXUS Common Decision Gateway（2026-09-25・MA-30 次phase）。
 *
 * consumer（Claude Code・Cursor・Hermes・OpenAI系Agent・各App・LINE/CRM・SNS/Growth・Worker）と
 * Decision Engine を疎結合にする境界。入口面（SDK / CLI / HTTP / MCP）はすべてこの decide() を呼ぶ。
 *
 *   Common Decision Contract v1（docs/gateway.md）
 *     request  = 既存 DecisionRequest（schemas/common/decision-request.schema.json）
 *                + 任意 contract_version / request_id / correlation_id（via は Gateway が付ける）
 *     response = {
 *       contract_version, ok, request_id, correlation_id,
 *       decision,          // ok=true：既存 DecisionResult をそのまま（名前を複製しない。tier / human_gate.required / outcome を読む）
 *       error, failure,    // ok=false：構造化エラーと failure policy（human-required | deny。fail-open は存在しない）
 *       gateway: { via, environment, engine:{id,version,mode}, latency_ms, timestamp }
 *     }
 *
 * Gateway が持つもの：envelope 検証・request_id 採番・timeout・同時実行上限・failure policy・structured error・
 *   process 内 stats（health 用）。Decision の中身（schema / rules / routing / fallback / Human Gate / metering）は
 *   engine（既定＝Decision Layer core）の責務で、ここに重複実装しない。
 * Runtime environment（2026-09-26）：environment（dev|staging|production）は Gateway の runtime 設定（EDL_ENVIRONMENT・未設定は dev）で決まる。
 *   consumer が request に書いた environment は via と同じく上書きする。consumer は任意の expected_environment で「自分が想定している環境」を
 *   宣言でき、runtime と違えば ENVIRONMENT_MISMATCH（fail-closed）。CLI / SDK の同居実行は consumer の process env を継ぐので DEV 扱いであり、
 *   staging / production を名乗れるのは deploy された HTTP Gateway の runtime 設定だけ（docs/gateway.md §12）。
 * Gateway は承認しない。ok=true でも tier=auto でも、既存の Human-only ゲート（MA-17 承認・SNS 公開・Hub 更新ボタン等）は別。
 */
import { randomUUID } from 'node:crypto';
import { readJson } from '../schemas/loader.mjs';
import { createDecisionLayerEngine, assertEngineShape } from './engine.mjs';
import { resolveRuntimeEnvironment, isRuntimeEnvironment, RUNTIME_ENVIRONMENTS, DEFAULT_RUNTIME_ENVIRONMENT } from '../core/environment.mjs';
import { HumanGateViolationError, SchemaValidationError, DecisionLayerError } from '../core/errors.mjs';

export const GATEWAY_CONTRACT_VERSION = '1';
export const GATEWAY_VIAS = Object.freeze(['sdk', 'cli', 'http', 'mcp']);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_TIMEOUT_MS = 30000; // Vercel 経路の 429 retry（SDK backoff 込み 6.8〜7.5s 実測）を十分に超える
const DEFAULT_MAX_CONCURRENT = 4; // burst 5 連続で 429 を実測（2026-09-19）。それ未満に抑える

/** error.code → 分類。HTTP status は http-server が envelope から決める（Decision 結果と HTTP status を混同しない） */
const ERROR_KINDS = Object.freeze({
  SCHEMA_INVALID: { kind: 'invalid_request', retryable: false },
  UNKNOWN_DECISION_TYPE: { kind: 'invalid_request', retryable: false },
  INVALID_ENVELOPE: { kind: 'invalid_request', retryable: false },
  UNSUPPORTED_CONTRACT_VERSION: { kind: 'invalid_request', retryable: false },
  ENVIRONMENT_MISMATCH: { kind: 'environment_mismatch', retryable: false },
  HUMAN_GATE_VIOLATION: { kind: 'human_gate_violation', retryable: false },
  GATEWAY_TIMEOUT: { kind: 'timeout', retryable: true },
  GATEWAY_BUSY: { kind: 'busy', retryable: true },
  ENGINE_ERROR: { kind: 'engine_error', retryable: true },
});

export function loadFailurePolicy(policy = readJson('policies/gateway/failure-policy.json')) {
  const allowed = policy.allowed ?? [];
  const check = (v, where) => {
    if (!['human-required', 'deny'].includes(v) || !allowed.includes(v)) {
      throw new Error(`failure-policy: ${where}=${JSON.stringify(v)} is not allowed (fail-open does not exist)`);
    }
  };
  check(policy.default, 'default');
  for (const [k, v] of Object.entries(policy.overrides ?? {})) check(v, `overrides.${k}`);
  return policy;
}

export function failureFor(decisionType, policy) {
  const p = policy.overrides?.[decisionType] ?? policy.default;
  return {
    policy: p,
    human_required: true,
    proceed_automatically: false,
    note: p === 'deny'
      ? 'Decision unavailable: do not proceed with this action.'
      : 'Decision unavailable: fall back to the existing human check / existing gates. This is not an approval.',
  };
}

function classify(err) {
  let code;
  if (err instanceof HumanGateViolationError) code = 'HUMAN_GATE_VIOLATION';
  else if (err instanceof SchemaValidationError) code = 'SCHEMA_INVALID';
  else if (err instanceof DecisionLayerError && ERROR_KINDS[err.code]) code = err.code;
  else code = 'ENGINE_ERROR';
  const k = ERROR_KINDS[code];
  // message は識別子レベルに留める。engine 例外の生 message（URL・body が混ざり得る）は返さない
  const message = code === 'ENGINE_ERROR' ? 'decision engine failed' : err.message;
  const details = code === 'SCHEMA_INVALID' ? { errors: err.details?.errors ?? [] } : undefined;
  return { code, kind: k.kind, retryable: k.retryable, message, ...(details ? { details } : {}) };
}

function envelopeError(code, message) {
  const e = new DecisionLayerError(message, code);
  return e;
}

function newStats() {
  return {
    started_at: new Date().toISOString(),
    requests: 0, ok: 0, failed: 0, fallbacks: 0, human_tier: 0, in_flight: 0,
    errors_by_code: {}, by_decision_type: {}, by_via: {},
    latency_ms: { last: null, max: 0, total: 0 },
  };
}

export function createGateway({
  engine,
  env = process.env,
  failurePolicy = loadFailurePolicy(),
  timeoutMs = Number(env.EDL_GATEWAY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  maxConcurrent = Number(env.EDL_GATEWAY_MAX_CONCURRENT) || DEFAULT_MAX_CONCURRENT,
  now = () => new Date(),
  environment = resolveRuntimeEnvironment(env),
} = {}) {
  if (!isRuntimeEnvironment(environment)) throw new Error(`environment must be one of ${RUNTIME_ENVIRONMENTS.join('|')}`);
  const eng = assertEngineShape(engine ?? createDecisionLayerEngine({ env }));
  // mock-jev（verification）は配管検証専用。staging / production の runtime では使わない（DEV 以外で模擬判定を返さない）
  if (environment !== DEFAULT_RUNTIME_ENVIRONMENT && eng.mode !== 'production') {
    throw new Error(`engine mode ${JSON.stringify(eng.mode)} is not allowed in the ${environment} environment (verification / mock is dev-only)`);
  }
  loadFailurePolicy(failurePolicy);
  const stats = newStats();

  function gatewayBlock(via, started) {
    return {
      via,
      environment,
      engine: { id: eng.id, version: eng.version, mode: eng.mode },
      latency_ms: Date.now() - started,
      timestamp: now().toISOString(),
    };
  }

  function prepare(raw, via) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw envelopeError('INVALID_ENVELOPE', 'request must be a JSON object');
    const { contract_version: cv, expected_environment: expected, ...request } = raw;
    if (cv !== undefined && cv !== GATEWAY_CONTRACT_VERSION) {
      throw envelopeError('UNSUPPORTED_CONTRACT_VERSION', `contract_version ${JSON.stringify(cv)} is not supported (supported: "${GATEWAY_CONTRACT_VERSION}")`);
    }
    if (expected !== undefined) {
      if (!isRuntimeEnvironment(expected)) throw envelopeError('INVALID_ENVELOPE', `expected_environment must be one of ${RUNTIME_ENVIRONMENTS.join('|')}`);
      if (expected !== environment) {
        throw envelopeError('ENVIRONMENT_MISMATCH', `consumer expects the ${expected} environment but this Gateway runs in ${environment}`);
      }
    }
    for (const f of ['request_id', 'correlation_id']) {
      if (request[f] !== undefined && (typeof request[f] !== 'string' || !ID_PATTERN.test(request[f]))) {
        throw envelopeError('INVALID_ENVELOPE', `${f} must match ${ID_PATTERN}`);
      }
    }
    request.request_id ??= `req_${randomUUID()}`;
    request.via = via; // consumer 指定値は上書き（入口は Gateway が知っている）
    request.environment = environment; // 同上（環境は runtime が知っている。consumer の自由入力を信頼しない）
    return request;
  }

  async function decide(raw, { via = 'sdk' } = {}) {
    if (!GATEWAY_VIAS.includes(via)) throw new Error(`via must be one of ${GATEWAY_VIAS.join('|')}`);
    const started = Date.now();
    const decisionType = typeof raw?.decision_type === 'string' ? raw.decision_type : null;
    const requestId = typeof raw?.request_id === 'string' && ID_PATTERN.test(raw.request_id) ? raw.request_id : null;
    const correlationId = typeof raw?.correlation_id === 'string' && ID_PATTERN.test(raw.correlation_id) ? raw.correlation_id : null;
    stats.requests += 1;
    stats.by_via[via] = (stats.by_via[via] ?? 0) + 1;
    if (decisionType) stats.by_decision_type[decisionType] = (stats.by_decision_type[decisionType] ?? 0) + 1;

    let request;
    let timer;
    let acquired = false;
    try {
      request = prepare(raw, via);
      if (stats.in_flight >= maxConcurrent) throw envelopeError('GATEWAY_BUSY', `max concurrent decisions (${maxConcurrent}) reached`);
      stats.in_flight += 1;
      acquired = true;
      const decision = await Promise.race([
        eng.decide(request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(envelopeError('GATEWAY_TIMEOUT', `decision exceeded ${timeoutMs}ms`)), timeoutMs); }),
      ]);
      stats.ok += 1;
      if (decision.fallback?.occurred) stats.fallbacks += 1;
      if (decision.tier === 'human') stats.human_tier += 1;
      const g = gatewayBlock(via, started);
      recordLatency(g.latency_ms);
      return {
        contract_version: GATEWAY_CONTRACT_VERSION,
        ok: true,
        request_id: request.request_id,
        correlation_id: request.correlation_id ?? null,
        decision,
        gateway: g,
      };
    } catch (err) {
      const error = classify(err);
      stats.failed += 1;
      stats.errors_by_code[error.code] = (stats.errors_by_code[error.code] ?? 0) + 1;
      const g = gatewayBlock(via, started);
      recordLatency(g.latency_ms);
      return {
        contract_version: GATEWAY_CONTRACT_VERSION,
        ok: false,
        request_id: request?.request_id ?? requestId,
        correlation_id: request?.correlation_id ?? correlationId,
        decision: null,
        error,
        failure: failureFor(decisionType, failurePolicy),
        gateway: g,
      };
    } finally {
      clearTimeout(timer);
      if (acquired) stats.in_flight -= 1;
    }
  }

  function recordLatency(ms) {
    stats.latency_ms.last = ms;
    stats.latency_ms.max = Math.max(stats.latency_ms.max, ms);
    stats.latency_ms.total += ms;
  }

  /** 公開してよい最小情報（認証なしの /health 用） */
  function version() {
    return { contract_version: GATEWAY_CONTRACT_VERSION, environment, engine: { id: eng.id, version: eng.version, mode: eng.mode } };
  }

  /** 詳細 health（認証済みの入口だけが返す。Secret は含まない） */
  function health() {
    const done = stats.ok + stats.failed;
    return {
      status: 'ok',
      ...version(),
      limits: { timeout_ms: timeoutMs, max_concurrent: maxConcurrent },
      engine_health: eng.health(),
      stats: { ...stats, latency_ms: { ...stats.latency_ms, avg: done ? Math.round(stats.latency_ms.total / done) : null } },
    };
  }

  function decisionTypes() {
    const index = readJson('schemas/common/decision-types.json').decision_types;
    return Object.entries(index).map(([id, e]) => ({
      decision_type: id, domain: e.domain, status: e.status, final_action: e.final_action ?? null,
      failure_policy: failureFor(id, failurePolicy).policy,
    }));
  }

  return { decide, health, version, decisionTypes, engine: eng, environment };
}
