/**
 * Outcome invariants（2026-09-26 実JEV Calibration）。
 *
 * decision_type の outcome schema が `x-outcome-invariants` で宣言する「field 間で同時に成り立たなければ矛盾になる関係」を
 * 評価する。例：paid-generation-gate の「route=en-generate-hub なら paid_generation_required=true」。
 * 何を選ぶか（route そのもの）は決めない。選んだ答え同士が自己矛盾していないかだけを見る。
 *
 * 宣言形式（schema 側。rules の when と同じ条件語彙に not_in を足したもの）:
 *   "x-outcome-invariants": [
 *     { "id": "...", "if": { "<field>": <value> | { "in": [...] } | { "not_in": [...] } }, "then": { ... 同上 ... } }
 *   ]
 *   if / then の複数条件は AND。field は outcome 直下のキー。"input.<key>" で input を参照できる。
 *
 * 使う場所：Jev Adapter（応答の自己矛盾を検知して確信度を持たない回答として扱う）と Calibration runner（矛盾件数の集計）。
 * rules の outcome もすべてこの invariants を満たすことを tests で固定する（rules と Jev で意味がずれないように）。
 */

function getField(outcome, input, name) {
  if (name.startsWith('input.')) return input?.[name.slice(6)];
  return outcome?.[name];
}

function matches(actual, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond) return cond.in.includes(actual);
    if ('not_in' in cond) return !cond.not_in.includes(actual);
    return false;
  }
  return actual === cond;
}

function allMatch(clause, outcome, input) {
  return Object.entries(clause ?? {}).every(([field, cond]) => matches(getField(outcome, input, field), cond));
}

/** outcome schema から invariants 宣言を取り出す（無ければ空配列） */
export function outcomeInvariantsOf(outcomeSchema) {
  const list = outcomeSchema?.['x-outcome-invariants'];
  return Array.isArray(list) ? list : [];
}

/**
 * @returns {string[]} 破られた invariant の id（空なら矛盾なし）
 */
export function checkOutcomeInvariants(outcomeSchema, outcome, input = {}) {
  const violated = [];
  for (const inv of outcomeInvariantsOf(outcomeSchema)) {
    if (allMatch(inv.if, outcome, input) && !allMatch(inv.then, outcome, input)) violated.push(inv.id);
  }
  return violated;
}
