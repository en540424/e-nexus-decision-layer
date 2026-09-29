#!/bin/sh
# 常駐 process のログを大きさで世代管理する（2026-09-29・Human Last-Mile Activation）。sudo 不要（ユーザーの LaunchAgent から定期実行できる）。
#
#   sh deploy/macos/rotate-logs.sh --base <repo を並べた親フォルダ> [--max-kb 5120] [--keep 3] [--dry-run]
#   sh deploy/macos/rotate-logs.sh [--max-kb N] [--keep N] [--dry-run] <log ファイル>...
#
# 対象（--base のとき）：
#   e-nexus-decision-layer/data/gateway-*.log（Gateway の LaunchAgent の stdout／stderr）
#   e-nexus-decision-layer/data/openmontage-launcher/autostart/launchd.*.log（watcher の LaunchAgent）
#   en-sns-hub/logs/*.log
# 方式：copy → truncate（<file>.1 … <file>.<keep>）。launchd は StandardOutPath を開いたまま書き続けるので、rename では新しい行が
# 古いファイルへ入り続ける。copy と truncate の間の数行が失われ得る（小さい）。launchd が追記モード（O_APPEND）で開くことを前提にする
# ＝〔実機で確定〕：初回に truncate 後の書き込み位置が先頭へ戻ることを確かめる（MIGRATION.md）。
# launcher-events.jsonl は launcher 自身が 2MB・1 世代で回している（integrations/openmontage）ので対象外。
set -eu

MAX_KB=5120; KEEP=3; DRY=0; BASE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --max-kb) MAX_KB="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    --*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
case "$MAX_KB" in ''|*[!0-9]*) echo "--max-kb must be a positive integer" >&2; exit 2 ;; esac
case "$KEEP" in ''|*[!0-9]*|0) echo "--keep must be 1 or more" >&2; exit 2 ;; esac

rotate() {
  f="$1"
  [ -f "$f" ] || return 0
  kb=$(( $(wc -c < "$f" | tr -d ' ') / 1024 ))
  if [ "$kb" -lt "$MAX_KB" ]; then echo "keep: $f (${kb}KB)"; return 0; fi
  if [ "$DRY" -eq 1 ]; then echo "[dry-run] rotate: $f (${kb}KB → $f.1 … $f.$KEEP)"; return 0; fi
  i=$KEEP
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    [ -f "$f.$prev" ] && mv -f "$f.$prev" "$f.$i"
    i=$prev
  done
  cp -p "$f" "$f.1"
  : > "$f"
  echo "rotated: $f (${kb}KB → $f.1)"
}

if [ -n "$BASE" ]; then
  for f in "$BASE"/e-nexus-decision-layer/data/gateway-*.log \
           "$BASE"/e-nexus-decision-layer/data/openmontage-launcher/autostart/launchd.*.log \
           "$BASE"/en-sns-hub/logs/*.log; do
    rotate "$f"
  done
fi
for f in "$@"; do rotate "$f"; done
