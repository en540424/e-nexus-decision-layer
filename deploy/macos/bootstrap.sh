#!/bin/sh
# E-NEXUS Mac mini の repo 配置（2026-09-29・Human Last-Mile Activation）。何度実行しても同じ結果になる（冪等）。
#
#   sh deploy/macos/bootstrap.sh --base <repo を並べる親フォルダの絶対パス> --owner <GitHub owner> [--bundle-dir <dir>] [--no-install] [--dry-run]
#
# やること：
#   1. deploy/macos/repos.conf の repo のうち、--base に無いものだけを clone する
#      （github＝https://github.com/<owner>/<name>.git・認証は gh／git の credential helper＝Human のログイン／bundle＝<bundle-dir>/<name>.bundle）
#   2. package-lock.json があり node_modules が無い repo で `npm ci`（--no-install で省略）
#   3. 次の手順を表示する（doctor → Keychain → validate → 常駐）
# やらないこと：既にある repo の pull・reset・checkout（手元の変更を消さない）／Secret の登録／LaunchAgent の登録／config.json の作成。
# 実機依存の値（--base・--owner）は引数で受け取り、推測で埋めない（MA-22 §9）。
set -eu

BASE=''; OWNER=''; BUNDLE_DIR=''; INSTALL=1; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$BASE" in /*|[A-Za-z]:/*) ;; *) echo "--base must be an absolute path" >&2; exit 2 ;; esac
case "$OWNER" in ''|*[!A-Za-z0-9-]*) echo "--owner must be a GitHub owner name ([A-Za-z0-9-])" >&2; exit 2 ;; esac
[ -d "$BASE" ] || { echo "--base $BASE does not exist (create it first)" >&2; exit 2; }

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
has_deps() { node -e 'const p=require(process.argv[1]);process.exit(["dependencies","devDependencies","optionalDependencies"].some((k)=>p[k]&&Object.keys(p[k]).length)?0:1)' "$1/package.json" 2>/dev/null; }
run() {
  if [ "$DRY" -eq 1 ]; then echo "[dry-run] $*"; else "$@"; fi
}

status=0
for line in $(grep -v '^[[:space:]]*#' "$HERE/repos.conf" | grep -v '^[[:space:]]*$' | tr -d ' \r'); do
  name=$(echo "$line" | cut -d'|' -f1)
  source=$(echo "$line" | cut -d'|' -f2)
  d="$BASE/$name"
  if [ -d "$d/.git" ]; then
    dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$dirty" -gt 0 ]; then echo "exists: $name（触らない・未commit／未checkout が $dirty 件。clone が途中で失敗した可能性：doctor.sh で確認）"; else echo "exists: $name（触らない）"; fi
  else
    case "$source" in
      github)
        run git clone "https://github.com/$OWNER/$name.git" "$d" || { echo "clone failed: $name（認証〈gh auth login は Human〉・network・path の長さを確認。途中まで作られた $d は確認してから Human が消す）" >&2; status=1; continue; }
        ;;
      bundle)
        b="$BUNDLE_DIR/$name.bundle"
        if [ -z "$BUNDLE_DIR" ] || [ ! -f "$b" ]; then
          echo "skip: $name — bundle が無い（Windows 側で deploy/macos/make-bundles.sh を実行し、$name.bundle を --bundle-dir へ運ぶ）" >&2
          status=1
          continue
        fi
        run git bundle verify "$b" >/dev/null
        run git clone "$b" "$d"
        # bundle の path を remote に残さない（remote の無い repo として扱う：managed-repos の登録どおり）
        run git -C "$d" remote remove origin
        ;;
      *) echo "unknown source for $name: $source" >&2; status=1; continue ;;
    esac
  fi
  if [ "$INSTALL" -eq 1 ] && [ -f "$d/package-lock.json" ] && [ ! -d "$d/node_modules" ] && has_deps "$d"; then
    (cd "$d" && run npm ci) || { echo "npm ci failed: $name" >&2; status=1; }
  fi
done

cat <<EOF
---
次の手順（MA-22 ランブック §9-2・$HERE/MIGRATION.md）：
  1. sh $HERE/doctor.sh --base $BASE                       前提と repo の確認（READ-ONLY）
  2. en-generate-hub: bash scripts/secret-migrate.sh set fal / set wavespeed   有料鍵を Keychain へ（Human・TTY）
     → bash scripts/secret-boundary-probe.sh が exit 0
  3. （使うときだけ）bash $HERE/keychain-edl.sh set <name>   Decision Layer 用 Secret（Human・TTY）
  4. sh $HERE/validate.sh --base $BASE                       全 repo の test と境界の確認
  5. OpenMontage watcher の常駐：python3 integrations/openmontage/enexus_openmontage_autostart.py install（Human・GUI ログイン中）
EOF
exit "$status"
