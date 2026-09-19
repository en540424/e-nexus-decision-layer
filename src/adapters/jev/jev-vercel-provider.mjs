/**
 * Vercel AI Gateway Provider（Jev）— 実装（2026-09-19、Vercel/AI SDK公式ドキュメント確認済み）。
 *
 * jev-direct-provider.mjs と同じく「経路（transport）だけ」を持つ。ただし Vercel AI Gateway の
 * Evaluation modality は TypeSafe の生API（{model, state, questions} + noul/choice/score）とは
 * 別の形（AI SDK の experimental_evaluate、questions は boolean/choice/score）で公開されているため、
 * この Provider は「transport + 相互変換」を担う。jev-adapter.mjs（変換層）・decision-engine は変更しない
 * （送る request / 受け取る raw response の形は Direct と同じ内部形に揃えて渡す）。
 *
 * 確認済み仕様（一次情報。2026-09-19取得。出典）:
 *   - https://vercel.com/docs/ai-gateway/modalities/evaluation
 *       「Evaluation is available through the AI SDK only.」（OpenAI/Anthropic/Cohere互換RESTには無い。
 *       AI SDK 7以上が必要）→ REST直叩きを推測実装しない理由
 *       import { experimental_evaluate as evaluate } from 'ai'
 *       questions: { [name]: { type: 'boolean'|'choice'|'score', instructions, criteria? } }
 *         boolean: criteria は任意 { true: '...', false: '...' } → answer { type:'boolean', probability }
 *         choice:  criteria は必須 { optionName: description }   → answer { type:'choice', choice, probabilities }
 *         score:   criteria は必須 [ラベル配列、最低2、昇順]      → answer { type:'score', score, probabilities }
 *       usage: { inputTokens, outputTokens }（camelCase。Direct の usage は snake_case）
 *   - https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
 *       choice/score の confidence は answer に無く、
 *       result.providerMetadata.typesafe.confidence（質問名キー）にある。boolean には確信度が無い
 *       （Direct の noul と同様、confidence は下流 jev-adapter.mjs が |2p-1| で独自導出する）
 *       ZDR: providerOptions.gateway.zeroDataRetention: true
 *   - https://ai-sdk.dev/docs/ai-sdk-core/evaluation, .../reference/ai-sdk-core/evaluate
 *       result.usage.{inputTokens,outputTokens}、maxRetries 既定2（SDKが内部でリトライ。二重リトライしない）
 *   - https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway
 *       createGateway({ apiKey, baseURL }) で明示的にキーを渡せる（AI_GATEWAY_API_KEY への暗黙依存を避け、
 *       他 Provider と同じく env を明示的に注入する設計に合わせる）
 *   - https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error
 *       APICallError は statusCode / isRetryable を持つ（duck-typing で判定。SDK未インストール時のテストや
 *       テスト用 evaluateImpl 注入でも同じ判定ロジックが効くようにするため isInstance() には依存しない）
 *
 * 実疎通で確定した点（2026-09-19、JEV_PROVIDER=vercel・model typesafe-ai/jev・ai@7 インストール済み環境）:
 *   - createGateway({ apiKey }).evaluationModel(modelId) の組み合わせは実在し、実通信に成功した
 *     （実装時は既定シングルトン gateway の .evaluationModel() しか一次情報で確認できていなかった。
 *     resolveEvaluationModel() の存在チェックは防御としてそのまま残す）
 *   - 正規モデルIDは `typesafe-ai/jev`（DEFAULT_VERCEL_MODEL_ID）。約3.1s / confidence≈0.08 の実応答を得た
 *   - 403 は「キー不正」以外（カード未認証・モデル権限・Gatewayポリシー）でも返るため、401（JEV_AUTH_FAILED）
 *     と 403（JEV_FORBIDDEN）を分けて分類する。どちらも再試行しない。response body はログに出さない
 *
 * 依存: npm パッケージ 'ai'（AI SDK v7、Node.js 22+ 必須）。Decision Layer 全体の依存ゼロ方針
 * （jev-direct-provider.mjs 参照）とは別に、Evaluation modality が AI SDK 経由でしか提供されないため
 * （REST代替なしと公式に明記）必要になる。ただし direct / mock / rules 経路や既存69 testsに影響させないよう
 * 動的 import('ai') にし、package.json では optionalDependencies に置く。未インストールなら
 * JEV_VERCEL_SDK_MISSING で unavailable にし、Engine は次の Adapter へフォールバックする（停止しない）。
 * テストでは実際の 'ai' を使わず、常に evaluateImpl を注入する（動的importを一切経由しない）。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

/**
 * Vercel AI Gateway 上の Jev の正規モデルID（vercel.com/ai-gateway/models/jev。2026-09-19 実疎通で成功確認済み）。
 * Direct の内部モデルID（`jev-latest` 等、TypeSafe 側のカタログ）とは別のカタログなので、
 * `typesafe-ai/${内部ID}` のような機械的接頭辞変換はしない（`typesafe-ai/jev-latest` は未検証）。
 */
