/**
 * channel-selection（MA-31 G3後半・2026-09-23）。
 * 投稿先候補の型付き選定ゲートであって投稿実行装置ではないこと（Human-only publish）、Rules First、
 * Jev 経路（注入した fake provider。実ネットワークは使わない）、fallback、metering、privacy を機械的に確認する。
 * content-publish-gate と同じ検証観点を、責務（媒体候補の選定 ≠ 公開readiness/risk判定）に合わせて構成する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, loadDecisionType } from '../src/schemas/loader.mjs';
import { assertValid } from '../src/schemas/validate.mjs';
import { createDecisionEngine } from '../src/core/decision-engine.mjs';
import { createRulesAdapter } from '../src/adapters/rules/rules-adapter.mjs';
import { createJevAdapter, buildJevRequest } from '../src/adapters/jev/jev-adapter.mjs';
import { toGatewayQuestions } from '../src/adapters/jev/jev-vercel-provider.mjs';
import { createLocalAdapterStub } from '../src/adapters/local/local-adapter-stub.mjs';
import { createLlmAdapterStub } from '../src/adapters/llm/llm-adapter-stub.mjs';
import { createHumanAdapter } from '../src/adapters/human/human-adapter.mjs';
import { createMemoryMeter } from '../src/usage/metering.mjs';
import { createDecisionLayer } from '../src/index.mjs';
import { AdapterUnavailableError, HumanGateViolationError, SchemaValidationError } from '../src/core/errors.mjs';

const DT_ID = 'channel-selection';
const DT = loadDecisionType(DT_ID);
const OUTCOME = DT.schema.properties.outcome;
const RULES = readJson('policies/routing/rules/channel-selection.json').rules;
const SAFETY = readJson('policies/safety/human-only.json');
const PUBLISH_KEYS = ['publish_now', 'auto_publish', 'publish_approved', 'publish_allowed', 'allow_publish', 'post_now'];
const STEERING = [/answer true/i, /answer false/i, /always choose/i, /you must choose/i, /always say/i];

/** ルールに当たらない普通の無料 note 記事 → Jev へ */
function baseInput(extra = {}) {
  return {
    content_id: 'vault:04_Note/下書き/2026-09-23_sample',
    source_type: 'note-draft',
    content_type: 'article',
    channel: 'note',
    channel_registered: true,
    channel_publication_state: 'not-published',
    title: '足場屋がAIで見積もりを速くした話',
    summary: '現場の見積もり作業をAIで半自動化した経緯と、うまくいかなかった点。',
    excerpt: '最初は表計算の関数だけで済むと思っていた。',
    language: 'ja',
    ...extra,
  };
}

function req(input) {
  return { decision_type: DT_ID, application_id: 'claude-code', project_id: 'en-knowledge-vault', input };
}

/** fake Jev provider：question 名ごとに回答を指定する。送られた request を seen に残し、実ネットワークは使わない */
function fakeProvider(answersByField, { seen = [], usage = { input_tokens: 480, output_tokens: 10 } } = {}) {
  return {
    id: 'fake',
    available: () => ({ ok: true }),
    async send({ request }) {
      seen.push(request);
      const answers = {};
      for (const [name, q] of Object.entries(request.questions)) {
        const a = answersByField[name];
        answers[name] = q.type === 'noul' ? { type: 'noul', noul: a } : { type: 'choice', choice: a.choice, confidence: a.confidence };
      }
      return { model: 'fake-jev', answers, usage };
    },
  };
}

function engineWith(provider) {
  const env = { EDL_ALLOW_NETWORK: 'true' };
  const meter = createMemoryMeter();
  const engine = createDecisionEngine({
    adapters: [createRulesAdapter(), createJevAdapter({ env, provider }), createLocalAdapterStub(), createLlmAdapterStub({ env: {} }), createHumanAdapter()],
    meter,
  });
  return { engine, meter };
}

const CLEAR_PRIMARY = {
  channel_status: { choice: 'primary', confidence: 0.93 },
  content_channel_fit: { choice: 'high', confidence: 0.9 },
  human_review_required: 0.04,
  recommended_route: { choice: 'channel-candidate-review', confidence: 0.91 },
};

function assertNeverPublishes(r) {
  for (const k of [...PUBLISH_KEYS, 'approved', 'approval', 'authorized', 'bypass_human_gate', 'skip_human_review']) assert.ok(!(k in r.outcome), k);
  assert.equal(r.human_gate.preserved, true);
  assert.match(r.human_gate.note, /never approves/);
}

