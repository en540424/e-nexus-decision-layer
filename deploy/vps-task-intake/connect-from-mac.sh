#!/bin/bash
# Mac から VPS の 1 回の保守を行う（2026-11-11・MA-24）。**実行は Human**（ssh を始めるのは Human・Mac の Terminal で）。
#
#   bash deploy/vps-task-intake/connect-from-mac.sh --ssh <user@host> [--identity <鍵の file>] --public-url https://<足した hostname> \
#        [--heartbeat] [--intake] [--source grok-commander --intents status.query,task.status,report.morning,note.record]
#
# すること（docs/vps-maintenance.md の A・B を 1 回に）：
#   1. この clone から受け口・heartbeat の受け側の file を VPS の ~/task-intake-src へ写す（tar を ssh の標準入力で）
#   2. VPS で deploy/vps-task-intake/vps-apply.sh を root で（ssh -t・sudo の password はここで 1 回）
#   3. VPS の受け渡しの file（channel の鍵・bot の鍵）を ssh で読み、Mac の Keychain へ `security -i` の標準入力で入れ、VPS から消す
#      （鍵は画面・引数・Mac の file に出ない）。--public-url を E-NEXUS/edl/task-intake-url へ
#   4. 結果の要約だけを出す。ssh は 1 本の接続を使い回す（ControlMaster。鍵の passphrase は 1 回）
#
# Keychain に入れる名前（account は e-nexus）：
#   E-NEXUS/edl/task-intake-vps-intake        channel の鍵（新しく作られた時だけ）
#   E-NEXUS/edl/task-intake-url               --public-url
#   E-NEXUS/edl/task-intake-bot-<source>      bot の Bearer 鍵（Grok Bot の画面へ貼る時は下の pbcopy を Human が行う）
# 変えないもの：VPS の既存の service・cloudflared の設定・firewall。Cloudflare の hostname・WAF は Human が画面で足す（deploy/cloudflare-task-intake）。
set -euo pipefail
cd "$(dirname "$0")/../.."
[ "$(uname -s)" = Darwin ] || { echo "macOS だけ" >&2; exit 2; }
[ -t 0 ] || { echo "Mac の Terminal で実行してください（sudo の password の入力があります）" >&2; exit 2; }

target=; identity=; public_url=; flags=(); source_id=; intents=
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh) target="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --public-url) public_url="${2:-}"; shift 2 ;;
    --heartbeat) flags+=(--heartbeat); shift ;;
    --intake) flags+=(--intake); shift ;;
    --source) source_id="${2:-}"; shift 2 ;;
    --intents) intents="${2:-}"; shift 2 ;;
    *) echo "知らない引数：$1" >&2; exit 2 ;;
  esac
