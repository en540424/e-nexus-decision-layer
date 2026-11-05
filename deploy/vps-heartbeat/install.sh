#!/bin/bash
# Mac mini の外部死活監視の受け側を VPS へ入れる（2026-11-05・H6）。**実行は Human**（root・VPS の上）。手順は README.md。
# 変えるもの：user edl-heartbeat・/opt/e-nexus-heartbeat・/etc/e-nexus/heartbeat.env・/var/lib/e-nexus-heartbeat・unit e-nexus-heartbeat.service だけ。
# 変えないもの：既存の service・Docker・Tailscale の Serve／Funnel・cloudflared の設定・firewall・package。
# 既存の service の PID を前後で比べ、変わっていれば NG と言う。何度流しても同じ結果になる（token と webhook は再利用）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/e-nexus/heartbeat.env
SAVED_PORT="$(sed -n 's/^HEARTBEAT_PORT=//p' "$ENV_FILE" 2>/dev/null || true)"
PORT="${HEARTBEAT_PORT:-${SAVED_PORT:-8795}}"  # 8790〜8793 は VPS staging の候補なので避ける
UNIT=e-nexus-heartbeat.service
WATCHED="en-product-hub audio-processor cloudflared tailscaled docker"

[ "$(id -u)" = 0 ] || { echo "root で実行してください" >&2; exit 2; }
command -v systemctl >/dev/null || { echo "systemd が要ります" >&2; exit 2; }
NODE=/usr/bin/node
[ -x "$NODE" ] || { echo "$NODE がありません（既存の node を使います。入れ替えません）" >&2; exit 2; }
[ "$("$NODE" -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ] || { echo "node 20 以上が要ります（何も変えていません）" >&2; exit 2; }
listening() { LISTEN="$(ss -lnt)"; awk '{print $4}' <<<"$LISTEN" | grep -E "$1" >/dev/null; }
pids() { for s in $WATCHED; do printf '%s=%s ' "$s" "$(systemctl show -p MainPID --value "$s" 2>/dev/null || echo none)"; done; }
BEFORE="$(pids)"

if ! systemctl is-active --quiet "$UNIT" && listening "[:.]$PORT$"; then
  echo "port $PORT は使われています。HEARTBEAT_PORT で別の番号を指定してください（何も変えていません）" >&2
  exit 1
fi

id edl-heartbeat >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin edl-heartbeat
install -d -m 0755 /opt/e-nexus-heartbeat
install -m 0644 "$HERE/receiver.mjs" /opt/e-nexus-heartbeat/receiver.mjs
[ -d /etc/e-nexus ] || install -d -m 0755 /etc/e-nexus

if [ ! -f "$ENV_FILE" ]; then
  [ -t 0 ] || { echo "端末で実行してください（ssh は -t を付ける。URL を画面に出さないため）" >&2; exit 2; }
  echo "監視の専用チャンネルの Discord Webhook の URL を貼ってください（Mac の Webhook とは別のものを推奨。表示しません）"
  read -r -s -p "URL: " url; echo
  [[ "$url" =~ ^https://discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$ ]] || { echo "Discord の Webhook の URL の形ではありません（何も書いていません）" >&2; exit 1; }
  token="$(openssl rand -hex 32)"
  ( umask 077; printf 'HEARTBEAT_TOKEN=%s\nDISCORD_WEBHOOK_URL=%s\nHEARTBEAT_PORT=%s\n' "$token" "$url" "$PORT" > "$ENV_FILE" )
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"  # 読むのは systemd（PID 1）
  unset url
  echo
  echo "Mac の Keychain へ入れる token（この画面にだけ出します。Mac の connect-heartbeat.sh の入力に貼ってください）："
  echo "$token"
  unset token
  echo
fi

( set -a; . "$ENV_FILE"; set +a; "$NODE" /opt/e-nexus-heartbeat/receiver.mjs --delivery-test ) || { echo "NG：Discord へ送れません。URL を確かめ、$ENV_FILE を消してやり直してください（service は変えていません）" >&2; exit 1; }
install -m 0644 "$HERE/e-nexus-heartbeat.service" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT" || { echo "NG：$UNIT が動いていません。journalctl -u $UNIT を確かめてください" >&2; exit 1; }
listening "^127\.0\.0\.1:$PORT$" || { echo "NG：loopback 以外で待っているか、待っていません" >&2; exit 1; }
AFTER="$(pids)"
[ "$BEFORE" = "$AFTER" ] || { echo "NG：既存の service の PID が変わりました：$BEFORE → $AFTER" >&2; exit 1; }
echo "OK：127.0.0.1:$PORT で動いています。既存の service は変わっていません。次は README の Cloudflare の手順へ"
