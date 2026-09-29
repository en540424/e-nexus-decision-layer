/**
 * Decision Layer 共通エラー。
 * Adapter が利用不能なときは AdapterUnavailableError を投げ、Engine が次の Adapter へフォールバックする。
 * Human-only 判定を機械で「承認」させようとした場合は HumanGateViolationError で停止する。
 */
export class DecisionLayerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'DecisionLayerError';
    this.code = code;
    this.details = details;
  }
}

export class SchemaValidationError extends DecisionLayerError {
  constructor(errors, details = {}) {
    super(`schema validation failed: ${errors.join('; ')}`, 'SCHEMA_INVALID', { errors, ...details });
    this.name = 'SchemaValidationError';
  }
}

export class AdapterUnavailableError extends DecisionLayerError {
  constructor(adapterId, reason, details = {}) {
    super(`adapter unavailable: ${adapterId} (${reason})`, 'ADAPTER_UNAVAILABLE', { adapterId, reason, ...details });
    this.name = 'AdapterUnavailableError';
  }
}

export class HumanGateViolationError extends DecisionLayerError {
  constructor(message, details = {}) {
    super(message, 'HUMAN_GATE_VIOLATION', details);
    this.name = 'HumanGateViolationError';
  }
}

/**
 * 呼び出し元（Gateway の timeout・HTTP client の切断・shutdown）が decide() を中断した（2026-09-29 FB-01）。
 * details.reason は中断理由（'GATEWAY_TIMEOUT' | 'CLIENT_DISCONNECTED' | 'SHUTDOWN' 等）。承認・判定の結果ではない。
 */
export class DecisionAbortedError extends DecisionLayerError {
  constructor(reason, details = {}) {
    super(`decision aborted (${reason})`, 'DECISION_ABORTED', { reason, ...details });
    this.name = 'DecisionAbortedError';
  }
}

/** AbortSignal.reason を識別子へ（string / {code} / 不明）。値は識別子レベルに留める（URL・body を混ぜない） */
export function abortReasonOf(signal) {
  const r = signal?.reason;
  if (typeof r === 'string' && /^[A-Z0-9_]{1,64}$/.test(r)) return r;
  if (r && typeof r === 'object' && typeof r.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(r.code)) return r.code;
  return 'ABORTED';
}

export class RegistryError extends DecisionLayerError {
  constructor(message, details = {}) {
    super(message, 'REGISTRY_ERROR', details);
    this.name = 'RegistryError';
  }
}
