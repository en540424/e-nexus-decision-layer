#!/usr/bin/env node
/**
 * Agent Integration の実経路 E2E（2026-10-02・Vault MA-32-5）。dev 専用・課金なし。
 *
 *   node scripts/agent-integration-e2e.mjs --knowledge-layer <e-nexus-knowledge-layer の path> --map <project-integration-map.json の path>
 *
 * Claude Code（Skill enexus-decision）と同じ形で **実 CLI を子 process として起動**し（`gateway decide --stdin`）、
 *   Agent request → Gateway → engine の組み立て（CLI composition root）→ Knowledge Context provider（子 process）→ Rules／Jev → Decision → Agent
 * を通す。Jev へは送らない（子 process の env で EDL_ALLOW_NETWORK=false を上書き・usage は一時 file）。
 * failure injection は EDL_KNOWLEDGE_HOME で Knowledge Layer の写し（壊したもの）や偽の provider を指して行う。
 * 確かめること：Knowledge available／partial／unavailable／stale／unknown／隔離・Rules First・Human review・偽造の拒否・
 *   provider の不正応答（JSON でない・判断 key・Secret・timeout）・Knowledge 無効（従来と同一）・子 process に Secret を渡さない・
 *   Knowledge へ consumer の自由文を渡さない・usage 行の要約・latency。
 * 終了コード：0＝全 PASS／1＝FAIL あり／2＝引数不正。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const klDir = opt('knowledge-layer');
const mapPath = opt('map');
if (!klDir || !mapPath || !fs.existsSync(path.join(klDir, 'src', 'cli.mjs')) || !fs.existsSync(mapPath)) {
  process.stderr.write('usage: node scripts/agent-integration-e2e.mjs --knowledge-layer <dir> --map <project-integration-map.json>\n');
  process.exit(2);
}
const results = [];
const check = (name, pass, detail) => results.push({ name, pass: Boolean(pass), ...(pass ? {} : { detail }) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-agent-e2e-'));
const usagePath = path.join(tmp, 'usage.jsonl');

/** Claude Code と同じ呼び方：request を stdin・envelope を stdout。env は Claude Code の env を継承し、課金経路だけ止める */
function decide(request, envOver = {}) {
  const env = { ...process.env, EDL_ALLOW_NETWORK: 'false', EDL_USAGE_PATH: usagePath, EDL_ENVIRONMENT: '', ...envOver };
  for (const [k, v] of Object.entries(envOver)) if (v === undefined) delete env[k];
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'gateway', 'decide', '--stdin'], { input: JSON.stringify(request), encoding: 'utf8', env, timeout: 40000 });
  let envelope = null;
  try { envelope = JSON.parse(r.stdout); } catch { /* 下で FAIL */ }
  return { envelope, ms: Date.now() - started, status: r.status };
}
function health(envOver = {}) {
  const r = spawnSync(process.execPath, [CLI, 'gateway', 'health'], { encoding: 'utf8', env: { ...process.env, EDL_ALLOW_NETWORK: 'false', ...envOver } });
  return JSON.parse(r.stdout);
}
const asg = (projectId, over = {}, envelopeOver = {}) => ({
  contract_version: '1', expected_environment: 'dev', decision_type: 'automation-safety-gate', application_id: 'claude-code', project_id: projectId,
  input: { automation_kind: 'workflow', environment: 'dev', target_scope: 'internal-only', external_send: false, paid_api: false, writes_external_system: false, irreversible: false, touches_secrets: false, personal_data: false, existing_gate: 'human-manual', rollback_available: true, rate_or_cap_limited: true, summary: 'agent e2e: internal workflow change (no send, no paid API)', ...over },
  ...envelopeOver,
});
const k = (e) => e?.decision?.knowledge;

