/**
 * 業務の home の置き場所（2026-11-18 夜・work_home_has_cron・work_home_has_plugins の根本）。
 *
 * 前の置き場所 ~/.hermes/profiles/work は、常駐の gateway（root の multiplexer・sandbox の外）が serve する場所だった：
 * profiles/ の下の「印」（config.yaml・.env・SOUL.md・profile.yaml・auth.json・state.db）の在る dir を 30 秒ごとに serve し直し
 * （v0.22.4 gateway/run_profile_reconcile.py）、cron の時計は serve する全部の profile の store を回し hook の登録もし直す（cron/AGENTS.md）。
 * dcada82 が置いた SOUL.md が印になり、常駐が cron・plugins を書き足して、確かめが止まった（確かめ自身が作った物が次の拒否の元）。
 * 新しい置き場所 ~/.hermes/e-nexus-work は profiles/ の外＝serve されない。root の下なので依存は root の物を使う（download しない）。
 *
 * 二つに分ける：
 *   本物の Hermes の code：v0.22.4（4d04303）の hermes_constants.py そのもの（git の blob の sha で固定）を本番と同じ Python で動かす。
 *     HERMES_SRC＝その file の在る dir を渡した時だけ動く（repo には Hermes の code を入れない）。無ければ skip。
 *   模擬：業務の home の名前の決まり（sandboxArgs）。
 * Hermes の本体（依存・起動・401）はここでは動かさない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEGACY_WORK_HOME_REL, productionParams, WORK_HOME_NAME, WORK_SOUL_MD } from '../scripts/lib/hermes-sandbox.mjs';

const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p)) ?? null;
/** v0.22.4（4d04303818b61bf3aa09278af48356315515965b）の hermes_constants.py の git の blob の sha */
const CONSTANTS_BLOB = 'f9897c96cc49c6e8b19f1a501715e064c99d182d';
const SRC = process.env.HERMES_SRC ? path.join(process.env.HERMES_SRC, 'hermes_constants.py') : null;
const blobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const realCode = SRC && existsSync(SRC) && blobSha(readFileSync(SRC)) === CONSTANTS_BLOB;

/** 本物の hermes_constants を path から読み、その関数で判定する。served は profiles._iter_named_profile_dirs と同じ条件
 *  （entry.is_dir() and name != "default" and PROFILE_ID_RE.match(name) and named_profile_has_identity(entry)）を本物の関数で組む */
const JUDGE_PY = String.raw`import importlib.util, json, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('hermes_constants', sys.argv[1])
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)
home = Path(os.environ['HERMES_HOME'])
root = hc.get_default_hermes_root()
profiles = root / 'profiles'
served = sorted(e.name for e in (profiles.iterdir() if profiles.is_dir() else [])
                if e.is_dir() and e.name != 'default' and hc.PROFILE_ID_RE.match(e.name) and hc.named_profile_has_identity(e))
print(json.dumps({'root': str(root), 'named': str(hc.named_profile_home(home)) if hc.named_profile_home(home) else None,
                  'name': hc.profile_name_for_home(home), 'identity': hc.named_profile_has_identity(home), 'served': served,
                  'markers': list(hc._PROFILE_IDENTITY_MARKERS)}))
`;

function judge(H, W) {
  const r = spawnSync('/usr/sbin/taskpolicy', ['-b', '/usr/bin/perl', '-e', 'alarm 20; exec @ARGV', PYTHON, '-I', '-B', '-c', JUDGE_PY, SRC],
    { encoding: 'utf8', timeout: 25_000, env: { PATH: '/usr/bin:/bin', HOME: H, HERMES_HOME: W } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('本物の Hermes の code（v0.22.4 の hermes_constants）：前の home（profiles/work）は SOUL.md を置いた時から常駐が serve する profile。新しい home（e-nexus-work）は serve されず、root は ~/.hermes のまま', { skip: !realCode || !PYTHON ? 'HERMES_SRC に 4d04303 の hermes_constants.py が無い' : false }, () => {
  const R = realpathSync(mkdtempSync(path.join(tmpdir(), 'hermes-layout-')));
  try {
    const H = path.join(R, 'hermes');
    const root = path.join(H, '.hermes');
    const legacy = path.join(root, LEGACY_WORK_HOME_REL);
    const work = path.join(root, WORK_HOME_NAME);
    for (const d of ['cron', 'hooks', 'memories', 'skills', 'cwd']) { mkdirSync(path.join(legacy, d), { recursive: true }); mkdirSync(path.join(work, d), { recursive: true }); }
    mkdirSync(path.join(root, 'profiles/other'), { recursive: true });
    writeFileSync(path.join(root, 'profiles/other/config.yaml'), '{}');

    // 11-13〜dcada82 の前：中のフォルダだけ＝印が無い＝serve されない
    let j = judge(H, legacy);
    assert.deepEqual(j.markers, ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db']);
    assert.equal(j.root, root);
    assert.equal(j.name, 'work');
    assert.equal(j.identity, false);
    assert.deepEqual(j.served, ['other']);
    // dcada82 の後：SOUL.md（と Hermes の state.db）が印になり、常駐の multiplexer の serve の一覧に入る
    writeFileSync(path.join(legacy, 'SOUL.md'), `${WORK_SOUL_MD}\n`);
    j = judge(H, legacy);
    assert.equal(j.identity, true);
    assert.equal(j.named, legacy);
    assert.deepEqual(j.served, ['other', 'work'], '前の home は常駐が serve する（cron の時計・hook の登録・plugin）');

    // 新しい home：同じ物（SOUL.md・state.db）が在っても profile ではない・serve の一覧に出ない・root は ~/.hermes（依存を共有）
    writeFileSync(path.join(work, 'SOUL.md'), `${WORK_SOUL_MD}\n`);
    writeFileSync(path.join(work, 'state.db'), '');
    j = judge(H, work);
    assert.equal(j.root, root, 'root は ~/.hermes＝installs・tools を共有（download しない）');
    assert.equal(j.named, null);
    assert.equal(j.name, null);
    assert.ok(!j.served.includes(WORK_HOME_NAME));
  } finally { rmSync(R, { recursive: true, force: true }); }
});

test('模擬：本番の業務の home は root の直下の e-nexus-work（profiles/ の外）', () => {
  const p = productionParams({ request: '/Users/Shared/w/inbox/t.json', brief: '/Users/Shared/w/b.json', result: '/Users/Shared/w/outbox/t.json', usage: '/Users/hermes/work/u.json' });
  assert.equal(p.WORK_HOME, '/Users/hermes/.hermes/e-nexus-work');
  assert.ok(!p.WORK_HOME.includes('/profiles/'));
  assert.equal(LEGACY_WORK_HOME_REL, 'profiles/work');
});
