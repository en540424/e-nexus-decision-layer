/**
 * Local Model Adapter — stub。
 * 将来 Mac mini 上のローカルモデル（Hermes / Ollama 等）へ判定を委ねる差し込み口。
 * 現段階では常に AdapterUnavailableError（LOCAL_MODEL_NOT_CONFIGURED）を返す。
 */
import { AdapterUnavailableError } from '../../core/errors.mjs';

export function createLocalAdapterStub({ model = null } = {}) {
  return {
    id: 'local',
    kind: 'probabilistic',
    provider: 'local',
    model,
    supports() {
      return true;
    },
    async decide({ decisionType }) {
      throw new AdapterUnavailableError('local', 'LOCAL_MODEL_NOT_CONFIGURED', { decisionType });
    },
  };
}
