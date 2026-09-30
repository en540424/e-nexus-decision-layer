#!/usr/bin/env bash
# E-NEXUS VPS staging orchestrator, remote side (2026-09-30, Deployment Completion Phase).
# Uploaded and started by deploy/vps-staging/run.mjs over ssh as root (the Human starts run.mjs).
#
#   bash stage.sh preflight | install <sha> | rollback | failure | digest | postflight <sha> | status | token | uninstall --yes
#
# Changes ONLY staging things: user edl-staging, /opt/e-nexus-staging, /etc/e-nexus/gateway-staging.env,
# /var/lib/e-nexus-staging, units e-nexus-*-staging*, and one Tailscale Serve HTTPS port (tailnet only, never funnel).
# Never stops or changes other services (Product Hub, audio-processor, cloudflared, n8n, tailscaled, docker).
# Never prints secret values. No paid API: EDL_ALLOW_NETWORK and Jev keys stay out of the staging env file.
# The Gateway listens on 127.0.0.1 only; consumers reach it through Tailscale Serve HTTPS with the staging token.
# ASCII only on purpose (edited on Windows, uploaded from Windows).
set -u
umask 027
export LC_ALL=C
# If the ssh client goes away, finish the phase instead of dying half-way on a write to a closed pipe.
trap '' PIPE

INBOX=/root/e-nexus-staging-inbox
KIT=$INBOX/kit
BUNDLE=$INBOX/edl.bundle
BASE=/opt/e-nexus-staging
REPO=$BASE/e-nexus-decision-layer
ENV_DIR=/etc/e-nexus
ENV_FILE=$ENV_DIR/gateway-staging.env
STATE=/var/lib/e-nexus-staging
ST=$STATE/state
SVC_USER=edl-staging
UNIT=e-nexus-decision-gateway-staging
DIGEST=e-nexus-usage-digest-staging
GW_PORTS="8790 8791 8792 8793"
SERVE_PORTS="8446 8447 8448 8449"
RESERVED_PORTS="22 80 443 4188 5678 5679 8443 8444 8787 18789"
PROTECTED="en-product-hub audio-processor cloudflared tailscaled docker"
MEMORY_MAX=256M
MIN_MEM_MB=300
MIN_DISK_MB=2048
FAILED=0
NODE=
GP=
SP=

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILED=1; }
warn() { echo "WARN  $*"; }
info() { echo "INFO  $*"; }
abort() { echo "ABORT $*"; exit 3; }
setstate() { printf '%s\n' "$2" > "$ST/$1"; echo "STATE $1=$2"; }
getstate() { if [ -f "$ST/$1" ]; then cat "$ST/$1"; fi; }
stamp_now() { date -u +%Y%m%dT%H%M%SZ; }

# State-changing systemctl only for staging units.
sctl() {
  local verb=$1 u skip=0
  shift
  for u in "$@"; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case "$u" in
      -s|--signal) skip=1 ;;
      -*) ;;
      e-nexus-*-staging|e-nexus-*-staging.service|e-nexus-*-staging.timer) ;;
      *) abort "refusing 'systemctl $verb' on non-staging unit: $u" ;;
    esac
  done
  systemctl "$verb" "$@"
}

load_state() {
  NODE=$(getstate node_path)
  GP=$(getstate gw_port)
  SP=$(getstate serve_port)
  if [ -z "$NODE" ] || [ -z "$GP" ] || [ -z "$SP" ]; then abort "run preflight first"; fi
}

serve_lines() { tailscale serve status --json 2>/dev/null | "$NODE" "$KIT/vps-tool.mjs" serve-parse; }

secure_env_file() {
  chown root:"$SVC_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
}

