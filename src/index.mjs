/**
 * E-NEXUS Decision Layer — SDK 入口。
 *
 *   import { createDecisionLayer } from 'e-nexus-decision-layer';
 *   const edl = createDecisionLayer();          // 既定: rules → jev → [mock-jev] → local(stub) → llm(stub) → human
 *   const result = await edl.decide({ decision_type: 'paid-generation-gate', application_id: 'openmontage', project_id: 'openmontage', input: {...} });
 *
 * App / IDE / Agent 側はこの関数か CLI（src/cli.mjs）だけを使う。Jev を直接呼ばない。
 *
 * mock-jev の役割（2026-09-19 実疎通後に確定）:
 *   「APIキー無し／Network Gate OFF で本体を検証する代替」であり、実 Jev の正常応答を上書きする本番 fallback ではない。
 *   実 Jev 経路が使える（Provider の available() が ok かつ EDL_ALLOW_NETWORK=true）ときは chain に入れない。
 *   実 Jev が正常応答して tier=human なら、chain は local → llm（再判定の差し込み口）→ human escalation へ進む
 *   （fallback.mjs の継続設計そのまま）。mock で置き換えない。
 */
import { createDecisionEngine } from './core/decision-engine.mjs';
import { createRulesAdapter } from './adapters/rules/rules-adapter.mjs';
import { createJevAdapter } from './adapters/jev/jev-adapter.mjs';
import { createMockJevAdapter } from './adapters/jev/mock-jev-adapter.mjs';
import { createLlmAdapterStub } from './adapters/llm/llm-adapter-stub.mjs';
import { createLocalAdapterStub } from './adapters/local/local-adapter-stub.mjs';
import { createHumanAdapter } from './adapters/human/human-adapter.mjs';
import { createFileMeter, createMemoryMeter } from './usage/metering.mjs';
import { resolveJevProvider } from './adapters/jev/jev-provider-interface.mjs';

/** 実 Jev 経路が使えるか（キーの有無と Network Gate だけを見る。値は読まない・送信しない） */
export function realJevUsable(env = process.env) {
  if (env.EDL_ALLOW_NETWORK !== 'true') return false;
  try {
    return resolveJevProvider(env).available(env).ok === true;
  } catch {
    return false;
  }
}

export function defaultAdapters({ env = process.env } = {}) {
  return [
    createRulesAdapter(),
    createJevAdapter({ env }),
    ...(realJevUsable(env) ? [] : [createMockJevAdapter()]),
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
