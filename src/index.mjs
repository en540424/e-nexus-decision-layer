/**
 * E-NEXUS Decision Layer — SDK 入口。
 *
 *   import { createDecisionLayer } from 'e-nexus-decision-layer';
 *   const edl = createDecisionLayer();          // 既定: rules → jev(stub) → mock-jev → local(stub) → llm(stub) → human
 *   const result = await edl.decide({ decision_type: 'paid-generation-gate', application_id: 'openmontage', project_id: 'openmontage', input: {...} });
 *
 * App / IDE / Agent 側はこの関数か CLI（src/cli.mjs）だけを使う。Jev を直接呼ばない。
 */
import { createDecisionEngine } from './core/decision-engine.mjs';
import { createRulesAdapter } from './adapters/rules/rules-adapter.mjs';
import { createJevAdapter } from './adapters/jev/jev-adapter.mjs';
import { createMockJevAdapter } from './adapters/jev/mock-jev-adapter.mjs';
import { createLlmAdapterStub } from './adapters/llm/llm-adapter-stub.mjs';
import { createLocalAdapterStub } from './adapters/local/local-adapter-stub.mjs';
import { createHumanAdapter } from './adapters/human/human-adapter.mjs';
import { createFileMeter, createMemoryMeter } from './usage/metering.mjs';

export function defaultAdapters({ env = process.env } = {}) {
  return [
    createRulesAdapter(),
    createJevAdapter({ env }),
    createMockJevAdapter(),
    createLocalAdapterStub(),
    createLlmAdapterStub({ env }),
    createHumanAdapter(),
  ];
}

export function createDecisionLayer({ adapters, meter, env = process.env, ...rest } = {}) {
  return createDecisionEngine({
    adapters: adapters ?? defaultAdapters({ env }),
    meter: meter ?? createFileMeter(),
    ...rest,
  });
}

export { createDecisionEngine } from './core/decision-engine.mjs';
export { createRulesAdapter, createJevAdapter, createMockJevAdapter, createLlmAdapterStub, createLocalAdapterStub, createHumanAdapter };
export { JEV_PROVIDER_IDS, assertJevProviderShape, resolveJevProvider, createDirectJevProvider, createVercelJevProvider, createCloudflareJevProvider } from './adapters/jev/jev-provider-interface.mjs';
export { createFileMeter, createMemoryMeter, summarize } from './usage/metering.mjs';
export { resolveCandidates, resolveProject, loadRegistry, checkRegistries } from './registries/registry.mjs';
export { listDecisionTypes, loadDecisionType } from './schemas/loader.mjs';
export * from './core/errors.mjs';
