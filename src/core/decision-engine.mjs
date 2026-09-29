/**
 * Decision Engine — E-NEXUS Decision Layer の中核。
 *
 *   request
 *     ↓ 1. schema validation（共通 + decision_type 固有の input）
 *     ↓ 2. safety policy（Human-only な decision_type は Adapter を一切呼ばず human へ）
 *     ↓ 3. registry から候補を絞る（Jev 等へ渡すのは候補だけ。FS探索はさせない）
 *     ↓ 4. router: rules → probabilistic adapters → human の chain を決める（cost policy で有料Adapterを止める）
 *     ↓ 5. fallback chain 実行 → confidence → tier
 *     ↓ 6. human gate 保護（outcome に承認を意味するキーがあれば例外。human_review_required=true は tier を human に固定）
 *     ↓ 7. outcome を decision_type schema で検証
 *     ↓ 8. usage metering（final resolver の usage ＋ attempts[]：途中で実際に呼んだ provider の usage も失わない）
 *   result（typed decision）
 *
 * Engine は Jev を知らない。知っているのは Adapter Interface だけ。
 */
import { randomUUID } from 'node:crypto';
import { readJson, loadDecisionType } from '../schemas/loader.mjs';
import { assertValid } from '../schemas/validate.mjs';
import { resolveCandidates } from '../registries/registry.mjs';
import { resolveChain, loadRoutingPolicy } from './router.mjs';
import { runFallbackChain } from './fallback.mjs';
import { loadThresholds, tierFor } from './confidence.mjs';
import { HumanGateViolationError, DecisionLayerError, DecisionAbortedError, abortReasonOf } from './errors.mjs';
import { assertAdapterShape } from '../adapters/adapter-interface.mjs';
import { buildUsageRecord, buildAbortedUsageRecord, createFileMeter } from '../usage/metering.mjs';

export function loadSafetyPolicy() {
  return readJson('policies/safety/human-only.json');
}
export function loadCostPolicy() {
  return readJson('policies/cost/limits.json');
}

/**
 * policies/safety/human-only.json の force_human_when_outcome_keys に列挙したキーのいずれかが true なら
 * confidence に関わらず tier=human。ドメインごとに語彙が違う（human_review_required / needs_human_review / human_required）ため
 * ここで一元的に読む。返り値は一致したキー名（無ければ null）。
 */
export function forcedHumanKey(outcome, safety) {
  const keys = safety.force_human_when_outcome_keys ?? [];
  const k = keys.find((key) => outcome?.[key] === true);
  if (k) return k;
  // force_human_when_outcome_values（2026-09-29 FB-04）：boolean でない enum の「止める・上げる」値（例 safety_class=escalate）も
  // confidence に関わらず tier=human にする。返り値は "field=value"（gate reason にそのまま使う）
  for (const [field, values] of Object.entries(safety.force_human_when_outcome_values ?? {})) {
    if (Array.isArray(values) && typeof outcome?.[field] === 'string' && values.includes(outcome[field])) return `${field}=${outcome[field]}`;
  }
  return null;
}

const TIER_ORDER = Object.freeze(['human', 'review', 'auto']);

/** Adapter ごとの tier の上限（policies/routing/default.json max_tier_by_adapter・2026-09-29 FB-21）。下げるだけで上げない */
export function capTier(tier, max) {
  if (!TIER_ORDER.includes(max)) return tier;
  return TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(max) ? max : tier;
}

