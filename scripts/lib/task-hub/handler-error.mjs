/** handler の失敗（2026-11-09・MA-24。2026-11-13 に handlers.mjs から分けた＝業務の handler と循環しない）。expected: true は想定内の終わり方（runner の連続失敗に数えない） */
export class HandlerError extends Error {
  constructor(code, { retryable = false, expected = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.expected = expected;
  }
}
export const fail = (code, opts) => new HandlerError(code, opts);