export const DEFAULT_VERCEL_MODEL_ID = 'typesafe-ai/jev';

/** Gateway モデルID。JEV_VERCEL_MODEL があれば完全上書き、無ければ正規既定。内部 request.model（Direct用）は使わない */
export function toGatewayModelId(env = {}) {
  return env.JEV_VERCEL_MODEL || DEFAULT_VERCEL_MODEL_ID;
}

/** 内部 questions（noul/choice/score）→ AI SDK evaluate() の questions（boolean/choice/score） */
export function toGatewayQuestions(questions) {
  const out = {};
  for (const [name, q] of Object.entries(questions ?? {})) {
    if (q.type === 'noul') {
      out[name] = { type: 'boolean', instructions: q.instructions };
    } else if (q.type === 'choice') {
      // 内部 criteria は { option: null }（description不明。jev-adapter.mjs 参照）。
      // AI SDK は string の description を期待するため null → '' に変換する（option名は保持）
      const criteria = Object.fromEntries(Object.keys(q.criteria ?? {}).map((k) => [k, q.criteria[k] ?? '']));
      out[name] = { type: 'choice', instructions: q.instructions, criteria };
    } else if (q.type === 'score') {
      out[name] = { type: 'score', instructions: q.instructions, criteria: [...(q.criteria ?? [])] };
    } else {
      throw new AdapterUnavailableError('jev', 'JEV_VERCEL_UNSUPPORTED_QUESTION_TYPE', { route: 'vercel', question: name, type: q.type });
    }
  }
  return out;
}

/**
 * AI SDK evaluate() の生 result → Direct と同じ内部形（{ model, answers, usage }）へ正規化する。
 * jev-adapter.mjs の parseJevResponse がそのまま読める形にする（jev-adapter.mjs は変更しない）。
 * confidence が providerMetadata に無い choice/score は confidence を付けず、
 * parseJevResponse 側の JEV_MALFORMED_RESPONSE 判定に委ねる（推測で補わない）。
 */
export function toDirectShapedResponse(result, { questions }) {
  const typesafeConfidence = result?.providerMetadata?.typesafe?.confidence ?? {};
  const answers = {};
  for (const [name, q] of Object.entries(questions ?? {})) {
    const raw = result?.answers?.[name];
    if (!raw || typeof raw !== 'object') continue; // 未回答 → answers に含めない（parseJevResponse が malformed 判定）
    if (q.type === 'noul') {
      if (raw.type === 'boolean' && typeof raw.probability === 'number') {
        answers[name] = { type: 'noul', noul: raw.probability };
      }
    } else if (q.type === 'choice') {
      if (raw.type === 'choice' && typeof raw.choice === 'string') {
        const confidence = typesafeConfidence[name];
        answers[name] = typeof confidence === 'number'
          ? { type: 'choice', choice: raw.choice, confidence }
          : { type: 'choice', choice: raw.choice };
      }
    } else if (q.type === 'score') {
      if (raw.type === 'score' && typeof raw.score === 'number') {
        const confidence = typesafeConfidence[name];
        answers[name] = typeof confidence === 'number'
          ? { type: 'score', score: raw.score, confidence }
          : { type: 'score', score: raw.score };
      }
    }
  }
  const usage = result?.usage ?? {};
  return {
    model: result?.response?.modelId,
    answers,
    usage: {
      input_tokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
      output_tokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
    },
  };
}

/** AI SDK / Gateway のエラーを Direct Provider と同じ reason 語彙へ分類する（duck-typing。isInstance()には依存しない）。
 *  evaluate() 呼び出し後にだけ使うため HTTP/ネットワーク系は networked:true（送信後の失敗）。判別できない SDK エラーは null */
