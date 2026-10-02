#!/bin/sh
# E-NEXUS の配置の一括検証（2026-09-29・Human Last-Mile Activation）。課金・外部送信・Secret の読み出しなし。
# Mac mini の移行後・更新後・rollback 後に使う。Windows の Git Bash でも動く（macOS だけの項目は飛ばす）。
#
#   sh deploy/macos/validate.sh --base <repo を並べた親フォルダの絶対パス> [--gateway-url http://127.0.0.1:8787] [--skip-tests]
#
# やること：
#   1. repos.conf の各 repo で test（npm test／decision-layer は OpenMontage 連携の Python unittest も）
#   2. （macOS）en-generate-hub の secret-boundary-probe.sh（有料鍵が shell の env に無く Keychain にある＝exit 0）
#   3. （macOS）OpenMontage watcher の LaunchAgent の状態（autostart status）
#   4. （任意）常駐 Gateway の GET /health と /ready（token 不要の 2 つだけ。/v1/* は呼ばない）
# 結果は 1 行 1 項目（PASS／FAIL／SKIP）。FAIL が 1 つでもあれば exit 1。
set -u

BASE=''; GW=''; TESTS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --gateway-url) GW="${2:-}"; shift 2 ;;
    --skip-tests) TESTS=0; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$BASE" ] && [ -d "$BASE" ] || { echo "--base <existing directory> is required" >&2; exit 2; }

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOGDIR=$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/enexus-validate-$$")
mkdir -p "$LOGDIR"
FAILS=0
result() { printf '%s %s\n' "$1" "$2"; [ "$1" = FAIL ] && FAILS=$((FAILS + 1)); return 0; }
IS_MAC=0
[ "$(uname -s 2>/dev/null)" = Darwin ] && IS_MAC=1
PY=''
for c in python3 python; do command -v "$c" >/dev/null 2>&1 && { PY=$c; break; }; done

for line in $(grep -v '^[[:space:]]*#' "$HERE/repos.conf" | grep -v '^[[:space:]]*$' | tr -d ' \r'); do
  name=$(echo "$line" | cut -d'|' -f1)
  test=$(echo "$line" | cut -d'|' -f3)
  d="$BASE/$name"
  if [ ! -d "$d/.git" ]; then result FAIL "$name: missing"; continue; fi
  if [ "$TESTS" -eq 0 ] || [ "$test" = none ]; then result SKIP "$name: tests"; continue; fi
  log="$LOGDIR/$name.npm-test.log"
  if (cd "$d" && npm test >"$log" 2>&1); then
    result PASS "$name: npm test（$(grep -E '^(ℹ|#) (pass|tests)' "$log" | tr '\n' ' ' | sed 's/  */ /g')）"
  else
    result FAIL "$name: npm test（log: ${log}）"
  fi
  if [ "$test" = npm+py ]; then
    if [ -z "$PY" ]; then result FAIL "$name: python not found"; continue; fi
    log="$LOGDIR/$name.py-test.log"
    # EDL_* を外して実行する（実 Gateway・実 usage 台帳へ届かない：decision-log 2026-09-26）
    if (cd "$d/integrations/openmontage" && env -u EDL_ALLOW_NETWORK -u EDL_HOME -u JEV_API_KEY "$PY" -m unittest discover -s . -p 'test_*.py' >"$log" 2>&1); then
      result PASS "$name: openmontage unittest（$(grep -E '^(Ran [0-9]+ tests|OK)' "$log" | tr '\n' ' ' | sed 's/  */ /g')）"
    else
      result FAIL "$name: openmontage unittest（log: ${log}）"
    fi
  fi
done

if [ "$IS_MAC" -eq 1 ]; then
  if [ -f "$BASE/en-generate-hub/scripts/secret-boundary-probe.sh" ]; then
    if (cd "$BASE/en-generate-hub" && bash scripts/secret-boundary-probe.sh >"$LOGDIR/probe.log" 2>&1); then
      result PASS "paid-provider secret boundary（probe exit 0）"
    else
      result FAIL "paid-provider secret boundary（log: $LOGDIR/probe.log・present/absent だけが書かれる）"
    fi
  fi
  if [ -n "$PY" ] && [ -f "$BASE/e-nexus-decision-layer/integrations/openmontage/enexus_openmontage_autostart.py" ]; then
    (cd "$BASE/e-nexus-decision-layer" && "$PY" integrations/openmontage/enexus_openmontage_autostart.py status >"$LOGDIR/autostart.log" 2>&1)
    result PASS "openmontage watcher: autostart status（$(head -n 3 "$LOGDIR/autostart.log" | tr '\n' ' ')）"
  fi
else
  result SKIP "macOS-only checks（secret-boundary-probe.sh・LaunchAgent）"
fi

if [ -n "$GW" ]; then
  case "$GW" in http://127.0.0.1:*|http://localhost:*|https://*) ;; *) echo "--gateway-url must be https:// or loopback http" >&2; exit 2 ;; esac
  for p in health ready; do
    code=$(curl -s -o "$LOGDIR/gw-$p.json" -w '%{http_code}' --max-time 5 "$GW/$p" || echo 000)
    if [ "$code" = 200 ]; then result PASS "gateway /$p: 200"; else result FAIL "gateway /$p: $code"; fi
  done
fi

echo "---"
echo "logs: $LOGDIR"
if [ "$FAILS" -gt 0 ]; then echo "validate: $FAILS FAIL"; exit 1; fi
echo "validate: no FAIL"
exit 0
