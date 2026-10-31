#!/usr/bin/env node
/**
 * Hermes Agent を Mac mini の専用ユーザーで動かすための一式を生成する（2026-10-22・Vault MA-24・MA-22 S1／S2／S5）。
 * **生成するだけで、ユーザー作成・インストール・登録・起動はしない（sudo・Secret・常駐は Human）**。
 *
 *   node scripts/hermes-service.mjs --user <Hermes 専用ユーザー> --operator <いまの管理ユーザー> --vault-src <Vault の read-only clone の絶対パス>
 *        --include-file <Vault の写しに入れるパターン（許可リスト）の絶対パス> --exclude-file <許可の中から除くパターンの絶対パス>
 *        --commit <40 桁の commit> --installer-sha256 <その commit の scripts/install.sh の sha256> --out-dir <まだ無いフォルダの絶対パス>
 *        [--share /Users/Shared/e-nexus-hermes] [--rss-max-mib 3072] [--label com.e-nexus.hermes]
 *
 * 出力（--out-dir）：README.txt（順番と担当）・provision.sh（Human・sudo：ユーザー・グループ・写しの置き場・管理者固定の設定・wrapper）・
 *   install-as-hermes.sh（Human が `sudo -u <user> -i` で：版を固定した公式 installer を sha256 を確かめて実行）・vault-copy.sh（operator：
 *   許可リストの範囲だけを写し、中身の検査で引っかかったファイルを落としてから公開する）・vault-deny-patterns.txt（その検査の正規表現）・
 *   managed-config.yaml（/etc/hermes/config.yaml：Hermes の managed scope）・run.sh（wrapper）・<label>.plist（LaunchDaemon・UserName）・
 *   acceptance.sh（Human・sudo：MA-24 §16 の検収＋Mac で足した項目）。
 * Vault の写しは既定で渡さない（2026-10-31）：許可リストに無いものは写らず（新しいフォルダも）、許可の中でも鍵・IP・電話・メール・口座・
 *   給与・顧客・契約の語を含むファイルは写すたびに落とす。確かめていない文書を安全と推定しないため。広げるのは Human。
 * 守ること：Claude Code のサブスク認証を流用させない（別 OS ユーザー＋home 700＋`auth.adopt_external_logins: false`。Hermes の既定は true）。
 *   課金の上限は Anthropic Console の Hermes 専用 workspace の上限で持つ（Hermes 自体に上限の仕組みは無い）。鍵は Hermes ユーザーの
 *   ~/.hermes/.env（600）に Human が入れる＝このファイル群に Secret を書かない。plist に NumberOfProcesses／NumberOfFiles を置かない
 *   （system の daemon だとシステム全体の sysctl を書き換え、同居する VM にも効く）。wrapper の ulimit で process ごとに絞る。
 *   Trading Lab の領域（Parallels・trading-lab・移植キット）は引数に取らない。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRADING_LAB_PATH } from './host-health.mjs';

const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/; // shell・XML にそのまま埋めるので空白と記号を許さない
export const GROUP = 'e-nexus-hermes-read';
export const WRAPPER_DIR = '/Library/Application Support/E-NEXUS/hermes';
/** Vault の写しから必ず除くもの（Vault の Secret 保護 deny・MA-24 §7-2・MA-22 S4 と同じ範囲＋鍵らしいファイル） */
/** 写しの置き場から rsync の規則に頼らず消す名前（大小文字を問わない。find の -iname） */
export const FORBIDDEN_NAMES = Object.freeze(['.git', '07_Vault-Keys', '.env', '.env.*', '.claude', '.agents', '.codex', '.obsidian', '*.pem', '*.p12', '*.key', 'id_rsa*', 'id_ed25519*']);
export const VAULT_EXCLUDES = Object.freeze(['.git/', '07_Vault-Keys/', '.env', '.env.*', '*.pem', '*.p12', '*.key', 'id_rsa*', 'id_ed25519*', '.claude/', '.agents/', '.codex/', '.obsidian/']);
/** 最初は読む・まとめる・知らせるだけ（MA-24 §3）。terminal は書き込み制限が効かない（Hermes 公式 docs） */
export const DISABLED_TOOLSETS = Object.freeze(['terminal', 'code_execution', 'browser', 'computer_use', 'connections', 'cronjob', 'delegation']);
/**
 * 初期のモデル（2026-10-31）。Hermes の仕事は読む・まとめる・知らせる（MA-24 §3）で、MA-24 §22-4 は「既定は軽いもの」。Haiku 5.5 は
 * 入力 0.10／出力 0.50 USD（1M token・100K token まで）で Sonnet 5.5 の 1/20。v0.22.4 は名前で Haiku 5.5 を知っている（thinking の扱い）。
 * 上げる時は Human が /etc/hermes/config.yaml を直す（root 所有なので Hermes 自身は変えられない）。
 */
export const DEFAULT_MODEL = 'claude-haiku-5-5';
/**
 * Vault の写しから中身と名前で落とす正規表現（grep -E -i・1 行 1 つ・# の行は注釈）。強い信号（鍵・token・IP・電話・メール・MAC・口座）と、
 * 給与・顧客・契約・個人情報の語。語は文書の話題でもあたるので多めに落ちる＝既定は安全側。Human が生成物の写しを直して広げる。
 * この repo は公開なので、特定の事業・口座・取引先の名前は書かない（それは Human が生成物の写しに足す）。全角の数字は検出できない。
 */
export const VAULT_DENY_PATTERNS = Object.freeze([
  'sk-ant-[A-Za-z0-9_-]{10}',
  'sk-proj-[A-Za-z0-9_-]{10}',
  'AIza[0-9A-Za-z_-]{35}',
  '[0-9]{8,10}:[A-Za-z0-9_-]{35}',
  '(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20}',
  'github_pat_[A-Za-z0-9_]{20}',
  'AKIA[0-9A-Z]{16}',
  'xox[abpr]-[0-9A-Za-z-]{10}',
  '(sk|rk)_(live|test)_[0-9A-Za-z]{10}',
  'whsec_[0-9A-Za-z]{10}',
  'BEGIN [A-Z ]*PRIVATE KEY',
  'Bearer [A-Za-z0-9._-]{20}',
  '(password|passwd|パスワード)[[:space:]]*[:=：]',
  '(api[_-]?key|secret|token)[[:space:]]*[:=]',
  '(^|[^0-9.])(1[0-9]{2}|2[0-5][0-9]|[1-9][0-9]?)\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}([^0-9.]|$)',
  '0[0-9]{1,4}-[0-9]{1,4}-[0-9]{4}',
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
  '([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}',
  '口座番号|account_id|MT5',
  '給与|賃金|源泉徴収|社会保険|マイナンバー',
  '顧客名|顧客情報|お客様情報|取引先|個人情報',
  '契約書|請求書|見積書|発注書|振込先',
]);

