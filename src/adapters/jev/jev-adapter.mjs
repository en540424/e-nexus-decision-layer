/**
 * Jev（TypeSafe AI）Adapter — 変換層。
 *
 * Engine から渡されるのは decisionType / input / candidates / context だけ（Adapter Interface契約どおり）。
 * outcome の型（何を訊くか）は Engine が知らないため、この Adapter が自分で
 * schemas/common/decision-types.json 経由の outcome schema を読み、Jev の questions（noul/choice/score）へ
 * 変換する。ネットワーク送信は一切ここでは行わない（Provider の責務。jev-provider-interface.mjs）。
 *
 * Network Gate:
 * - EDL_ALLOW_NETWORK !== 'true' → AdapterUnavailableError('NETWORK_DISABLED')（Provider 側でも二重チェックする）
 * - Provider.available(env) が ok でない → その reason（例: JEV_API_KEY_MISSING）
 * いずれの場合も Engine は次の Adapter（mock-jev / llm / human）へフォールバックし、停止しない。
 *
 * 構造（経路を固定しない）:
 *   Decision Layer → Jev Adapter（この file：変換だけ）→ Jev Provider（jev-provider-interface.mjs：経路だけ）
 *                                                         ├─ direct（TypeSafe Direct API。実装済み）
 *                                                         ├─ vercel（Vercel AI Gateway。予約）
 *                                                         └─ cloudflare（Cloudflare 経由。予約）
 *   経路の追加は Provider 1ファイルで済み、この Adapter・Engine は変更しない。
 *
 * outcome schema → Jev questions の写像（2026-09-19 Jev公式API仕様確認済み。詳細は MA-30開発ログ参照）:
 *   boolean                                  → noul   （true/falseの確率。answer.noul >= 0.5 を true とする）
 *   string + enum                            → choice （criteria = 各enum値、説明は無いため null）
 *   integer + minimum/maximum（2〜10段）      → score  （criteria = 段数ぶんの汎用ラベル。answerは最近傍の段へ丸める）
 *   上記に当てはまらないフィールド（自由文字列・object・配列・範囲が2〜10段でない数値等）は
 *   AdapterUnavailableError('JEV_UNSUPPORTED_OUTCOME_FIELD') とし、推測でquestionを作らない。
 *
 * confidence:
 *   choice / score は Jev の answer.confidence をそのまま使う。
 *   noul は公式にconfidenceが無いため |2*noul-1| を Decision Layer 側の導出値として使う（0=五分五分, 1=確信）。
 *   全体confidenceは「最も不確かなquestionの値」（各questionの最小値）とし、楽観的合成をしない。
 *
 * APIキーの値をログ・例外メッセージ・結果へ含めない。
 *
 * attempt metering（2026-09-19）:
 *   正常応答は networked:true・route（direct/vercel）・model（応答の実モデルID）・retry_count（Provider が meta に書いた場合のみ）を
 *   AdapterResult に付ける。送信後の失敗（HTTP/timeout/応答不正）は Provider／parseJevResponse が details.networked=true を付けて throw し、
 *   送信前のゲート（NETWORK_DISABLED / *_KEY_MISSING / JEV_UNSUPPORTED_OUTCOME_FIELD 等）は付けない（core が false と扱う）。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';
import { assertJevProviderShape, resolveJevProvider } from './jev-provider-interface.mjs';
import { loadDecisionType } from '../../schemas/loader.mjs';
import { getEntry } from '../../registries/registry.mjs';

export const JEV_ENV = Object.freeze({
  apiKey: 'JEV_API_KEY',
  baseUrl: 'JEV_API_BASE_URL',
  provider: 'JEV_PROVIDER',
  allowNetwork: 'EDL_ALLOW_NETWORK',
  model: 'JEV_MODEL',
});

const DEFAULT_MODEL = 'jev-latest';

/** 1つの outcome フィールド定義から Jev question（と、応答を読み戻すための plan）を作る。対応不能なら null */
function planForField(name, fieldSchema, decisionType) {
  const instructions = fieldSchema?.description || `Determine ${name} for this ${decisionType} decision.`;
  if (fieldSchema?.type === 'boolean') {
    return { question: { type: 'noul', instructions }, plan: { kind: 'noul' } };
  }
  if (fieldSchema?.type === 'string' && Array.isArray(fieldSchema.enum) && fieldSchema.enum.length >= 1) {
    const criteria = Object.fromEntries(fieldSchema.enum.map((v) => [v, null]));
    return { question: { type: 'choice', instructions, criteria }, plan: { kind: 'choice', enumValues: [...fieldSchema.enum] } };
  }
  if (
    (fieldSchema?.type === 'integer' || fieldSchema?.type === 'number')
    && Number.isInteger(fieldSchema.minimum) && Number.isInteger(fieldSchema.maximum)
  ) {
    const levels = fieldSchema.maximum - fieldSchema.minimum + 1;
    if (levels >= 2 && levels <= 10) {
      const criteria = Array.from({ length: levels }, (_, i) => `${name} = ${fieldSchema.minimum + i}`);
      return { question: { type: 'score', instructions, criteria }, plan: { kind: 'score', minimum: fieldSchema.minimum, levels } };
    }
  }
  return null;
}

