#!/bin/sh
# remote の無い repo を Mac mini へ運ぶための git bundle を作る（2026-09-29・Human Last-Mile Activation）。READ-ONLY（repo を変更しない）。
# Windows の Git Bash でも macOS でも動く。
#
#   sh deploy/macos/make-bundles.sh --out <出力フォルダ> <repo の絶対パス>...
#
# 例：sh deploy/macos/make-bundles.sh --out <USB 等> <親フォルダ>/en-product-hub
# 出力：<out>/<repo 名>.bundle（全 branch・tag）と <out>/<repo 名>.bundle.sha256。作ったあと `git bundle verify` で確かめる。
# Mac 側では bootstrap.sh --bundle-dir <out> が clone する（remote は残さない）。
# bundle は repo の履歴そのもの（config.json・.env・data/ 等の gitignore 対象は入らない）。運ぶ経路（AirDrop・USB）は Human が選ぶ。
set -eu

OUT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    --*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
[ $# -gt 0 ] || { echo "give at least one repo path" >&2; exit 2; }
mkdir -p "$OUT"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

for repo in "$@"; do
  [ -d "$repo/.git" ] || { echo "not a git repo: $repo" >&2; exit 2; }
  name=$(basename "$repo")
  dirty=$(git -C "$repo" status --porcelain | wc -l | tr -d ' ')
  [ "$dirty" -eq 0 ] || echo "note: $name has $dirty uncommitted change(s) — bundles carry commits only" >&2
  b="$OUT/$name.bundle"
  git -C "$repo" bundle create "$(cd "$OUT" && pwd)/$name.bundle" --all
  git -C "$repo" bundle verify "$(cd "$OUT" && pwd)/$name.bundle" >/dev/null
  sha "$b" > "$b.sha256"
  echo "bundle: ${b}（HEAD $(git -C "$repo" rev-parse --short HEAD)・sha256 $(cat "$b.sha256")）"
done