snapshot() {
  local tag=$1 u id
  : > "$ST/protected.$tag"
  for u in $PROTECTED en-product-hub-backup.timer; do
    echo "$u $(systemctl show -p ActiveState -p MainPID -p ActiveEnterTimestampMonotonic --value "$u" 2>/dev/null | tr '\n' ' ')" >> "$ST/protected.$tag"
  done
  for id in $(docker ps -q --filter name=n8n 2>/dev/null); do
    echo "container $(docker inspect -f '{{.Name}} {{.State.StartedAt}}' "$id" 2>/dev/null)" >> "$ST/protected.$tag"
  done
  serve_lines > "$ST/serve.$tag" 2>/dev/null || true
  ss -H -tln | awk '{print $4}' | sed 's/.*://' | sort -u > "$ST/ports.$tag"
  {
    awk '/MemAvailable/ {print "mem_available_mb", int($2/1024)}' /proc/meminfo
    echo "load1 $(cut -d' ' -f1 /proc/loadavg)"
    echo "disk_free_mb $(df -Pm / | awk 'NR==2 {print $4}')"
    echo "processes $(ps -e --no-headers | wc -l)"
  } > "$ST/resources.$tag"
}

paid_guard() {
  if [ -f "$ENV_FILE" ]; then
    if grep -Eq '^(EDL_ALLOW_NETWORK|JEV_API_KEY|JEV_PROVIDER|ENEXUS_LLM_ANTHROPIC_API_KEY|AI_GATEWAY_API_KEY)=' "$ENV_FILE"; then
      abort "network/paid keys are present in the staging env file (staging stays network-off until a Human GO)"
    fi
    pass "staging env file has no network/paid keys"
  fi
  if [ -f "/etc/systemd/system/$UNIT.service" ]; then
    if [ -z "$(systemctl show -p Environment --value "$UNIT" 2>/dev/null)" ]; then pass "unit has no Environment="; else abort "unit $UNIT has Environment= set"; fi
  fi
}

choose_ports() {
  local gp sp p owner mainpid line
  gp=$(getstate gw_port)
  if [ -n "$gp" ]; then
    owner=$(ss -H -tlnp "( sport = :$gp )" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
    mainpid=$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
    if [ -n "$owner" ] && [ "$owner" != "$mainpid" ]; then abort "gateway port $gp is held by another process (pid $owner)"; fi
  else
    for p in $GW_PORTS; do
      if ! ss -H -tln "( sport = :$p )" 2>/dev/null | grep -q .; then gp=$p; break; fi
    done
    [ -n "$gp" ] || abort "no free gateway port in: $GW_PORTS"
  fi
  case " $RESERVED_PORTS " in *" $gp "*) abort "gateway port $gp is reserved" ;; esac
  setstate gw_port "$gp"
  pass "gateway port 127.0.0.1:$gp"

  sp=$(getstate serve_port)
  if [ -n "$sp" ]; then
    line=$(grep "^PORT $sp " "$ST/serve.before" || true)
    if [ -n "$line" ] && ! echo "$line" | grep -q " proxy=http://127.0.0.1:$gp "; then abort "serve port $sp is used by something else"; fi
  else
    for p in $SERVE_PORTS; do
      case " $RESERVED_PORTS " in *" $p "*) continue ;; esac
      if ! grep -q "^PORT $p " "$ST/serve.before"; then sp=$p; break; fi
    done
    [ -n "$sp" ] || abort "no free serve port in: $SERVE_PORTS"
  fi
  setstate serve_port "$sp"
  pass "serve port https:$sp (tailnet only)"
}

