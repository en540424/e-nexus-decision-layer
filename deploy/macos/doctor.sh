#!/bin/sh
# E-NEXUS Mac mini の前提チェック（2026-09-29・Human Last-Mile Activation）。READ-ONLY：何もインストール・登録・変更しない。
# Secret の値は読まない・表示しない（Keychain は項目の有無だけを見る。`security find-generic-password` に -w を付けない）。
#
#   sh deploy/macos/doctor.sh --base <repo を並べた親フォルダの絶対パス> [--hermes-user <Hermes 専用ユーザー名>]
#
# 出力は 1 行 1 項目：PASS／WARN／FAIL／INFO。FAIL が 1 つでもあれば exit 1（bootstrap.sh・validate.sh の前に使う）。
# macOS 以外（Windows の Git Bash 等）でも動き、macOS でしか見られない項目は INFO「not macOS」で飛ばす。
# 判定の根拠：MA-22 ランブック §9・MA-17 §21（有料鍵は shell の env に置かず Keychain）・MA-30 §18-13（旧 Vercel 鍵）・MA-22 S1／S8・MA-24 §7（ホストの安全）。
set -u

BASE=''; HERMES_USER=''
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --hermes-user) HERMES_USER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FAILS=0
say() { printf '%s %s\n' "$1" "$2"; [ "$1" = FAIL ] && FAILS=$((FAILS + 1)); return 0; }
has() { command -v "$1" >/dev/null 2>&1; }
# package.json に依存（dependencies・devDependencies・optionalDependencies）があるか。無ければ node_modules は要らない
has_deps() { node -e 'const p=require(process.argv[1]);process.exit(["dependencies","devDependencies","optionalDependencies"].some((k)=>p[k]&&Object.keys(p[k]).length)?0:1)' "$1/package.json" 2>/dev/null; }
IS_MAC=0
[ "$(uname -s 2>/dev/null)" = Darwin ] && IS_MAC=1

# ─── OS ───
if [ "$IS_MAC" -eq 1 ]; then
  say INFO "os: macOS $(sw_vers -productVersion 2>/dev/null || echo '?') $(uname -m)"
else
  say INFO "os: not macOS ($(uname -s 2>/dev/null || echo '?')) — macOS-only checks are skipped"
fi

# ─── コマンド ───
for c in git curl; do
  if has "$c"; then say PASS "command $c"; else say FAIL "command $c: not found"; fi
done
if has node; then
  v=$(node -p 'process.versions.node' 2>/dev/null || echo 0)
  major=${v%%.*}
  if [ "${major:-0}" -ge 20 ] 2>/dev/null; then say PASS "node $v (>=20)"; else say FAIL "node $v: need >=20 (package.json engines)"; fi
else
  say FAIL "command node: not found（LaunchAgent の --node には \`command -v node\` の絶対パスを渡す）"
fi
if has npm; then say PASS "command npm"; else say FAIL "command npm: not found"; fi
PY=''
for c in python3 python; do has "$c" && { PY=$c; break; }; done
if [ -n "$PY" ]; then
  if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    say PASS "$PY $("$PY" -c 'import platform; print(platform.python_version())') (>=3.10・OpenMontage 連携)"
  else
    say FAIL "$PY: need >=3.10 (integrations/openmontage)"
  fi
else
  say FAIL "python3: not found (integrations/openmontage)"
fi
for c in gh claude; do
  if has "$c"; then say INFO "command $c: found"; else say INFO "command $c: not found（$c は任意：gh＝clone の認証、claude＝en-sns-hub の候補生成）"; fi
done
if [ "$IS_MAC" -eq 1 ]; then
  for c in security launchctl lsof; do
    if has "$c"; then say PASS "command $c"; else say FAIL "command $c: not found"; fi
  done
fi

# ─── Secret の境界（値は見ない・有無だけ）───
for n in FAL_KEY WAVESPEED_API_KEY; do
  eval "val=\${$n:-}"
  if [ -n "$val" ]; then say FAIL "env $n: present in this shell（MA-17 §21：有料鍵は shell profile から消して Keychain へ。secret-migrate.sh set）"; else say PASS "env $n: absent"; fi