// ---------------------------------------------------------------- registry / schema

test('channel-selection is registered (moved out of reserved) with a closed schema and final_action human-only', () => {
  const idx = readJson('schemas/common/decision-types.json');
  assert.ok(idx.decision_types[DT_ID]);
  assert.ok(!idx.reserved_decision_types[DT_ID]);
  assert.equal(DT.domain, 'growth');
  assert.equal(DT.final_action, 'human-only');
  assert.equal(DT.schema.properties.input.additionalProperties, false, 'input is closed (no arbitrary PII / full body fields)');
  assert.equal(OUTCOME.additionalProperties, false);
  // 他の Growth 予約は予約のまま（content-publish-gate は既に実装済み）
  for (const id of ['lead-triage', 'next-best-action', 'customer-reply-gate', 'automation-safety-gate']) {
    assert.ok(idx.reserved_decision_types[id], id);
    assert.equal(loadDecisionType(id), null, id);
  }
});

test('route vocabulary is candidacy-only: no field name or enum value means publish / post / send / execute / dispatch / approve (発注書§22)', () => {
  const EXECUTION_WORDS = /publish|post|auto|send|execute|dispatch|approv|authoriz/i;
  const routes = OUTCOME.properties.recommended_route.enum;
  assert.deepEqual(routes, ['channel-candidate-review', 'not-a-candidate', 'hold']);
  for (const [name, prop] of Object.entries(OUTCOME.properties)) {
    assert.ok(!EXECUTION_WORDS.test(name), `field name: ${name}`);
    for (const v of prop.enum ?? []) assert.ok(!EXECUTION_WORDS.test(v), `${name} enum value: ${v}`);
  }
  for (const k of Object.keys(OUTCOME.properties)) assert.ok(!SAFETY.forbidden_outcome_keys.includes(k), k);
  for (const k of PUBLISH_KEYS) assert.ok(SAFETY.forbidden_outcome_keys.includes(k), `${k} is a forbidden outcome key`);
});

test('every outcome field maps to a Jev question (boolean / enum only) so Jev is never unavailable for this type', () => {
  const { request, fieldPlans } = buildJevRequest({ decisionType: DT_ID, outcomeSchema: OUTCOME, input: baseInput(), candidates: [] });
  assert.deepEqual(Object.keys(fieldPlans).sort(), ['channel_status', 'content_channel_fit', 'human_review_required', 'recommended_route']);
  assert.equal(request.questions.human_review_required.type, 'noul');
  assert.equal(request.questions.channel_status.type, 'choice');
  assert.equal(request.questions.content_channel_fit.type, 'choice');
  // 2026-09-26：route は channel_status から導出（x-jev-derive）。Jev への質問にはしない
  assert.equal(fieldPlans.recommended_route.kind, 'derived');
  assert.ok(!('recommended_route' in request.questions));
  // Rules First 通過後に到達し得る値だけを提示（x-jev-enum）
  assert.deepEqual(Object.keys(request.questions.channel_status.criteria), ['primary', 'secondary', 'not_recommended']);
  assert.deepEqual(Object.keys(request.questions.content_channel_fit.criteria), ['high', 'medium', 'low']);
});

test('Vercel Gateway conversion (the Human smoke route) accepts this schema: no throw, non-empty criteria for every enum', () => {
  const { request } = buildJevRequest({ decisionType: DT_ID, outcomeSchema: OUTCOME, input: baseInput(), candidates: [] });
  const gw = toGatewayQuestions(request.questions);
  assert.deepEqual(Object.keys(gw).sort(), Object.keys(request.questions).sort());
  for (const field of ['channel_status', 'content_channel_fit']) {
    for (const [v, text] of Object.entries(gw[field].criteria)) assert.ok(typeof text === 'string' && text.length > 0, `${field}.${v}`);
  }
});

// ---------------------------------------------------------------- Jev question design（Calibration 方式）