preflight() {
  local c n best major tv mem disk load cpus u
  [ "$(id -u)" = 0 ] || abort "must run as root"
  install -d -m 0750 -o root -g root "$STATE" "$ST" "$STATE/backups"
  . /etc/os-release
  if [ "${ID:-}" = ubuntu ]; then pass "os ${PRETTY_NAME:-ubuntu}"; else warn "os is not ubuntu: ${PRETTY_NAME:-unknown}"; fi
  for c in git openssl curl tailscale systemctl ss flock systemd-run docker comm cmp; do
    command -v "$c" >/dev/null 2>&1 || abort "missing tool: $c"
  done
  pass "tools present"
  best=
  for n in "$(command -v node 2>/dev/null)" /usr/bin/node /usr/local/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] || continue
    n=$(readlink -f "$n")
    case "$n" in /root/*|/home/*) continue ;; esac
    major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "${major:-0}" -ge 20 ]; then best=$n; break; fi
  done
  [ -n "$best" ] || abort "no node >= 20 outside /root and /home (installing node is a separate decision)"
  setstate node_path "$best"
  NODE=$best
  pass "node $("$best" --version) at $best"
  tv=$(tailscale version 2>/dev/null | head -1)
  if "$best" -e 'const [a,b]=String(process.argv[1]||"0.0").split(".").map(Number);process.exit(a>1||(a===1&&b>=52)?0:1)' "$tv"; then pass "tailscale $tv"; else abort "tailscale $tv is too old for 'serve --bg'"; fi
  mem=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  disk=$(df -Pm / | awk 'NR==2 {print $4}')
  load=$(cut -d' ' -f1 /proc/loadavg)
  cpus=$(nproc)
  [ "$mem" -ge "$MIN_MEM_MB" ] || abort "memory available ${mem}MB < ${MIN_MEM_MB}MB"
  pass "memory available ${mem}MB"
  [ "$disk" -ge "$MIN_DISK_MB" ] || abort "disk free ${disk}MB < ${MIN_DISK_MB}MB"
  pass "disk free ${disk}MB"
  awk -v l="$load" -v c="$cpus" 'BEGIN{exit !(l < c*2)}' || abort "load $load is too high for $cpus cpus"
  pass "load $load ($cpus cpus)"
  snapshot before
  for u in $PROTECTED; do
    [ "$(systemctl is-active "$u" 2>/dev/null)" = active ] || abort "protected service $u is not active; not touching this host"
  done
  pass "protected services active: $PROTECTED"
  if grep -q '^container ' "$ST/protected.before"; then pass "n8n container running"; else warn "n8n container not found"; fi
  choose_ports
  paid_guard
  if [ -s "$BUNDLE" ] && git bundle list-heads "$BUNDLE" >/dev/null 2>&1; then pass "bundle readable"; else abort "bundle missing or unreadable"; fi
  [ "$FAILED" = 0 ] || abort "preflight failed"
  echo "RESULT preflight PASS"
}

wait_ready() {
  local i
  for i in $(seq 1 "$1"); do
    if curl -fsS -m 2 "http://127.0.0.1:$GP/ready" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

journal_tail() { journalctl -u "$UNIT" -n 15 -o cat --no-pager 2>/dev/null | sed 's/^/INFO  journal: /'; }

write_env() {
  local sha=$1 ts tok
  if [ ! -d "$ENV_DIR" ]; then install -d -m 0755 -o root -g root "$ENV_DIR"; fi
  if [ -f "$ENV_FILE" ]; then
    ts=$(stamp_now)
    install -d -m 0700 "$STATE/backups/$ts"
    cp -p "$ENV_FILE" "$STATE/backups/$ts/"
    grep -Eq '^EDL_GATEWAY_TOKEN=[0-9a-f]{64}$' "$ENV_FILE" || abort "existing env file has no valid token line (not printing it)"
    grep -q '^EDL_ENVIRONMENT=staging$' "$ENV_FILE" || abort "existing env file is not a staging env file"
    sed -i "s/^EDL_EXPECTED_RELEASE=.*/EDL_EXPECTED_RELEASE=$sha/" "$ENV_FILE"
  else
    tok=$(openssl rand -hex 32)
    ( umask 077; printf 'EDL_ENVIRONMENT=staging\nEDL_EXPECTED_RELEASE=%s\nEDL_GATEWAY_TOKEN=%s\nEDL_GATEWAY_RATE_LIMIT_PER_MIN=600\n' "$sha" "$tok" > "$ENV_FILE" )
    tok=
    pass "env file created (token generated on this host, not shown)"
  fi
  secure_env_file
  if grep -q "^EDL_EXPECTED_RELEASE=$sha\$" "$ENV_FILE"; then pass "env file pinned to ${sha:0:12} (0640 root:$SVC_USER)"; else abort "env file update failed"; fi
}

