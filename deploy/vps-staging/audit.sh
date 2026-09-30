#!/usr/bin/env bash
# E-NEXUS VPS staging: READ-ONLY host audit (2026-09-30, Deployment Completion Phase).
#
# Usage (Human, from the PC; the script is piped over ssh, nothing is copied to the host):
#   cat deploy/vps-staging/audit.sh | ssh -o BatchMode=yes -o ConnectTimeout=15 root@<host> 'tr -d \\r | bash -s'
# (no double quotes in the remote command: Windows PowerShell 5.1 mangles embedded quotes for native exes)
#
# Changes nothing. Never prints secret values, process arguments, unit Environment= lines,
# logs of existing services, or raw IP addresses (addresses are shown as loopback/tailnet/private/public).
# Secret-like files are checked with stat only. ASCII only on purpose: it is piped through Windows shells.

main() {
  export LC_ALL=C
  sec() { printf '\n=== %s ===\n' "$1"; }
  cls() {
    case "$1" in
      127.*|::1) echo loopback ;;
      0.0.0.0|'*'|::) echo any ;;
      100.*) echo tailnet ;;
      10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) echo private ;;
      fe80*) echo linklocal ;;
      fd7a:115c:a1e0*) echo tailnet6 ;;
      *) echo public ;;
    esac
  }
  listen() {
    ss -H "-$1lnp" 2>/dev/null | while read -r _st _rq _sq local _peer proc; do
      port=${local##*:}; addr=${local%:*}; addr=${addr%%\%*}; addr=${addr#[}; addr=${addr%]}
      name=$(printf '%s' "$proc" | sed -n 's/.*(("\([^"]*\)".*/\1/p')
      printf '%s %-6s %-9s %s\n' "$1" "$port" "$(cls "$addr")" "${name:--}"
    done | sort -u -k2,2n
  }

  sec machine
  . /etc/os-release; echo "os=$PRETTY_NAME kernel=$(uname -r) arch=$(uname -m)"
  echo "cpus=$(nproc) uptime=$(uptime -p) loadavg=$(cut -d' ' -f1-3 /proc/loadavg)"
  timedatectl show -p Timezone -p NTPSynchronized 2>/dev/null | tr '\n' ' '; echo
  free -m
  swapon --show 2>/dev/null || echo "swap: none"
  df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null
  echo "processes=$(ps -e --no-headers | wc -l)"

  sec network
  ip -o addr show | awk '{print $2, $3, $4}' | while read -r ifc fam cidr; do echo "$ifc $fam $(cls "${cidr%/*}")"; done | sort -u

  sec listening
  listen t
  listen u

  sec runtime
  for c in node npm python3 git docker openssl tailscale cloudflared nginx caddy apache2 pm2 rsync jq curl; do
    p=$(command -v "$c" 2>/dev/null); echo "$c ${p:+$(readlink -f "$p")}${p:--}"
  done
  echo "node=$(node --version 2>/dev/null) npm=$(npm --version 2>/dev/null) git=$(git --version 2>/dev/null | awk '{print $3}') python=$(python3 --version 2>/dev/null | awk '{print $2}')"
  echo "docker=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,) compose=$(docker compose version --short 2>/dev/null) $(openssl version 2>/dev/null)"
  np=$(command -v node 2>/dev/null) && echo "node_pkg=$(dpkg -S "$(readlink -f "$np")" 2>/dev/null | cut -d: -f1)"
  echo "tailscale=$(tailscale version 2>/dev/null | head -1)"
  systemctl --version | head -1

  sec services
  echo "-- running:"; systemctl list-units --type=service --state=running --no-legend --plain | awk '{print "  " $1}'
  echo "-- failed:"; systemctl list-units --state=failed --no-legend --plain | awk '{print "  " $1}'
  echo "-- timers:"; systemctl list-timers --all --no-legend --plain | awk '{print "  " $(NF-1) " -> " $NF}'
  echo "-- selected (enabled/active):"
  for u in n8n-loopback-proxy openclaw-gateway tailscaled docker cron unattended-upgrades ufw nginx en-product-hub en-product-hub-backup.timer audio-processor cloudflared; do
    echo "  $u $(systemctl is-enabled "$u" 2>/dev/null || true)/$(systemctl is-active "$u" 2>/dev/null || true)"
  done
  echo "-- unit files mentioning nexus/edl:"; ls /etc/systemd/system 2>/dev/null | grep -Ei 'nexus|edl' | sed 's/^/  /'

  sec top-memory
  ps -eo user,rss,comm --sort=-rss | head -15

  sec docker
  timeout 15 docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}}' 2>/dev/null
  timeout 20 docker stats --no-stream --format '{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' 2>/dev/null
  timeout 15 docker compose ls 2>/dev/null

  sec exposure
  echo "-- tailscale serve:"; timeout 10 tailscale serve status 2>&1 | sed -E 's#https?://[^ /]+#<host>#g; s/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g' | sed 's/^/  /'
  echo "-- tailscale funnel:"; timeout 10 tailscale funnel status 2>&1 | sed -E 's#https?://[^ /]+#<host>#g; s/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/<ip>/g' | sed 's/^/  /'
  echo "-- reverse proxy / tls dirs:"; for d in /etc/nginx /etc/caddy /etc/apache2 /etc/letsencrypt /etc/cloudflared; do [ -e "$d" ] && echo "  exists $d" || echo "  absent $d"; done
  echo "-- firewall:"; (ufw status 2>/dev/null | head -1) || true
  echo "  nft_chains=$(nft list ruleset 2>/dev/null | grep -c 'chain ') iptables_rules=$(iptables -S 2>/dev/null | wc -l)"

  sec access
  sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|maxauthtries) ' | sed 's/^/  /'
  echo "-- login-shell users:"; awk -F: '$7 !~ /(nologin|false|sync|halt|shutdown)$/ {print "  " $1 " uid=" $3}' /etc/passwd
  echo "-- groups:"; for g in sudo docker; do echo "  $(getent group "$g")"; done
  echo "-- authorized_keys (fingerprints only):"
  for h in /root $(awk -F: '$3>=1000 && $6 ~ /^\/home\// {print $6}' /etc/passwd); do
    f="$h/.ssh/authorized_keys"
    [ -f "$f" ] && { echo "  $f $(stat -c '%a %U' "$f")"; ssh-keygen -lf "$f" 2>/dev/null | awk '{print "    " $1 " " $2 " " $NF}'; }
  done
  echo "-- cron:"
  for u in $(cut -d: -f1 /etc/passwd); do
    n=$(crontab -l -u "$u" 2>/dev/null | grep -Evc '^[[:space:]]*(#|$)'); [ "${n:-0}" -gt 0 ] && echo "  crontab $u: $n entries"
  done
  echo "  cron.d: $(ls /etc/cron.d 2>/dev/null | tr '\n' ' ')"
  echo "-- secret-like files (stat only):"
  for f in /etc/cloudflared/token /opt/audio-processor/processor.key /opt/en-product-hub/config.json; do
    [ -e "$f" ] && stat -c '  %a %U:%G %n' "$f" || echo "  absent $f"
  done
  find /opt /root /home /srv -maxdepth 4 \( -name '.env' -o -name '.env.*' -o -name '*.env' \) -type f -printf '  %m %u:%g %p\n' 2>/dev/null | head -20
  echo "-- updates: upgradable=$(apt list --upgradable 2>/dev/null | grep -c upgradable) security=$(apt list --upgradable 2>/dev/null | grep -c -- '-security')"
  echo "-- journald: $(journalctl --disk-usage 2>/dev/null)"

  sec deployments
  ls -la /opt 2>/dev/null | awk 'NR>1 {print "  " $1 " " $3 ":" $4 " " $NF}'
  find /opt /srv /root -maxdepth 3 -name .git -type d 2>/dev/null | while read -r g; do
    d=${g%/.git}
    echo "  git $d branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null) head=$(git -C "$d" rev-parse --short HEAD 2>/dev/null) dirty=$(git -C "$d" status --porcelain 2>/dev/null | wc -l) remote_host=$(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's#^[a-z]+://##; s#^[^@]*@##; s#[:/].*##')"
  done

  sec staging-candidates
  for p in /opt/e-nexus-staging /etc/e-nexus /var/lib/e-nexus-staging /var/log/e-nexus-staging; do [ -e "$p" ] && echo "  exists $p" || echo "  free $p"; done
  id edl-staging >/dev/null 2>&1 && echo "  user edl-staging exists" || echo "  user edl-staging free"
  for p in 8790 8791 8792 8793 18480 18481; do
    ss -H -tln "( sport = :$p )" 2>/dev/null | grep -q . && echo "  port $p used" || echo "  port $p free"
  done

  sec end
  echo "AUDIT DONE (read-only, nothing changed)"
}
main "$@" </dev/null