test('question design: every field has concrete instructions, every enum value has criteria, the brief separates this from publishing and from content-publish-gate', () => {
  for (const [name, prop] of Object.entries(OUTCOME.properties)) {
    assert.ok(typeof prop.description === 'string' && prop.description.length > 60, `${name} needs a real description`);
    if (prop.enum) for (const v of prop.enum) assert.ok(typeof prop['x-enum-descriptions']?.[v] === 'string' && prop['x-enum-descriptions'][v].length > 20, `${name}.${v}`);
  }
  assert.match(OUTCOME.description, /never selects a channel to publish to/);
  assert.match(OUTCOME.description, /never a publishing approval/);
  assert.match(OUTCOME.description, /separate decision \(content-publish-gate\)/);
  // human_review_required = 「このcontent×channelの組合せに焦点確認が要るか」。「投稿に Human 承認が要るか」（常に要る）と混同しない
  assert.match(OUTCOME.properties.human_review_required.description, /not about whether posting to this channel needs human approval/);
  const texts = [OUTCOME.description, OUTCOME['x-jev-brief'], ...Object.values(OUTCOME.properties).flatMap((p) => [p.description, ...Object.values(p['x-enum-descriptions'] ?? {}), ...Object.values(p['x-boolean-criteria'] ?? {})])];
  for (const t of texts) for (const re of STEERING) assert.ok(!re.test(t), `steering phrase ${re} in: ${t.slice(0, 60)}`);
  const { request } = buildJevRequest({ decisionType: DT_ID, outcomeSchema: OUTCOME, input: baseInput(), candidates: [], inputSchema: DT.schema.properties.input });
  for (const [name, q] of Object.entries(request.questions)) assert.equal(q.instructions, OUTCOME.properties[name].description, name);
  // Jev には Rules First 通過後の前提を含む x-jev-brief を送る（公開承認ではないこと・content-publish-gate と別であることを含む）
  assert.equal(request.state.brief, OUTCOME['x-jev-brief']);
  assert.match(request.state.brief, /never a publishing approval/);
  assert.match(request.state.brief, /separate decision \(content-publish-gate\)/);
  // input_notes：input の enum 値（channel=note）の意味だけを schema の固定文から添える。他の input 値は増やさない
  assert.deepEqual(request.state.input_notes, { channel: DT.schema.properties.input.properties.channel['x-enum-descriptions'].note });
  assert.match(request.state.input_notes.channel, /note\.com/);
  assert.deepEqual(request.state.input, baseInput(), 'input itself is passed unchanged');
});

// ---------------------------------------------------------------- rules table（runtime では一致時にしか検証されないため表全体を検査）

test('rules table: every rule outcome passes the outcome schema and is status/route-consistent; no rule can emit a publish key', () => {
  const ids = new Set();
  const STATUS_TO_ROUTE = {
    primary: 'channel-candidate-review', secondary: 'channel-candidate-review',
    not_recommended: 'not-a-candidate', excluded: 'not-a-candidate', future: 'not-a-candidate', internal: 'not-a-candidate',
    unavailable: 'hold',
  };
  for (const rule of RULES) {
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
    assertValid(OUTCOME, rule.outcome, `rule ${rule.id}`);
    const o = rule.outcome;
    assert.equal(o.recommended_route, STATUS_TO_ROUTE[o.channel_status], `${rule.id}: route must match channel_status bucket`);
    for (const k of Object.keys(o)) assert.ok(!SAFETY.forbidden_outcome_keys.includes(k), `${rule.id}: ${k}`);
    // human-channel-preferred が唯一 primary を返す rule（Human の明示指定を尊重するため）。他の rule は自ら primary を確定しない
    if (rule.id !== 'human-channel-preferred') assert.notEqual(o.channel_status, 'primary', `${rule.id}: rules never self-declare primary from content fit`);
    // どの rule も内容を読んでいないので content_channel_fit は常に none（human-channel-preferred も例外ではない：Human の指定は尊重するが fit を判断したわけではない）
    assert.equal(o.content_channel_fit, 'none', rule.id);
  }
  // 名前で止めるのは方針が固定済みの3媒体だけ（planned / manual は caller の channel_registered で判定。Channel Registry を複製しない）
  const namedChannels = new Set(RULES.map((r) => r.when.channel).filter((c) => typeof c === 'string'));
  assert.deepEqual([...namedChannels].sort(), ['discord', 'facebook', 'linkedin', 'threads', 'x']);
  const blockedByName = RULES.filter((r) => typeof r.when.channel === 'string' && Object.keys(r.when).length === 1).map((r) => r.when.channel).sort();
  assert.deepEqual(blockedByName, ['discord', 'facebook', 'linkedin']);
});

