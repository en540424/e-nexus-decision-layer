/**
 * Hermes の導入一式の生成（2026-10-22・MA-24）。生成するだけ・Claude Code の資格情報を流用させない・版を固定・Secret を書かない・
 * system の daemon に全体の上限（NumberOfProcesses 等）を置かない・Trading Lab の領域を引数に取らない。何も実行しない（Windows でも通る）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, validateArgs, parseArgs, VAULT_EXCLUDES, DISABLED_TOOLSETS } from '../scripts/hermes-service.mjs';

const COMMIT = '4d04303818b61bf3aa09278af48356315515965b';
const SHA = '20f44240ebada354a468104a6a6724d037afcb8883d4d09ddeb4815622c52d8b';
const ARGV = ['--user', 'hermes', '--operator', 'opuser', '--vault-src', '/Users/opuser/Obsidian/EN-Knowledge-Vault', '--exclude-file', '/Users/opuser/e-nexus-runtime/hermes-excludes.txt', '--commit', COMMIT, '--installer-sha256', SHA, '--out-dir', '/Users/opuser/e-nexus-runtime/hermes-bundle-test-not-created'];
const bundle = () => buildBundle(parseArgs(ARGV), { now: () => new Date('2026-10-22T05:00:00Z') });

test('引数：正しい組は通る・同じ user・管理系の名前・版の未固定・Trading Lab の領域・空白入りのパスを拒否', () => {
  assert.deepEqual(validateArgs(parseArgs(ARGV)), []);
  const bad = (k, v) => validateArgs({ ...parseArgs(ARGV), [k]: v }).join('\n');
  assert.match(bad('user', 'opuser'), /differ from --operator/);
  assert.match(bad('user', 'root'), /new dedicated user/);
  assert.match(bad('commit', 'main'), /40-hex/);
  assert.match(bad('installerSha256', 'abc'), /64 hex/);
  assert.match(bad('vaultSrc', '/Users/opuser/Parallels/x'), /Trading Lab/);
  assert.match(bad('share', '/Users/opuser/hermes-share'), /outside the operator home/);
  assert.match(bad('share', '/Users/Shared/my share'), /without spaces/);
  assert.match(bad('rssMaxMib', '99999'), /512-8192/);
  // install -d は既存のフォルダの権限も変える：共有フォルダそのもの・浅いパス・.. を拒否
  assert.match(bad('share', '/Users/Shared'), /dedicated new folder/);
  assert.match(bad('share', '/etc'), /dedicated new folder/);
  assert.match(bad('share', '/Users/Shared/../../etc/x'), /dedicated new folder/);
  assert.match(bad('vaultSrc', '/Users/opuser/../x/Vault'), /must not contain \.\./);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown argument/);
});

test('生成物：8 ファイル・差し込み漏れなし・Secret らしい値なし', () => {
  const files = bundle();
  assert.deepEqual(Object.keys(files).sort(), ['README.txt', 'acceptance.sh', 'com.e-nexus.hermes.plist', 'install-as-hermes.sh', 'managed-config.yaml', 'provision.sh', 'run.sh', 'vault-copy.sh']);
  for (const [name, body] of Object.entries(files)) {
    assert.ok(!body.includes('@@'), `${name}: 差し込み漏れ`);
    assert.ok(!/\\\$\{/.test(body), `${name}: \\\${ が残っている`);
    assert.ok(!/sk-ant-|ANTHROPIC_API_KEY=[A-Za-z0-9]/.test(body), `${name}: 鍵の値を書かない（README の … は置き場の説明）`);
  }
  assert.match(files['install-as-hermes.sh'], new RegExp(`\\[ "\\$got" = ${SHA} \\]`));
});

test('認証：Claude Code の資格情報を流用させない（managed scope で false・別 user・検収で確かめる）', () => {
  const f = bundle();
  assert.match(f['managed-config.yaml'], /^auth:\n {2}adopt_external_logins: false$/m);
  assert.match(f['managed-config.yaml'], /^ {2}mode: manual$/m);
  assert.match(f['managed-config.yaml'], /^ {2}check: false$/m);
  for (const t of DISABLED_TOOLSETS) assert.ok(f['managed-config.yaml'].includes(t));
  assert.ok(DISABLED_TOOLSETS.includes('terminal'), 'terminal は書き込み制限が効かないので最初は止める');
  assert.match(f['acceptance.sh'], /\.claude\/\.credentials\.json/);
  assert.match(f['acceptance.sh'], /\/Users\/opuser\/\.claude /);
  assert.match(f['provision.sh'], /--lock-operator-home/);
  assert.match(f['provision.sh'], /sysadminctl -addUser hermes .*-password - interactive/);
  assert.ok(!/-admin\b/.test(f['provision.sh'].replace(/checkmember -m hermes admin/g, '')), '管理者にしない');
});

test('導入：公式 installer を commit で固定し sha256 を確かめ、browser・computer-use を入れない', () => {
  const s = bundle()['install-as-hermes.sh'];
  assert.match(s, new RegExp(`raw\\.githubusercontent\\.com/NousResearch/hermes-agent/${COMMIT}/scripts/install\\.sh`));
  assert.match(s, new RegExp(`--commit ${COMMIT} --non-interactive --skip-browser --skip-computer-use`));
  assert.match(s, /taskpolicy -b/);
  assert.ok(!/hermes-agent\.nousresearch\.com\/install\.sh/.test(s), '版の固定されていない hosted の one-liner を使わない');
});

test('常駐：LaunchDaemon は UserName・Background・異常終了の時だけ再起動・全体の上限を置かない', () => {
  const p = bundle()['com.e-nexus.hermes.plist'];
  assert.match(p, /<key>UserName<\/key><string>hermes<\/string>/);
  assert.match(p, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(p, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(p, /<key>HOME<\/key><string>\/Users\/hermes<\/string>/);
  assert.ok(!/NumberOfProcesses|NumberOfFiles|SoftResourceLimits|HardResourceLimits/.test(p), 'system の daemon だとシステム全体の sysctl が変わる');
  const r = bundle()['run.sh'];
  assert.match(r, /ulimit -n 4096/);
  assert.match(r, /hermes gateway run --external-supervisor/);
  assert.match(r, /-gt 3072 \]/);
  assert.match(r, /STOP present: not starting"; exit 0/);
  assert.match(r, /\[ "\$up" -lt 600 \]/, '起動直後は VM の復旧を優先して待つ');
});

test('Vault の写し：.git・Secret・agent の設定を除き、追加の除外ファイルが無ければ動かない・既定は表示だけ', () => {
  const v = bundle()['vault-copy.sh'];
  for (const x of ['.git/', '07_Vault-Keys/', '.env', '.env.*']) assert.ok(VAULT_EXCLUDES.includes(x) && v.includes(`--exclude='${x}'`), x);
  assert.match(v, /--exclude-from=\/Users\/opuser\/e-nexus-runtime\/hermes-excludes\.txt/);
  assert.match(v, /DRY=--dry-run; \[ "\$APPLY" -eq 1 \] && DRY=''/);
  assert.match(v, /chmod 640/);
  assert.ok(!/\/Parallels|AI-Trading-Lab|trading-lab\/|mac-mini-migration-kit|prlctl/i.test(Object.values(bundle()).join('\n')), 'Trading Lab の領域・Parallels の操作を参照しない');
});

test('provision：写しの置き場が既にあれば作らない／検収：別 user の gateway を FAIL に数える（pipe の subshell で数えを失わない）', () => {
  const f = bundle();
  assert.match(f['provision.sh'], /\[ -e \/Users\/Shared\/e-nexus-hermes \] && \{ echo .*already exists/);
  assert.ok(f['provision.sh'].indexOf('already exists（install -d') < f['provision.sh'].indexOf('run install -d -o opuser'), '確認が作成より前');
  const acc = f['acceptance.sh'];
  assert.match(acc, /for p in \$\(pgrep -f 'hermes gateway'\); do .* \|\| ng "9 /);
  assert.ok(!/pgrep -f 'hermes gateway' \| while/.test(acc));
  assert.ok(!/\\s/.test(acc), 'BSD sed・grep の \\s は使わない');
  assert.match(f['run.sh'], /sleep 30 & wait \$!/);
});
