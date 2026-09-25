/**
 * Common Decision Gateway — MCP 入口（stdio・依存ゼロ）。
 *
 * Claude Code・Cursor・将来の MCP 対応 Agent（Hermes・OpenAI Agents 等）が、IDE / AI を問わず同じ Decision Tool を使うための面。
 * tool 内部で判断ロジックを複製しない：すべて createGateway().decide(…, { via: 'mcp' }) を呼ぶだけ。
 *
 * プロトコル（2026-09-25 に Context7 で公式仕様を確認）：
 *   - stdio：1行 = 1 JSON-RPC message（改行区切り・メッセージ内改行なし）。stdout はプロトコル専用、ログは stderr
 *   - legacy era（initialize ハンドシェイク）で実装。対応版は SUPPORTED_PROTOCOL_VERSIONS。
 *     modern era（2026-07-28〜）の server/discover には -32601 を返す＝仕様上「legacy server」と判定され initialize へ fallback される
 *   - tools/call の結果は content[text] + structuredContent（envelope）。ok=false は isError=true（failure policy は本文にある）
 * 接続（Claude Code / Cursor の MCP 設定への登録）は Human-only（Vault MCP接続台帳 §4-7・§5）。
 */
import { createInterface } from 'node:readline';
import { createGateway } from './gateway.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = { name: 'e-nexus-decision-gateway', version: '0.1.0' };

const DECIDE_DESCRIPTION = [
  'E-NEXUS Common Decision Gateway: returns a typed decision for a registered decision_type (e.g. paid-generation-gate,',
  'content-publish-gate, channel-selection, model-route). Use it at a decision point (paid API vs local/free route, provider/model',
  'routing, whether a human must look, publish/channel candidate) instead of guessing. Rules are evaluated first, then the',
  'configured decision engine (currently Jev), then human escalation.',
  'The result NEVER approves anything: tier=auto or ok=true is not permission to spend, publish, deploy or send.',
  'Existing human-only gates (e.g. en-generate-hub approval) always still apply. If ok=false, follow result.failure (human-required or deny).',
].join(' ');

export const TOOLS = Object.freeze([
  {
    name: 'enexus_decide',
    title: 'E-NEXUS Decision',
    description: DECIDE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['decision_type', 'application_id', 'project_id', 'input'],
      properties: {
        decision_type: { type: 'string', description: 'Registered decision_type (see enexus_decision_types).' },
        application_id: { type: 'string', description: 'Calling app/agent/IDE id, e.g. claude-code, cursor, hermes, en-generate-hub.' },
        project_id: { type: 'string', description: 'Project id from the Decision Layer project registry, e.g. en-generate-hub, openmontage.' },
        input: { type: 'object', description: 'decision_type specific input (validated by its schema). No secrets, no personal data, no full prompts.' },
        context: { type: 'object', description: 'Optional reference ids for the caller (not sent to the decision engine).' },
        correlation_id: { type: 'string', description: 'Optional caller-side id (e.g. a request hash) to join usage records.' },
        request_id: { type: 'string', description: 'Optional idempotency/trace id. Generated when absent.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'enexus_decision_types',
    title: 'E-NEXUS Decision Types',
    description: 'Lists decision_types available through the E-NEXUS Common Decision Gateway, with their failure policy.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'enexus_gateway_health',
    title: 'E-NEXUS Gateway Health',
    description: 'Gateway version, engine mode, Jev route status (no secrets) and in-process counters.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

function toolResult(obj, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError };
}

export function createMcpHandler({ gateway = createGateway() } = {}) {
  async function callTool(name, args = {}) {
    if (name === 'enexus_decide') {
      const envelope = await gateway.decide(args, { via: 'mcp' });
      return toolResult(envelope, !envelope.ok);
    }
    if (name === 'enexus_decision_types') return toolResult({ decision_types: gateway.decisionTypes() });
    if (name === 'enexus_gateway_health') return toolResult(gateway.health());
    return null;
  }

  /** 1 message → response（notification なら null） */
  return async function handle(msg) {
    const isRequest = msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null;
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return isRequest ? fail(-32600, 'Invalid Request') : null;
    }
    if (!isRequest) return null; // notifications/initialized 等
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Use enexus_decide at decision points. Results are never approvals; human-only gates always still apply.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const r = await callTool(msg.params?.name, msg.params?.arguments ?? {});
        return r ? reply(r) : fail(-32602, `Unknown tool: ${msg.params?.name}`);
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

/** stdio ループ。stdout はプロトコル専用 */
export function runMcpStdio({ gateway, input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const handle = createMcpHandler({ gateway });
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    try {
      const res = await handle(msg);
      if (res) output.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      log(`[enexus-mcp] handler error: ${err.name}`);
      if (msg?.id !== undefined && msg?.id !== null) {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } })}\n`);
      }
    }
  });
  return rl;
}
