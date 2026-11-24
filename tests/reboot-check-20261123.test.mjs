import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, parseLaunchctl, targets } from '../scripts/reboot-check.mjs';

const MIN = 60_000;
const now = Date.parse('2026-11-23T10:00:00Z');
const t = (id) => targets('/h').find((x) => x.id === id);

test('parseLaunchctl：1 段目の state だけを読む（中の endpoint の state = active を読まない）', () => {
  const text = 'gui/501/com.e-nexus.task-hub = {\n\tactive count = 0\n\tstate = not running\n\truns = 12\n\tlast exit code = 0\n\tendpoints = {\n\t\t"x" = {\n\t\t\tstate = active\n\t\t}\n\t}\n}';
  assert.deepEqual(parseLaunchctl(text), { loaded: true, state: 'not running', runs: 12, last_exit: '0' });
  assert.deepEqual(parseLaunchctl(''), { loaded: false });
});

test('judge：登録が無いのは problem・起動の直後で記録がまだ無いのは waiting・時間が経っても無ければ problem', () => {
  assert.equal(judge(t('task_hub'), { launchd: { loaded: false }, recordMtime: null, now, bootAt: now - MIN }).verdict, 'problem');
  assert.equal(judge(t('task_hub'), { launchd: { loaded: true, last_exit: '0' }, recordMtime: null, now, bootAt: now - 3 * MIN }).verdict, 'waiting');
  assert.equal(judge(t('task_hub'), { launchd: { loaded: true, last_exit: '0' }, recordMtime: null, now, bootAt: now - 60 * MIN }).reason, 'no_record');
});

test('judge：記録が新しければ ok・古ければ stale・起動の前の記録のままなら not_run_since_boot', () => {
  const loaded = { loaded: true, last_exit: '0' };
  assert.equal(judge(t('task_hub'), { launchd: loaded, recordMtime: now - 2 * MIN, now, bootAt: now - 600 * MIN }).verdict, 'ok');
  assert.equal(judge(t('task_hub'), { launchd: loaded, recordMtime: now - 30 * MIN, now, bootAt: now - 600 * MIN }).reason, 'stale 30m');
  // 起動から 10 分・記録は起動の 1 分前（新しさの範囲の中でも、起動の後に 1 回も動いていない）→ 次の回を待つ
  assert.deepEqual(judge(t('host_health'), { launchd: loaded, recordMtime: now - 11 * MIN, now, bootAt: now - 10 * MIN }), { id: 'host_health', verdict: 'waiting', reason: 'not_run_since_boot' });
  // 起動から 60 分・まだ起動の前の記録のまま → problem
  assert.equal(judge(t('host_health'), { launchd: loaded, recordMtime: now - 61 * MIN, now, bootAt: now - 60 * MIN }).verdict, 'problem');
});

test('judge：常駐（Hermes）は running でなければ problem（起動から 5 分の間は waiting）・最後の終了コードが 0 でない回は problem', () => {
  assert.equal(judge(t('hermes'), { launchd: { loaded: true, state: 'running' }, now, bootAt: now - 600 * MIN }).verdict, 'ok');
  assert.equal(judge(t('hermes'), { launchd: { loaded: true, state: 'not running' }, now, bootAt: now - 2 * MIN }).verdict, 'waiting');
  assert.equal(judge(t('hermes'), { launchd: { loaded: true, state: 'not running' }, now, bootAt: now - 60 * MIN }).verdict, 'problem');
  assert.equal(judge(t('task_hub'), { launchd: { loaded: true, last_exit: '78: EX_CONFIG' }, recordMtime: now - MIN, now, bootAt: now - 600 * MIN }).verdict, 'problem');
  assert.equal(judge(t('task_hub'), { launchd: { loaded: true, last_exit: '(never exited)' }, recordMtime: now - MIN, now, bootAt: now - 600 * MIN }).verdict, 'ok');
});
