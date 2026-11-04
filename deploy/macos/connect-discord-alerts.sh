#!/bin/bash
# host-health の異常通知を Discord へつなぐ（2026-11-04・MA-22 §11-7）。**実行は Human**（Webhook URL の入力があるため）。
# 先に Discord で、監視の専用チャンネルと、そのチャンネル専用の Webhook を作る（既存の Webhook を使い回さない）。
#
#   bash deploy/macos/connect-discord-alerts.sh
#
# することは 2 つだけ：① URL を Keychain へ入れる（マスクされたプロンプト。引数・環境変数・ファイルでは受けない）② 配送試験を 1 通送る。
# URL は表示しない。Claude Code の `!` ではなく、Mac の Terminal で実行する（入力が会話に残らないように）。
# 登録済みの job が --webhook を持っているかも確かめる（持っていなければ OK と言わない）。やり直す時は同じコマンドをもう一度（上書き）。
set -euo pipefail

NAME="host-health-webhook"
SPEC="credential:E-NEXUS/edl/$NAME"
cd "$(dirname "$0")/../.."

[ -t 0 ] || { echo "Mac の Terminal で実行してください（マスクされたプロンプトが要ります）" >&2; exit 2; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE=/opt/homebrew/bin/node

bash deploy/macos/keychain-edl.sh set "$NAME"
echo "配送試験を 1 通送ります（監視の状態は変えません）"
if "$NODE" scripts/host-health.mjs --webhook "$SPEC" --webhook-format discord --webhook-test; then
  if /usr/bin/grep -q "$SPEC" "$HOME/Library/LaunchAgents/com.e-nexus.host-health.plist" 2>/dev/null; then
    echo "OK：チャンネルに「配送試験」が届いていれば接続は完了です。次の :20／:50 から通知が動きます"
  else
    echo "NG：配送はできましたが、登録済みの job が --webhook を持っていません。Claude Code に job の登録し直しを頼んでください" >&2
    exit 1
  fi
else
  echo "NG：上の webhook_test のコードを Claude Code に伝えてください（WEBHOOK_URL_NOT_DISCORD＝URL の貼り間違い・WEBHOOK_HTTP_404＝Webhook が消えている）" >&2
  exit 1
fi
