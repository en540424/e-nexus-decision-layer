/**
 * Agent Integration Contract：envelope → Agent の次の行動（Vault MA-32-5・2026-10-02）。
 * Node と Python の参照実装が言語非依存の cases で同じ結果・承認を返さない・緩めない。Hermes（Python）でも同じ解釈になる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../src/core/paths.mjs';
import { readJson } from '../src/schemas/loader.mjs';
import { interpretEnvelope } from '../consumer-kit/node/interpret.mjs';

const CASES_FILE = join(ROOT, 'consumer-kit', 'conformance', 'interpretation-cases.json');
const { cases } = readJson('consumer-kit/conformance/interpretation-cases.json');

test('interpretation cases：Node 参照実装が全 case で期待どおり・approval は常に false', () => {
  assert.ok(cases.length >= 12);
  for (const c of cases) {
    const r = interpretEnvelope(c.envelope, { expectedEnvironment: c.expected_environment });
    assert.equal(r.next, c.expect.next, c.name);
    assert.equal(r.approval, false, c.name);
  }
});

test('緩めない：tier auto 以外・壊れた入力からは candidate を返さない（ランダムな envelope でも）', () => {
  const tiers = ['auto', 'review', 'human', 'go', undefined, null];
  for (let i = 0; i < 2000; i += 1) {
    const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
    const env = {
      contract_version: pick(['1', '2', undefined]),
      ok: pick([true, false, 'true', undefined]),
      decision: pick([null, undefined, { tier: pick(tiers), human_gate: pick([undefined, { required: pick([true, false, 'true']) }]), outcome: pick([undefined, { approved: true }, { x: 1 }]) }]),
      gateway: pick([undefined, { environment: pick(['dev', 'production', undefined]) }]),
      failure: pick([undefined, { policy: pick(['deny', 'human-required', 'allow']) }]),
    };
    const r = interpretEnvelope(env);
    assert.equal(r.approval, false);
    if (r.next === 'candidate') {
      assert.ok(env.contract_version === '1' && env.ok === true && env.decision?.tier === 'auto' && env.decision.human_gate?.required !== true && env.gateway?.environment === 'dev' && !env.decision.outcome?.approved, JSON.stringify(env));
    }
    if (r.next === 'stop') assert.ok(env.ok !== true && env.failure?.policy === 'deny');
  }
});

test('Python 参照実装（Hermes 等）も同じ結果', (t) => {
  const py = ['python', 'python3', 'py'].map((cmd) => spawnSync(cmd, [join(ROOT, 'consumer-kit', 'python', 'enexus_interpret.py'), CASES_FILE], { encoding: 'utf8' })).find((r) => r.status === 0);
  if (!py) { t.skip('Python が無いノード'); return; }
  const out = JSON.parse(py.stdout);
  assert.equal(out.length, cases.length);
  cases.forEach((c, i) => assert.deepEqual(out[i], interpretEnvelope(c.envelope, { expectedEnvironment: c.expected_environment }), c.name));
});
