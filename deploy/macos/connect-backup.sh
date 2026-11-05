#!/bin/bash
# 暗号化バックアップをつなぐ（2026-11-05・H5）。**実行は Human**（passphrase と token の入力があるため）。手順は docs/runtime-monitoring.md §5。
# 先に GitHub で Private repo と、その repo だけの fine-grained PAT（Contents: Read and write）を作り、passphrase を Mac の外に控える。
#
#   bash deploy/macos/connect-backup.sh <owner> <repo> <deny-file の絶対パス>
#
# することは順に：① passphrase を Keychain へ ② Mac の外の控えから打ち直して一致を確かめる ③ token を Keychain へ ④ 送る条件を全部確かめる
# ⑤ 初回を送る（読み直して確かめる）⑥ 毎日の job を登録する。どこかで失敗すれば先へ進まず、job は登録しない。やり直しは同じコマンドをもう一度。
# Claude Code の `!` ではなく、Mac の Terminal で実行する（入力が会話に残らないように）。
set -euo pipefail

OWNER="${1:-}"; REPO="${2:-}"; DENY="${3:-}"
LABEL="com.e-nexus.runtime-backup"
cd "$(dirname "$0")/../.."
DIR="$PWD"

[ -n "$OWNER" ] && [ -n "$REPO" ] && [ -n "$DENY" ] || { echo "使い方：bash deploy/macos/connect-backup.sh <owner> <repo> <deny-file の絶対パス>" >&2; exit 2; }
[ -t 0 ] || { echo "Mac の Terminal で実行してください（マスクされたプロンプトが要ります）" >&2; exit 2; }
[ -f "$DENY" ] || { echo "deny のファイルがありません" >&2; exit 2; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE=/opt/homebrew/bin/node

bash deploy/macos/keychain-edl.sh set backup-passphrase
echo "Mac の外に控えた passphrase を、控えを見ながらもう一度入力してください（Keychain と同じかを確かめます）"
read -r -s -p "passphrase: " typed; echo
printf '%s\n' "$typed" | "$NODE" scripts/backup-run.mjs attest-key || { unset typed; echo "NG：控えと一致しません。もう一度やり直してください" >&2; exit 1; }
unset typed
bash deploy/macos/keychain-edl.sh set backup-token
"$NODE" scripts/backup-run.mjs check --owner "$OWNER" --repo "$REPO" --deny-file "$DENY" || { echo "NG：上の failure のコードを Claude Code に伝えてください（何も送っていません）" >&2; exit 1; }
"$NODE" scripts/backup-run.mjs run --owner "$OWNER" --repo "$REPO" --deny-file "$DENY" || { echo "NG：初回が失敗しました。上の failure のコードを Claude Code に伝えてください" >&2; exit 1; }
"$NODE" scripts/scheduled-job-service.mjs --job runtime-backup --target launchd --dir "$DIR" --node "$NODE" --owner "$OWNER" --repo "$REPO" --deny-file "$DENY" --hour 4 --minute 40 | /usr/bin/sed -e '1d' -e '/^# 登録/,$d' > "$HOME/Library/LaunchAgents/$LABEL.plist"
/usr/bin/plutil -lint "$HOME/Library/LaunchAgents/$LABEL.plist" >/dev/null
/bin/launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "OK：初回を送り、読み直して確かめました。毎日 4:40 に動きます（正常なら通知は来ません）。常駐の増加の通知が 1 回届きます"
