#!/bin/bash
# VPS の 1 回の保守（2026-11-11・MA-24）。**Mac の connect-from-mac.sh が ssh で呼ぶ**（root。Human が ssh を始める）。単独でも動く。
#   bash vps-apply.sh [--heartbeat] [--intake] [--source <id> --intents <a.b,c.d> [--businesses <b1,b2>]] [--handoff-dir <dir>] [--handoff-owner <user>]
#   --businesses その bot が出せる business（2026-11-13・Mac の config と 2 重）。登録済みの bot は intents・businesses だけ替える（鍵は作り直さない）。
#                省くと今の businesses のまま（制限を黙って外さない）。外す時だけ --businesses all
#
#   --heartbeat  生存信号の受け側（/opt/e-nexus-heartbeat/receiver.mjs）を同梱の版へ入れ替える。同じなら何もしない。
#                前の版と state を /var/lib/e-nexus-maint/<時刻>/ へ写し、再起動の後に active・listening でなければ自動で前の版へ戻す。
#   --intake     Task Hub の受け口を入れる（install.sh。何度流しても同じ）。新しい channel の鍵は handoff の file へ（画面に出さない）
#   --source     bot の Bearer 鍵を作る（既にあれば作り直さない＝Mac の Keychain の鍵がそのまま使える）。鍵は handoff の file へ
#   --handoff-dir  鍵を書くフォルダ（既定：ssh した user の home の .e-nexus-handoff）。0700・owner は --handoff-owner。Mac が取って消す
#
# 変えないもの：既存の service（n8n・Twilio 系・cloudflared・tailscaled・docker・Product Hub）・cloudflared の設定・firewall・package。
# 既存の service の PID を前後で比べ、変わっていれば NG と言う。一括の再起動はしない（再起動するのは e-nexus-heartbeat と e-nexus-task-intake だけ）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "NG root で実行してください" >&2; exit 2; }

do_hb=0; do_intake=0; source_id=; intents=; businesses=; handoff_dir=; handoff_owner="${SUDO_USER:-root}"
while [ $# -gt 0 ]; do
  case "$1" in
    --heartbeat) do_hb=1; shift ;;
    --intake) do_intake=1; shift ;;
    --source) source_id="${2:-}"; shift 2 ;;
    --intents) intents="${2:-}"; shift 2 ;;
    --businesses) businesses="${2:-}"; shift 2 ;;
    --handoff-dir) handoff_dir="${2:-}"; shift 2 ;;
    --handoff-owner) handoff_owner="${2:-}"; shift 2 ;;
    *) echo "NG 知らない引数：$1" >&2; exit 2 ;;
  esac