// ---- Knowledge Layer の写し（壊すため）。fs.cpSync は Windows の Node 24 で落ちたため平らな dir を手で写す（scripts/knowledge-integration-e2e.mjs と同じ）
const copyFlat = (from, to) => { fs.mkdirSync(to, { recursive: true }); if (!fs.existsSync(from)) return; for (const n of fs.readdirSync(from)) { const p = path.join(from, n); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(to, n)); } };
let copies = 0;
function klCopy(mutate) {
  const d = path.join(tmp, `kl${copies += 1}`);
  for (const sub of ['src', 'vocabulary', 'schemas']) copyFlat(path.join(klDir, sub), path.join(d, sub));
  fs.copyFileSync(path.join(klDir, 'package.json'), path.join(d, 'package.json'));
  for (const sub of ['data/knowledge', 'data/state']) copyFlat(path.join(klDir, sub), path.join(d, sub));
  mutate?.(d);
  return d;
}
/** 偽の provider（Knowledge Context contract を話すふりをする）。受け取った request と env の名前を cwd に書く */
function fakeProvider(name, body) {
  const d = path.join(tmp, `fake-${name}`);
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'cli.mjs'), `import fs from 'node:fs';\nlet t='';for await (const c of process.stdin) t+=c;\nfs.writeFileSync('seen.json', JSON.stringify({ request: JSON.parse(t), env: Object.keys(process.env).sort(), argv: process.argv.slice(2) }));\n${body}\n`);
  return d;
}

// ---- 独立計算：Map から consumer 集合
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
function expectedConsumers(projectId) {
  const p = map.projects.find((x) => x.id === projectId);
  const caps = [...(p?.provides ?? [])];
  return map.projects.filter((x) => x.id !== projectId && caps.some((c) => x.capabilities?.[c] && x.capabilities[c].level !== 'NONE')).map((x) => `project:${x.id}`).sort();
}

const latency = {};

// 1. health：CLI が兄弟フォルダの Knowledge を見つけて注入している（場所の path は出さない）
{
  const h = health();
  check('health：CLI が Knowledge provider を注入（configured・場所の path は出さない）', h.knowledge_runtime?.status === 'configured' && h.engine_health?.knowledge?.configured === true && !JSON.stringify(h).includes(klDir.replace(/\\/g, '\\\\')) && !JSON.stringify(h).includes(path.basename(klDir) + path.sep), h.knowledge_runtime);
}

// 2. Rules First（Knowledge を問い合わせない）
{
  const r = decide(asg('e-nexus-crm-core', { touches_secrets: true }));
  check('Rules First：rule で決まる input は Knowledge を問い合わせない（not_requested・rules）', r.envelope?.ok && k(r.envelope)?.status === 'not_requested' && k(r.envelope).rule_id === 'touches-secrets' && r.envelope.decision.resolved_by === 'rules', k(r.envelope));
  latency.rules_first_ms = r.ms;
}

// 3. Knowledge available（実データ）：impact の consumer 集合が Map と一致・refs だけ・envelope v1 の key 不変
for (const projectId of ['e-nexus-decision-layer', 'e-nexus-crm-core']) {
  const r = decide(asg(projectId));
  const kn = k(r.envelope);
  const got = (kn?.refs?.entities ?? []).filter((id) => id.startsWith('project:') && id !== `project:${projectId}`).sort();
  const exp = expectedConsumers(projectId);
  check(`[${projectId}] Knowledge available：status ok・subject・Jev 不在なので human（自動で進まない）`, r.envelope?.ok && kn?.status === 'ok' && kn.subject === `project:${projectId}` && r.envelope.decision.tier === 'human', { kn, tier: r.envelope?.decision?.tier });
  check(`[${projectId}] impact の consumer project が Map から独立に計算した集合と一致`, JSON.stringify(got) === JSON.stringify(exp) || (kn?.warnings ?? []).includes('truncated') && got.every((x) => exp.includes(x)), { got, exp });
  check(`[${projectId}] envelope は Contract v1 のまま・decision.knowledge は refs だけ`, r.envelope?.contract_version === '1' && JSON.stringify(Object.keys(r.envelope).sort()) === JSON.stringify(['contract_version', 'correlation_id', 'decision', 'gateway', 'ok', 'request_id']) && kn && !('facts' in kn) && !('usage' in kn), Object.keys(r.envelope ?? {}));
  latency[`available_${projectId}_ms`] = r.ms;
  latency[`enrichment_${projectId}_ms`] = kn?.latency_ms;
}