// ---------------------------------------------------------------- representative cases A〜L

test('A: ordinary free note article, nothing forces a rule → Jev decides candidacy; still never a publish', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY, { seen }));
  const r = await engine.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.channel_status, 'primary');
  assert.equal(r.outcome.content_channel_fit, 'high');
  assert.equal(r.outcome.recommended_route, 'channel-candidate-review');
  assert.equal(r.outcome.human_review_required, false);
  // tier=auto は「この候補判定に確信がある」であって投稿許可ではない（content-publish-gate の tier=auto 固定と同じ意味論）
  assert.equal(r.tier, 'auto');
  assert.equal(r.human_gate.required, false);
  assertNeverPublishes(r);
  assert.equal(DT.final_action, 'human-only', 'posting stays Human-only regardless of tier');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].state.input, baseInput(), 'Jev receives exactly the (closed, minimal) input');
});

test('B: short SNS-style content on X / Threads reflects the opt-in condition (missing → hold, granted → reaches Jev)', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  for (const channel of ['x', 'threads']) {
    const missing = await engine.decide(req(baseInput({ channel, content_type: 'post' })));
    assert.match(missing.rationale, new RegExp(`^rule:${channel}-opt-in-missing`));
    assert.equal(missing.outcome.channel_status, 'unavailable');
    assert.equal(missing.outcome.recommended_route, 'hold');
    const granted = await engine.decide(req(baseInput({ channel, content_type: 'post', human_opt_in: true })));
    assert.equal(granted.resolved_by, 'jev', channel);
    assert.equal(granted.outcome.recommended_route, 'channel-candidate-review');
    assertNeverPublishes(granted);
  }
});

test('C / D / E: facebook (excluded) / linkedin (future) / discord (internal) → deterministic, not a candidate', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY, { seen }));
  const cases = [['facebook', 'channel-facebook-excluded', 'excluded'], ['linkedin', 'channel-linkedin-future', 'future'], ['discord', 'channel-discord-internal', 'internal']];
  for (const [channel, ruleId, status] of cases) {
    const r = await engine.decide(req(baseInput({ channel })));
    assert.equal(r.resolved_by, 'rules', channel);
    assert.match(r.rationale, new RegExp(`^rule:${ruleId}`), channel);
    assert.equal(r.outcome.channel_status, status, channel);
    assert.equal(r.outcome.recommended_route, 'not-a-candidate', channel);
    assert.equal(r.confidence, 1);
    assertNeverPublishes(r);
  }
  assert.equal(seen.length, 0, 'channel policy is never asked to Jev');
});

test('F: video content on a registered channel (YouTube) reaches Jev as a live candidacy question', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY, { seen }));
  const r = await engine.decide(req(baseInput({ channel: 'youtube', content_type: 'video', media_type: 'video' })));
  assert.equal(r.resolved_by, 'jev');
  assert.equal(r.outcome.recommended_route, 'channel-candidate-review');
  assert.equal(seen[0].state.input.content_type, 'video');
});

test('G / H: an unregistered channel (planned media, no real account yet) is unavailable/hold, not fabricated as a candidate', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  for (const channel of ['instagram', 'pinterest', 'tiktok']) {
    const r = await engine.decide(req(baseInput({ channel, channel_registered: false, content_type: 'other', media_type: 'image' })));
    assert.match(r.rationale, /^rule:channel-not-registered/, channel);
    assert.equal(r.outcome.channel_status, 'unavailable', channel);
    assert.equal(r.outcome.recommended_route, 'hold', channel);
  }
});

test('I: already published on this channel → excluded (not a duplicate candidate); unknown publication state → hold', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const published = await engine.decide(req(baseInput({ channel_publication_state: 'published' })));
  assert.match(published.rationale, /^rule:channel-publication-state-published/);
  assert.equal(published.outcome.channel_status, 'excluded');
  assert.equal(published.outcome.recommended_route, 'not-a-candidate');
  const unknown = await engine.decide(req(baseInput({ channel_publication_state: 'unknown' })));
  assert.match(unknown.rationale, /^rule:channel-publication-state-unknown/);
  assert.equal(unknown.outcome.recommended_route, 'hold');
});

