/**
 * 再 Calibration 材料（scripts/recalibration-report.mjs・2026-09-29 FB-09）。usage.jsonl を読むだけ・課金なし・新しい計測はしない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectRows, buildReport, formatReport, parseLabels, jevAttemptOf, DEFAULT_GRID } from '../scripts/recalibration-report.mjs';
import { ROOT } from '../src/core/paths.mjs';

const T = { auto_min: 0.85, review_min: 0.6 };
const row = (id, { conf = null, tier = 'human', app = 'en-sns-hub', type = 'content-publish-gate', aborted, ts = '2026-09-28T00:00:00Z', resolvedBy } = {}) => ({
  timestamp: ts, decision_id: `dec_${id}`, request_id: `req_${id}`, application_id: app, decision_type: type, tier,
  resolved_by: resolvedBy ?? (conf === null ? 'rules' : tier === 'human' ? 'human' : 'jev'),
  ...(aborted ? { aborted: true } : {}),
  attempts: conf === null ? [{ adapter: 'rules', status: 'ok', confidence: 1 }] : [{ adapter: 'rules', status: 'unavailable' }, { adapter: 'jev', status: 'ok', confidence: conf, networked: true }],
});

const ROWS = [
  row('a', { conf: 0.95, tier: 'auto' }),
  row('b', { conf: 0.7, tier: 'review' }),
  row('c', { conf: 0.4, tier: 'human' }),
  row('d', { conf: 0.82, tier: 'human' }), // forced human（強制フラグ）でも confidence は 0.82
  row('e'), // rules
  row('f', { conf: 0.99, tier: 'auto', aborted: true }),
  row('g', { conf: 0.99, tier: 'auto', app: 'claude-code' }),
  row('h', { conf: 0.99, tier: 'auto', type: 'channel-selection' }),
  row('i', { conf: 0.9, tier: 'auto', ts: '2026-09-01T00:00:00Z' }),
];

test('selects one decision type / consumer / period and drops aborted rows', () => {
  const s = selectRows(ROWS, { decisionType: 'content-publish-gate', application: 'en-sns-hub', since: '2026-09-26T00:00:00Z' });
  assert.deepEqual(s.map((r) => r.decision_id), ['dec_a', 'dec_b', 'dec_c', 'dec_d', 'dec_e']);
  assert.equal(jevAttemptOf(ROWS[4]), null, 'rules rows have no Jev attempt');
});

test('report: distributions, Jev reach, and threshold simulation from recorded Jev confidence only', () => {
  const s = selectRows(ROWS, { decisionType: 'content-publish-gate', application: 'en-sns-hub', since: '2026-09-26T00:00:00Z' });
  const rep = buildReport(s, { current: T, grid: DEFAULT_GRID });
  assert.equal(rep.requests, 5);
  assert.deepEqual(rep.final_tier, { auto: 1, review: 1, human: 3 }, 'the rules-resolved row e is recorded as tier human in this fixture');
  assert.equal(rep.jev_reached, 4);
  assert.equal(rep.human_rate, 0.6);
  const cur = rep.simulation[0];
  assert.deepEqual([cur.auto, cur.review, cur.human], [1, 2, 1], 'd (0.82) is review by confidence alone — the forced human is not visible in usage');
  const loose = rep.simulation.find((x) => x.thresholds.auto_min === 0.8);
  assert.equal(loose.auto, 2);
  assert.equal(rep.simulation.length, DEFAULT_GRID.length, 'current thresholds are not duplicated in the grid');
  assert.match(formatReport(rep, { decisionType: 'content-publish-gate', application: 'en-sns-hub' }), /\| 0\.85 \| 0\.6 \| 4 \| 1 \| 2 \| 1 \|/);
});

test('labels: agreement, false auto and false escalation for the actual tiers and each simulated threshold', () => {
  const s = selectRows(ROWS, { decisionType: 'content-publish-gate', application: 'en-sns-hub', since: '2026-09-26T00:00:00Z' });
  const labels = parseLabels([
    JSON.stringify({ request_id: 'req_a', label: 'human' }), // 実際は auto → false auto
    JSON.stringify({ decision_id: 'dec_c', label: 'review' }), // 実際は human → false escalation
    JSON.stringify({ request_id: 'req_b', label: 'review' }),
    'not json',
    JSON.stringify({ request_id: 'req_x', label: 'approve' }), // 語彙外は無視
  ].join('\n'));
  assert.equal(labels.size, 3);
  const rep = buildReport(s, { current: T, labels });
  assert.deepEqual(rep.actual_vs_label, { labeled: 3, agreement: 0.333, false_auto: 1, false_escalation: 1 });
  assert.equal(rep.simulation[0].false_auto, 1);
  assert.equal(rep.simulation[0].false_escalation, 1);
});

test('CLI reads a usage file read-only and prints JSON (no network, no writes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edl-recal-'));
  try {
    const p = join(dir, 'usage.jsonl');
    writeFileSync(p, `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'recalibration-report.mjs'), '--decision-type', 'content-publish-gate', '--application', 'en-sns-hub', '--usage', p, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.requests, 6, 'without --since the older row is included (aborted still excluded)');
    assert.deepEqual(out.current_thresholds, T);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