// 4. production 対象：Knowledge ok でも Jev が無ければ human（Knowledge は承認ではない）
{
  const r = decide(asg('e-nexus-crm-core', { environment: 'production' }));
  check('production 対象：Knowledge ok でも自動にならない（tier human・human_gate.required）', r.envelope?.ok && k(r.envelope)?.status === 'ok' && r.envelope.decision.tier === 'human' && r.envelope.decision.human_gate?.required === true, r.envelope?.decision?.tier);
}

// 5. unknown：観測の無い環境（staging）は coverage unknown のまま
{
  const d = klCopy();
  fs.writeFileSync(path.join(d, 'src', 'probe.mjs'), ''); // 写しが使われていることを確かめる目印（中身は無い）
  const r = decide(asg('e-nexus-crm-core', { environment: 'staging' }), { EDL_KNOWLEDGE_HOME: d });
  check('unknown：観測の無い環境（staging）を正常にしない（status ok・観測の refs に staging が無い）', k(r.envelope)?.status === 'ok' && !(k(r.envelope).refs.states ?? []).some((s) => s.includes('.staging.')), k(r.envelope));
}

// 6. partial：実測の置き場が無い（未 sync のノード）
{
  const d = klCopy((x) => fs.rmSync(path.join(x, 'data', 'state'), { recursive: true, force: true }));
  const r = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: d });
  check('partial：実測の置き場が無い＝partial（sync_metadata_missing を落とさない）', k(r.envelope)?.status === 'partial' && k(r.envelope).warnings.includes('sync_metadata_missing'), k(r.envelope));
}

// 7. stale：全観測が古い
{
  const d = klCopy((x) => {
    const f = path.join(x, 'data', 'state', 'observations.jsonl');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"observed_at":"[^"]+"/g, '"observed_at":"2026-01-01T00:00:00Z"'));
  });
  const r = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: d });
  check('stale：古い観測は stale_state の warning つき（effective にしない）', k(r.envelope)?.status === 'ok' && k(r.envelope).warnings.includes('stale_state'), k(r.envelope));
}

// 8. 隔離：壊れた実測1件で全体を止めない・warning を落とさない
{
  const d = klCopy((x) => fs.appendFileSync(path.join(x, 'data', 'state', 'observations.jsonl'), 'not json\n'));
  const r = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: d });
  check('隔離：壊れた実測があっても Knowledge は使える・state_records_quarantined を示す', k(r.envelope)?.status === 'ok' && k(r.envelope).warnings.includes('state_records_quarantined'), k(r.envelope));
}

// 9. unavailable：commit される事実（data/knowledge）が壊れている＝開かない
{
  const d = klCopy((x) => fs.appendFileSync(path.join(x, 'data', 'knowledge', 'entities.jsonl'), '{"broken":\n'));
  const dev = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: d });
  const prod = decide(asg('e-nexus-crm-core', { environment: 'production' }), { EDL_KNOWLEDGE_HOME: d });
  check('unavailable：壊れた Knowledge は data_integrity_error（dev は止めずに事実ごと渡す）', k(dev.envelope)?.status === 'unavailable' && k(dev.envelope).reason === 'data_integrity_error', k(dev.envelope));
  check('unavailable（production）：rules が human-review へ上げる', prod.envelope?.decision?.resolved_by === 'rules' && prod.envelope.decision.outcome.automation_route === 'human-review', prod.envelope?.decision?.rationale);
}

