import { createDecisionEngine } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter } from '../src/adapters/jev/jev-adapter.mjs';
import { createMockJevAdapter } from '../src/adapters/jev/mock-jev-adapter.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';

/** テスト用: ネットワーク無し・キー無し環境で、メモリ上の meter を使う Engine */
export function makeEngine({ adapters, env = {}, ...rest } = {}) {
  const meter = createMemoryMeter();
  const engine = createDecisionEngine({
    adapters: adapters ?? [
      createRulesAdapter(),
      createJevAdapter({ env }),
      createMockJevAdapter({ allowMockControl: true }),
      createLocalAdapterStub(),
      createLlmAdapterStub({ env }),
      createHumanAdapter(),
    ],
    meter,
    ...rest,
  });
  return { engine, meter };
}

export function gateRequest(input, extra = {}) {
  return {
    decision_type: 'paid-generation-gate',
    application_id: 'openmontage',
    project_id: 'openmontage',
    input,
    ...extra,
  };
}
