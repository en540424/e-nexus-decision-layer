/**
 * Confidence → Tier 変換。
 * tier 語彙は en-product-hub の pull-plan（auto / claude / human）と揃える意図で auto / review / human とする。
 *   auto   : 自動処理候補（それでも Human-only 判定は §safety が上書きして human にする）
 *   review : 上位LLM再判定（llm adapter）または追加確認
 *   human  : Human Review
 * 閾値は policies/routing/confidence-thresholds.json から decision_type ごとに読み、コードへ固定しない。
 */
import { readJson } from '../schemas/loader.mjs';

export const TIERS = Object.freeze(['auto', 'review', 'human']);

export function loadThresholds(decisionType) {
  const doc = readJson('policies/routing/confidence-thresholds.json');
  return { ...doc.default, ...(doc.overrides?.[decisionType] ?? {}) };
}

export function tierFor(confidence, thresholds) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 'human';
  if (confidence >= thresholds.auto_min) return 'auto';
  if (confidence >= thresholds.review_min) return 'review';
  return 'human';
}
