#!/bin/bash
# 外部の死活監視へつなぐ Mac 側（2026-11-05・H6）。**実行は Human**（URL と token の入力があるため）。先に deploy/vps-heartbeat/README.md の 1〜3 を済ませる。
#
#   bash deploy/macos/connect-heartbeat.sh
#
# することは 2 つだけ：① URL と token を Keychain へ入れる（マスクされたプロンプト）② 試しに 1 回送る。不合格なら URL と token を Keychain から消す。
# 合格すれば次の :20／:50 から host-health が送る（job は登録済みで、Keychain に入るまでは何もしない）。Claude Code の `!` ではなく、Mac の Terminal で実行する。
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -t 0 ] || { echo "Mac の Terminal で実行してください（マスクされたプロンプトが要ります）" >&2; exit 2; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE=/opt/homebrew/bin/node

/usr/bin/grep -q -- '--heartbeat' "$HOME/Library/LaunchAgents/com.e-nexus.host-health.plist" 2>/dev/null || { echo "NG：登録済みの job が --heartbeat を持っていません。Claude Code に job の登録し直しを頼んでください（何も変えていません）" >&2; exit 1; }
echo "URL は https://<Cloudflare に足した hostname>/hb の形です"
bash deploy/macos/keychain-edl.sh set heartbeat-url
echo "token は VPS の install.sh が出した 64 文字です"
bash deploy/macos/keychain-edl.sh set heartbeat-token
if "$NODE" scripts/heartbeat-test.mjs; then
  echo "OK：受け側が受け取りました。次の :20／:50 から 30 分ごとに送ります（正常なら通知は来ません）"
else
  /usr/bin/security delete-generic-password -s E-NEXUS/edl/heartbeat-url -a e-nexus >/dev/null 2>&1 || true
  /usr/bin/security delete-generic-password -s E-NEXUS/edl/heartbeat-token -a e-nexus >/dev/null 2>&1 || true
  echo "NG：Keychain から消しました。上の code を Claude Code に伝えてください（rejected＝token の違い・failed＝hostname か Tunnel・config_invalid＝形の違い）" >&2
  exit 1
fi