install_unit() {
  local src=$1 name dst ts
  name=$(basename "$src")
  dst=/etc/systemd/system/$name
  case "$name" in e-nexus-*-staging.service|e-nexus-*-staging.timer) ;; *) abort "refusing to install unit $name" ;; esac
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then info "unit $name unchanged"; return 0; fi
  if [ -f "$dst" ]; then
    ts=$(stamp_now)
    install -d -m 0700 "$STATE/backups/$ts"
    cp -p "$dst" "$STATE/backups/$ts/"
  fi
  install -m 0644 -o root -g root "$src" "$dst"
  systemctl daemon-reload
  pass "unit $name installed"
}

check_version() {
  local want=$1 got envname
  got=$(curl -fsS -m 3 "http://127.0.0.1:$GP/version" 2>/dev/null | "$NODE" "$KIT/vps-tool.mjs" json-get release.commit)
  if [ "$got" = "$want" ]; then pass "version release ${want:0:12}"; else fail "version release is '${got:0:12}', expected ${want:0:12}"; fi
  envname=$(curl -fsS -m 3 "http://127.0.0.1:$GP/health" 2>/dev/null | "$NODE" "$KIT/vps-tool.mjs" json-get environment)
  if [ "$envname" = staging ]; then pass "health environment staging"; else fail "health environment is '$envname'"; fi
}

serve_ensure() {
  local cur target="http://127.0.0.1:$GP"
  cur=$(serve_lines | grep "^PORT $SP " || true)
  if [ -z "$cur" ]; then
    tailscale serve --bg --https="$SP" "$target" >/dev/null 2>&1 || abort "tailscale serve failed for https:$SP"
    pass "tailscale serve https:$SP -> $target (tailnet only)"
  elif echo "$cur" | grep -q " proxy=$target "; then
    info "tailscale serve https:$SP already -> $target"
  else
    abort "serve port $SP points elsewhere now; not changing it"
  fi
  cur=$(serve_lines | grep "^PORT $SP " || true)
  if echo "$cur" | grep -q " proxy=$target "; then pass "serve mapping https:$SP verified"; else fail "serve mapping https:$SP not visible"; fi
  if echo "$cur" | grep -q " funnel=0"; then pass "no funnel on $SP (tailnet only)"; else fail "funnel is ON for $SP"; fi
}

# Clone (first time) and fetch from the bundle, then check out <sha> detached. tests/vps-staging-kit.test.mjs runs this with real git.
checkout_release() {
  local repo=$1 bundle=$2 sha=$3
  if [ ! -d "$repo/.git" ]; then git clone --quiet --no-checkout "$bundle" "$repo" || abort "clone from bundle failed"; fi
  git -C "$repo" fetch --quiet "$bundle" '+refs/heads/*:refs/remotes/bundle/*' || abort "fetch from bundle failed"
  git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null || abort "commit ${sha:0:12} is not in the bundle"
  if [ -z "$(git -C "$repo" ls-files | head -1)" ]; then
    # never checked out: clone --no-checkout leaves an empty index, which 'status' reports as every file deleted.
    # Nothing local to keep, so the first checkout uses --force (2026-09-30: the first VPS run stopped here).
    git -C "$repo" -c advice.detachedHead=false checkout --quiet --force --detach "$sha" || abort "first checkout failed"
  else
    [ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ] || abort "staging checkout has tracked changes; not touching it"
    git -C "$repo" -c advice.detachedHead=false checkout --quiet --detach "$sha" || abort "checkout failed"
  fi
}

