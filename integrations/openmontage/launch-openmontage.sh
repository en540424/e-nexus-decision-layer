#!/usr/bin/env sh
# E-NEXUS OpenMontage Launcher (macOS / Linux). Mac mini などで同じ入口を使う。
#   初回だけ:  ./launch-openmontage.sh init --openmontage-root <OpenMontage cloneのパス>
#   以後:      ./launch-openmontage.sh          # OpenMontage + 監視 + Decision Gateway
#              ./launch-openmontage.sh watch    # 監視だけ（常駐・agent は別起動）
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python)"
exec "$PY" "$HERE/enexus_openmontage_launcher.py" "$@"