test('J: Human explicitly names note as preferred → primary; policy block still wins over an explicit human preference', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const preferred = await engine.decide(req(baseInput({ human_channel_preference: 'preferred' })));
  assert.match(preferred.rationale, /^rule:human-channel-preferred/);
  assert.equal(preferred.outcome.channel_status, 'primary');
  assert.equal(preferred.outcome.content_channel_fit, 'none', 'rules never assess fit, even for an explicit human preference');
  assert.equal(preferred.outcome.recommended_route, 'channel-candidate-review');
  assertNeverPublishes(preferred);
  // facebook が preferred でも policy block が先に評価される（Human preference は policy block を突破しない）
  const blocked = await engine.decide(req(baseInput({ channel: 'facebook', human_channel_preference: 'preferred' })));
  assert.match(blocked.rationale, /^rule:channel-facebook-excluded/);
  assert.equal(blocked.outcome.channel_status, 'excluded');
  // Human が明示的に使わないでほしいと指定した媒体は excluded
  const excluded = await engine.decide(req(baseInput({ human_channel_preference: 'excluded' })));
  assert.match(excluded.rationale, /^rule:human-channel-excluded/);
  assert.equal(excluded.outcome.recommended_route, 'not-a-candidate');
});

test('ordering invariant: an explicit human "preferred" preference never overrides an earlier deterministic stop', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const cases = [
    [{ channel: 'facebook' }, 'rule:channel-facebook-excluded', 'excluded'],
    [{ channel: 'linkedin' }, 'rule:channel-linkedin-future', 'future'],
    [{ channel: 'discord' }, 'rule:channel-discord-internal', 'internal'],
    [{ channel_publication_state: 'published' }, 'rule:channel-publication-state-published', 'excluded'],
    [{ channel_publication_state: 'unknown' }, 'rule:channel-publication-state-unknown', 'unavailable'],
    [{ paid_listing: true }, 'rule:paid-listing-out-of-scope', 'excluded'],
    [{ channel: 'instagram', channel_registered: false }, 'rule:channel-not-registered', 'unavailable'],
    [{ channel: 'x', content_type: 'post' }, 'rule:x-opt-in-missing', 'unavailable'],
    [{ channel: 'threads', content_type: 'post', human_opt_in: false }, 'rule:threads-opt-in-false', 'unavailable'],
  ];
  for (const [extra, ruleIdPattern, status] of cases) {
    const input = baseInput({ ...extra, human_channel_preference: 'preferred' });
    const r = await engine.decide(req(input));
    assert.match(r.rationale, new RegExp(`^${ruleIdPattern}`), JSON.stringify(extra));
    assert.equal(r.outcome.channel_status, status, JSON.stringify(extra));
    assert.notEqual(r.outcome.channel_status, 'primary', JSON.stringify(extra));
  }
  // 情報不足も Human の明示優先で上書きされない（title/summary-missing は human-channel-preferred より先に評価される）
  const noTitle = baseInput({ human_channel_preference: 'preferred' });
  delete noTitle.title;
  const a = await engine.decide(req(noTitle));
  assert.match(a.rationale, /^rule:title-missing/);
  assert.equal(a.outcome.channel_status, 'unavailable');
  const noSummary = baseInput({ human_channel_preference: 'preferred' });
  delete noSummary.summary;
  const b = await engine.decide(req(noSummary));
  assert.match(b.rationale, /^rule:summary-missing/);
  assert.equal(b.outcome.channel_status, 'unavailable');
});

test('K: a paid note listing is out of scope for content distribution (not confused with free content)', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const r = await engine.decide(req(baseInput({ paid_listing: true })));
  assert.match(r.rationale, /^rule:paid-listing-out-of-scope/);
  assert.equal(r.outcome.channel_status, 'excluded');
  assert.equal(r.outcome.recommended_route, 'not-a-candidate');
});

test('L: missing information (title / summary) → hold by rule (typed result, not a schema error)', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const noTitle = baseInput();
  delete noTitle.title;
  const a = await engine.decide(req(noTitle));
  assert.match(a.rationale, /^rule:title-missing/);
  assert.equal(a.outcome.recommended_route, 'hold');
  const noSummary = baseInput();
  delete noSummary.summary;
  const b = await engine.decide(req(noSummary));
  assert.match(b.rationale, /^rule:summary-missing/);
  assert.equal(b.outcome.recommended_route, 'hold');
});