install_release() {
  local sha=${1:-} out
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || abort "install needs a full 40-char sha"
  load_state
  paid_guard
  id "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER" || abort "useradd $SVC_USER failed"
  if [ ! -d "$BASE" ]; then install -d -m 0750 -o root -g "$SVC_USER" "$BASE"; fi
  checkout_release "$REPO" "$BUNDLE" "$sha"
  chown -R root:"$SVC_USER" "$REPO"
  chmod -R g+rX,g-w,o-rwx "$REPO"
  install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$REPO/data" "$REPO/data/usage"
  chown -R "$SVC_USER:$SVC_USER" "$REPO/data"
  (cd "$REPO" && "$NODE" scripts/gateway-release.mjs stamp >/dev/null) || abort "release stamp failed"
  chown root:"$SVC_USER" "$REPO/release.json" "$REPO/releases.jsonl"
  chmod 0640 "$REPO/release.json" "$REPO/releases.jsonl"
  pass "checkout ${sha:0:12} (detached, release stamped)"
  write_env "$sha"
  out=$STATE/render
  rm -rf "$out"
  install -d -m 0750 "$out"
  "$NODE" "$KIT/vps-tool.mjs" render-gateway --repo "$REPO" --env-path "$ENV_FILE" --user "$SVC_USER" --port "$GP" --node "$NODE" --memory-max "$MEMORY_MAX" --out "$out" >/dev/null || abort "rendering the gateway unit failed"
  install_unit "$out/$UNIT.service"
  sctl enable "$UNIT" >/dev/null 2>&1 || abort "enable $UNIT failed"
  # a deliberate restart must not count against the crash-loop limit (StartLimitBurst)
  sctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  sctl restart "$UNIT" || abort "restart $UNIT failed"
  if wait_ready 40; then pass "ready on 127.0.0.1:$GP"; else journal_tail; abort "gateway did not become ready"; fi
  check_version "$sha"
  serve_ensure
  [ "$FAILED" = 0 ] || abort "install ${sha:0:12} failed"
  echo "RESULT install ${sha:0:12} PASS"
}

rollback() {
  local prev
  load_state
  prev=$(cd "$REPO" && "$NODE" scripts/gateway-release.mjs previous 2>/dev/null | "$NODE" "$KIT/vps-tool.mjs" json-get rollback_to.commit)
  [[ "$prev" =~ ^[0-9a-f]{40}$ ]] || abort "no rollback target in releases.jsonl"
  info "rollback to ${prev:0:12} (gateway-release.mjs previous)"
  install_release "$prev"
  echo "RESULT rollback ${prev:0:12} PASS"
}

restore_after_failure() {
  local f="$1/$(basename "$ENV_FILE")"
  if [ -f "$f" ] && ! cmp -s "$f" "$ENV_FILE"; then
    cp -p "$f" "$ENV_FILE"
    secure_env_file
    sctl reset-failed "$UNIT" >/dev/null 2>&1 || true
    sctl restart "$UNIT" >/dev/null 2>&1 || true
    wait_ready 40 || true
    info "env file restored after an interrupted failure test"
  fi
}