/**
 * decisionType の outcome schema から Jev への request（{model, state, questions}）を組み立てる。
 * 対応できない outcome フィールドが1つでもあれば推測せず AdapterUnavailableError を投げる。
 * @returns {{ request: object, fieldPlans: Record<string, object> }}
 */
export function buildJevRequest({ decisionType, outcomeSchema, input, candidates, model = DEFAULT_MODEL }) {
  const properties = outcomeSchema?.properties ?? {};
  const questions = {};
  const fieldPlans = {};
  const unsupported = [];
  for (const [name, fieldSchema] of Object.entries(properties)) {
    const built = planForField(name, fieldSchema, decisionType);
    if (!built) {
      unsupported.push(name);
      continue;
    }
    questions[name] = built.question;
    fieldPlans[name] = built.plan;
  }
  if (unsupported.length) {
    throw new AdapterUnavailableError('jev', 'JEV_UNSUPPORTED_OUTCOME_FIELD', { decisionType, fields: unsupported });
  }
  const request = {
    model,
    state: {
      task: decisionType,
      input,
      candidates: (candidates ?? []).map((c) => ({ id: c.id, description: c.description ?? '' })),
    },
    questions,
  };
  return { request, fieldPlans };
}

/** noul の確率から Decision Layer 独自の confidence を導出する（公式にはconfidence無し） */
function noulConfidence(noul) {
  return Math.abs(2 * noul - 1);
}

function estimateCostUsdMicros(inputTokens) {
  try {
    const entry = getEntry('models', 'jev');
    const perMillion = entry?.pricing?.input_usd_micros_per_million_tokens;
    if (typeof perMillion !== 'number') return 0;
    return Math.round((inputTokens / 1_000_000) * perMillion);
  } catch {
    return 0;
  }
}

/**
 * Jev の生応答（{model, answers, usage}）を AdapterResult へ正規化する。
 * fieldPlans に無い質問は無視し、fieldPlans にあるのに answers に無い／型不一致／値が不正なものは
 * 全体を JEV_MALFORMED_RESPONSE として unavailable にする（部分的な出力を推測で補わない）。
 */
