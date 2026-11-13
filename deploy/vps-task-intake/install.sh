#!/bin/bash
# Task Hub の VPS 側の受け口を入れる（2026-11-09・MA-24）。**実行は Human**（root・VPS の上）。手順は README.md。AI は実行しない。
#   sudo bash install.sh                          入れる（何度流しても同じ結果。channel の鍵と sources は再利用）
#   sudo bash install.sh add-source <id> [intents] bot の Bearer 鍵を作る（hash だけを保存・鍵は画面に 1 回だけ）。intents は a.b,c.* のように , 区切り
#   sudo bash install.sh remove-source <id>
# 変えるもの：user edl-task-intake・/opt/e-nexus-task-intake・/etc/e-nexus/task-intake.env・/etc/e-nexus/task-intake-sources.json・/var/lib/e-nexus-task-intake・unit e-nexus-task-intake.service だけ。
# 変えないもの：既存の service・Docker・Tailscale の Serve／Funnel・cloudflared の設定・firewall・package。Cloudflare の経路（公開の入口）は Human が README の手順で足す。
# 既存の service の PID を前後で比べ、変わっていれば NG と言う。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/e-nexus/task-intake.env
SOURCES_FILE=/etc/e-nexus/task-intake-sources.json
APP=/opt/e-nexus-task-intake
SAVED_PORT="$(sed -n 's/^TASK_INTAKE_PORT=//p' "$ENV_FILE" 2>/dev/null || true)"
PORT="${TASK_INTAKE_PORT:-${SAVED_PORT:-8796}}"  # 8790〜8793 は VPS staging の候補・8795 は heartbeat なので避ける
UNIT=e-nexus-task-intake.service
WATCHED="en-product-hub audio-processor cloudflared tailscaled docker e-nexus-heartbeat"

[ "$(id -u)" = 0 ] || { echo "root で実行してください" >&2; exit 2; }
command -v systemctl >/dev/null || { echo "systemd が要ります" >&2; exit 2; }
NODE=/usr/bin/node
[ -x "$NODE" ] || { echo "$NODE がありません（既存の node を使います。入れ替えません）" >&2; exit 2; }
[ "$("$NODE" -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ] || { echo "node 20 以上が要ります（何も変えていません）" >&2; exit 2; }

if [ "${1:-}" = add-source ] || [ "${1:-}" = remove-source ]; then
  [ -f "$ENV_FILE" ] || { echo "先に install.sh（引数なし）で入れてください" >&2; exit 2; }
  [ -n "${2:-}" ] || { echo "usage: install.sh $1 <id>" >&2; exit 2; }
  CMD="--$1"
  ( set -a; . "$ENV_FILE"; set +a; "$NODE" "$APP/deploy/vps-task-intake/intake.mjs" "$CMD" "$2" ${3:+"$3"} )
  chgrp edl-task-intake "$SOURCES_FILE" && chmod 0640 "$SOURCES_FILE"
  systemctl restart "$UNIT"  # sources は起動時に読む。レート枠の数え直しだけが副作用
  echo "OK：$UNIT を再起動しました（保存済みの依頼・結果は残っています）"
  exit 0
fi

listening() { LISTEN="$(ss -lnt)"; awk '{print $4}' <<<"$LISTEN" | grep -E "$1" >/dev/null; }
pids() { for s in $WATCHED; do printf '%s=%s ' "$s" "$(systemctl show -p MainPID --value "$s" 2>/dev/null || echo none)"; done; }
BEFORE="$(pids)"

WIRE="$HERE/../../scripts/lib/task-hub/wire.mjs"
[ -f "$WIRE" ] || { echo "wire.mjs が見つかりません（README の写し方で scripts/lib/task-hub/wire.mjs も一緒に写してください）" >&2; exit 2; }

if ! systemctl is-active --quiet "$UNIT" && listening "[:.]$PORT$"; then
  echo "port $PORT は使われています。TASK_INTAKE_PORT で別の番号を指定してください（何も変えていません）" >&2
  exit 1
fi

id edl-task-intake >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin edl-task-intake
install -d -m 0755 "$APP" "$APP/deploy" "$APP/deploy/vps-task-intake" "$APP/scripts" "$APP/scripts/lib" "$APP/scripts/lib/task-hub"
install -m 0644 "$HERE/intake.mjs" "$APP/deploy/vps-task-intake/intake.mjs"
install -m 0644 "$WIRE" "$APP/scripts/lib/task-hub/wire.mjs"
[ -d /etc/e-nexus ] || install -d -m 0755 /etc/e-nexus
if [ ! -f "$SOURCES_FILE" ]; then
  ( umask 037; printf '{}\n' > "$SOURCES_FILE" )  # bot はまだ 0 件。add-source で 1 件ずつ足す
fi
chgrp edl-task-intake "$SOURCES_FILE"
chmod 0640 "$SOURCES_FILE"

if [ ! -f "$ENV_FILE" ]; then
  key="$(openssl rand -hex 32)"
  ( umask 077; printf 'TASK_INTAKE_CHANNEL_KEY=%s\nTASK_INTAKE_CHANNEL=vps-intake\nTASK_INTAKE_SOURCES=%s\nTASK_INTAKE_PORT=%s\nTASK_INTAKE_STATE=/var/lib/e-nexus-task-intake\n' "$key" "$SOURCES_FILE" "$PORT" > "$ENV_FILE" )
  chown root:root "$ENV_FILE"
  chmod 0600 "$ENV_FILE"  # 読むのは systemd（PID 1）
  if [ -n "${TASK_INTAKE_KEY_OUT:-}" ]; then
    # 2026-11-11：画面に出さず 0600 の新しい file へ（Mac の connect-from-mac.sh が取り、Keychain へ入れて消す）
    ( umask 077; set -o noclobber; printf '%s\n' "$key" > "$TASK_INTAKE_KEY_OUT" )
    echo "channel の鍵：受け渡しの file に書きました（画面には出しません）"
  else
    echo
    echo "Mac の Keychain（E-NEXUS/edl/task-intake-vps-intake）へ入れる channel の鍵（この画面にだけ出します）："
    echo "$key"
    echo
  fi
  unset key
fi

( set -a; . "$ENV_FILE"; set +a; "$NODE" "$APP/deploy/vps-task-intake/intake.mjs" --check ) || { echo "NG：env か sources の形が違います（service は変えていません）" >&2; exit 1; }
install -m 0644 "$HERE/e-nexus-task-intake.service" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT" || { echo "NG：$UNIT が動いていません。journalctl -u $UNIT を確かめてください" >&2; exit 1; }
listening "^127\.0\.0\.1:$PORT$" || { echo "NG：loopback 以外で待っているか、待っていません" >&2; exit 1; }
if command -v curl >/dev/null; then
  CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" || true)"
  [ "$CODE" = 401 ] || { echo "NG：認証なしの /mcp が 401 ではありません（$CODE）" >&2; exit 1; }
fi
AFTER="$(pids)"
[ "$BEFORE" = "$AFTER" ] || { echo "NG：既存の service の PID が変わりました：$BEFORE → $AFTER" >&2; exit 1; }
echo "OK：127.0.0.1:$PORT で動いています。既存の service は変わっていません。次は README の bot 鍵と Cloudflare の手順へ（公開の入口を足すのは Human）"
