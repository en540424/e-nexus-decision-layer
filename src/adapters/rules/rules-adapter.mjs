/**
 * Rules Adapter（deterministic）。
 * policies/routing/rules/<decision_type>.json のルール表を上から評価し、最初に一致した outcome を confidence 1.0 で返す。
 * どのルールにも一致しなければ AdapterUnavailableError('NO_RULE_MATCHED') → Engine が次の Adapter（Jev等）へ進む。
 *
 * ルール形式:
 *   { "id": "...", "when": { "<field>": <value> | { "in": [...] } | { "lt": n } | { "lte": n } | { "gt": n } | { "gte": n } | { "exists": true } },
 *     "outcome": { ... }, "rationale": "..." }
 * when の複数条件は AND。フィールドは input 直下のキー、または "a.b" のドット記法。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../core/paths.mjs';
import { readJson } from '../../schemas/loader.mjs';
import { AdapterUnavailableError } from '../../core/errors.mjs';

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function matchCondition(actual, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond) return cond.in.includes(actual);
    if ('exists' in cond) return cond.exists ? actual !== undefined : actual === undefined;
    if (typeof actual !== 'number') return false;
    if ('lt' in cond && !(actual < cond.lt)) return false;
    if ('lte' in cond && !(actual <= cond.lte)) return false;
    if ('gt' in cond && !(actual > cond.gt)) return false;
    if ('gte' in cond && !(actual >= cond.gte)) return false;
    return true;
  }
  return actual === cond;
}

export function evaluateRules(rules, input) {
  for (const rule of rules) {
    const ok = Object.entries(rule.when ?? {}).every(([field, cond]) => matchCondition(getPath(input, field), cond));
    if (ok) return rule;
  }
  return null;
}

export function createRulesAdapter({ rulesDir = 'policies/routing/rules' } = {}) {
  const rulesPath = (decisionType) => join(rulesDir, `${decisionType}.json`);
  return {
    id: 'rules',
    kind: 'deterministic',
    provider: null,
    model: null,
    supports(decisionType) {
      return existsSync(join(ROOT, rulesPath(decisionType)));
    },
    async decide({ decisionType, input }) {
      if (!this.supports(decisionType)) throw new AdapterUnavailableError('rules', 'NO_RULES_FILE', { decisionType });
      const doc = readJson(rulesPath(decisionType));
      const matched = evaluateRules(doc.rules ?? [], input);
      if (!matched) throw new AdapterUnavailableError('rules', 'NO_RULE_MATCHED', { decisionType });
      return {
        outcome: structuredClone(matched.outcome),
        confidence: 1.0,
        rationale: `rule:${matched.id}${matched.rationale ? ` — ${matched.rationale}` : ''}`,
        usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd_micros: 0 },
      };
    },
  };
}
