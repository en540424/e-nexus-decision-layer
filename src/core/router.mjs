/**
 * Router：decision_type ごとに「どの Adapter を、どの順で」試すかを policies/routing/default.json から決める。
 * 原則：deterministic rules → probabilistic（jev / mock-jev / local / llm）→ human。
 * Adapter の実体は登録済みのものだけ（未登録IDは無視し、その旨を trace に残す）。
 */
import { readJson } from '../schemas/loader.mjs';

export function loadRoutingPolicy() {
  return readJson('policies/routing/default.json');
}

export function resolveChain(decisionType, adapters, policy = loadRoutingPolicy()) {
  const ids = policy.overrides?.[decisionType]?.chain ?? policy.default_chain;
  const available = new Map(adapters.map((a) => [a.id, a]));
  const chain = [];
  const skipped = [];
  for (const id of ids) {
    const a = available.get(id);
    if (!a) {
      skipped.push({ adapter: id, reason: 'NOT_REGISTERED' });
      continue;
    }
    if (!a.supports(decisionType)) {
      skipped.push({ adapter: id, reason: 'UNSUPPORTED' });
      continue;
    }
    chain.push(a);
  }
  // human は必ず終端に置く（policy が省略していても保険で追加）
  if (!chain.some((a) => a.kind === 'human')) {
    const human = adapters.find((a) => a.kind === 'human');
    if (human) chain.push(human);
  }
  return { chain, skipped };
}