done
[ -z "$source_id" ] || [[ "$source_id" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "NG --source の形" >&2; exit 2; }
[ -z "$source_id" ] || [ -n "$intents" ] || { echo "NG --source には --intents が要ります（無いと VPS 側で全部の intent を通す）" >&2; exit 2; }
[ -z "$intents" ] || [[ "$intents" =~ ^[a-z0-9][a-z0-9.*-]*(,[a-z0-9][a-z0-9.*-]*){0,30}$ ]] || { echo "NG --intents の形" >&2; exit 2; }
[ -z "$businesses" ] || [ "$businesses" = all ] || [[ "$businesses" =~ ^[a-z0-9][a-z0-9-]{0,62}(,[a-z0-9][a-z0-9-]{0,62}){0,19}$ ]] || { echo "NG --businesses の形" >&2; exit 2; }
id "$handoff_owner" >/dev/null 2>&1 || { echo "NG --handoff-owner の user が無い" >&2; exit 2; }
owner_home="$(getent passwd "$handoff_owner" | cut -d: -f6)"
handoff_dir="${handoff_dir:-$owner_home/.e-nexus-handoff}"

WATCHED="en-product-hub audio-processor cloudflared tailscaled docker"
pids() { for s in $WATCHED; do printf '%s=%s ' "$s" "$(systemctl show -p MainPID --value "$s" 2>/dev/null || echo none)"; done; }
# 動いている container の名前と起動時刻（n8n など。再起動すれば StartedAt が変わる）
containers() { if command -v docker >/dev/null; then ids="$(docker ps -q 2>/dev/null || true)"; [ -z "$ids" ] || docker inspect -f '{{.Name}}={{.State.StartedAt}}' $ids 2>/dev/null | sort | tr '\n' ' '; fi; true; }
BEFORE="$(pids)"; BEFORE_C="$(containers)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MAINT="/var/lib/e-nexus-maint/$STAMP"

if [ "$do_intake" = 1 ] || [ -n "$source_id" ]; then
  # 受け渡しの場所（symlink はたどらない・root が他人の場所へ書かない）
  [ ! -L "$handoff_dir" ] || { echo "NG $handoff_dir が symlink" >&2; exit 1; }
  install -d -m 0700 -o "$handoff_owner" "$handoff_dir"
  [ "$(stat -c %U "$handoff_dir")" = "$handoff_owner" ] && [ ! -L "$handoff_dir" ] || { echo "NG $handoff_dir の持ち主" >&2; exit 1; }
fi

# ── A. heartbeat ─────────────────────────────────────────────
if [ "$do_hb" = 1 ]; then
  HB_UNIT=e-nexus-heartbeat
  NEW="$SRC/deploy/vps-heartbeat/receiver.mjs"
  CUR=/opt/e-nexus-heartbeat/receiver.mjs
  [ -f "$CUR" ] || { echo "NG heartbeat：$CUR が無い（入っていない VPS。何も変えていません）" >&2; exit 1; }
  if cmp -s "$NEW" "$CUR"; then
    echo "OK heartbeat：同じ版（入れ替えなし）"
  else
    install -d -m 0700 "$MAINT"
    cp -p "$CUR" "$MAINT/receiver.prev.mjs"
    [ -f /var/lib/e-nexus-heartbeat/state.json ] && cp -p /var/lib/e-nexus-heartbeat/state.json "$MAINT/state.prev.json"
    /usr/bin/node --check "$NEW" || { echo "NG heartbeat：新しい版の構文（何も変えていません）" >&2; exit 1; }
    # 起きたか：active で、再起動の後の journal に listening が出て、8 秒後も同じ pid で active（すぐ落ちる版を通さない）
    started_ok() { # $1=journal の起点
      local log pid
      sleep 3
      systemctl is-active --quiet "$HB_UNIT" || return 1
      pid="$(systemctl show -p MainPID --value "$HB_UNIT")"
      sleep 5
      systemctl is-active --quiet "$HB_UNIT" || return 1
      [ "$(systemctl show -p MainPID --value "$HB_UNIT")" = "$pid" ] || return 1
      log="$(journalctl -u "$HB_UNIT" --since "$1" --no-pager -o cat 2>/dev/null || true)"  # pipe の途中で grep が抜けて SIGPIPE にならないよう先に取る
      case "$log" in *listening*) return 0 ;; *) return 1 ;; esac
    }
    since="@$(date +%s)"
    install -m 0644 "$NEW" "$CUR"
    systemctl restart "$HB_UNIT"
    if started_ok "$since"; then
      echo "OK heartbeat：入れ替えて動いています（前の版：$MAINT）"
    else
      systemctl stop "$HB_UNIT" || true
      install -m 0644 "$MAINT/receiver.prev.mjs" "$CUR"
      [ ! -f "$MAINT/state.prev.json" ] || cp -p "$MAINT/state.prev.json" /var/lib/e-nexus-heartbeat/state.json  # cp -p で持ち主・mode も前のまま
      since="@$(date +%s)"
      systemctl start "$HB_UNIT"
      if started_ok "$since"; then
        echo "NG heartbeat：新しい版が起きなかったので前の版と state へ戻しました（前の版は動いています）" >&2
      else
        echo "NG heartbeat：前の版へ戻しましたが動いていません（systemctl status $HB_UNIT を Claude Code に伝えてください）" >&2
      fi
      exit 1
    fi
  fi