failure_tests() {
  local bk n0 n1 st code pid0 pid1 pidA rc t0 took
  load_state
  bk=$STATE/backups/$(stamp_now)-failure
  install -d -m 0700 "$bk"
  cp -p "$ENV_FILE" "$bk/"
  trap 'restore_after_failure "$bk"' EXIT
  trap 'restore_after_failure "$bk"; trap - EXIT; exit 130' HUP INT TERM

  # F1 bad config: release pin mismatch -> refused_to_start (exit 2) -> no restart loop
  sed -i 's/^EDL_EXPECTED_RELEASE=.*/EDL_EXPECTED_RELEASE=0000000000000000000000000000000000000000/' "$ENV_FILE"
  secure_env_file
  sctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  n0=$(systemctl show -p NRestarts --value "$UNIT")
  sctl restart "$UNIT" >/dev/null 2>&1 || true
  sleep 12
  st=$(systemctl show -p ActiveState --value "$UNIT")
  code=$(systemctl show -p ExecMainStatus --value "$UNIT")
  n1=$(systemctl show -p NRestarts --value "$UNIT")
  if [ "$st" != active ] && [ "$code" = 2 ] && [ "$n1" = "$n0" ]; then pass "bad config: refused to start (exit 2), no restart loop"; else fail "bad config: state=$st exit=$code restarts $n0->$n1"; fi
  if journalctl -u "$UNIT" -n 30 -o cat --no-pager 2>/dev/null | grep -q refused_to_start; then pass "bad config: refused_to_start logged"; else fail "bad config: no refused_to_start in the log"; fi
  cp -p "$bk/$(basename "$ENV_FILE")" "$ENV_FILE"
  secure_env_file
  sctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  if sctl restart "$UNIT" && wait_ready 40; then pass "bad config: recovered after restoring the env file"; else fail "bad config: did not recover"; fi

  # F2 crash: SIGKILL -> Restart=on-failure brings it back
  sctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  pid0=$(systemctl show -p MainPID --value "$UNIT")
  sctl kill -s SIGKILL "$UNIT"
  sleep 7
  wait_ready 30 || true
  pid1=$(systemctl show -p MainPID --value "$UNIT")
  if [ "$pid1" != 0 ] && [ "$pid1" != "$pid0" ] && wait_ready 3; then pass "crash: SIGKILL -> restarted automatically"; else fail "crash: pid $pid0 -> $pid1"; fi

  # F3 port conflict: a second instance on the same port must fail fast and leave the service alone
  pidA=$(systemctl show -p MainPID --value "$UNIT")
  t0=$SECONDS
  systemd-run --quiet --wait --collect --unit=e-nexus-portprobe-staging --uid="$SVC_USER" --gid="$SVC_USER" --working-directory="$REPO" \
    -p RuntimeMaxSec=20 -p NoNewPrivileges=true "$NODE" scripts/run-gateway.mjs --env-file "$ENV_FILE" --host 127.0.0.1 --port "$GP" >/dev/null 2>&1
  rc=$?
  took=$((SECONDS - t0))
  if [ "$rc" != 0 ] && [ "$took" -lt 18 ]; then pass "port conflict: second instance refused (exit $rc, ${took}s)"; else fail "port conflict: second instance exit $rc after ${took}s"; fi
  if [ "$(systemctl show -p MainPID --value "$UNIT")" = "$pidA" ] && wait_ready 5; then pass "port conflict: running service untouched"; else fail "port conflict: running service disturbed"; fi

  # F4 graceful restart (SIGTERM -> drain -> stop -> start)
  sctl reset-failed "$UNIT" >/dev/null 2>&1 || true
  if sctl restart "$UNIT" && wait_ready 40; then pass "graceful restart: ready again"; else fail "graceful restart failed"; fi
  if journalctl -u "$UNIT" -n 80 -o cat --no-pager 2>/dev/null | grep -q '"event":"draining"'; then pass "graceful restart: draining logged"; else warn "graceful restart: draining not seen in the last 80 lines"; fi

  # F5 boot persistence (no host reboot: other services run here)
  if [ "$(systemctl is-enabled "$UNIT" 2>/dev/null)" = enabled ]; then pass "boot: unit enabled"; else fail "boot: unit not enabled"; fi

  trap - EXIT HUP INT TERM
  restore_after_failure "$bk"
  if [ "$FAILED" = 0 ]; then echo "RESULT failure PASS"; else echo "RESULT failure FAIL"; fi
}