export function classifyGatewayError(err) {
  if (typeof err?.statusCode === 'number') {
    const status = err.statusCode;
    if (status === 401) {
      return new AdapterUnavailableError('jev', 'JEV_AUTH_FAILED', { route: 'vercel', networked: true, status, retryable: false });
    }
    if (status === 403) {
      // キーは通ったが拒否された（カード未認証・モデル権限・Gatewayポリシー等）。原因はGateway側で確認する
      return new AdapterUnavailableError('jev', 'JEV_FORBIDDEN', { route: 'vercel', networked: true, status, retryable: false });
    }
    if (status === 422 || status === 400) {
      return new AdapterUnavailableError('jev', 'JEV_REQUEST_REJECTED', { route: 'vercel', networked: true, status, retryable: false });
    }
    if (status === 429) {
      return new AdapterUnavailableError('jev', 'JEV_RATE_LIMITED', { route: 'vercel', networked: true, status, retryable: err.isRetryable !== false });
    }
    if (status === 408 || status === 529 || (status >= 500 && status <= 599)) {
      return new AdapterUnavailableError('jev', 'JEV_OVERLOADED', { route: 'vercel', networked: true, status, retryable: err.isRetryable !== false });
    }
    return new AdapterUnavailableError('jev', 'JEV_HTTP_ERROR', { route: 'vercel', networked: true, status, retryable: !!err.isRetryable });
  }
  if (err?.name === 'AbortError' || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET') {
    return new AdapterUnavailableError('jev', 'JEV_NETWORK_ERROR', { route: 'vercel', networked: true, retryable: true });
  }
  // SDK 内部エラーは送信前（引数不正等）か送信後か判別できない → networked: null（不明。true と偽らない）
  return new AdapterUnavailableError('jev', 'JEV_VERCEL_SDK_ERROR', { route: 'vercel', networked: null, detail: err?.name ?? 'unknown', retryable: false });
}

/** createGateway() が返すインスタンスから evaluationModel を安全に解決する。無ければ推測せず即座に失敗する */
export function resolveEvaluationModel(gatewayProvider, modelId) {
  if (typeof gatewayProvider?.evaluationModel !== 'function') {
    throw new AdapterUnavailableError('jev', 'JEV_VERCEL_SDK_ERROR', { route: 'vercel', detail: 'gateway.evaluationModel is not a function' });
  }
  return gatewayProvider.evaluationModel(modelId);
}

async function loadSdk() {
  try {
    return await import('ai');
  } catch {
    throw new AdapterUnavailableError('jev', 'JEV_VERCEL_SDK_MISSING', {
      route: 'vercel',
      detail: 'npm package "ai" (AI SDK v7, experimental_evaluate) is not installed',
    });
  }
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.evaluateImpl]   テスト用に注入する evaluate 実装（既定: 動的 import('ai') 経由の実SDK）。
 *   注入時は { model: <modelId文字列>, state, questions, providerOptions, maxRetries } を受け取る想定。
 * @param {Function} [opts.gatewayFactory] テスト用に注入する createGateway 相当（既定: 実SDKの createGateway）
 */
export function createVercelJevProvider({ evaluateImpl, gatewayFactory } = {}) {
  return {
    id: 'vercel',
    available(env) {
      if (!env.AI_GATEWAY_API_KEY) return { ok: false, reason: 'JEV_VERCEL_API_KEY_MISSING' };
      return { ok: true };
    },
    async send({ request, env }) {
      // Adapter 側で EDL_ALLOW_NETWORK / キーを既にチェックしているが、Provider が単独で呼ばれても
      // 迂回できないよう、ここでも同じゲートを再確認する（direct provider と同じ二重チェック）。
      if (env.EDL_ALLOW_NETWORK !== 'true') {
        throw new AdapterUnavailableError('jev', 'NETWORK_DISABLED', { route: 'vercel' });
      }
      if (!env.AI_GATEWAY_API_KEY) {
        throw new AdapterUnavailableError('jev', 'JEV_VERCEL_API_KEY_MISSING', { route: 'vercel' });
      }

      const questions = toGatewayQuestions(request.questions);
      const modelId = toGatewayModelId(env);
      const providerOptions = env.JEV_ZDR === 'true' ? { gateway: { zeroDataRetention: true } } : undefined;

      let evaluateFn;
      let model;
      if (evaluateImpl) {
        evaluateFn = evaluateImpl;
        model = modelId;
      } else {
        const sdk = await loadSdk();
        const makeGateway = gatewayFactory ?? sdk.createGateway;
        const gatewayOpts = { apiKey: env.AI_GATEWAY_API_KEY };
        if (env.AI_GATEWAY_BASE_URL) gatewayOpts.baseURL = env.AI_GATEWAY_BASE_URL;
        const gatewayProvider = makeGateway(gatewayOpts);
        model = resolveEvaluationModel(gatewayProvider, modelId);
        evaluateFn = sdk.experimental_evaluate;
      }

      // AI SDK が内部で最大2回リトライするが回数は観測できないため、retry_count は meta に書かない（捏造しない）
      let result;
      try {
        result = await evaluateFn({ model, state: request.state, questions, providerOptions, maxRetries: 2 });
      } catch (err) {
        if (err instanceof AdapterUnavailableError) throw err;
        throw classifyGatewayError(err);
      }
      return toDirectShapedResponse(result, { questions: request.questions });
    },
  };
}