fi

# ── B. task intake ───────────────────────────────────────────
if [ "$do_intake" = 1 ]; then
  ch_out="$handoff_dir/channel.key"
  # 受け口がまだ無い時だけ前の受け渡しの file を消す（前の回が途中で止まり、Mac がまだ取っていない鍵を消さない）
  [ -f /etc/e-nexus/task-intake.env ] || rm -f "$ch_out"
  TASK_INTAKE_KEY_OUT="$ch_out" bash "$SRC/deploy/vps-task-intake/install.sh"
  [ -f "$ch_out" ] && chown "$handoff_owner" "$ch_out" && chmod 0600 "$ch_out"
  [ -f "$ch_out" ] && echo "OK intake：channel の鍵は受け渡しの file にある（Mac が取る）" || echo "OK intake：channel の鍵は前からある（新しく作っていない＝Mac の Keychain の鍵をそのまま使う）"
fi
if [ -n "$source_id" ]; then
  SOURCES_FILE=/etc/e-nexus/task-intake-sources.json
  [ -f "$SOURCES_FILE" ] || { echo "NG source：受け口が入っていない（--intake を先に）" >&2; exit 1; }
  # 入っている受け口が同梱の版と同じ時だけ（古い版は TASK_INTAKE_KEY_OUT を知らず、鍵を画面に出す）
  cmp -s "$SRC/deploy/vps-task-intake/intake.mjs" /opt/e-nexus-task-intake/deploy/vps-task-intake/intake.mjs || { echo "NG source：入っている受け口が古い版（--intake も付けて入れ直す。鍵は作っていません）" >&2; exit 1; }
  if /usr/bin/node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Object.hasOwn(j,process.argv[2])?0:1)' "$SOURCES_FILE" "$source_id"; then
    echo "OK source：$source_id は登録済み（鍵は作り直さない。前の回の受け渡しの file があれば Mac が取る。替える時は install.sh remove-source $source_id の後にもう一度）"
    # intents・businesses は今の指定に揃える（鍵は変えない・2026-11-13）
    bash "$SRC/deploy/vps-task-intake/install.sh" set-scope "$source_id" "$intents" "${businesses:-keep}" | sed 's/^/OK source：/'
  else
    bot_out="$handoff_dir/bot-$source_id.key"
    rm -f "$bot_out"  # source が無い＝この file は無効（前の回の残り）
    TASK_INTAKE_KEY_OUT="$bot_out" bash "$SRC/deploy/vps-task-intake/install.sh" add-source "$source_id" "$intents" "${businesses:-keep}"
    chown "$handoff_owner" "$bot_out" && chmod 0600 "$bot_out"
  fi
fi

AFTER="$(pids)"; AFTER_C="$(containers)"
[ "$BEFORE" = "$AFTER" ] || { echo "NG 既存の service の PID が変わりました：$BEFORE → $AFTER" >&2; exit 1; }
[ "$BEFORE_C" = "$AFTER_C" ] || { echo "NG container の一覧が変わりました" >&2; exit 1; }
echo "OK 既存の service と container は変わっていません"
if [ "$do_intake" = 1 ] || [ -n "$source_id" ]; then
  port="$(sed -n 's/^TASK_INTAKE_PORT=//p' /etc/e-nexus/task-intake.env)"
  c1="$(curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "http://127.0.0.1:$port/mcp" || true)"
  c2="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$port/" || true)"
  echo "check intake：鍵なし POST /mcp=$c1（401 が正）・GET /=$c2（404 が正）・port=$port"
  [ "$c1" = 401 ] && [ "$c2" = 404 ] || { echo "NG intake の応答" >&2; exit 1; }
fi
echo "RESULT OK"