digest_timer() {
  local out rc
  load_state
  out=$STATE/render-digest
  rm -rf "$out"
  install -d -m 0750 "$out"
  "$NODE" "$KIT/vps-tool.mjs" render-digest --repo "$REPO" --user "$SVC_USER" --node "$NODE" --hour 6 --minute 5 --out "$out" >/dev/null || abort "rendering the digest units failed"
  install_unit "$out/$DIGEST.service"
  install_unit "$out/$DIGEST.timer"
  sctl enable "$DIGEST.timer" >/dev/null 2>&1 || abort "enable $DIGEST.timer failed"
  sctl start "$DIGEST.timer" || abort "start $DIGEST.timer failed"
  pass "digest timer active (daily 06:05 host time, report mode)"
  sctl start "$DIGEST.service"
  rc=$?
  if [ "$rc" = 0 ]; then pass "digest ran once"; else fail "digest run failed (rc=$rc)"; fi
  journalctl -u "$DIGEST.service" -n 12 -o cat --no-pager 2>/dev/null | tail -6 | sed 's/^/INFO  digest: /'
  if [ "$FAILED" = 0 ]; then echo "RESULT digest PASS"; else echo "RESULT digest FAIL"; fi
}

postflight() {
  local want=${1:-} newports gone mem cur tok
  load_state
  snapshot after
  if cmp -s "$ST/protected.before" "$ST/protected.after"; then
    pass "protected services unchanged (state, MainPID, start time, backup timer, n8n container)"
  else
    fail "protected services changed:"
    diff "$ST/protected.before" "$ST/protected.after" | sed 's/^/INFO  /'
  fi
  if diff <(grep -v "^PORT $SP " "$ST/serve.before") <(grep -v "^PORT $SP " "$ST/serve.after") >/dev/null; then pass "other tailscale serve entries unchanged"; else fail "other tailscale serve entries changed"; fi
  if grep -q "^PORT $SP https=1 proxy=http://127.0.0.1:$GP funnel=0\$" "$ST/serve.after"; then pass "staging serve https:$SP -> 127.0.0.1:$GP, no funnel"; else fail "staging serve mapping is not as expected"; fi
  newports=$(comm -13 "$ST/ports.before" "$ST/ports.after" | grep -vx "$GP" | tr '\n' ' ')
  if [ -z "${newports// /}" ]; then pass "no new listening ports except 127.0.0.1:$GP"; else fail "unexpected new listening ports: $newports"; fi
  gone=$(comm -23 "$ST/ports.before" "$ST/ports.after" | tr '\n' ' ')
  if [ -z "${gone// /}" ]; then pass "no listening port disappeared"; else fail "listening ports disappeared: $gone"; fi
  if ss -H -tln "( sport = :$GP )" | awk '{print $4}' | grep -qv '^127\.0\.0\.1:'; then fail "gateway listens beyond 127.0.0.1"; else pass "gateway listens on 127.0.0.1 only"; fi
  if [ "$(systemctl is-active "$UNIT")" = active ] && [ "$(systemctl is-enabled "$UNIT")" = enabled ]; then pass "$UNIT active + enabled"; else fail "$UNIT not active/enabled"; fi
  if [ "$(systemctl is-active "$DIGEST.timer")" = active ] && [ "$(systemctl is-enabled "$DIGEST.timer")" = enabled ]; then pass "$DIGEST.timer active + enabled"; else fail "$DIGEST.timer not active/enabled"; fi
  mem=$(systemctl show -p MemoryCurrent --value "$UNIT")
  if [[ "$mem" =~ ^[0-9]+$ ]] && [ "$mem" -lt 268435456 ]; then pass "gateway memory $((mem / 1048576))MB (MemoryMax $MEMORY_MAX)"; else warn "gateway memory: $mem"; fi
  "$NODE" "$KIT/vps-tool.mjs" usage-check "$REPO/data/usage/staging/usage.jsonl" | sed 's/^/INFO  /'
  if "$NODE" "$KIT/vps-tool.mjs" usage-check "$REPO/data/usage/staging/usage.jsonl" >/dev/null; then pass "paid/network calls: 0"; else fail "usage shows networked or paid attempts"; fi
  if [ "$(stat -c '%a %U:%G' "$ENV_FILE")" = "640 root:$SVC_USER" ]; then pass "env file 0640 root:$SVC_USER"; else fail "env file permissions: $(stat -c '%a %U:%G' "$ENV_FILE")"; fi
  paid_guard
  tok=$(sed -n 's/^EDL_GATEWAY_TOKEN=//p' "$ENV_FILE")
  if [ -n "$tok" ] && journalctl -u "$UNIT" -u "$DIGEST.service" -o cat --no-pager 2>/dev/null | grep -Fqf <(printf '%s\n' "$tok"); then fail "the staging token appears in the journal"; else pass "token not present in staging logs"; fi
  tok=
  if [ -n "$want" ]; then check_version "$want"; fi
  cur=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
  info "resources before: $(tr '\n' ' ' < "$ST/resources.before")"
  info "resources after:  $(tr '\n' ' ' < "$ST/resources.after")"
  echo "SUMMARY unit=$UNIT release=${cur:0:12} bind=127.0.0.1:$GP serve=https:$SP(tailnet-only) digest=$DIGEST.timer user=$SVC_USER"
  if [ "$FAILED" = 0 ]; then echo "RESULT postflight PASS"; else echo "RESULT postflight FAIL"; fi
}

