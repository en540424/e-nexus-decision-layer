#!/bin/bash
# Task Hub の回（scripts/task-hub-cycle.mjs）を 5 分ごとに動かす LaunchAgent（2026-11-11・MA-24）。**新しい LaunchAgent＝Human の承認の後だけ**。
#   bash deploy/macos/connect-task-hub.sh            何を書くかを表示（dry-run）
#   bash deploy/macos/connect-task-hub.sh --apply    ~/Library/LaunchAgents/com.e-nexus.task-hub.plist を書いて登録（user の domain・sudo なし）
#   bash deploy/macos/connect-task-hub.sh --remove   登録を外して plist を消す（Task Hub の保存物は残る）
# 常駐しない（1 回 1〜数十秒で終わる）。Background・LowPriorityIO・nice。AI／課金なし。
# 休眠の条件：Task Hub の config.json が無い・Keychain に VPS の URL／鍵が無い時は通信しない（task-intake-sync が not_configured）。
# 止める：--remove、または Task Hub の保存先に PAUSE を置く（run が止まる）。host-health は最後の回の結果を読み、続けて問題か 30 分止まれば知らせる。
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
LABEL=com.e-nexus.task-hub
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/opt/homebrew/bin/node
[ -x "$NODE" ] || NODE="$(command -v node)"
mode="${1:-dry-run}"

plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>scripts/task-hub-cycle.mjs</string>
	</array>
	<key>RunAtLoad</key>
	<false/>
	<key>StartInterval</key>
	<integer>300</integer>
	<key>StandardErrorPath</key>
	<string>$REPO/data/task-hub-cycle.err.log</string>
	<key>StandardOutPath</key>
	<string>$REPO/data/task-hub-cycle.out.log</string>
	<key>WorkingDirectory</key>
	<string>$REPO</string>
</dict>
</plist>
EOF
}

case "$mode" in
  dry-run)
    echo "would write $PLIST and run: launchctl bootstrap gui/$(id -u) $PLIST"
    plist
    ;;
  --apply)
    [ -f "$HOME/e-nexus-runtime/mac-runtime-state/task-hub/config.json" ] || { echo "NG Task Hub の config.json が無い（先に作る）" >&2; exit 1; }
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/$LABEL" || true; fi
    tmp="$PLIST.tmp-$$"
    plist > "$tmp"
    plutil -lint "$tmp" >/dev/null
    chmod 0644 "$tmp"
    mv "$tmp" "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    launchctl print "gui/$(id -u)/$LABEL" | grep -E '^\s*(state|run interval) =' || true
    echo "OK $LABEL を登録しました（5 分ごと。最初の回は 5 分後）"
    ;;
  --remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "OK $LABEL を外しました"
    ;;
  *) echo "usage: connect-task-hub.sh [--apply|--remove]" >&2; exit 2 ;;
esac
