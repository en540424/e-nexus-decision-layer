/**
 * LLM Adapter — stub。
 * Medium confidence 時の「上位LLM再判定」経路の差し込み口。Claude / GPT / その他はここで provider を切り替える。
 * 現段階では外部送信を行わず、常に AdapterUnavailableError を返す（Engine は次の Adapter へ進む）。
 * 実装時も Adapter Interface（adapter-interface.mjs）を守り、Engine を変更しない。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

export function createLlmAdapterStub({ provider = 'anthropic', model = null, env = process.env } = {}) {
  return {
    id: 'llm',
    kind: 'probabilistic',
    provider,
    model,
    supports() {
      return true;
    },
    async decide({ decisionType }) {
      if (env.EDL_ALLOW_NETWORK !== 'true') throw new AdapterUnavailableError('llm', 'NETWORK_DISABLED', { decisionType });
      throw new AdapterUnavailableError('llm', 'LLM_CLIENT_NOT_IMPLEMENTED', { decisionType, provider });
    },
  };
}
