/**
 * Human Adapter。
 * フォールバック連鎖の終端。「判断できなかった」を「Humanへ上げる」という型付き結果に変換する。
 * 自動で何かを承認することは構造上できない（outcome は常に human_review_required=true の escalation）。
 * 実際のHuman承認そのものは既存の各ゲート（en-generate-hub の Human-only承認、Claude Code の permission、
 * Product Hub の更新ボタン等）が担い、Decision Layer はそれを置き換えない。
 */
export function createHumanAdapter() {
  return {
    id: 'human',
    kind: 'human',
    provider: null,
    model: null,
    supports() {
      return true;
    },
    async decide({ decisionType, context }) {
      return {
        outcome: {
          escalated: true,
          human_review_required: true,
          reason: context?.escalation_reason ?? 'no automated adapter could decide',
          decision_type: decisionType,
        },
        confidence: 0,
        rationale: 'escalated to human',
        usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0 },
      };
    },
  };
}
