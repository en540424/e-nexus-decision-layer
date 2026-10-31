/**
 * Hermes の導入一式の生成（2026-10-22・MA-24）。生成するだけ・Claude Code の資格情報を流用させない・版を固定・Secret を書かない・
 * system の daemon に全体の上限（NumberOfProcesses 等）を置かない・Trading Lab の領域を引数に取らない。何も実行しない（Windows でも通る）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBundle, validateArgs, parseArgs, VAULT_EXCLUDES, DISABLED_TOOLSETS, DEFAULT_MODEL, VAULT_DENY_PATTERNS, FORBIDDEN_NAMES } from '../scripts/hermes-service.mjs';

const COMMIT = '4d04303818b61bf3aa09278af48356315515965b';
const SHA = '20f44240ebada354a468104a6a6724d037afcb8883d4d09ddeb4815622c52d8b';
const ARGV = ['--user', 'hermes', '--operator', 'opuser', '--vault-src', '/Users/opuser/Obsidian/EN-Knowledge-Vault', '--include-file', '/Users/opuser/e-nexus-runtime/hermes-includes.txt', '--exclude-file', '/Users/opuser/e-nexus-runtime/hermes-excludes.txt', '--commit', COMMIT, '--installer-sha256', SHA, '--out-dir', '/Users/opuser/e-nexus-runtime/hermes-bundle-test-not-created'];
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
  assert.match(bad('includeFile', undefined), /--include-file must be an absolute path/, '許可リストは必須（既定で写さない）');
  assert.match(bad('includeFile', '/Users/opuser/my list.txt'), /--include-file must be an absolute path without spaces/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown argument/);
});

test('生成物：9 ファイル・差し込み漏れなし・Secret らしい値なし', () => {
  const files = bundle();
  assert.deepEqual(Object.keys(files).sort(), ['README.txt', 'acceptance.sh', 'com.e-nexus.hermes.plist', 'install-as-hermes.sh', 'managed-config.yaml', 'provision.sh', 'run.sh', 'vault-copy.sh', 'vault-deny-patterns.txt']);
  for (const [name, body] of Object.entries(files)) {
    assert.ok(!body.includes('@@'), `${name}: 差し込み漏れ`);
    assert.ok(!/\\\$\{/.test(body), `${name}: \\\${ が残っている`);
    assert.ok(!/sk-ant-[A-Za-z0-9]{8}|ANTHROPIC_API_KEY=[A-Za-z0-9]/.test(body), `${name}: 鍵の値を書かない（検査の正規表現と README の … は値ではない）`);
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

test('Vault の写し：既定で渡さない（許可リスト必須・残りは全部除く）・中身と名前の検査に通ったものだけ公開・既定は表示だけ', () => {
  const v = bundle()['vault-copy.sh'];
  for (const x of ['.git/', '07_Vault-Keys/', '.env', '.env.*']) assert.ok(VAULT_EXCLUDES.includes(x) && v.includes(`--exclude='${x}'`), x);
  // 順番：必ず除くもの → Human の除外 → 許可リスト → 残り全部を除く（rsync は最初に合った規則を使う）
  assert.match(v, /--exclude='\.obsidian\/' --exclude-from=\/Users\/opuser\/e-nexus-runtime\/hermes-excludes\.txt --include-from=\/Users\/opuser\/e-nexus-runtime\/hermes-includes\.txt --exclude='\*' /);
  assert.match(v, /hermes-includes\.txt が空/);
  assert.match(v, /^DENY="\$HERE\/vault-deny-patterns\.txt"$/m);
  assert.match(v, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin; export PATH$/m, 'Homebrew の GNU sed・find を拾わない');
  assert.match(v, /CR（Windows の改行）/);
  assert.match(v, /rsync の規則（! \+ - \. : 等）/, '! で必ず除くものを外せる（openrsync の --include-from は規則を読む）');
  assert.match(v, /stat -f '%Su %Sg %Lp' \/Users\/Shared\/e-nexus-hermes\)" = "opuser e-nexus-hermes-read 750"/);
  assert.ok(!/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(Object.values(bundle()).filter((x) => x.startsWith('#!')).join('\n')), '$var の直後に全角文字を置かない（shell が変数名の一部として読み、set -u で止まる）');
  assert.match(v, /if \[ "\$APPLY" -eq 0 \]; then\n.*--dry-run[^\n]*\n[^\n]*\n {2}exit 0/);
  assert.match(v, /^STAGE="\$WORK\/v"$\n[^]*chmod 700 "\$WORK"$/m);
  assert.match(v, /^\[ ! -d \/Users\/Shared\/e-nexus-hermes\/vault \] \|\| chmod 700 \/Users\/Shared\/e-nexus-hermes\/vault$/m, '失敗したら前回の写しも読めない');
  for (const n of FORBIDDEN_NAMES) assert.ok(v.includes(`-iname '${n}'`), n);
  assert.match(v, /-prune -exec rm -rf \{\} \+/);
  assert.match(v, /! -type f ! -type d -exec rm -f/, 'symlink・FIFO・socket を消す');
  assert.match(v, /-type f ! -name '\*\.md' ! -name '\*\.txt' -exec rm -f/);
  assert.match(v, /perl -0777 -ne 'print "\$ARGV\\n" if \/\\x00\/'/, 'UTF-16 等の検査できないファイルを落とす');
  assert.match(v, /grep -rlai -E -f "\$WORK\/deny"/);
  assert.match(v, /find "\$STAGE" -mindepth 1 \| sed [^\n]* \| LC_ALL=C grep -ai -E -f "\$WORK\/deny"/, '名前も検査する');
  assert.match(v, /-type d -empty -delete/);
  assert.match(v, /\[ "\$rc" -le 1 \] \|\| fail "中身の検査が失敗/, 'grep の失敗（exit 2）で公開しない');
  assert.match(v, /\[ "\$rc" -eq 1 \] \|\| fail "中身の検査にあたるファイルが落としきれていない/);
  const pub = v.indexOf('"$STAGE/" /Users/Shared/e-nexus-hermes/vault/');
  for (const k of ['落としきれていない', '必ず除くものが残っている', 'chmod 640 {} +']) assert.ok(v.indexOf(k) > 0 && v.indexOf(k) < pub, `${k} は公開より前`);
  assert.equal(bundle()['vault-deny-patterns.txt'], `${VAULT_DENY_PATTERNS.join('\n')}\n`);
  for (const re of VAULT_DENY_PATTERNS) assert.doesNotThrow(() => new RegExp(re.replace('[[:space:]]', '\\s')), re);
  assert.ok(!/\/Parallels|AI-Trading-Lab|trading-lab\/|mac-mini-migration-kit|prlctl/i.test(Object.values(bundle()).join('\n')), 'Trading Lab の領域・Parallels の操作を参照しない');
});

test('モデルと費用：軽いモデルを Anthropic 直結で固定・fallback なし・token を使う補助処理を止める', () => {
  const m = bundle()['managed-config.yaml'];
  assert.equal(DEFAULT_MODEL, 'claude-haiku-5-5');
  assert.match(m, /^model:\n {2}provider: anthropic\n {2}default: claude-haiku-5-5\n {2}base_url: https:\/\/api\.anthropic\.com$/m, '初期の config.yaml の OpenRouter の base_url に鍵を送らない');
  assert.match(m, /^fallback_providers: \[\]$/m);
  assert.match(m, /^auxiliary:\n {2}background_review:\n {4}enabled: false\n {2}title_generation:\n {4}enabled: false$/m);
  assert.match(m, /^ {2}redact_secrets: true$/m);
  assert.ok(!/\t/.test(m), 'YAML に tab を入れない（読めないと managed scope は黙って無視される）');
  const r = bundle()['README.txt'];
  assert.match(r, /402（billing_error）/);
  assert.match(r, /auto-reload は Off のまま/);
});

test('検収：確かめられない時は PASS にしない・managed scope を YAML と Hermes の表示で確かめる・.env は名前と権限だけ', () => {
  const acc = bundle()['acceptance.sh'];
  assert.match(acc, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin; export PATH$/m);
  assert.match(acc, /\/usr\/bin\/ruby -ryaml -e 'c = YAML\.safe_load/);
  assert.match(acc, /= "false anthropic claude-haiku-5-5 https:\/\/api\.anthropic\.com \[\]" \] && ok/);
  assert.match(acc, /sudo -u hermes -i hermes config 2>&1\) \|\| true/);
  assert.match(acc, /grep -q '\/etc\/hermes' && echo "\$cfg" \| grep -qE 'adopt_external_logins\[\^a-z\]\{0,8\}false'/, '名前だけでなく false まで見る');
  assert.match(acc, /stat -f '%Su %Lp' "\$E"\)" = "hermes 600"/);
  assert.match(acc, /sed -n 's\/\^\\\(export \\\)\\\{0,1\\\}\\\(\[A-Z\]\[A-Z0-9_\]\\\{0,63\\\}\\\)=/, '名前の形を狭くし、値の一部を名前として拾わない');
  assert.match(acc, /grep -vx ANTHROPIC_API_KEY/);
  assert.ok(!/cat "\$E"|echo "\$cfg"\s*$/m.test(acc), '.env と hermes config の出力をそのまま出さない');
  assert.match(acc, /sudo -u opuser test -r "\$E" && ng/);
  // 再検査は grep の終了コードで判断（パターンが無い・読めない＝exit 2 を PASS にしない）
  assert.match(acc, /rc=0; LC_ALL=C grep -rqai -E -f "\$D" \/Users\/Shared\/e-nexus-hermes\/vault \|\| rc=\$\?\n {2}\[ "\$rc" -eq 1 \] && ok/);
  assert.match(acc, /else ng "3 検査のパターン/);
  assert.match(acc, /grep -rlqa 'sk-ant-\[A-Za-z0-9_-\]\\\{20\\\}' \$L 2>\/dev\/null \|\| rc=\$\?\n {2}\[ "\$rc" -eq 1 \] && ok/);
  assert.match(acc, /\/Users\/opuser\/Obsidian\/EN-Knowledge-Vault \/Users\/opuser\/e-nexus-runtime\/hermes-includes\.txt/, '実際の --vault-src と許可リストを読めないこと');
});

test('vault-copy.sh を小さな検体で実行：許可リストの外・.md 以外・symlink・NUL・名前と中身の検査・規則行・CR（macOS）', { skip: process.platform !== 'darwin' }, () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'edl-hermes-')));
  try {
    const src = path.join(tmp, 'src');
    const w = (rel, body) => { mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); writeFileSync(path.join(src, rel), body); };
    w('AI/ok.md', '# 設計\nふつうの文書\n');
    w('AI/sub/ok2.txt', 'plain\n');
    w('AI/pay.md', '給与の表\n');
    w('AI/ip.md', 'host 192.0.2.10 here\n');
    w('AI/mail.md', 'contact someone@example.com\n');
    w('AI/upper.md', 'PASSWORD = x\n');
    w('AI/顧客情報_A.md', '中身はふつう\n');
    w('AI/取引先/only.md', '中身はふつう\n');
    w('AI/utf16.txt', Buffer.from('﻿hello', 'utf16le'));
    w('AI/script.mjs', 'export {}\n');
    w('AI/drop/x.md', 'Human が除く\n');
    w('AI/.env', 'X=1\n');
    w('AI/.ENV.md', 'X=1\n');
    w('AI/07_vault-keys/k.md', 'ふつう\n');
    w('Other/secret.md', '許可リストの外\n');
    w('top.md', '許可リストの外\n');
    symlinkSync('/etc/hosts', path.join(src, 'AI', 'link.md'));
    const inc = path.join(tmp, 'inc.txt');
    writeFileSync(inc, '# 許可リスト\n/AI/***\n');
    writeFileSync(path.join(tmp, 'exc.txt'), '/AI/drop/\n');
    const share = path.join(tmp, 'share');
    mkdirSync(share, { mode: 0o750 });
    spawnSync('/usr/bin/chgrp', ['staff', share], { timeout: 10_000 });
    const operator = os.userInfo().username;
    const files = buildBundle(parseArgs(['--user', 'hermes-none', '--operator', operator, '--vault-src', src, '--include-file', inc, '--exclude-file', path.join(tmp, 'exc.txt'), '--commit', COMMIT, '--installer-sha256', SHA, '--out-dir', path.join(tmp, 'out'), '--share', share]));
    const out = path.join(tmp, 'out');
    mkdirSync(out);
    writeFileSync(path.join(out, 'vault-copy.sh'), files['vault-copy.sh'].replaceAll('e-nexus-hermes-read', 'staff'));
    writeFileSync(path.join(out, 'vault-deny-patterns.txt'), files['vault-deny-patterns.txt']);
    const run = (...args) => spawnSync('/usr/sbin/taskpolicy', ['-b', '/bin/sh', path.join(out, 'vault-copy.sh'), ...args], { encoding: 'utf8', timeout: 30_000 });
    const stat = (p) => (spawnSync('/usr/bin/stat', ['-f', '%Lp', p], { encoding: 'utf8', timeout: 10_000 }).stdout || '').trim();
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!existsSync(path.join(share, 'vault')), '既定は表示だけ');
    const r = run('--apply');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const vault = path.join(share, 'vault');
    const list = spawnSync('/usr/bin/find', [vault, '-mindepth', '1'], { encoding: 'utf8', timeout: 10_000 }).stdout.split('\n').filter(Boolean).map((p) => path.relative(vault, p)).sort();
    assert.deepEqual(list, ['AI', 'AI/ok.md', 'AI/sub', 'AI/sub/ok2.txt'], '取引先/ のように中身を全部落としたフォルダの名前も残さない');
    const report = readFileSync(path.join(share, '.filtered.txt'), 'utf8').split('\n').filter(Boolean).sort();
    assert.deepEqual(report, ['AI/ip.md', 'AI/mail.md', 'AI/pay.md', 'AI/upper.md', 'AI/utf16.txt', 'AI/取引先', 'AI/取引先/only.md', 'AI/顧客情報_A.md']);
    assert.equal(stat(path.join(share, '.stage')), '700', 'rsync -a が置き場の root を元の 755 に変えない');
    assert.equal(stat(path.join(share, '.filtered.txt')), '600');
    assert.equal(stat(vault), '750');
    assert.equal(stat(path.join(vault, 'AI', 'ok.md')), '640');
    // 2 回目：消えたファイルは写しからも消える
    rmSync(path.join(src, 'AI', 'sub'), { recursive: true });
    assert.equal(run('--apply').status, 0);
    assert.ok(!existsSync(path.join(vault, 'AI', 'sub')));
    // 拒否：rsync の規則行（! で必ず除くものを外せる）・CR・空の許可リスト。前回の写しは公開のまま（何もしていない）
    for (const [body, re] of [['!\n/AI/***\n', /rsync の規則/], ['/AI/***\r\n', /CR/], ['# まだ決めていない\n', /が空/]]) {
      writeFileSync(inc, body);
      const bad = run('--apply');
      assert.equal(bad.status, 2, body);
      assert.match(bad.stderr, re);
    }
    // 検査が失敗したら（パターンが壊れている＝grep exit 2）公開せず、前回の写しも 700 で閉じる
    writeFileSync(inc, '/AI/***\n');
    writeFileSync(path.join(out, 'vault-deny-patterns.txt'), '(\n');
    const broken = run('--apply');
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stderr, /検査が失敗/);
    assert.equal(stat(vault), '700');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