done
eval "val=\${AI_GATEWAY_API_KEY:-}"
if [ -n "$val" ]; then say WARN "env AI_GATEWAY_API_KEY: present（Vercel 経路は 2026-09-29 に廃止・キーは失効済み。profile から消す）"; else say PASS "env AI_GATEWAY_API_KEY: absent"; fi
unset val
if [ "$IS_MAC" -eq 1 ]; then
  for t in E-NEXUS/paid-provider/fal E-NEXUS/paid-provider/wavespeed; do
    if security find-generic-password -s "$t" -a e-nexus >/dev/null 2>&1; then say PASS "keychain $t: present"; else say WARN "keychain $t: absent（en-generate-hub: bash scripts/secret-migrate.sh set <provider>）"; fi
  done
  for n in jev-key-staging jev-key-production gateway-token-staging gateway-token-production llm-anthropic digest-webhook; do
    t="E-NEXUS/edl/$n"
    if security find-generic-password -s "$t" -a e-nexus >/dev/null 2>&1; then say INFO "keychain $t: present"; else say INFO "keychain $t: absent（使うときだけ：bash deploy/macos/keychain-edl.sh set ${n}）"; fi
  done
fi

# ─── repo ───
if [ -z "$BASE" ]; then
  say WARN "repos: --base not given — repo checks skipped"
elif [ ! -d "$BASE" ]; then
  say FAIL "repos: base $BASE does not exist"
else
  grep -v '^[[:space:]]*#' "$HERE/repos.conf" | grep -v '^[[:space:]]*$' | while IFS='|' read -r name source test; do
    d="$BASE/$name"
    if [ ! -d "$d/.git" ]; then
      say FAIL "repo $name: missing（bootstrap.sh・source=${source}）"
      continue
    fi
    br=$(git -C "$d" branch --show-current 2>/dev/null || echo '?')
    dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    remote=$(git -C "$d" remote 2>/dev/null | head -n 1)
    ahead=''
    if [ -n "$remote" ] && git -C "$d" rev-parse --verify -q '@{u}' >/dev/null 2>&1; then
      ahead=" ahead/behind=$(git -C "$d" rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null | tr '\t' '/')（最後の fetch 時点）"
    fi
    [ -n "$remote" ] || remote='(none)'
    if [ -f "$d/package.json" ] && [ ! -d "$d/node_modules" ] && has_deps "$d"; then nm=' node_modules=missing（npm ci）'; else nm=''; fi
    say PASS "repo $name: branch=$br remote=$remote dirty=$dirty$ahead$nm"
  done
  if [ -d "$BASE/en-sns-hub" ]; then
    if [ -f "$BASE/en-sns-hub/config.json" ]; then say PASS "en-sns-hub config.json: present"; else say WARN "en-sns-hub config.json: absent（config.example.json から作る・productHubPath はこの Mac のパス）"; fi
  fi
fi
# repo の検査は while が subshell で動くため FAIL を数え直す
if [ -n "$BASE" ] && [ -d "$BASE" ]; then
  missing=$(grep -v '^[[:space:]]*#' "$HERE/repos.conf" | grep -v '^[[:space:]]*$' | while IFS='|' read -r name _s _t; do [ -d "$BASE/$name/.git" ] || echo "$name"; done | wc -l | tr -d ' ')
  FAILS=$((FAILS + missing))
fi

# ─── 常駐（LaunchAgent）と電源・暗号化（macOS のみ・判断材料として表示）───
if [ "$IS_MAC" -eq 1 ]; then
  uid=$(id -u)
  for label in com.enexus.openmontage-watcher com.e-nexus.decision-gateway.staging com.e-nexus.decision-gateway.production; do
    if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then say INFO "launchagent $label: loaded"; else say INFO "launchagent $label: not loaded"; fi
  done
  fv=$(fdesetup isactive 2>/dev/null); [ -n "$fv" ] || fv=unknown  # fdesetup isactive exits 1 when false
  say INFO "filevault: ${fv}（true なら停電・再起動の後、誰かがログインするまで LaunchAgent は起動しない＝Human の判断：MIGRATION.md §判断）"
  if defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser >/dev/null 2>&1; then say INFO "auto-login: enabled"; else say INFO "auto-login: disabled"; fi
  ar=$(pmset -g 2>/dev/null | awk '$1 == "autorestart" {print $2}')
  say INFO "power: autorestart=${ar:-unknown}（1＝停電復旧後に自動起動）"
