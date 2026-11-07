#!/bin/sh
# Hermes の実読み取りの検証（2026-11-07・H4）。Human が 1 回だけ実行する（sudo のパスワードが要る＝Claude Code は実行できない）。
#   sh deploy/macos/hermes-read-check.sh <証跡のフォルダの絶対パス>
#     [--share <合成データの置き場>] [--brief <要約>] [--skip-guards（test 用）]
# すること：hermes として `hermes -z` を 1 回だけ動かす。道具は file だけ・90 秒で強制終了・Hermes の設定も権限も変えない・鍵の値は読まない。
# 有料の API を使う。1 回の実行の中で Messages API の要求は 2 回以上になる（ファイルを読む指示の応答＋答え。一時的な障害なら Hermes が再試行する）。回数は結果の api_calls に出る。
# 同じ証跡のフォルダでは 2 回目を拒む。もう 1 回の判断は Human（承認を取ってから別のフォルダで）。
# 終わったら Console の Usage で、結果の時刻・model・トークン数が E-NEXUS-Hermes の鍵に載っていることを確かめる（反映に時間がかかる）。
set -u
EVIDENCE=${1:-}
[ -n "$EVIDENCE" ] || { echo "usage: sh deploy/macos/hermes-read-check.sh <証跡のフォルダの絶対パス>" >&2; exit 2; }
shift
SHARE=/Users/Shared/e-nexus-hermes/read-check
BRIEF_ARG=''
SKIP=''
while [ $# -gt 0 ]; do
  case "$1" in
    --share) [ $# -ge 2 ] || { echo "--share needs a value" >&2; exit 2; }; SHARE=$2; shift 2 ;;
    --brief) [ $# -ge 2 ] || { echo "--brief needs a value" >&2; exit 2; }; BRIEF_ARG=$2; shift 2 ;;
    --skip-guards) SKIP=--skip-guards; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -ne 0 ] || { echo "sudo を付けずに実行する（中で hermes の分だけ sudo する）" >&2; exit 2; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
HH=/Users/hermes
USAGE=$HH/work/read-check-usage.json
GATEWAY='gateway run --external-supervisor'
umask 077
gateway_pid() { pgrep -U hermes -f "$GATEWAY" | head -1; }
if [ -z "$SKIP" ]; then
  [ "$(sysctl -n kern.memorystatus_vm_pressure_level)" = 1 ] || { echo "メモリ逼迫の間は始めない" >&2; exit 3; }
  [ -n "$(gateway_pid)" ] || { echo "Hermes の常駐が見えない。始めない" >&2; exit 3; }
fi
sudo -v || exit 3
if [ -n "$BRIEF_ARG" ]; then
  node "$REPO/scripts/hermes-read-check.mjs" prepare --evidence "$EVIDENCE" --share "$SHARE" --brief "$BRIEF_ARG" $SKIP || exit $?
else
  node "$REPO/scripts/hermes-read-check.mjs" prepare --evidence "$EVIDENCE" --share "$SHARE" $SKIP || exit $?
fi
trap 'rm -rf "$SHARE"' EXIT
[ -n "$SKIP" ] || gateway_pid > "$EVIDENCE/gateway.before"
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE/started"
# sudo -i は引数を login shell が読み直すので使わない。環境は LaunchDaemon の plist と同じものだけ渡す。cwd は hermes が入れる所へ
( cd "$SHARE" && sudo -u hermes -H /usr/bin/env -i HOME="$HH" HERMES_HOME="$HH/.hermes" HERMES_WRITE_SAFE_ROOT="$HH/work" PATH="$HH/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    /usr/bin/perl -e 'alarm 90; exec @ARGV' /usr/sbin/taskpolicy -b "$HH/.local/bin/hermes" -z "$(cat "$EVIDENCE/prompt.txt")" -t file --usage-file "$USAGE" ) > "$EVIDENCE/answer.txt" 2> "$EVIDENCE/stderr.txt"
EC=$?
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE/finished"
sudo -u hermes -H /bin/cat "$USAGE" > "$EVIDENCE/usage.json" 2>/dev/null
sudo -u hermes -H /bin/rm -f "$USAGE"
if [ -z "$SKIP" ]; then
  gateway_pid > "$EVIDENCE/gateway.after"
  cmp -s "$EVIDENCE/gateway.before" "$EVIDENCE/gateway.after" && echo "常駐の pid は変わっていない" || echo "注意：常駐の pid が変わった"
fi
node "$REPO/scripts/hermes-read-check.mjs" grade --evidence "$EVIDENCE" --exit "$EC"