done
[[ "$target" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*$|^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "--ssh <user@host> が要ります" >&2; exit 2; }
[ -z "$identity" ] || [ -f "$identity" ] || { echo "--identity の file が無い" >&2; exit 2; }
[ ${#flags[@]} -gt 0 ] || [ -n "$source_id" ] || { echo "--heartbeat・--intake・--source のどれかが要ります" >&2; exit 2; }
[ -z "$source_id" ] || [[ "$source_id" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || { echo "--source の形" >&2; exit 2; }
[ -z "$source_id" ] || [ -n "$intents" ] || { echo "--source には --intents が要ります（無いと VPS 側で全部の intent を通す）" >&2; exit 2; }
[ -z "$intents" ] || [[ "$intents" =~ ^[a-z0-9][a-z0-9.*-]*(,[a-z0-9][a-z0-9.*-]*){0,30}$ ]] || { echo "--intents の形" >&2; exit 2; }
if [ -n "$public_url" ]; then
  [[ "$public_url" =~ ^https://[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "--public-url は https://<hostname>（path なし・小文字）" >&2; exit 2; }
fi

for f in deploy/vps-task-intake/vps-apply.sh deploy/vps-task-intake/install.sh deploy/vps-task-intake/intake.mjs deploy/vps-task-intake/e-nexus-task-intake.service scripts/lib/task-hub/wire.mjs deploy/vps-heartbeat/receiver.mjs; do
  [ -f "$f" ] || { echo "NG この clone に $f が無い" >&2; exit 1; }
done
# 写すのは commit 済みの版だけ（手元の未 commit の変更を VPS に入れない）
if [ -n "$(git status --porcelain -- deploy/vps-task-intake deploy/vps-heartbeat scripts/lib/task-hub/wire.mjs)" ]; then
  echo "NG 写す file に commit していない変更があります（git status を見て Claude Code に伝えてください）" >&2; exit 1
fi

CM_DIR="$(mktemp -d /tmp/edl-cm.XXXXXX)"
trap 'ssh -o ControlPath="$CM_DIR/cm" -O exit "$target" >/dev/null 2>&1 || true; rm -rf "$CM_DIR"' EXIT
SSH=(ssh -o ControlMaster=auto -o ControlPath="$CM_DIR/cm" -o ControlPersist=300 -o ConnectTimeout=20 -o ServerAliveInterval=15)
[ -z "$identity" ] || SSH+=(-i "$identity" -o IdentitiesOnly=yes)

echo "1/4 VPS へ写す（$(git log -1 --format=%h) の版）"
COPYFILE_DISABLE=1 tar czf - deploy/vps-task-intake deploy/vps-heartbeat scripts/lib/task-hub/wire.mjs \
  | "${SSH[@]}" "$target" 'rm -rf task-intake-src && mkdir -p task-intake-src && tar xzf - -C task-intake-src'

echo "2/4 VPS で保守（sudo の password を聞かれたら VPS の password）"
remote_args=(${flags[@]+"${flags[@]}"})
[ -z "$source_id" ] || remote_args+=(--source "$source_id" --intents "$intents")
q="$(printf '%q ' "${remote_args[@]}")"
"${SSH[@]}" -t "$target" "if [ \"\$(id -u)\" = 0 ]; then bash task-intake-src/deploy/vps-task-intake/vps-apply.sh $q; else sudo bash task-intake-src/deploy/vps-task-intake/vps-apply.sh --handoff-owner \"\$(id -un)\" $q; fi" \
  || { echo "NG VPS の保守が失敗しました（上の NG の行を Claude Code に伝えてください）。途中で作られた鍵は VPS の受け渡しの file に残してあり、直した後に同じコマンドをもう一度実行すれば取ります" >&2; exit 1; }

echo "3/4 鍵を Mac の Keychain へ（画面に出しません）"
store() { # $1=service  stdin=値。入れた後に読み直して同じ値の時だけ 0（値は表示しない）
  local v got; IFS= read -r v || true
  [[ "$v" =~ ^(etk_)?[0-9a-f]{64,}$|^https:// ]] || { echo "NG $1 の値の形が違う（入れていません）" >&2; return 1; }
  printf 'add-generic-password -U -s %s -a e-nexus -l %s -w %s\n' "$1" "$1" "$v" | /usr/bin/security -i >/dev/null
  got="$(/usr/bin/security find-generic-password -s "$1" -a e-nexus -w 2>/dev/null || true)"
  if [ -n "$got" ] && [ "$got" = "$v" ]; then v=; got=; echo "stored: $1"; return 0; fi
  v=; got=; echo "NG $1 を Keychain に入れられませんでした（VPS の file は消していません。Keychain の解錠を確かめてもう一度）" >&2; return 1
}
take() { # VPS の handoff の file を読む（消さない。無ければ空）
  "${SSH[@]}" "$target" "f=\"\$HOME/.e-nexus-handoff/$1\"; [ ! -f \"\$f\" ] || [ -L \"\$f\" ] || cat \"\$f\""
}
drop() { # Keychain に入ったのを確かめた後だけ VPS の file を消す
  "${SSH[@]}" "$target" "rm -f \"\$HOME/.e-nexus-handoff/$1\""
}
bad=0
ch="$(take channel.key)"
if [ -n "$ch" ]; then printf '%s\n' "$ch" | store E-NEXUS/edl/task-intake-vps-intake && drop channel.key || bad=1; else echo "channel の鍵：新しく作られていない（前の Keychain の値を使う）"; fi
ch=
if [ -n "$source_id" ]; then
  bk="$(take "bot-$source_id.key")"
  if [ -n "$bk" ]; then printf '%s\n' "$bk" | store "E-NEXUS/edl/task-intake-bot-$source_id" && drop "bot-$source_id.key" || bad=1; else echo "bot の鍵：$source_id は登録済み（作り直していない）"; fi
  bk=
fi
[ -z "$public_url" ] || printf '%s\n' "$public_url" | store E-NEXUS/edl/task-intake-url || bad=1
"${SSH[@]}" "$target" 'rmdir "$HOME/.e-nexus-handoff" 2>/dev/null; ls -A "$HOME/.e-nexus-handoff" 2>/dev/null | wc -l' | { read -r n; [ "${n:-0}" = 0 ] || echo "WARN VPS の ~/.e-nexus-handoff に file が残っています（消してください）"; }

echo "4/4 Mac の状態"
bash deploy/macos/keychain-edl.sh status task-intake-url task-intake-vps-intake ${source_id:+task-intake-bot-$source_id}
echo
echo "次（Human）：Cloudflare に hostname と WAF を足す → Grok Bot の MCP に登録（deploy/cloudflare-task-intake/README.md・docs/vps-maintenance.md）"
[ -z "$source_id" ] || echo "  Bot の鍵を貼る時：/usr/bin/security find-generic-password -s E-NEXUS/edl/task-intake-bot-$source_id -a e-nexus -w | pbcopy  （貼ったら何か別の文字を copy して clipboard を上書き）"
[ "$bad" = 0 ] || { echo "RESULT NG（Keychain に入らなかった鍵がある。VPS の受け渡しの file は残してあるので、同じコマンドをもう一度）" >&2; exit 1; }
echo "RESULT OK"
