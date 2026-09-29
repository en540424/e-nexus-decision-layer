#!/bin/bash
# Decision Layer 用 Secret（E-NEXUS/edl/*）の macOS Keychain 登録（2026-09-29・Human Last-Mile Activation）。**実行は Human**。
# en-generate-hub の scripts/secret-migrate.sh（有料 provider 鍵）と同じ形。値は表示しない（present／absent だけ）。
#
# 置き場所（読む側と同じ規約：scripts/lib/env-file.mjs の readCredential）：
#   login Keychain の generic password・service＝E-NEXUS/edl/<name>・account＝e-nexus
# env file（scripts/run-gateway.mjs）からは `NAME=credential:E-NEXUS/edl/<name>` で参照する。
# 値はマスクされたプロンプト（`security add-generic-password -w`）でだけ入力する。引数・環境変数・ファイルでは受けない。
#
#   bash deploy/macos/keychain-edl.sh status [<name>...]   既定の名前（下の KNOWN）または指定の名前の有無
#   bash deploy/macos/keychain-edl.sh set <name>           TTY で値を 2 回入力（新規・ローテーション）
#   bash deploy/macos/keychain-edl.sh delete <name>        名前をもう一度入力して確認してから削除
#
# name は [a-z0-9-]{1,64}（EDL_CREDENTIAL_PATTERN と同じ）。例：gateway-token-staging・jev-key-staging・llm-anthropic・digest-webhook。
# どの名前を作るか（環境ごとの token・Jev 鍵の置き場）は Human の判断（MA-22 ランブック §9-2 の 4）。
set -euo pipefail

ACCOUNT="e-nexus"
KNOWN="gateway-token-staging gateway-token-production jev-key-staging jev-key-production llm-anthropic digest-webhook"

valid_name() {
  [[ "$1" =~ ^[a-z0-9-]{1,64}$ ]]
}
target_of() {
  valid_name "$1" || { echo "invalid name: '$1'（[a-z0-9-]{1,64}）" >&2; return 2; }
  echo "E-NEXUS/edl/$1"
}
in_keychain() {
  /usr/bin/security find-generic-password -s "$1" -a "$ACCOUNT" >/dev/null 2>&1
}

[ "$(uname -s)" = Darwin ] || { echo "macOS only（Windows は資格情報マネージャー：docs/deploy-production-gateway.md）" >&2; exit 2; }

action="${1:-status}"
case "$action" in
  status)
    shift || true
    names="${*:-$KNOWN}"
    for n in $names; do
      t="$(target_of "$n")"
      if in_keychain "$t"; then echo "$t: present"; else echo "$t: absent"; fi
    done
    ;;
  set)
    n="${2:-}"; t="$(target_of "$n")"
    [ -t 0 ] || { echo "set needs an interactive terminal (masked prompt)" >&2; exit 2; }
    echo "Type the value for $t at the masked prompt (twice). It is not echoed and not stored in history."
    /usr/bin/security add-generic-password -U -s "$t" -a "$ACCOUNT" -l "$t" -w
    in_keychain "$t" && echo "$t: stored in the Keychain"
    ;;
  delete)
    n="${2:-}"; t="$(target_of "$n")"
    [ -t 0 ] || { echo "delete needs an interactive terminal" >&2; exit 2; }
    in_keychain "$t" || { echo "$t: absent; nothing to delete"; exit 0; }
    read -r -p "Type the name ($n) to delete $t from the Keychain: " confirm
    [ "$confirm" = "$n" ] || { echo "not confirmed; nothing deleted" >&2; exit 1; }
    /usr/bin/security delete-generic-password -s "$t" -a "$ACCOUNT" >/dev/null
    echo "$t: deleted from the Keychain"
    ;;
  *)
    echo "usage: keychain-edl.sh status [<name>...] | set <name> | delete <name>" >&2
    exit 2
    ;;
esac