fi

# ─── ホストの安全（macOS のみ・2026-10-21：本番の workload〈Trading Lab の VM〉と同居する Runtime Node の判断材料）───
# 読み取りだけ・sudo なし・ネットワークに出ない。Trading Lab の process・VM・パスは見ない。IP・MAC アドレス・process 名は出さない。
# ここの項目は PASS／INFO／WARN だけで FAIL は増やさない（exit code の意味を変えない）
if [ "$IS_MAC" -eq 1 ]; then
  ports=$(networksetup -listallhardwareports 2>/dev/null)
  dev=$(route -n get default 2>/dev/null | awk '$1 == "interface:" {print $2; exit}')
  if [ -n "$dev" ]; then
    kind=$(printf '%s\n' "$ports" | awk -v d="$dev" '/^Hardware Port: / {p = substr($0, 16)} $1 == "Device:" && $2 == d {print p; exit}')
    case "$kind" in
      Wi-Fi) say INFO "network: primary=${dev}（Wi-Fi。24 時間の常駐は有線を推奨）" ;;
      *) say INFO "network: primary=${dev}（${kind:-unknown}）" ;;
    esac
  else
    say WARN "network: default route なし（回線を確認）"
  fi
  eth=$(printf '%s\n' "$ports" | awk '$0 == "Hardware Port: Ethernet" {getline; print $2; exit}')
  if [ -n "$eth" ]; then
    link=$(ifconfig "$eth" 2>/dev/null | awk '$1 == "status:" {print $2; exit}')
    say INFO "network: ethernet ${eth} link=${link:-unknown}"
  fi
  FW=/usr/libexec/ApplicationFirewall/socketfilterfw
  if [ -x "$FW" ]; then
    fws=$("$FW" --getglobalstate 2>/dev/null | sed -n 's/.*(State = \([0-9]\)).*/\1/p')
    case "$fws" in 0) fw=off ;; 1) fw=on ;; 2) fw=block-all ;; *) fw=unknown ;; esac
    if "$FW" --getstealthmode 2>/dev/null | grep -q 'is on'; then sm=on; else sm=off; fi
    say INFO "firewall: ${fw} stealth=${sm}（判断待ち：MA-22 S1）"
  fi
  # 外から届く待ち受け（S1 の完了判定）。address は出さず port と範囲だけ
  ext=$(netstat -an -p tcp 2>/dev/null | awk '$6 == "LISTEN" && $4 !~ /^127\./ && $4 !~ /^::1\./ && $4 !~ /%lo0\./ {print $4}' | sort -u)
  if [ -z "$ext" ]; then
    say PASS "listen: loopback 以外で待ち受けている TCP は無い"
  else
    for addr in $ext; do
      port=${addr##*.}
      case "$addr" in \*.*) scope='すべての interface' ;; *) scope='特定の address' ;; esac
      say WARN "listen: tcp ${port}（${scope}。外から届く＝MA-22 S1：開いている理由を 1 行で書けること）"
    done
  fi
  if printf '%s\n' "$ext" | grep -q '\.22$'; then say INFO "remote-login: on（:22 で待ち受け）"; else say INFO "remote-login: off（:22 の待ち受けなし）"; fi
  pss=$(pmset -g ps 2>/dev/null)
  src=$(printf '%s\n' "$pss" | sed -n "s/^Now drawing from '\(.*\)'.*/\1/p")
  if printf '%s\n' "$pss" | grep -qi 'ups'; then say INFO "power: UPS あり（${src:-unknown}）"; else say INFO "power: UPS は認識されていない（${src:-unknown}。停電で VM・常駐が不正終了し得る）"; fi
  pm=$(pmset -g 2>/dev/null)
  pv() { printf '%s\n' "$pm" | awk -v k="$1" '$1 == k {print $2; exit}'; }
  say INFO "power: sleep=$(pv sleep) disksleep=$(pv disksleep) standby=$(pv standby) powernap=$(pv powernap)"
  sur() { defaults read /Library/Preferences/com.apple.SoftwareUpdate "$1" 2>/dev/null || echo unset; }
  ai=$(sur AutomaticallyInstallMacOSUpdates)
  if [ "$ai" = 1 ]; then
    say WARN "softwareupdate: macOS の自動インストールが有効（同居する本番 workload がある間に再起動し得る）"
  else
    say INFO "softwareupdate: auto-install=${ai} auto-download=$(sur AutomaticDownload) critical=$(sur CriticalUpdateInstall)（unset は GUI で確認）"
  fi
  freek=$(df -k / 2>/dev/null | awk 'NR == 2 {print $4}')
  if [ -n "$freek" ]; then
    freeg=$((freek / 1048576))
    if [ "$freeg" -lt 50 ]; then say WARN "disk: 起動ディスクの空き ${freeg} GiB（50 GiB 未満）"; else say INFO "disk: 起動ディスクの空き ${freeg} GiB"; fi
  fi
  mp=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)
  case "$mp" in
    1) say INFO "memory: pressure normal" ;;
    2) say WARN "memory: pressure warn" ;;
    4) say WARN "memory: pressure critical" ;;
    *) say INFO "memory: pressure unknown" ;;
  esac
  bt=$(sysctl -n kern.boottime 2>/dev/null | sed 's/^.*} //')
  say INFO "boot: ${bt:-unknown}"
  uid=$(id -u)
  for job in usage-digest rotate-logs watcher-cycle knowledge-refresh host-health; do
    label="com.e-nexus.${job}"
    if out=$(launchctl print "gui/${uid}/${label}" 2>/dev/null); then
      ec=$(printf '%s\n' "$out" | awk -F' = ' '$1 ~ /^[[:space:]]*last exit code$/ {print $2; exit}')
      case "$ec" in
        ''|0|'(never exited)') say INFO "scheduled job ${label}: loaded（last exit ${ec:-none}）" ;;
        *) say WARN "scheduled job ${label}: loaded・last exit ${ec}" ;;
      esac
    else
      say INFO "scheduled job ${label}: not loaded（登録は Human：scripts/scheduled-job-service.mjs）"
    fi
  done
  if has tailscale; then
    bs=$(tailscale status --json 2>/dev/null | sed -n 's/.*"BackendState": *"\([A-Za-z]*\)".*/\1/p' | head -n 1)
    say INFO "tailscale: installed（BackendState=${bs:-unknown}）"
  else
    say INFO "tailscale: not installed（MA-24 Q6〜Q8 の後）"
  fi
  # Hermes は専用ユーザーで動かす（同じ user だと Claude Code の資格情報と home 全体に届く：MA-24 §7-1・Hermes 公式 docs）
  if has hermes || [ -d "$HOME/.hermes" ]; then say WARN "hermes: この user に Hermes がある（MA-24 §7-1：専用ユーザーで動かす）"; else say INFO "hermes: この user には無い"; fi
  if [ -n "$HERMES_USER" ]; then
    if id "$HERMES_USER" >/dev/null 2>&1; then say INFO "hermes user ${HERMES_USER}: exists"; else say INFO "hermes user ${HERMES_USER}: not found"; fi
  fi
  # 別のローカルユーザーは主グループが staff になり、group に読める home の中へ入れる
  hm=$(stat -f '%Lp' "$HOME" 2>/dev/null)
  others=$(dscl . -list /Users UniqueID 2>/dev/null | awk -v me="$(id -un)" '$2 >= 500 && $1 != me' | wc -l | tr -d ' ')
  case "$hm" in
    700|'') say INFO "home: mode ${hm:-unknown}" ;;
    *) if [ "${others:-0}" -gt 0 ]; then say WARN "home: mode ${hm}（ほかのローカルユーザー ${others} 人が group／other の権限で読める。700 にする：MA-24 §7-1）"; else say INFO "home: mode ${hm}（ほかのローカルユーザーを作る前に 700 にする：MA-24 §7-1）"; fi ;;
  esac
fi

echo "---"
if [ "$FAILS" -gt 0 ]; then echo "doctor: $FAILS FAIL"; exit 1; fi
echo "doctor: no FAIL"
exit 0