test('semantics pinned: deterministic not-a-candidate / hold without a fit concern are tier=auto and human_gate.required=false — callers must key on recommended_route, not on human_gate.required', async () => {
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const cases = [
    [{ channel: 'facebook' }, 'not-a-candidate'],
    [{ channel: 'linkedin' }, 'not-a-candidate'],
    [{ channel: 'discord' }, 'not-a-candidate'],
    [{ channel_publication_state: 'published' }, 'not-a-candidate'],
    [{ paid_listing: true }, 'not-a-candidate'],
    [{ human_channel_preference: 'excluded' }, 'not-a-candidate'],
    [{ channel_publication_state: 'unknown' }, 'hold'],
    [{ channel: 'instagram', channel_registered: false }, 'hold'],
    [{ channel: 'x', content_type: 'post' }, 'hold'],
  ];
  for (const [extra, route] of cases) {
    const r = await engine.decide(req(baseInput(extra)));
    assert.equal(r.outcome.recommended_route, route, JSON.stringify(extra));
    assert.equal(r.tier, 'auto', JSON.stringify(extra));
    assert.equal(r.human_gate.required, false, JSON.stringify(extra));
    assertNeverPublishes(r);
  }
});

test('gap closed (2026-09-26 Calibration): recommended_route is derived from channel_status, so status/route cannot contradict; a status/fit contradiction at high confidence → invariant violation → confidence 0 → human', async () => {
  // route は Jev に訊かない（x-jev-derive）。Jev が route を返しても使われない
  const seen = [];
  const { engine } = engineWith(fakeProvider({ ...CLEAR_PRIMARY, channel_status: { choice: 'not_recommended', confidence: 0.9 }, content_channel_fit: { choice: 'low', confidence: 0.88 }, recommended_route: { choice: 'channel-candidate-review', confidence: 0.9 } }, { seen }));
  const r = await engine.decide(req(baseInput()));
  assert.ok(!('recommended_route' in seen[0].questions), 'route is not asked');
  assert.equal(r.outcome.channel_status, 'not_recommended');
  assert.equal(r.outcome.recommended_route, 'not-a-candidate', 'derived from channel_status');
  // primary × fit low は自己矛盾（x-outcome-invariants）→ 回答全体を信頼しない
  const { engine: e2 } = engineWith(fakeProvider({ ...CLEAR_PRIMARY, channel_status: { choice: 'primary', confidence: 0.95 }, content_channel_fit: { choice: 'low', confidence: 0.95 } }));
  const r2 = await e2.decide(req(baseInput()));
  assert.equal(r2.tier, 'human');
  assert.equal(r2.resolved_by, 'human');
  const jev = r2.fallback.trace.find((a) => a.adapter === 'jev');
  assert.equal(jev.status, 'ok');
  assert.equal(jev.confidence, 0, 'contradiction ⇒ no confidence');
  assert.equal(jev.networked, true, 'usage of the real call is kept');
  assertNeverPublishes(r2);
  assert.equal(DT.final_action, 'human-only');
});

// ---------------------------------------------------------------- Human-only publish（機械的な壁）

test('an adapter returning a publish-execution key is rejected with HumanGateViolationError', async () => {
  for (const key of PUBLISH_KEYS) {
    const rogue = {
      id: 'rogue', kind: 'probabilistic', provider: 'mock', model: null, supports: () => true,
      decide: async () => ({ outcome: { channel_status: 'primary', content_channel_fit: 'high', human_review_required: false, recommended_route: 'channel-candidate-review', [key]: true }, confidence: 0.99 }),
    };
    const engine = createDecisionEngine({ adapters: [rogue, createHumanAdapter()], meter: createMemoryMeter(), routingPolicy: { default_chain: ['rogue', 'human'], overrides: {} } });
    await assert.rejects(() => engine.decide(req(baseInput())), HumanGateViolationError, key);
  }
});

// ---------------------------------------------------------------- fallback（既存 chain をそのまま使う）

test('no key / network gate off: rules miss → jev NETWORK_DISABLED → mock-jev is not used for this type → human escalation', async () => {
  const meter = createMemoryMeter();
  const edl = createDecisionLayer({ env: {}, meter });
  const r = await edl.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'human');
  assert.equal(r.tier, 'human');
  assert.equal(r.outcome.escalated, true);
  const byAdapter = Object.fromEntries(r.fallback.trace.map((t) => [t.adapter, t]));
  assert.equal(byAdapter.rules.reason, 'NO_RULE_MATCHED');
  assert.match(byAdapter.jev.reason, /KEY_MISSING|NETWORK_DISABLED/, 'send-before gate');
  assert.equal(byAdapter.jev.networked, false);
  assert.ok(!('mock-jev' in byAdapter), 'mock-jev never decides a channel-selection candidacy (no heuristic → UNSUPPORTED)');
  assert.ok(r.fallback.skipped.some((s) => s.adapter === 'mock-jev' && s.reason === 'UNSUPPORTED'));
  assert.equal(meter.readAll().length, 1);
});

