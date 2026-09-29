#!/bin/sh
# 新 3 type（automation-safety-gate・customer-reply-gate・lead-triage）の実 JEV Calibration を 1 コマンドで流す（2026-09-29・L07）。
# **課金あり（TypeSafe Direct）。Human の GO が無ければ実行しない**（MA-30 §18：run ごとに Human go）。計画と費用は
# docs/poc/calibration/2026-09-29-growth-types-calibration-plan.md。
#
#   sh scripts/run-growth-calibration.sh --go <GO を受けた日 YYYY-MM-DD> [--plan full|single] [--dry-run]
#
# plan：full  ＝ cases×5・holdout×1・adversarial×3（Jev へ最大 119 回・上限の見込み 約 0.014 USD）
#       single＝ どれも×1（最大 37 回・約 0.0042 USD）
# 前提：この shell に JEV_API_KEY・JEV_PROVIDER=direct・EDL_ALLOW_NETWORK=true（無ければ runner が exit 4 で何も送らない）。鍵は表示しない。
# 1 回でも stopped（401／402／403／422／429・連続 unavailable）が出たら、以降の run を実行しない（再課金しない）。最後に analyze を表示する。
# 結果は docs/poc/calibration/results/<stamp>-<label>.json（Secret 混入は runner が検査）。usage は data/usage/usage.jsonl。
set -eu

GO=''; PLAN=full; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO="${2:-}"; shift 2 ;;
    --plan) PLAN="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$GO" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "--go <YYYY-MM-DD> is required（Human の GO を受けた日。GO が無ければ実行しない）" >&2; exit 2 ;; esac
case "$PLAN" in full|single) ;; *) echo "--plan must be full|single" >&2; exit 2 ;; esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
DIR=docs/poc/calibration
OUTS=''

repeat_of() {
  if [ "$PLAN" = single ]; then echo 1; return; fi
  case "$1" in cases) echo 5 ;; holdout.cases) echo 1 ;; adversarial.cases) echo 3 ;; esac
}

for t in automation-safety-gate customer-reply-gate lead-triage; do
  for v in cases holdout.cases adversarial.cases; do
    f="$DIR/$t.$v.json"
    r=$(repeat_of "$v")
    label="$t-${v%.cases}-go$GO"
    [ "$v" = cases ] && label="$t-main-go$GO"
    if [ "$DRY" -eq 1 ]; then
      n=$(node scripts/poc-calibration.mjs dry-run --questions improved --cases "$f" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).jev_candidates))')
      echo "[dry-run] $label: Jev へ $n 件 × repeat $r = $((n * r)) 回"
      continue
    fi
    out="$DIR/results/$(date -u +%Y%m%dT%H%M%SZ)-$label.json"
    node scripts/poc-calibration.mjs run --questions improved --cases "$f" --repeat "$r" --label "$label" --out "$out" >/dev/null
    [ -f "$out" ] || { echo "no result for $label（exit 4＝前提の env が無い。何も送っていない）" >&2; exit 4; }
    OUTS="$OUTS $out"
    stopped=$(node -e 'const o=require(require("path").resolve(process.argv[1]));console.log(o.stopped?JSON.stringify(o.stopped):"")' "$out")
    if [ -n "$stopped" ]; then
      echo "STOPPED at $label: $stopped — 以降の run は実行しない" >&2
      break 2
    fi
    echo "done: $label → $out"
  done
done

[ "$DRY" -eq 1 ] && exit 0
# shellcheck disable=SC2086
node scripts/poc-calibration.mjs analyze $OUTS
