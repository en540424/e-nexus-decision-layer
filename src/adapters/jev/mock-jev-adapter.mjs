/**
 * Mock Jev Adapter。
 * 実APIキーが無くても Decision Layer本体（routing / fallback / confidence / metering / human gate）を検証するための決定的な模擬判定器。
 *
 * 模擬の仕方（優先順）:
 *   1. allowMockControl=true のときだけ input.__mock に従う（テスト専用。index.mjs の既定は false）
 *      { "__mock": { "outcome": {...}, "confidence": 0.7 } } / { "__mock": { "unavailable": true } }
 *   2. options.responses[decisionType] があればそれを返す
 *   3. それも無ければ decision_type ごとの既定ヒューリスティック（poc用の簡易な判定）を返す
 * 本物のJevに置き換わっても Engine 側のコードは変わらない（同じ Adapter Interface）。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

const DEFAULT_HEURISTICS = {
  // PoC: 有料生成直前のDecision Gate。「有料が必要か」を推定するだけで、承認は一切返さない。
  'paid-generation-gate': (input) => {
    const wantsPhotoreal = input.style === 'photoreal' || input.style === 'cinematic';
    const long = (input.duration_sec ?? 0) > 20;
    const hasRefMedia = Boolean(input.has_reference_media);
    let confidence = 0.9;
    let outcome;
    if (input.asset_kind === 'kinetic-typography' || input.asset_kind === 'subtitle' || input.asset_kind === 'slideshow') {
      outcome = { local_sufficient: true, remotion_suitable: true, paid_generation_required: false, human_review_required: false, recommended_route: 'remotion' };
    } else if (wantsPhotoreal || hasRefMedia) {
      outcome = { local_sufficient: false, remotion_suitable: false, paid_generation_required: true, human_review_required: true, recommended_route: 'en-generate-hub' };
      confidence = long ? 0.75 : 0.88;
    } else {
      outcome = { local_sufficient: false, remotion_suitable: true, paid_generation_required: false, human_review_required: true, recommended_route: 'human-review' };
      confidence = 0.55;
    }
    return { outcome, confidence, rationale: 'mock-jev heuristic' };
  },
};

export function createMockJevAdapter({ responses = {}, defaultUnavailable = false, allowMockControl = false } = {}) {
  return {
    id: 'mock-jev',
    kind: 'probabilistic',
    provider: 'mock',
    model: 'mock-jev',
    supports(decisionType) {
      return Boolean(responses[decisionType] || DEFAULT_HEURISTICS[decisionType]);
    },
    async decide({ decisionType, input }) {
      if (defaultUnavailable) throw new AdapterUnavailableError('mock-jev', 'SIMULATED_UNAVAILABLE', { decisionType });
      // __mock はテスト専用。allowMockControl=false（本番既定）では無視する
      const mock = allowMockControl ? input?.__mock : undefined;
      if (mock?.unavailable) throw new AdapterUnavailableError('mock-jev', 'SIMULATED_UNAVAILABLE', { decisionType });
      const base = mock?.outcome
        ? { outcome: mock.outcome, confidence: mock.confidence ?? 0.9, rationale: 'mock-jev (__mock)' }
        : responses[decisionType]
          ? structuredClone(responses[decisionType])
          : DEFAULT_HEURISTICS[decisionType]?.(input);
      if (!base) throw new AdapterUnavailableError('mock-jev', 'UNSUPPORTED_DECISION_TYPE', { decisionType });
      // 模擬トークン量：input の JSON 長からの概算（原価管理の配管が動くことだけを確認する目的）
      const inputTokens = Math.ceil(JSON.stringify(input ?? {}).length / 4);
      return {
        ...base,
        usage: base.usage ?? { input_tokens: inputTokens, output_tokens: 16, estimated_cost_usd_micros: 0 },
      };
    },
  };
}
