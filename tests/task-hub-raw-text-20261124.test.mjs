/**
 * 原文と解析用の文の分離（2026-11-24・Human 決定）。受け口は params を NFKC に揃える（鍵の形・見た目の同じ文字の検査のため）。
 * params.text が揃えで変わった時だけ、受け取ったままの文を task の raw_text に別に残す。承認の digest・params は変えない。架空の文だけ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { contentDigest, parseEnvelope } from '../scripts/lib/task-hub/envelope.mjs';
import { exportDictations } from '../scripts/karte-dictation-export.mjs';
import { ingestInbox } from '../scripts/lib/task-hub/intake.mjs';
import { runOnce } from '../scripts/lib/task-hub/runner.mjs';
import { dropInbox, envelope, keyFor, makeEnv, seal } from './task-hub-helpers.mjs';

const FW = '架空町の試験邸。正面１０ｍ、左側約５ｍ、高さ約６ｍ。訂正：カーポートあり';
const env1 = (text) => JSON.stringify({ v: 1, idempotency_key: 'raw-text-0001-abcd', business: 'biz-a', intent: 'note.record', params: { text } });

test('parseEnvelope：揃えで変わった時だけ raw_text（受け取ったまま）・変わらない文・見えない文字を含む文には付けない・params は揃えた形のまま', () => {
  const r = parseEnvelope(env1(FW));
  assert.equal(r.envelope.raw_text, FW);
  assert.equal(r.envelope.params.text, FW.normalize('NFKC'));
  assert.ok(!('raw_text' in parseEnvelope(env1('half width 10m')).envelope));
  const hidden = parseEnvelope(env1(`高さ約６ｍ${String.fromCodePoint(0x200b)}`));
  assert.ok(hidden.ok && !('raw_text' in hidden.envelope), '見えない文字の原文は残さない（揃えた文は見えない文字を取った形）');
  assert.equal(parseEnvelope(env1('ｓｋ-ant-api03-' + 'A'.repeat(40))).code, 'secret_shaped_value', '鍵の形の検査は今までどおり');
});

test('承認の digest は params だけ（raw_text が在っても同じ）＝今までの承認・重複の判定は変わらない', () => {
  const r = parseEnvelope(env1(FW));
  const d = (e) => contentDigest({ source: 's', business: e.business, intent: e.intent, params: e.params });
  assert.equal(d(r.envelope), d({ ...r.envelope, raw_text: undefined }));
});

test('Bot の封から口述の記録まで：記録の text は原文・text_normalized は揃えた形・書き出しは原文・全角と半角の同じ文は 1 件', async () => {
  const env = makeEnv();
  try {
    const send = async (text, key) => {
      dropInbox(env.inbox, `r-${key}.json`, seal(envelope({ intent: 'note.record', idempotency_key: key, params: { kind: 'dictation', text, site: '架空町の試験邸', recorded_on: '2026-11-23' } })));
      const [r] = await ingestInbox(env.inbox, { keyFor, now: env.clock.t, store: env.store, policy: env.policy });
      await runOnce({ store: env.store, policy: env.policy, handlers: env.handlers, now: () => env.tick(10) });
      return env.store.readTask(r.task_id);
    };
    const t = await send(FW, 'raw-fw-0001-abcd');
    assert.equal(t.raw_text, FW);
    const [row] = [...env.store.readRecords('biz-a', 'dictation').values()];
    assert.deepEqual([row.text, row.text_normalized], [FW, FW.normalize('NFKC')]);
    assert.equal(exportDictations(env.store, 'biz-a').inputs[0].text, FW, 'APP 側へは原文');
    const again = await send(FW.normalize('NFKC'), 'raw-hw-0001-abcd');
    assert.equal(again.result.duplicate, true, '揃えた形が同じなら同じ口述');
    assert.ok(!JSON.stringify(t.result).includes('１０'), '結果に原文を返さない');
  } finally { rmSync(env.root, { recursive: true, force: true }); }
});