status() {
  load_state
  echo "STATE gw_port=$GP"
  echo "STATE serve_port=$SP"
  echo "INFO  $UNIT $(systemctl is-enabled "$UNIT" 2>/dev/null)/$(systemctl is-active "$UNIT" 2>/dev/null)"
  echo "INFO  $DIGEST.timer $(systemctl is-enabled "$DIGEST.timer" 2>/dev/null)/$(systemctl is-active "$DIGEST.timer" 2>/dev/null)"
  echo "INFO  release $(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null)"
  serve_lines | grep "^PORT $SP " | sed 's/^/INFO  serve /'
}

token() {
  local tok
  tok=$(sed -n 's/^EDL_GATEWAY_TOKEN=//p' "$ENV_FILE" 2>/dev/null)
  [[ "$tok" =~ ^[0-9a-f]{64}$ ]] || { echo "ABORT no staging token"; exit 3; }
  printf '%s\n' "$tok"
}

uninstall() {
  [ "${1:-}" = --yes ] || abort "uninstall needs --yes (keeps repo, env file, data and backups)"
  load_state
  sctl disable "$DIGEST.timer" >/dev/null 2>&1 || true
  sctl stop "$DIGEST.timer" >/dev/null 2>&1 || true
  sctl disable "$UNIT" >/dev/null 2>&1 || true
  sctl stop "$UNIT" >/dev/null 2>&1 || true
  if serve_lines | grep -q "^PORT $SP .* proxy=http://127.0.0.1:$GP "; then tailscale serve --https="$SP" "http://127.0.0.1:$GP" off >/dev/null 2>&1 || true; fi
  rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$DIGEST.service" "/etc/systemd/system/$DIGEST.timer"
  systemctl daemon-reload
  echo "RESULT uninstall PASS (repo, env file, data and backups kept)"
}

main() {
  local cmd=${1:-}
  exec 9>/run/e-nexus-staging.lock
  flock -n 9 || abort "another staging run is in progress"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    preflight) preflight ;;
    install) install_release "${1:-}" ;;
    rollback) rollback ;;
    failure) failure_tests ;;
    digest) digest_timer ;;
    postflight) postflight "${1:-}" ;;
    status) status ;;
    token) token ;;
    uninstall) uninstall "${1:-}" ;;
    *) echo "usage: stage.sh <preflight|install <sha>|rollback|failure|digest|postflight <sha>|status|token|uninstall --yes>"; exit 2 ;;
  esac
  [ "$FAILED" = 0 ]
}

# Run only when executed; tests source this file to call single functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
  exit $?
fi
