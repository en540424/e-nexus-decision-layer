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

export class RegistryError extends DecisionLayerError {
  constructor(message, details = {}) {
    super(message, 'REGISTRY_ERROR', details);
    this.name = 'RegistryError';
  }
}
