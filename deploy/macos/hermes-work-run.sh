#!/bin/sh
# Hermes に承認済みの依頼を 1 件だけ渡して処理させる（2026-11-11・2026-11-13 に scripts/hermes-work.mjs へ移した・MA-24・docs/hermes-work.md §11）。**実行は Human**（sudo の password と承認の確認コード）。
#   sh deploy/macos/hermes-work-run.sh [--paid-ok] [--task <id> --retry] [--no-approve]
# 1. 承認待ちの hermes.task を全文で見せて、確認コードで承認（空 Enter で飛ばす）→ 2. Hermes の inbox へ渡す → 3. --paid-ok が無ければ課金の前で止まる
# 4. 課金なしの確かめ（sandbox の規則・無効な鍵での起動）→ 5. sandbox の中で hermes -z を 1 回（120 秒）→ 結果の取り込み → 依頼元へ返す
[ "$(id -u)" -ne 0 ] || { echo "sudo を付けずに実行する（中で hermes の分だけ sudo する）" >&2; exit 2; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node || echo /opt/homebrew/bin/node)
exec "$NODE" "$REPO/scripts/hermes-work.mjs" run "$@"