/** policies/cost/limits.json の 1 判定あたり上限（USD micros）。正の整数だけを有効にし、null・0・不正値は「強制しない」 */
export function costLimitOf(costPolicy) {
  const v = costPolicy?.per_decision_estimated_cost_usd_micros_max;
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

function assertNoApprovalKeys(outcome, safety) {
  const forbidden = safety.forbidden_outcome_keys ?? [];
  const found = Object.keys(outcome).filter((k) => forbidden.includes(k));
  if (found.length) {
    throw new HumanGateViolationError(`outcome contains forbidden approval-like keys: ${found.join(', ')}`, { keys: found });
  }
}

export function createDecisionEngine({
  adapters,
  meter = createFileMeter(),
  routingPolicy = loadRoutingPolicy(),
  safetyPolicy = loadSafetyPolicy(),
  costPolicy = loadCostPolicy(),
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(adapters) || adapters.length === 0) throw new DecisionLayerError('adapters[] required', 'NO_ADAPTERS');
  adapters.forEach(assertAdapterShape);
  const requestSchema = readJson('schemas/common/decision-request.schema.json');
  const resultSchema = readJson('schemas/common/decision-result.schema.json');
  const escalationSchema = readJson('schemas/common/escalation-outcome.schema.json');

  /**
   * @param {object} request  DecisionRequest
   * @param {{ signal?: AbortSignal }} [opts]  signal（任意・2026-09-29 FB-01）：呼び出し元が abort したら以降の Adapter を呼ばず
   *   DecisionAbortedError を投げる。それまでに呼んだ attempt があれば aborted=true の usage 行を1行書く（送信済み Jev の課金を失わない）
   */
  async function decide(request, { signal } = {}) {
    if (signal?.aborted) throw new DecisionAbortedError(abortReasonOf(signal));
    // 1. 共通 schema
    assertValid(requestSchema, request, 'decision-request');
    const dt = loadDecisionType(request.decision_type);
    if (!dt) throw new DecisionLayerError(`unknown decision_type: ${request.decision_type}`, 'UNKNOWN_DECISION_TYPE');
    assertValid(dt.schema.properties.input, request.input, `${request.decision_type}.input`);

    const decisionId = `dec_${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}_${randomUUID().slice(0, 8)}`;
    const timestamp = now().toISOString();
    const thresholds = loadThresholds(request.decision_type);
    const humanOnly = (safetyPolicy.human_only_decision_types ?? []).includes(request.decision_type);

    // 3. 候補（Registry由来のみ）
    const candidates = dt.candidates
      ? resolveCandidates(dt.candidates.kind, { projectId: request.project_id, tags: dt.candidates.tags ?? [] })
      : [];

    // 4. chain（Human-only は human だけ／cost policy で有料Adapterを除外）
    let chain;
    let skipped = [];
    if (humanOnly) {
      chain = adapters.filter((a) => a.kind === 'human');
      skipped = adapters.filter((a) => a.kind !== 'human').map((a) => ({ adapter: a.id, reason: 'HUMAN_ONLY_DECISION_TYPE' }));
    } else {
      const resolved = resolveChain(request.decision_type, adapters, routingPolicy);
      skipped = resolved.skipped;
      const allowPaid = request.options?.allow_paid_adapters === true;
      chain = resolved.chain.filter((a) => {
        const paid = (costPolicy.paid_providers ?? []).includes(a.provider);
        if (paid && !allowPaid) {
          skipped.push({ adapter: a.id, reason: 'COST_GATE_PAID_ADAPTER_NOT_ALLOWED' });
          return false;
        }
        return true;
      });
    }

    // 5. 実行
    let chainResult;
    try {
      chainResult = await runFallbackChain({
        chain, decisionType: request.decision_type, input: request.input, candidates,
        context: { ...(request.context ?? {}), escalation_reason: humanOnly ? 'human-only decision type' : undefined },
        thresholds,
        signal,
        costLimitUsdMicros: costLimitOf(costPolicy),
      });
    } catch (err) {
      if (err instanceof DecisionAbortedError) {
        const trace = err.details.trace ?? [];
        if (trace.length > 0) {
          meter.record(buildAbortedUsageRecord({ request, decisionId, timestamp, trace, reason: err.details.reason }));
        }
        throw new DecisionAbortedError(err.details.reason, { decision_id: decisionId, attempts: trace.length });
      }
      throw err;
    }
    const { chosen, trace, fallback_occurred } = chainResult;
    if (!chosen) throw new DecisionLayerError('no adapter produced a result', 'NO_RESULT');

    const { adapter, result: adapterResult } = chosen;
    const escalated = adapter.kind === 'human';
    const outcome = structuredClone(adapterResult.outcome);

    // 6. human gate 保護
    assertNoApprovalKeys(outcome, safetyPolicy);
    let tier = escalated ? 'human' : capTier(tierFor(adapterResult.confidence, thresholds), routingPolicy.max_tier_by_adapter?.[adapter.id]);
    let gateReason = null;
    if (humanOnly) { tier = 'human'; gateReason = 'decision_type is Human-only by safety policy'; }
    else if (escalated) { gateReason = 'escalated: no automated adapter could decide'; }
    else if (forcedHumanKey(outcome, safetyPolicy)) {
      const forced = forcedHumanKey(outcome, safetyPolicy);
      tier = 'human';
      gateReason = forced.includes('=') ? `outcome.${forced}` : `outcome.${forced}=true`;
    }
    else if (tier === 'human') { gateReason = `confidence ${adapterResult.confidence} below review_min ${thresholds.review_min}`; }

    // 7. outcome 検証
    if (escalated) assertValid(escalationSchema, outcome, 'escalation-outcome');
    else assertValid(dt.schema.properties.outcome, outcome, `${request.decision_type}.outcome`);

    const result = {
      decision_id: decisionId,
      decision_type: request.decision_type,
      application_id: request.application_id,
      project_id: request.project_id,
      tenant: request.tenant ?? null,
      outcome,
      confidence: adapterResult.confidence,
      tier,
      resolved_by: adapter.id,
      provider: adapter.provider ?? null,
      model: adapter.model ?? null,
      rationale: adapterResult.rationale ?? null,
      human_gate: {
        required: tier === 'human',
        preserved: true,
        reason: gateReason,
        note: 'Decision Layer never approves. Existing Human-only gates (en-generate-hub approval, Claude Code permissions, Product Hub update button) remain authoritative.',
      },
      fallback: { occurred: fallback_occurred, trace, skipped },
      candidates_considered: candidates.map((c) => c.id),
      thresholds,
      timestamp,
    };
    assertValid(resultSchema, result, 'decision-result');

    // 8. metering（top-level = final resolver の usage。attempts[] / usage_total = 途中 attempt を含む全体。fallback.trace と同じ record）
    result.usage = meter.record(buildUsageRecord({ request, result, adapter, adapterResult, fallbackOccurred: fallback_occurred, trace }));
    return result;
  }

  return { decide, adapters, meter };
}
