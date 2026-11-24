#!/bin/sh
# dev-session の runner（screen の中で動く・2026-11-23・docs/dev-session.md）。
# usage: dev-session-runner.sh <session dir> <history.jsonl> <name> <run> <command...>
# command を実行し、終わったら終了コードと時刻を exit.json と history.jsonl に残す。name と run は呼び出し側が形を確かめた物だけ（[a-z0-9-]）。
dir=$1; hist=$2; name=$3; run=$4; shift 4
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
printf '{"pid":%d,"at":"%s"}\n' "$$" "$(now)" > "$dir/run.json.tmp" && mv "$dir/run.json.tmp" "$dir/run.json"
"$@"
code=$?
at=$(now)
printf '{"code":%d,"at":"%s"}\n' "$code" "$at" > "$dir/exit.json.tmp" && mv "$dir/exit.json.tmp" "$dir/exit.json"
printf '{"at":"%s","event":"exit","name":"%s","run":"%s","code":%d}\n' "$at" "$name" "$run" "$code" >> "$hist"
exit "$code"