export function parseJevResponse(raw, { fieldPlans = {} } = {}) {
  if (!raw || typeof raw !== 'object' || !raw.answers || typeof raw.answers !== 'object') {
    throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: 'missing answers', networked: true });
  }
  const outcome = {};
  const fieldConfidence = {};
  for (const [name, plan] of Object.entries(fieldPlans)) {
    const answer = raw.answers[name];
    if (!answer || typeof answer !== 'object' || answer.type !== plan.kind) {
      throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: `answer missing or wrong type: ${name}`, networked: true });
    }
    if (plan.kind === 'noul') {
      if (typeof answer.noul !== 'number' || answer.noul < 0 || answer.noul > 1) {
        throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: `invalid noul: ${name}`, networked: true });
      }
      outcome[name] = answer.noul >= 0.5;
      fieldConfidence[name] = noulConfidence(answer.noul);
    } else if (plan.kind === 'choice') {
      if (typeof answer.choice !== 'string' || !plan.enumValues.includes(answer.choice)) {
        throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: `invalid choice: ${name}`, networked: true });
      }
      if (typeof answer.confidence !== 'number' || answer.confidence < 0 || answer.confidence > 1) {
        throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: `missing confidence: ${name}`, networked: true });
      }
      outcome[name] = answer.choice;
      fieldConfidence[name] = answer.confidence;
    } else if (plan.kind === 'score') {
      if (typeof answer.score !== 'number') {
        throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: `invalid score: ${name}`, networked: true });
      }
      if (typeof answer.confidence !== 'number' || answer.confidence < 0 || answer.confidence > 1) {
        throw new AdapterUnavailableError('jev', 'JEV_MALFORMED_RESPONSE', { detail: `missing confidence: ${name}`, networked: true });
      }
      const levelIndex = Math.min(Math.max(Math.round(answer.score), 0), plan.levels - 1);
      outcome[name] = plan.minimum + levelIndex;
      fieldConfidence[name] = answer.confidence;
    }
  }
  const confidences = Object.values(fieldConfidence);
  const confidence = confidences.length ? Math.min(...confidences) : 1;
  const usage = raw.usage ?? {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return {
    outcome,
    confidence,
    rationale: Object.entries(fieldConfidence).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ') || 'jev',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd_micros: estimateCostUsdMicros(inputTokens),
    },
    // 応答を parse できた＝実際に送信した。model は provider が実際に使ったID（応答に無ければ付けない＝adapter.model のまま）
    networked: true,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
  };
}

/**
 * @param {object} opts
 * @param {object} [opts.env]       環境変数（テストでは注入）
 * @param {object} [opts.provider]  Jev Provider（省略時は env.JEV_PROVIDER から解決、既定 direct）
 */
export function createJevAdapter({ env = process.env, provider = null } = {}) {
  const resolveProvider = () => (provider ? assertJevProviderShape(provider) : resolveJevProvider(env));
  return {
    id: 'jev',
    kind: 'probabilistic',
    provider: 'typesafe-ai',
    model: 'jev',
    get route() {
      try { return resolveProvider().id; } catch { return null; }
    },
    supports() {
      return true; // 対応可否は decide 時に環境で判断する（型付き判定は全 decision_type が対象）
    },
    async decide({ decisionType, input, candidates }) {
      const p = resolveProvider();
      const avail = p.available(env);
      if (!avail.ok) throw new AdapterUnavailableError('jev', avail.reason ?? 'JEV_PROVIDER_UNAVAILABLE', { decisionType, route: p.id });
      if (env[JEV_ENV.allowNetwork] !== 'true') throw new AdapterUnavailableError('jev', 'NETWORK_DISABLED', { decisionType, route: p.id });
      const dt = loadDecisionType(decisionType);
      const outcomeSchema = dt?.schema?.properties?.outcome ?? null;
      const model = env[JEV_ENV.model] || DEFAULT_MODEL;
      const { request, fieldPlans } = buildJevRequest({ decisionType, outcomeSchema, input, candidates, model });
      // meta は Provider が書き戻す attempt 情報（retry_count 等。取得できる Provider だけが書く。捏造しない）
      const meta = {};
      let raw;
      try {
        raw = await p.send({ request, env, meta });
      } catch (err) {
        if (err instanceof AdapterUnavailableError) {
          err.details.route ??= p.id;
          if (Number.isInteger(meta.retry_count)) err.details.retry_count ??= meta.retry_count;
        }
        throw err;
      }
      let parsed;
      try {
        parsed = parseJevResponse(raw, { fieldPlans });
      } catch (err) {
        if (err instanceof AdapterUnavailableError) err.details.route ??= p.id;
        throw err;
      }
      return { ...parsed, route: p.id, ...(Number.isInteger(meta.retry_count) ? { retry_count: meta.retry_count } : {}) };
    },
  };
}
