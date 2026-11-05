#!/bin/bash
# GitHub の無人の見張りをつなぐ（2026-11-05・H3）。**実行は Human**（token の入力があるため）。
# 先に GitHub で fine-grained PAT を発行する（手順は docs/runtime-monitoring.md §4）。gh のログインや classic token は使わない。
#
#   bash deploy/macos/connect-github-monitor.sh <owner>
#
# することは 2 つだけ：① token を Keychain へ入れる（マスクされたプロンプト）② 検収する（fine-grained か・6 repo を読めるか・書けないか）。
# 不合格の token は Keychain から消す。合格すれば次の :20／:50 から host-health が使う（job は登録済みで、token が入るまでは何もしない）。
# Claude Code の `!` ではなく、Mac の Terminal で実行する（入力が会話に残らないように）。
set -euo pipefail

NAME="github-monitor-token"
TARGET="E-NEXUS/edl/$NAME"
OWNER="${1:-}"
cd "$(dirname "$0")/../.."

[ -n "$OWNER" ] || { echo "使い方：bash deploy/macos/connect-github-monitor.sh <owner>" >&2; exit 2; }
[ -t 0 ] || { echo "Mac の Terminal で実行してください（マスクされたプロンプトが要ります）" >&2; exit 2; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE=/opt/homebrew/bin/node

bash deploy/macos/keychain-edl.sh set "$NAME"
if "$NODE" scripts/github-monitor-check.mjs --owner "$OWNER"; then
  if /usr/bin/grep -q "$TARGET" "$HOME/Library/LaunchAgents/com.e-nexus.host-health.plist" 2>/dev/null; then
    echo "OK：次の :20／:50 から GitHub の見張りが動きます（正常なら通知は来ません）"
  else
    echo "NG：token は合格しましたが、登録済みの job が --github-credential を持っていません。Claude Code に job の登録し直しを頼んでください" >&2
    exit 1
  fi
else
  /usr/bin/security delete-generic-password -s "$TARGET" -a e-nexus >/dev/null 2>&1 || true
  echo "NG：token は Keychain から消しました。上のコードを Claude Code に伝えてください（TOKEN_CAN_WRITE＝書き込みの権限がある・REPO_NOT_READABLE＝repo の選択か権限が足りない・NOT_FINE_GRAINED＝classic か gh の token）" >&2
  exit 1
fi
