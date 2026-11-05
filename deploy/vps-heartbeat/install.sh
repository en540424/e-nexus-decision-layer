#!/bin/bash
# Mac mini の外部死活監視の受け側を VPS へ入れる（2026-11-05・H6）。**実行は Human**（root・VPS の上）。手順は README.md。
# 変えるもの：user edl-heartbeat・/opt/e-nexus-heartbeat・/etc/e-nexus/heartbeat.env・/var/lib/e-nexus-heartbeat・unit e-nexus-heartbeat.service だけ。
# 変えないもの：既存の service・Docker・Tailscale の Serve／Funnel・cloudflared の設定・firewall・package。
# 既存の service の PID を前後で比べ、変わっていれば NG と言う。何度流しても同じ結果になる（token と webhook は再利用）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${HEARTBEAT_PORT:-8791}"
ENV_FILE=/etc/e-nexus/heartbeat.env
UNIT=e-nexus-heartbeat.service
WATCHED="en-product-hub audio-processor cloudflared tailscaled docker"

[ "$(id -u)" = 0 ] || { echo "root で実行してください" >&2; exit 2; }
command -v systemctl >/dev/null || { echo "systemd が要ります" >&2; exit 2; }
NODE=/usr/bin/node
[ -x "$NODE" ] || { echo "$NODE がありません（既存の node を使います。入れ替えません）" >&2; exit 2; }
pids() { for s in $WATCHED; do printf '%s=%s ' "$s" "$(systemctl show -p MainPID --value "$s" 2>/dev/null || echo none)"; done; }
BEFORE="$(pids)"

if ! systemctl is-active --quiet "$UNIT" && ss -lnt | awk '{print $4}' | grep -qE "[:.]$PORT$"; then
  echo "port $PORT は使われています。HEARTBEAT_PORT で別の番号を指定してください（何も変えていません）" >&2
  exit 1
fi

id edl-heartbeat >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin edl-heartbeat
install -d -m 0755 /opt/e-nexus-heartbeat
install -m 0644 "$HERE/receiver.mjs" /opt/e-nexus-heartbeat/receiver.mjs
install -d -m 0755 /etc/e-nexus

if [ ! -f "$ENV_FILE" ]; then
  echo "監視の専用チャンネルの Discord Webhook の URL を貼ってください（Mac の Webhook とは別のものを推奨。表示しません）"
  read -r -s -p "URL: " url; echo
  case "$url" in https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*) ;; *) echo "Discord の Webhook の URL ではありません（何も書いていません）" >&2; exit 1 ;; esac
  token="$(openssl rand -hex 32)"
  ( umask 027; printf 'HEARTBEAT_TOKEN=%s\nDISCORD_WEBHOOK_URL=%s\nHEARTBEAT_PORT=%s\n' "$token" "$url" "$PORT" > "$ENV_FILE" )
  chown root:edl-heartbeat "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  unset url
  echo
  echo "Mac の Keychain へ入れる token（この画面にだけ出します。Mac の connect-heartbeat.sh の入力に貼ってください）："
  echo "$token"
  unset token
  echo
fi

install -m 0644 "$HERE/e-nexus-heartbeat.service" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT" || { echo "NG：$UNIT が動いていません。journalctl -u $UNIT を確かめてください" >&2; exit 1; }
ss -lnt | awk '{print $4}' | grep -qE "^127\.0\.0\.1:$PORT$" || { echo "NG：loopback 以外で待っているか、待っていません" >&2; exit 1; }
AFTER="$(pids)"
[ "$BEFORE" = "$AFTER" ] || { echo "NG：既存の service の PID が変わりました：$BEFORE → $AFTER" >&2; exit 1; }
echo "OK：127.0.0.1:$PORT で動いています。既存の service は変わっていません。次は README の Cloudflare の手順へ"