// 10. 設定したのに使えない（EDL_KNOWLEDGE_HOME が無い場所）＝黙って Knowledge 無しへ戻さない
{
  const missing = path.join(tmp, 'no-such-knowledge');
  const r = decide(asg('e-nexus-crm-core', { environment: 'production' }), { EDL_KNOWLEDGE_HOME: missing });
  const h = health({ EDL_KNOWLEDGE_HOME: missing });
  check('misconfigured：unavailable(source_unavailable) として判断側に見える・production は human-review', k(r.envelope)?.status === 'unavailable' && k(r.envelope).reason === 'source_unavailable' && r.envelope.decision.outcome?.automation_route === 'human-review', k(r.envelope));
  check('misconfigured：health に misconfigured（path は出さない）', h.knowledge_runtime?.status === 'misconfigured' && !JSON.stringify(h).includes('no-such-knowledge'), h.knowledge_runtime);
}

// 11. provider の不正応答：JSON でない・判断 key・Secret・timeout はどれも unavailable（部分的に使わない）
{
  const garbage = fakeProvider('garbage', "process.stdout.write('this is not json');");
  const r1 = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: garbage });
  check('不正応答（JSON でない）＝unavailable(malformed_response)', k(r1.envelope)?.status === 'unavailable' && k(r1.envelope).reason === 'malformed_response', k(r1.envelope));
  const seen = JSON.parse(fs.readFileSync(path.join(garbage, 'seen.json'), 'utf8'));
  check('子 process に Secret を渡さない（JEV_*・EDL_*・*_KEY・*_TOKEN が env に無い）', !seen.env.some((n) => /^(JEV_|EDL_|AI_GATEWAY_|ANTHROPIC|OPENAI)|_KEY$|_TOKEN$|SECRET/i.test(n)), seen.env.filter((n) => /KEY|TOKEN|JEV|EDL/i.test(n)));
  check('Knowledge へ consumer の自由文・input を渡さない（Knowledge Context request の field だけ）', JSON.stringify(Object.keys(seen.request).sort()) === JSON.stringify(['contract', 'environment', 'queries', 'subject']) && !JSON.stringify(seen.request).includes('agent e2e'), seen.request);
  const ctxBase = { contract: 'enexus-knowledge-context-v1', status: 'ok', reason: null, as_of: '2026-10-02T00:00:00Z', environment: 'dev', subject: { ref: { type: 'project', match: 'edlRegistryId', value: 'e-nexus-crm-core' }, id: 'project:e-nexus-crm-core', type: 'project', lifecycle: 'active', attrs: {}, authority: 0 }, facts: {}, authorities: [{ origins: ['deterministic_extraction'], validation: ['unverified'], min_confidence: 1 }], warnings: [], omitted: { unsafe_ids: 0, unsafe_values: 0 } };
  const decisionKey = fakeProvider('decision-key', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...ctxBase, subject: { ...ctxBase.subject, attrs: {} }, facts: {}, recommended: 'allow' })}));`);
  const r2 = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: decisionKey });
  check('不正応答（判断 key を含む）＝unavailable(malformed_response)', k(r2.envelope)?.status === 'unavailable' && k(r2.envelope).reason === 'malformed_response', k(r2.envelope));
  const leak = fakeProvider('secret', `process.stdout.write(JSON.stringify(${JSON.stringify({ ...ctxBase, subject: { ...ctxBase.subject, lifecycle: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' } })}));`);
  const r3 = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: leak });
  check('不正応答（Secret 風の値）＝unavailable・envelope に値を出さない', k(r3.envelope)?.status === 'unavailable' && !JSON.stringify(r3.envelope).includes('sk-ant'), k(r3.envelope));
  const hang = fakeProvider('hang', 'setInterval(() => {}, 1000);');
  const r4 = decide(asg('e-nexus-crm-core', { environment: 'production' }), { EDL_KNOWLEDGE_HOME: hang });
  check('timeout：unavailable(timeout)・production は human-review・Gateway の 30s に届く前に返る', k(r4.envelope)?.status === 'unavailable' && k(r4.envelope).reason === 'timeout' && r4.envelope.decision.outcome?.automation_route === 'human-review' && r4.ms < 15000, { kn: k(r4.envelope), ms: r4.ms });
  const crash = fakeProvider('crash', 'process.exit(3);');
  const r5 = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE_HOME: crash });
  check('provider が何も返さず終了＝unavailable(malformed_response)', k(r5.envelope)?.status === 'unavailable', k(r5.envelope));
}

// 12. Knowledge 無効（EDL_KNOWLEDGE=off）＝従来と同一（decision.knowledge が付かない）
{
  const r = decide(asg('e-nexus-crm-core'), { EDL_KNOWLEDGE: 'off' });
  check('EDL_KNOWLEDGE=off：Knowledge を使わない（従来と同一）', r.envelope?.ok && !('knowledge' in r.envelope.decision), r.envelope?.decision?.knowledge);
}

// 13. 偽造・入口の検査
{
  const forged = decide(asg('e-nexus-crm-core', { knowledge_context: { contract: 'enexus-knowledge-context-v1', status: 'ok' } }));
  check('偽造 knowledge_context は INVALID_ENVELOPE（failure human-required・自動で進まない）', forged.envelope?.ok === false && forged.envelope.error.code === 'INVALID_ENVELOPE' && forged.envelope.failure.proceed_automatically === false, forged.envelope?.error);
  const secret = decide(asg('e-nexus-crm-core', { summary: 'use key sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCC' }));
  check('input に鍵の形の値＝INVALID_ENVELOPE（Knowledge にも Jev にも届かない）', secret.envelope?.ok === false && secret.envelope.error.code === 'INVALID_ENVELOPE' && !JSON.stringify(secret.envelope).includes('CCCCCCCC'), secret.envelope?.error);
}

// 14. executor-route（Knowledge 要件の無い decision_type）：rules だけで答え、Knowledge を問い合わせない
{
  const r = decide({ contract_version: '1', expected_environment: 'dev', decision_type: 'executor-route', application_id: 'claude-code', project_id: 'e-nexus-decision-layer', input: { work_center: 'implementation', execution_mode: 'interactive', environment: 'dev', needs_vault_write: true } });
  check('executor-route（実 CLI）：rules が claude-code を返す・Knowledge 要件が無いので knowledge を付けない', r.envelope?.ok && r.envelope.decision.resolved_by === 'rules' && r.envelope.decision.outcome.recommended_executor === 'claude-code' && !('knowledge' in r.envelope.decision), r.envelope?.decision);
  const p = decide({ contract_version: '1', expected_environment: 'dev', decision_type: 'executor-route', application_id: 'claude-code', project_id: 'e-nexus-decision-layer', input: { work_center: 'operations', execution_mode: 'scheduled', environment: 'production', production_change: true } });
  check('executor-route（実 CLI）：Production 変更は human・tier human', p.envelope?.decision?.outcome?.recommended_executor === 'human' && p.envelope.decision.tier === 'human', p.envelope?.decision?.outcome);
}

// 15. usage 行：application_id・decision_type・Knowledge の要約（中身は無い）・Jev へ送っていない
{
  const rows = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const withK = rows.filter((x) => x.knowledge);
  check('usage：Knowledge を使った判定の行に要約（status・reason・latency・rule だけ）', withK.length > 0 && withK.every((x) => Object.keys(x.knowledge).sort().join() === 'environment,latency_ms,provider,reason,requested,rule_id,status,warnings' && x.application_id === 'claude-code'), withK[0]?.knowledge);
  check('usage：Jev へ送っていない（networked な attempt が 0）', rows.length > 0 && rows.every((x) => (x.attempts ?? []).every((a) => a.networked !== true)), rows.length);
  check('usage：状態ごとの件数が Knowledge の結果と一致して記録されている', ['ok', 'partial', 'unavailable', 'not_requested'].every((s) => withK.some((x) => x.knowledge.status === s)), [...new Set(withK.map((x) => x.knowledge.status))]);
}

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, passed: results.length - failed.length, total: results.length, latency, results }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
