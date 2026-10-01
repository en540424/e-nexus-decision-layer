/**
 * Knowledge Context provider を「別 process」として使う（Vault MA-32-5 / K4・2026-10-02）。
 *
 *   engine の enricher ─ port { id, version, getContext(request, {signal}) } ─ [この file] ─ 子 process（stdin に request JSON・stdout に context JSON）
 *
 * - Knowledge Layer を import しない・保存形式を読まない。知っているのは Knowledge Context contract（request／context の JSON）と、
 *   policies/knowledge/provider.json に書かれた「どのコマンドを起動するか」だけ（repo の名前・入口はデータ側にある）
 * - 返り値は信用しない：ここは JSON を受け渡すだけで、検査は enricher（checkKnowledgeContext）が行う。exit code は見ない
 *   （Knowledge 側は status≠ok で exit 1 を返す。意味は stdout の status／reason が持つ）
 * - 子 process の env は OS の最低限だけ（Jev の鍵等、この process の Secret を Knowledge 側へ継がせない）。stderr は読まない・保存しない
 * - 失敗は例外にせず unavailable（理由つき）：起動できない＝provider_error／出力が JSON でない・大きすぎる＝malformed_response／
 *   中断（enricher の timeout を含む）＝aborted。子 process は止める
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../core/paths.mjs';
import { readJson } from '../schemas/loader.mjs';
import { unavailableKnowledgeContext } from './knowledge-enricher.mjs';

const DEFAULT_MAX_STDOUT = 262144;
// 子 process へ渡す env（名前だけ。Windows の node は SystemRoot が無いと起動に失敗する）
const CHILD_ENV_NAMES = Object.freeze(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ']);

export function childEnvFor(env = process.env) {
  const out = {};
  for (const k of CHILD_ENV_NAMES) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}

/**
 * @param {object} o
 * @param {string} o.command  起動するコマンド（例：process.execPath）
 * @param {string[]} [o.args]
 * @param {string} [o.cwd]
 * @param {string} [o.id]  explainability 用の provider id
 * @param {string} [o.version]
 */
export function createProcessKnowledgeProvider({ command, args = [], cwd, id = 'knowledge-process', version = '1', env = process.env, maxStdoutBytes = DEFAULT_MAX_STDOUT } = {}) {
  if (typeof command !== 'string' || !command) throw new Error('process knowledge provider: command is required');
  const childEnv = childEnvFor(env);
  const stats = { spawned: 0, failed: 0 };
  return Object.freeze({
    id,
    version,
    getContext(request, { signal } = {}) {
      const environment = request?.environment;
      if (signal?.aborted) return Promise.resolve(unavailableKnowledgeContext(environment, 'aborted'));
      return new Promise((done) => {
        let settled = false;
        let child;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (v.status === 'unavailable' && v.reason !== null) stats.failed += 1;
          done(v);
        };
        const kill = () => { try { child?.kill(); } catch { /* 既に終了 */ } };
        const onAbort = () => { kill(); finish(unavailableKnowledgeContext(environment, 'aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          child = spawn(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
          stats.spawned += 1;
        } catch {
          finish(unavailableKnowledgeContext(environment, 'provider_error'));
          return;
        }
        const chunks = [];
        let size = 0;
        child.on('error', () => finish(unavailableKnowledgeContext(environment, 'provider_error')));
        child.stdout.on('data', (c) => {
          size += c.length;
          if (size > maxStdoutBytes) { kill(); finish(unavailableKnowledgeContext(environment, 'malformed_response')); return; }
          chunks.push(c);
        });
        child.on('close', () => {
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish(unavailableKnowledgeContext(environment, 'malformed_response')); return; }
          finish(parsed);
        });
        child.stdin.on('error', () => { /* 子が先に終了した：close で扱う */ });
        child.stdin.end(JSON.stringify(request));
      });
    },
    stats: () => ({ ...stats }),
  });
}

/** 設定したのに使えないときの provider（黙って Knowledge 無しへ戻さない：毎回 unavailable(source_unavailable) を返す） */
function unavailableProvider(reason) {
  return Object.freeze({
    id: 'knowledge-unavailable',
    version: '1',
    async getContext(request) { return unavailableKnowledgeContext(request?.environment, reason); },
  });
}

/**
 * CLI の composition root 用：policies/knowledge/provider.json と env から provider を決める。
 * @returns {{ status: 'disabled'|'not_found'|'configured'|'misconfigured', source: 'env'|'sibling'|null, reason: string|null, provider: object|null }}
 *   disabled／not_found は provider を返さない（engine は従来と同一）。misconfigured は unavailable を返す provider（判断側で見える）。
 */
export function resolveKnowledgeProvider({ env = process.env, environment, policy = readJson('policies/knowledge/provider.json') } = {}) {
  const loc = policy.locate;
  if (env[loc.env_switch] === 'off') return { status: 'disabled', source: null, reason: 'switched_off', provider: null };
  if (!policy.environments.includes(environment)) return { status: 'disabled', source: null, reason: 'environment_not_wired', provider: null };
  const fromEnv = typeof env[loc.env_home] === 'string' && env[loc.env_home] !== '';
  const home = fromEnv ? resolve(env[loc.env_home]) : resolve(ROOT, '..', loc.sibling_dir);
  const entry = join(home, loc.entry);
  if (!existsSync(entry)) {
    return fromEnv
      ? { status: 'misconfigured', source: 'env', reason: 'entry_not_found', provider: unavailableProvider('source_unavailable') }
      : { status: 'not_found', source: null, reason: 'sibling_not_found', provider: null };
  }
  return {
    status: 'configured',
    source: fromEnv ? 'env' : 'sibling',
    reason: null,
    provider: createProcessKnowledgeProvider({ command: process.execPath, args: [entry, ...loc.args], cwd: home, id: 'knowledge-process', version: policy.version, env, maxStdoutBytes: policy.max_stdout_bytes }),
  };
}