test('real Jev fails after sending (429) → attempt keeps networked=true / unknown usage → falls through to human', async () => {
  const provider = {
    id: 'fake',
    available: () => ({ ok: true }),
    async send() { throw new AdapterUnavailableError('jev', 'JEV_RATE_LIMITED', { status: 429, networked: true, retry_count: 2 }); },
  };
  const { engine, meter } = engineWith(provider);
  const r = await engine.decide(req(baseInput()));
  assert.equal(r.resolved_by, 'human');
  const jev = r.fallback.trace.find((t) => t.adapter === 'jev');
  assert.equal(jev.status, 'unavailable');
  assert.equal(jev.reason, 'JEV_RATE_LIMITED');
  assert.equal(jev.networked, true);
  assert.equal(jev.usage_known, false);
  assert.equal(jev.retry_count, 2);
  assert.equal(meter.readAll()[0].usage_total.unknown_usage_attempts, 1);
});

// ---------------------------------------------------------------- metering

test('metering: Jev decision records provider / model / route / confidence / latency / tokens / cost / networked in attempts[]', async () => {
  const { engine, meter } = engineWith(fakeProvider(CLEAR_PRIMARY));
  const r = await engine.decide(req(baseInput()));
  assert.equal(meter.readAll().length, 1);
  const row = meter.readAll()[0];
  assert.equal(row.decision_type, DT_ID);
  assert.equal(row.resolved_by, 'jev');
  assert.equal(row.provider, 'typesafe-ai');
  assert.equal(row.tier, 'auto');
  const jev = row.attempts.find((a) => a.adapter === 'jev');
  assert.equal(jev.final, true);
  assert.equal(jev.model, 'fake-jev');
  assert.equal(jev.route, 'fake');
  assert.equal(jev.networked, true);
  assert.equal(jev.input_tokens, 480);
  assert.equal(typeof jev.estimated_cost_usd_micros, 'number');
  assert.equal(typeof jev.latency_ms, 'number');
  assert.ok(Math.abs(jev.confidence - r.confidence) < 1e-9);
  assert.equal(row.attempts[0].adapter, 'rules');
  assert.equal(row.attempts[0].reason, 'NO_RULE_MATCHED');
  assert.equal(row.usage_total.networked_attempts, 1);
});

test('metering: rule decision is one free, non-networked attempt', async () => {
  const { engine, meter } = engineWith(fakeProvider(CLEAR_PRIMARY));
  await engine.decide(req(baseInput({ channel: 'facebook' })));
  const row = meter.readAll()[0];
  assert.equal(row.resolved_by, 'rules');
  assert.equal(row.estimated_cost_usd_micros, 0);
  assert.equal(row.attempts.length, 1);
  assert.equal(row.attempts[0].networked, false);
  assert.equal(row.usage_total.estimated_cost_usd_micros, 0);
});

// ---------------------------------------------------------------- privacy（input は閉じていて有限）

test('privacy: unknown input fields (e.g. author email / full body) and over-long free text are rejected before any adapter runs', async () => {
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY, { seen }));
  await assert.rejects(() => engine.decide(req(baseInput({ author_email: 'x@example.com' }))), SchemaValidationError);
  await assert.rejects(() => engine.decide(req(baseInput({ body: 'full text' }))), SchemaValidationError);
  await assert.rejects(() => engine.decide(req(baseInput({ excerpt: 'あ'.repeat(1201) }))), SchemaValidationError);
  assert.equal(seen.length, 0);
});

test('sample request for the Human smoke run is valid and reaches Jev (no rule match)', async () => {
  const sample = readJson('docs/growth/channel-selection.sample-request.json');
  const seen = [];
  const { engine } = engineWith(fakeProvider(CLEAR_PRIMARY, { seen }));
  const r = await engine.decide(sample);
  assert.equal(r.resolved_by, 'jev');
  assert.equal(seen.length, 1);
});