export function validateArgs(a) {
  const errors = [];
  for (const k of ['user', 'operator']) if (!USER_NAME.test(a[k] ?? '')) errors.push(`--${k} must be a local user name`);
  if (a.user && a.user === a.operator) errors.push('--user must differ from --operator（同じ user だと Claude Code の資格情報と home 全体に届く）');
  if (/^(root|admin|daemon|nobody)$/.test(a.user ?? '')) errors.push('--user must be a new dedicated user');
  for (const k of ['vaultSrc', 'includeFile', 'excludeFile', 'outDir', 'share']) {
    const flag = `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (typeof a[k] !== 'string' || !SAFE_PATH.test(a[k])) errors.push(`${flag} must be an absolute path without spaces or shell characters`);
    else if (TRADING_LAB_PATH.test(a[k])) errors.push(`${flag}: Trading Lab の領域は使わない`);
  }
  if (a.share && a.vaultSrc && (a.share.startsWith(`${a.vaultSrc}/`) || a.vaultSrc.startsWith(`${a.share}/`))) errors.push('--share and --vault-src must not contain each other');
  if (a.share && a.operator && a.share.startsWith(`/Users/${a.operator}/`)) errors.push('--share must be outside the operator home（home は 700 にするので Hermes が入れない）');
  // provision の `install -d -m 750` は既にあるフォルダの権限も変える（/Users/Shared を渡すと 1777→750）。専用の新しいフォルダだけにする
  if (typeof a.share === 'string' && (a.share.split('/').includes('..') || a.share.split('/').filter(Boolean).length < 3)) errors.push('--share must be a dedicated new folder at least 3 levels deep (e.g. /Users/Shared/e-nexus-hermes), without ..');
  for (const k of ['vaultSrc', 'includeFile', 'excludeFile', 'outDir']) if (typeof a[k] === 'string' && a[k].split('/').includes('..')) errors.push(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must not contain ..`);
  if (!/^[0-9a-f]{40}$/.test(a.commit ?? '')) errors.push('--commit must be a 40-hex commit（版を固定する。branch・latest は使わない）');
  if (!/^[0-9a-f]{64}$/.test(a.installerSha256 ?? '')) errors.push('--installer-sha256 must be 64 hex');
  if (!/^[a-z0-9.-]{3,64}$/.test(a.label ?? '')) errors.push('--label must be a reverse-DNS name');
  if (!Number.isInteger(Number(a.rssMaxMib)) || Number(a.rssMaxMib) < 512 || Number(a.rssMaxMib) > 8192) errors.push('--rss-max-mib must be 512-8192');
  if (a.outDir && existsSync(a.outDir)) errors.push('--out-dir already exists（生成物は上書きしない）');
  return errors;
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 検査済みの値だけを @@KEY@@ へ差し込む（shell の $ を JS でエスケープしなくて済むように） */
function fill(template, v) {
  return template.replace(/@@([A-Z0-9_]+)@@/g, (_, k) => {
    if (!(k in v)) throw new Error(`template key not provided: ${k}`);
    return String(v[k]);
  }).replaceAll('\\${', '${'); // String.raw の中で JS の差し込みを避けるために書いた \${ を shell の ${ に戻す
}

const PROVISION = String.raw`#!/bin/sh
# Hermes 専用ユーザーの用意（Human が sudo で実行。既定は表示だけ、--apply で実行）。生成：scripts/hermes-service.mjs
#   sudo sh provision.sh [--apply] [--lock-operator-home]
# すること：(1) operator の home を 700 にする（--lock-operator-home の時だけ。700 でなければ (2) 以降を拒否）
#   (2) 標準ユーザー @@USER@@（管理者でない・ログイン画面に出さない・home 700）(3) グループ @@GROUP@@（@@USER@@ と @@OPERATOR@@）
#   (4) Vault の写しの置き場 @@SHARE@@（@@OPERATOR@@ 所有・グループに読み取りだけ）(5) /etc/hermes/config.yaml（root 所有・Hermes の managed scope）
#   (6) wrapper（root 所有）。LaunchDaemon の登録はしない（README の H7）。Secret は扱わない。
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
APPLY=0; LOCK=0
for a in "$@"; do case "$a" in --apply) APPLY=1 ;; --lock-operator-home) LOCK=1 ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
run() { echo "+ $*"; if [ "$APPLY" -eq 1 ]; then "$@"; fi; }
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 2; }
id @@OPERATOR@@ >/dev/null 2>&1 || { echo "operator @@OPERATOR@@ not found" >&2; exit 2; }
if id @@USER@@ >/dev/null 2>&1; then echo "user @@USER@@ already exists（作り直さない）" >&2; exit 2; fi
mode=$(stat -f '%Lp' /Users/@@OPERATOR@@)
if [ "$mode" != 700 ]; then
  if [ "$LOCK" -eq 1 ]; then run chmod 700 /Users/@@OPERATOR@@
  else echo "/Users/@@OPERATOR@@ is mode $mode: 別ユーザーから ~/.claude・runtime repo・Vault clone が読める。--lock-operator-home を付ける（MA-24 §7-1）" >&2; exit 2; fi
fi
run sysadminctl -addUser @@USER@@ -fullName "E-NEXUS Hermes" -shell /bin/zsh -home /Users/@@USER@@ -password - interactive
run dscl . -create /Users/@@USER@@ IsHidden 1
run createhomedir -c -u @@USER@@
run chmod 700 /Users/@@USER@@
run dseditgroup -o create -r "E-NEXUS Hermes Vault readers" @@GROUP@@
run dseditgroup -o edit -a @@USER@@ -t user @@GROUP@@
run dseditgroup -o edit -a @@OPERATOR@@ -t user @@GROUP@@
[ -e @@SHARE@@ ] && { echo "@@SHARE@@ already exists（install -d は既存の権限を変えるので、専用の新しいフォルダだけにする）" >&2; exit 2; }
run install -d -o @@OPERATOR@@ -g @@GROUP@@ -m 750 @@SHARE@@ @@SHARE@@/vault
run install -d -o root -g wheel -m 755 /etc/hermes
run install -o root -g wheel -m 644 "$HERE/managed-config.yaml" /etc/hermes/config.yaml
run install -d -o root -g wheel -m 755 "@@WRAPPER_DIR@@"
run install -o root -g wheel -m 755 "$HERE/run.sh" "@@WRAPPER_DIR@@/run.sh"
run install -o @@USER@@ -g staff -m 700 "$HERE/install-as-hermes.sh" /Users/@@USER@@/install-as-hermes.sh
if [ "$APPLY" -eq 1 ]; then
  if dseditgroup -o checkmember -m @@USER@@ admin >/dev/null 2>&1; then echo "FAIL: @@USER@@ is admin" >&2; exit 1; fi
  for p in /Users/@@OPERATOR@@ /Users/@@OPERATOR@@/.claude /Users/@@OPERATOR@@/e-nexus-runtime; do
    if sudo -u @@USER@@ test -r "$p"; then echo "FAIL: @@USER@@ can read $p" >&2; exit 1; fi
  done
  echo "provision: done（次は README の H2：vault-copy.sh）"
else
  echo "（表示だけ。実行は --apply）"
fi
`;

const INSTALL_AS_HERMES = String.raw`#!/bin/sh
# Hermes の導入（Human が sudo -u @@USER@@ -i sh <このファイル> で実行。@@USER@@ の home の中だけに入る）。生成：scripts/hermes-service.mjs
# 公式 installer を commit @@COMMIT@@ の版で取り、sha256 を確かめてから、版を固定・対話なし・browser と computer-use なしで実行する。
# installer は uv・Python・Node.js・ripgrep・FFmpeg を ~/.hermes へ入れ、~/.zshrc・~/.zprofile に PATH を足す（Hermes 公式 docs）。
set -eu
[ "$(id -un)" = @@USER@@ ] || { echo "run as @@USER@@（sudo -u @@USER@@ -i）" >&2; exit 2; }
[ "$HOME" = /Users/@@USER@@ ] || { echo "HOME must be /Users/@@USER@@（sudo -i で入る）" >&2; exit 2; }
T=$(mktemp -d "$HOME/.edl-install.XXXXXX")
curl -fsSL --proto '=https' -o "$T/install.sh" "https://raw.githubusercontent.com/NousResearch/hermes-agent/@@COMMIT@@/scripts/install.sh"
got=$(shasum -a 256 "$T/install.sh" | awk '{print $1}')
[ "$got" = @@INSTALLER_SHA256@@ ] || { echo "install.sh sha256 mismatch: $got" >&2; exit 1; }
/usr/sbin/taskpolicy -b /bin/bash "$T/install.sh" --commit @@COMMIT@@ --non-interactive --skip-browser --skip-computer-use
rm -rf "$T"
mkdir -p -m 700 "$HOME/work" "$HOME/.hermes-edl"
echo "installed. 次：README の H4（鍵の発行と ~/.hermes/.env・chmod 600。値を画面・ログに出さない）→ H5 の検収"
`;

const VAULT_COPY = String.raw`#!/bin/sh
# Vault の写し（operator @@OPERATOR@@ が実行。sudo なし）。生成：scripts/hermes-service.mjs
#   sh vault-copy.sh [--apply]
# @@VAULT_SRC@@ → @@SHARE@@/vault。順番：(1) 必ず除くもの（.git・Secret・agent の設定）(2) @@EXCLUDE_FILE@@
# (3) @@INCLUDE_FILE@@ に書いたものだけ入れ、ほかは全部除く（新しいフォルダも既定で写らない）(4) 必ず除くものを rsync の規則に頼らず
# もう一度消し、.md・.txt 以外・symlink・特殊ファイル・NUL を含むファイル（UTF-16 等＝検査できない）を落とす (5) 中身と名前（ファイル・
# フォルダ）を vault-deny-patterns.txt で検査し（大小文字を問わない）、あたったものを落とす (6) 検査に通ったものだけを vault へ出す。
# 写しはグループ @@GROUP@@ に読み取りだけ（dir 750・file 640）。Hermes は書けない・消せない。Vault 本体には何もしない。
# 途中の置き場 @@SHARE@@/.stage（700。rsync は写し先の root の権限を元に合わせるので、その下の v へ写す）と落としたものの一覧
# @@SHARE@@/.filtered.txt（600）は @@OPERATOR@@ だけが読める。--apply の間は前回の vault も 700 にし、最後まで通った時だけ 750 に戻る
# （途中で失敗すると Hermes は前回の写しも読めない＝閉じる側に倒す）。
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
APPLY=0; [ "\${1:-}" = --apply ] && APPLY=1
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DENY="$HERE/vault-deny-patterns.txt"
WORK=@@SHARE@@/.stage
STAGE="$WORK/v"
REPORT=@@SHARE@@/.filtered.txt
fail() { echo "FAIL: $*（公開しない）" >&2; exit 1; }
[ "$(id -un)" = @@OPERATOR@@ ] || { echo "run as @@OPERATOR@@" >&2; exit 2; }
[ -d @@SHARE@@ ] && [ "$(stat -f '%Su %Sg %Lp' @@SHARE@@)" = "@@OPERATOR@@ @@GROUP@@ 750" ] || { echo "@@SHARE@@ が無いか、所有者・グループ・権限が違う（先に provision.sh --apply）" >&2; exit 2; }
CR=$(printf '\r')
for f in @@INCLUDE_FILE@@ @@EXCLUDE_FILE@@ "$DENY"; do
  [ -f "$f" ] || { echo "$f が無い：許可リスト・除外・検査の 3 つを置く（除外は空でもよいが、決めたことを残す）" >&2; exit 2; }
  if grep -q "$CR" "$f"; then echo "$f に CR（Windows の改行）がある：LF に直す（CR があると規則も検査も効かない）" >&2; exit 2; fi
done
if grep -nE '^[[:space:]]*(!|[-+.:HSPR][ _,]|(exclude|include|merge|dir-merge|hide|show|protect|risk|clear)([ ,_]|$))' @@INCLUDE_FILE@@ @@EXCLUDE_FILE@@ >&2; then
  echo "許可・除外のファイルに rsync の規則（! + - . : 等）がある：パターンだけを書く（規則は必ず除くものを外せる）" >&2; exit 2
fi
grep -qvE '^[[:space:]]*(#|$)' @@INCLUDE_FILE@@ || { echo "@@INCLUDE_FILE@@ が空：写す範囲（許可リスト）を Human が決めて置く" >&2; exit 2; }
grep -qvE '^[[:space:]]*(#|$)' "$DENY" || { echo "$DENY が空（中身の検査なしでは写さない）" >&2; exit 2; }
[ -d @@VAULT_SRC@@ ] || { echo "@@VAULT_SRC@@ not found" >&2; exit 2; }
if [ "$APPLY" -eq 0 ]; then
  /usr/sbin/taskpolicy -b /usr/bin/rsync -a --dry-run -v @@RSYNC_EXCLUDES@@ --exclude-from=@@EXCLUDE_FILE@@ --include-from=@@INCLUDE_FILE@@ --exclude='*' @@VAULT_SRC@@/ "$STAGE/"
  echo "（表示だけ。--apply で写し、検査にあたったものを落としてから @@SHARE@@/vault へ出す）"
  exit 0
fi
umask 077
mkdir -p "$STAGE"; chmod 700 "$WORK"
[ ! -d @@SHARE@@/vault ] || chmod 700 @@SHARE@@/vault
grep -vE '^[[:space:]]*(#|$)' "$DENY" > "$WORK/deny"
/usr/sbin/taskpolicy -b /usr/bin/rsync -a --delete --delete-excluded @@RSYNC_EXCLUDES@@ --exclude-from=@@EXCLUDE_FILE@@ --include-from=@@INCLUDE_FILE@@ --exclude='*' @@VAULT_SRC@@/ "$STAGE/"
find "$STAGE" -mindepth 1 \( @@FORBIDDEN_FIND@@ \) -prune -exec rm -rf {} +
find "$STAGE" ! -type f ! -type d -exec rm -f {} +
find "$STAGE" -type f ! -name '*.md' ! -name '*.txt' -exec rm -f {} +
find "$STAGE" -type f -exec perl -0777 -ne 'print "$ARGV\n" if /\x00/' {} + | sed "s#^$STAGE/##" > "$WORK/nul"
rc=0; LC_ALL=C /usr/sbin/taskpolicy -b grep -rlai -E -f "$WORK/deny" "$STAGE" > "$WORK/content" || rc=$?
[ "$rc" -le 1 ] || fail "中身の検査が失敗（grep exit \${rc}）"
rc=0; find "$STAGE" -mindepth 1 | sed "s#^$STAGE/##" | LC_ALL=C grep -ai -E -f "$WORK/deny" > "$WORK/names" || rc=$?
[ "$rc" -le 1 ] || fail "名前の検査が失敗（grep exit \${rc}）"
{ cat "$WORK/nul" "$WORK/names"; sed "s#^$STAGE/##" "$WORK/content"; } | sort -u > "$REPORT"
while IFS= read -r f; do [ -n "$f" ] && rm -rf -- "$STAGE/$f"; done < "$REPORT"
find "$STAGE" -mindepth 1 -type d -empty -delete
find "$STAGE" -mindepth 1 -type d -empty -delete
rc=0; LC_ALL=C grep -rqai -E -f "$WORK/deny" "$STAGE" || rc=$?
[ "$rc" -eq 1 ] || fail "中身の検査にあたるファイルが落としきれていない（grep exit \${rc}）"
n=$(find "$STAGE" -mindepth 1 | sed "s#^$STAGE/##" | LC_ALL=C grep -aci -E -f "$WORK/deny" || true)
[ "$n" = 0 ] || fail "名前の検査にあたるものが落としきれていない"
[ -z "$(find "$STAGE" \( @@FORBIDDEN_FIND@@ -o ! -type f ! -type d \) -print | head -n 1)" ] || fail "必ず除くものが残っている"
chgrp -R @@GROUP@@ "$STAGE"
find "$STAGE" -type d -exec chmod 750 {} +
find "$STAGE" -type f -exec chmod 640 {} +
/usr/sbin/taskpolicy -b /usr/bin/rsync -a --delete "$STAGE/" @@SHARE@@/vault/
[ -z "$(find @@SHARE@@/vault \( @@FORBIDDEN_FIND@@ -o ! -type f ! -type d \) -print | head -n 1)" ] || { chmod 700 @@SHARE@@/vault; fail "写しに除くべきものが残っている"; }
echo "vault-copy: done（写した $(find @@SHARE@@/vault -type f | wc -l | tr -d ' ') ファイル・落とした $(wc -l < "$REPORT" | tr -d ' ')。一覧は \${REPORT}）"
`;

const RUN = String.raw`#!/bin/sh
# Hermes gateway の wrapper（root 所有・LaunchDaemon @@LABEL@@ が UserName=@@USER@@ で起動）。生成：scripts/hermes-service.mjs
# 止める：sudo launchctl bootout system/@@LABEL@@（Human）か、touch /Users/@@USER@@/.hermes-edl/STOP（次の起動から動かない）。
# KeepAlive は「異常終了の時だけ」。exit 0 では再起動しない＝STOP・メモリ超過・異常終了の重なり（1 時間に 3 回）では exit 0 で止まる。
# Hermes の exit 75（再起動の依頼。hermes update の後）はそのまま返し、launchd が ThrottleInterval の後に起動し直す。
set -u
S=/Users/@@USER@@/.hermes-edl
mkdir -p "$S"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
[ -f "$S/STOP" ] && { log "STOP present: not starting"; exit 0; }
# 起動から 10 分は待つ（停電・再起動の直後は同居の VM の復旧を優先する）
up=$(( $(date +%s) - $(sysctl -n kern.boottime | sed 's/.*sec = \([0-9]*\).*/\1/') ))
[ "$up" -lt 600 ] && sleep $((600 - up))
ulimit -n 4096
ulimit -u 512
/Users/@@USER@@/.local/bin/hermes gateway run --external-supervisor &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; log "stopped by signal"; exit 0' TERM INT
while kill -0 "$pid" 2>/dev/null; do
  sleep 30 & wait $!   # trap が 30 秒待たずに動くように（launchd の終了の猶予は 20 秒）
  rss=$(ps -U @@USER@@ -o rss= | awk '{s+=$1} END {print int(s/1024)}')
  if [ "\${rss:-0}" -gt @@RSS_MAX_MIB@@ ]; then
    log "RSS \${rss} MiB > @@RSS_MAX_MIB@@ MiB: stopping and writing STOP"
    : > "$S/STOP"
    kill -TERM "$pid" 2>/dev/null; sleep 20; kill -KILL "$pid" 2>/dev/null
    exit 0
  fi
done
wait "$pid"; ec=$?
[ "$ec" -eq 0 ] && exit 0
[ "$ec" -eq 75 ] && { log "restart requested (75)"; exit 75; }
now=$(date +%s)
echo "$now" >> "$S/crashes"
recent=$(awk -v t=$((now - 3600)) '$1 >= t' "$S/crashes" | wc -l | tr -d ' ')
if [ "$recent" -ge 3 ]; then log "exit $ec: $recent crashes in 1h, writing STOP"; : > "$S/STOP"; exit 0; fi
log "exit $ec"
exit "$ec"
`;

const MANAGED_CONFIG = `# E-NEXUS Mac Runtime：Hermes の管理者固定の設定（/etc/hermes/config.yaml・root 所有 0644・Hermes の managed scope）。
# 生成：scripts/hermes-service.mjs。Secret を書かない（このファイルは誰でも読める）。ユーザーの config.yaml より優先される（key ごと）。
# Hermes の既定との違い：adopt_external_logins（既定 true）・approvals.mode（既定 smart）・write_approval（既定 false）・
# updates.check（既定 true）・pre_update_backup（既定 quick）・disabled_toolsets（既定は空）・model（初期の config.yaml は
# OpenRouter の base_url）・auxiliary の background_review と title_generation（既定 on・token を使う）。key は v0.22.4 の
# hermes_cli/config_defaults.py で確かめた。このファイルが YAML として読めないと Hermes は黙って無視する（fail-open）
# → 直したら acceptance.sh の「managed scope が効いている」を必ず見る。
model:
  provider: anthropic
  default: ${DEFAULT_MODEL}
  base_url: https://api.anthropic.com
fallback_providers: []
auxiliary:
  background_review:
    enabled: false
  title_generation:
    enabled: false
auth:
  adopt_external_logins: false
approvals:
  mode: manual
  timeout: 300
  cron_mode: deny
  single_query_mode: deny
  unattended_mode: deny
agent:
  disabled_toolsets: [${DISABLED_TOOLSETS.join(', ')}]
  max_turns: 50
  run_budget_seconds: 900
security:
  allow_private_urls: false
  redact_secrets: true
memory:
  write_approval: true
skills:
  write_approval: true
  guard_agent_created: true
updates:
  check: false
  pre_update_backup: full
`;

const ACCEPTANCE = String.raw`#!/bin/sh
# Hermes の検収（Human が sudo で実行。READ-ONLY）。生成：scripts/hermes-service.mjs
# MA-24 §16 の 6 条件＋Mac で足した項目のうち、機械で確かめられるもの。手で確かめる項目は最後に表示する。
# 確かめられない時は PASS にしない（FAIL か INFO）。鍵の値は読まない・出さない。hermes config は Hermes 自身の設定を移行することがある。
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
FAILS=0
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ok() { echo "PASS $*"; }
ng() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
as() { sudo -u @@USER@@ "$@" 2>/dev/null; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 2; }
f=$(find @@SHARE@@/vault -type f -name '*.md' -print | head -n 1)
[ -n "$f" ] && as test -r "$f" && ok "1 Vault の写しが読める" || ng "1 Vault の写しが読めない"
as test -w @@SHARE@@/vault && ng "2 写しに書ける" || { [ -n "$f" ] && as test -w "$f" && ng "2 写しのファイルに書ける" || ok "2 写しに書けない・消せない"; }
left=$(find @@SHARE@@/vault \( @@FORBIDDEN_FIND@@ -o ! -type f ! -type d -o -type f ! -name '*.md' ! -name '*.txt' \) -print | head -n 1)
[ -d @@SHARE@@/vault ] && [ -z "$left" ] && ok "3 Secret・.git・agent の設定・.md/.txt 以外・symlink が写しに無い" || ng "3 写しが無いか、除くべきものがある"
D=$(mktemp); grep -vE '^[[:space:]]*(#|$)' "$HERE/vault-deny-patterns.txt" > "$D" 2>/dev/null
if [ -s "$D" ] && [ -d @@SHARE@@/vault ]; then
  rc=0; LC_ALL=C grep -rqai -E -f "$D" @@SHARE@@/vault || rc=$?
  [ "$rc" -eq 1 ] && ok "3 写しの中身に検査（vault-deny-patterns.txt）にあたるものが無い" || ng "3 写しの中身が検査にあたるか、検査できない（grep exit \${rc}）"
  n=$(find @@SHARE@@/vault -mindepth 1 | sed "s#^@@SHARE@@/vault/##" | LC_ALL=C grep -aci -E -f "$D" || true)
  [ "$n" = 0 ] && ok "3 写しの名前に検査にあたるものが無い" || ng "3 写しの名前が検査にあたる（\${n} 件）"
else ng "3 検査のパターン（$HERE/vault-deny-patterns.txt）か写しが無い"; fi
rm -f "$D"
{ as test -x @@SHARE@@/.stage || as test -r @@SHARE@@/.filtered.txt; } && ng "3 @@USER@@ が検査前の置き場か落とした一覧を読める" || ok "3 @@USER@@ は検査前の置き場・落とした一覧を読めない"
as test -e /Users/@@USER@@/.git-credentials && ng "4 git の資格情報がある" || { as test -d /Users/@@USER@@/.config/gh && ng "4 gh の資格情報がある" || ok "4 git・gh の資格情報が無い"; }
as test -d /Users/@@USER@@/.hermes/memories && ok "5 Hermes Memory は Vault の外（~/.hermes/memories）" || echo "INFO 5 ~/.hermes/memories はまだ無い（初回の対話の後に確かめる）"
[ -f @@README@@ ] && ok "6 停止の方法：@@README@@" || ng "6 README が無い"
for p in /Users/@@OPERATOR@@ /Users/@@OPERATOR@@/.claude /Users/@@OPERATOR@@/e-nexus-runtime @@VAULT_SRC@@ @@INCLUDE_FILE@@ @@EXCLUDE_FILE@@ /Users/@@OPERATOR@@/.config/gh /Users/@@OPERATOR@@/Library/Keychains; do
  as test -r "$p" && ng "7 $p を読める" || ok "7 $p を読めない"
done
as test -e /Users/@@USER@@/.claude/.credentials.json && ng "8 Claude Code の資格情報がある" || ok "8 Claude Code の資格情報が無い"
as grep -qiE 'claude_code|oauth' /Users/@@USER@@/.hermes/auth.json && ng "8 auth.json に OAuth の記述" || ok "8 auth.json に OAuth の記述が無い"
# managed scope は YAML が読めないと黙って無視される（fail-open）→ YAML として読んで値を確かめ、Hermes 自身の表示でも確かめる
[ "$(stat -f '%Su %Lp' /etc/hermes/config.yaml 2>/dev/null)" = "root 644" ] && ok "8 /etc/hermes/config.yaml は root 所有・644" || ng "8 /etc/hermes/config.yaml が無いか、所有者・権限が違う"
y=$(perl -e 'alarm 30; exec @ARGV' /usr/bin/ruby -ryaml -e 'c = YAML.safe_load(File.read("/etc/hermes/config.yaml")); m = c["model"] || {}; puts [c.dig("auth", "adopt_external_logins"), m["provider"], m["default"], m["base_url"], c["fallback_providers"].inspect].join(" ")' 2>/dev/null) || y=''
[ "$y" = "false anthropic @@DEFAULT_MODEL@@ https://api.anthropic.com []" ] && ok "8 managed scope（YAML として読んだ値）：adopt false・Anthropic 直結・@@DEFAULT_MODEL@@・fallback なし" || ng "8 /etc/hermes/config.yaml を YAML として読めないか、値が想定と違う（読めないと Hermes は黙って無視する）"
if as test -x /Users/@@USER@@/.local/bin/hermes; then
  cfg=$(perl -e 'alarm 60; exec @ARGV' sudo -u @@USER@@ -i hermes config 2>&1) || true
  if echo "$cfg" | grep -q '/etc/hermes' && echo "$cfg" | grep -qE 'adopt_external_logins[^a-z]{0,8}false'; then
    ok "8 hermes config が managed scope と adopt_external_logins: false を示す"
  else ng "8 hermes config に /etc/hermes と adopt_external_logins: false が揃って出ない（hermes doctor・hermes config を目で確かめる。形の違いなら手の確認で可）"; fi
else
  echo "INFO 8 hermes はまだ入っていない（H3 の後にもう一度）"
fi
# 鍵（H4 の後）：値は読まない・出さない。名前と所有者・権限だけ
E=/Users/@@USER@@/.hermes/.env
if [ -f "$E" ]; then
  [ "$(stat -f '%Su %Lp' "$E")" = "@@USER@@ 600" ] && ok "8 .env は @@USER@@ 所有・600" || ng "8 .env の所有者か権限が違う"
  names=$(sed -n 's/^\(export \)\{0,1\}\([A-Z][A-Z0-9_]\{0,63\}\)=.*/\2/p' "$E" | sort -u)
  echo "$names" | grep -qx ANTHROPIC_API_KEY && ok "8 .env に ANTHROPIC_API_KEY がある" || echo "INFO 8 .env に ANTHROPIC_API_KEY がまだ無い（H4）"
  other=$(echo "$names" | grep -E 'KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH' | grep -vx ANTHROPIC_API_KEY | tr '\n' ' ')
  [ -z "$other" ] && ok "8 .env に ほかの鍵・token の名前が無い" || ng "8 .env に ANTHROPIC_API_KEY 以外の鍵・token（\${other}）：402 の時に別の資格情報へ切り替わる・Max の token は使わない"
  sudo -u @@OPERATOR@@ test -r "$E" && ng "8 @@OPERATOR@@ が .env を読める" || ok "8 @@OPERATOR@@ は .env を読めない"
else
  echo "INFO 8 ~/.hermes/.env はまだ無い（H3・H4 の後にもう一度）"
fi
L=''; for d in /Users/@@USER@@/.hermes/logs /Users/@@USER@@/.hermes/sessions /Users/@@USER@@/.hermes-edl; do [ -d "$d" ] && L="$L $d"; done
if [ -n "$L" ]; then
  rc=0; sudo -u @@USER@@ grep -rlqa 'sk-ant-[A-Za-z0-9_-]\{20\}' $L 2>/dev/null || rc=$?
  [ "$rc" -eq 1 ] && ok "8 ログ・session に鍵らしい文字列が無い" || ng "8 ログ・session に鍵らしい文字列があるか、検査できない（grep exit \${rc}。あれば Console で失効して発行し直す）"
else echo "INFO 8 ログ・session はまだ無い"; fi
dseditgroup -o checkmember -m @@USER@@ admin >/dev/null 2>&1 && ng "@@USER@@ が admin" || ok "@@USER@@ は管理者でない"
if out=$(launchctl print system/@@LABEL@@ 2>/dev/null); then
  echo "$out" | grep -iE '^[[:space:]]*(state|username|spawn type|last exit code) =' | sed 's/^[[:space:]]*/INFO 9 launchctl: /'
  pgrep -U @@USER@@ -f 'hermes gateway' >/dev/null && ok "9 gateway は @@USER@@ の process" || ng "9 @@USER@@ の gateway の process が無い"
  for p in $(pgrep -f 'hermes gateway'); do [ "$(ps -o user= -p "$p" | tr -d ' ')" = @@USER@@ ] || ng "9 @@USER@@ 以外の user で gateway が動いている（pid \${p}）"; done
else
  echo "INFO 9 @@LABEL@@ は未登録（H7 の後にもう一度）"
fi
n=$(netstat -an -p tcp | awk '$6=="LISTEN"{print $4}' | grep -vcE '^(127\.|::1\.)')
[ "$n" -eq 0 ] && ok "10 loopback 以外の TCP 待ち受け 0" || echo "WARN 10 loopback 以外の TCP 待ち受け \${n}（doctor の D4 で理由を確かめる）"
echo "--- 手で確かめる：11 止めて 60 秒以内に @@USER@@ の process が 0（ps -U @@USER@@）・Trading Lab が影響なしと確認／12 Console の Hermes 用 workspace に月の上限・組織の auto-reload が意図どおり（Off なら、クレジットを使い切ると止まる）／13 24 時間で RSS < @@RSS_MAX_MIB@@ MiB（host-health --hermes-user @@USER@@）／14 子 process も background（ps -o pid,pri,comm -U @@USER@@）"
[ "$FAILS" -eq 0 ] && echo "acceptance: no FAIL" || { echo "acceptance: $FAILS FAIL"; exit 1; }
`;

function plist(v) {
  const env = { HOME: `/Users/${v.USER}`, PATH: `/Users/${v.USER}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HERMES_HOME: `/Users/${v.USER}/.hermes`, HERMES_WRITE_SAFE_ROOT: `/Users/${v.USER}/work` };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(v.LABEL)}</string>`,
    `  <key>UserName</key><string>${xml(v.USER)}</string>`,
    '  <key>GroupName</key><string>staff</string>',
    '  <key>ProgramArguments</key>',
    `  <array><string>/bin/sh</string><string>${xml(`${WRAPPER_DIR}/run.sh`)}</string></array>`,
    `  <key>WorkingDirectory</key><string>${xml(`/Users/${v.USER}`)}</string>`,
    '  <key>EnvironmentVariables</key>',
    `  <dict>${Object.entries(env).map(([k, x]) => `<key>${k}</key><string>${xml(x)}</string>`).join('')}</dict>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>300</integer>',
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>LowPriorityIO</key><true/>',
    '  <key>Umask</key><integer>63</integer>',
    `  <key>StandardOutPath</key><string>${xml(`/Users/${v.USER}/.hermes-edl/launchd.log`)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(`/Users/${v.USER}/.hermes-edl/launchd.log`)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function readme(v) {
  return `Hermes（Mac mini・専用ユーザー ${v.USER}）の導入一式。生成：scripts/hermes-service.mjs（${v.GENERATED_AT}）
版：NousResearch/hermes-agent commit ${v.COMMIT}（installer sha256 ${v.INSTALLER_SHA256}）
正本：Vault MA-24（Hermes 常駐 Agent 導入設計）・MA-22 S1／S2／S5。このファイルに Secret は無い。

順番と担当（Trading Lab の VM・Parallels・MT5 には一切触れない。重い工程は FX 市場の週末の休場中か、Trading Lab が認めた時間に）
  H0 前提：Anthropic Console に Hermes 専用 workspace を作り、月の利用上限を設定する（Human）。鍵はまだ発行しない（H4 の直前に発行する。
     値は発行の時に 1 回しか表示されず、H1〜H3 の間に置いておく安全な場所が無い）。Decision Layer 用の鍵とは別にする。Claude の Pro／Max の資格情報（login・claude setup-token の token）は使わない。
     Max の付属の API クレジット（2026-10〜・Max 5x は月 100 USD・期限は請求の周期の終わり・繰り越し無し）を使うなら、claude.ai の
     Settings > Billing で Console の組織を 1 つ link する（後から自分では変えられない＝Human の判断）。クレジットはその組織の全部の鍵・
     workspace が分け合うので、workspace の上限は要る。クレジットだけの組織は使い切ると API が止まる（Max の枠・プランへは請求されない）が、
     購入したクレジットや auto-reload があると止まらずに有料で続く → 始める前に Console の Billing で、Promotional credits の残高と期限・
     購入したクレジットの残高・auto-reload の On／Off を Human が確かめる（出典：platform.claude.com/docs/en/about-claude/api-credits-for-subscribers）。
  H1 sudo sh provision.sh            → 表示を読む → sudo sh provision.sh --apply --lock-operator-home（Human）
  H2 sh vault-copy.sh                → 表示を読む → sh vault-copy.sh --apply（${v.OPERATOR}）
     写す範囲は許可リスト ${v.INCLUDE_FILE}（無ければ動かない）から ${v.EXCLUDE_FILE} を引いたもの。そこから .md・.txt 以外と、
     中身が vault-deny-patterns.txt（鍵・IP・電話・メール・口座・給与・顧客・契約の語）にあたるファイルを落とす。落とした一覧は
     ${v.SHARE}/.filtered.txt（${v.OPERATOR} だけが読める）。広げる時は Human が許可リストか検査の行を直して H2 をやり直す
     3 つのファイルは LF（CR があると止まる）・パターンだけ（rsync の ! + - : 等の規則は拒否）。特定の事業・口座・取引先の名前で落としたい時は
     生成物の vault-deny-patterns.txt に行を足す（repo は公開なので generator には書かない）。途中で失敗すると前回の写しも 700 のまま＝Hermes は読めない
  H3 sudo -u ${v.USER} -i sh /Users/${v.USER}/install-as-hermes.sh（Human。provision が ${v.USER} の home へ置いた写し）
  H4 鍵（Human。AI は見ない・AI の session の端末で打たない）：Console の Hermes 専用 workspace で鍵を 1 本発行 → 別の Terminal で
       sudo -u ${v.USER} -i → umask 077; nano ~/.hermes/.env に ANTHROPIC_API_KEY=… を貼る → chmod 600 ~/.hermes/.env → exit → pbcopy < /dev/null（クリップボードを消す）。
     鍵を echo・export・コマンドの引数に書かない（shell の履歴・ps に残る）。値を他の場所（メモ・チャット・Windows）に残さない。失くしたら失効して発行し直す
  H5 sudo sh acceptance.sh（Human）→ FAIL 0（managed scope が効いていること・.env の名前と権限も見る）
  H6 sudo -u ${v.USER} -i hermes で 1 回だけ対話（Human）。Vault の写し ${v.SHARE}/vault を読ませる。終わったら acceptance をもう一度。
     Console の Usage で、この 1 回の分が Hermes の workspace に付いたこと（Decision Layer の鍵・Max の枠ではないこと）を確かめる
  H7 常駐（Human・sudo。host-health が登録済みで、Trading Lab が時期を認めた後）：
       （host-health は ${v.OPERATOR} が node scripts/scheduled-job-service.mjs --job host-health --target launchd --dir <decision-layer>
        --node "$(command -v node)" --hermes-user ${v.USER} で生成し、表示の launchctl bootstrap で登録＝Human）
       sudo install -o root -g wheel -m 644 ${v.LABEL}.plist /Library/LaunchDaemons/
       sudo launchctl bootstrap system /Library/LaunchDaemons/${v.LABEL}.plist
       sudo launchctl print system/${v.LABEL}
  H8 1 週間の観察（host-health --hermes-user ${v.USER}・Console の usage）

モデルと費用
  既定は ${v.DEFAULT_MODEL}（/etc/hermes/config.yaml で固定・Anthropic に直結・fallback なし・background_review と自動の題名づけは off）。
  上げる時は Human が sudo で /etc/hermes/config.yaml の model.default を直し（例 claude-sonnet-5-5・単価は約 20 倍）、Hermes を起動し直す。
  上限は Console の Hermes 専用 workspace の月の上限（Hermes 自体には無い）。上限・クレジットに当たると API は 402（billing_error）を返し、
  Hermes はその turn を再試行せずに止める（v0.22.4 の agent/error_classifier.py：billing は retryable でない）。資格情報の切り替えと
  fallback は行き先が無い（.env の鍵は 1 本・fallback_providers は空）ので、別の課金へ流れない。gateway は動いたままで、待機中は課金されない。
  購入したクレジットの残高があると、付属のクレジットを使い切った後もその分は使われ得る（順番と残高は Console の Billing で見る）。
  workspace の上限はそれも含めて止める。auto-reload は Off のままにする（On にすると上限まで有料で続く）。

止める（1 か所にまとめる＝MA-24 §16 の 6）
  すぐ止める：sudo launchctl bootout system/${v.LABEL}
  次から起動させない：sudo -u ${v.USER} touch /Users/${v.USER}/.hermes-edl/STOP（消すと次の起動から動く）
  wrapper が自分で止まる：${v.USER} の RSS 合計が ${v.RSS_MAX_MIB} MiB を超えた時・1 時間に 3 回異常終了した時（STOP を書いて exit 0）
  Hermes を止めても Trading Lab の LIVE には影響しない（Hermes は LIVE の経路にいない）

外す
  sudo launchctl bootout system/${v.LABEL}; sudo rm /Library/LaunchDaemons/${v.LABEL}.plist
  sudo -u ${v.USER} -i hermes uninstall --dry-run → hermes uninstall（--full で ~/.hermes も）→ Console で鍵を失効
  sudo rm -rf "${WRAPPER_DIR}" /etc/hermes; rm -rf ${v.SHARE}/vault ${v.SHARE}/.stage ${v.SHARE}/.filtered.txt
  （必要なら）sudo sysadminctl -deleteUser ${v.USER}; sudo dseditgroup -o delete ${GROUP}
`;
}

export function buildBundle(a, { now = () => new Date() } = {}) {
  const v = {
    USER: a.user, OPERATOR: a.operator, GROUP, SHARE: a.share, VAULT_SRC: a.vaultSrc, INCLUDE_FILE: a.includeFile, EXCLUDE_FILE: a.excludeFile, COMMIT: a.commit,
    INSTALLER_SHA256: a.installerSha256, LABEL: a.label, RSS_MAX_MIB: Number(a.rssMaxMib), WRAPPER_DIR, OUT_DIR: a.outDir, DEFAULT_MODEL,
    README: `${a.outDir}/README.txt`, GENERATED_AT: now().toISOString(),
    RSYNC_EXCLUDES: VAULT_EXCLUDES.map((x) => `--exclude='${x}'`).join(' '),
    FORBIDDEN_FIND: FORBIDDEN_NAMES.map((x) => `-iname '${x}'`).join(' -o '),
  };
  return {
    'README.txt': readme(v),
    'provision.sh': fill(PROVISION, v),
    'install-as-hermes.sh': fill(INSTALL_AS_HERMES, v),
    'vault-copy.sh': fill(VAULT_COPY, v),
    'vault-deny-patterns.txt': `${VAULT_DENY_PATTERNS.join('\n')}\n`,
    'run.sh': fill(RUN, v),
    'managed-config.yaml': MANAGED_CONFIG,
    'acceptance.sh': fill(ACCEPTANCE, v),
    [`${a.label}.plist`]: plist(v),
  };
}

export function parseArgs(argv) {
  const a = { share: '/Users/Shared/e-nexus-hermes', rssMaxMib: 3072, label: 'com.e-nexus.hermes' };
  const map = { '--user': 'user', '--operator': 'operator', '--vault-src': 'vaultSrc', '--include-file': 'includeFile', '--exclude-file': 'excludeFile', '--commit': 'commit', '--installer-sha256': 'installerSha256', '--out-dir': 'outDir', '--share': 'share', '--rss-max-mib': 'rssMaxMib', '--label': 'label' };
  for (let i = 0; i < argv.length; i += 2) {
    if (!map[argv[i]]) throw new Error(`unknown argument: ${argv[i]}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    a[map[argv[i]]] = argv[i + 1];
  }
  return a;
}

function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const errors = validateArgs(a);
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  const files = buildBundle(a);
  mkdirSync(a.outDir, { recursive: true, mode: 0o700 });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(a.outDir, name), body, { mode: name.endsWith('.sh') ? 0o700 : 0o600, flag: 'wx' });
  console.log(`generated ${Object.keys(files).length} files in ${a.outDir}（実行・登録はしていない。順番は README.txt）`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
