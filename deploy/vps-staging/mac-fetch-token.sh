#!/bin/bash
# Mac mini (Hermes and other consumers): put the VPS staging Gateway token into the login Keychain without showing it (2026-09-30).
# Run by the Human on the Mac (the Human starts SSH to the VPS; a password prompt or a key both work).
#
#   bash deploy/vps-staging/mac-fetch-token.sh --tailscale-name <VPS tailscale name>
#
# Stores service=E-NEXUS/edl/gateway-token-staging account=e-nexus (the name scripts/lib/env-file.mjs readCredential reads;
# same place as deploy/macos/keychain-edl.sh). The value goes to 'security -i' on stdin: never on a command line, in a file or on screen.
# Prints only: stored / not stored, and the staging URL https://<vps>.<tailnet>.ts.net:<serve port> for the consumer config.
# ASCII only on purpose.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "macOS only (on Windows, run.mjs already stored it in the Credential Manager)"; exit 2; }
name=
while [ $# -gt 0 ]; do
  case "$1" in
    --tailscale-name) name=${2:-}; shift 2 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]] || { echo "usage: mac-fetch-token.sh --tailscale-name <VPS>"; exit 2; }
command -v tailscale >/dev/null || { echo "tailscale CLI not found"; exit 1; }
command -v node >/dev/null || { echo "node not found (run deploy/macos/bootstrap.sh first)"; exit 1; }

ip=$(tailscale ip -4 "$name" | head -1)
[[ "$ip" =~ ^100\. ]] || { echo "tailscale ip -4 $name failed (is this Mac on the tailnet?)"; exit 1; }
dns=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const n=process.argv[1].toLowerCase();const p=Object.values(j.Peer||{}).find(x=>String(x.HostName||"").toLowerCase()===n||String(x.DNSName||"").toLowerCase().startsWith(n+"."));process.stdout.write(p&&p.DNSName?String(p.DNSName).replace(/\.$/,""):"")})' "$name")
[ -n "$dns" ] || { echo "could not find the MagicDNS name of $name"; exit 1; }

tok=$(ssh -o ConnectTimeout=15 "root@$ip" 'bash /root/e-nexus-staging-inbox/kit/stage.sh token')
port=$(ssh -o ConnectTimeout=15 "root@$ip" 'cat /var/lib/e-nexus-staging/state/serve_port')
if ! [[ "$tok" =~ ^[0-9a-f]{64}$ ]]; then tok=; echo "could not read the staging token"; exit 1; fi
printf 'add-generic-password -U -s E-NEXUS/edl/gateway-token-staging -a e-nexus -w %s\n' "$tok" | /usr/bin/security -i >/dev/null
tok=
if /usr/bin/security find-generic-password -s E-NEXUS/edl/gateway-token-staging -a e-nexus >/dev/null 2>&1; then
  echo "stored: E-NEXUS/edl/gateway-token-staging (value not shown)"
else
  echo "store failed"
  exit 1
fi
[[ "$port" =~ ^[0-9]{2,5}$ ]] && echo "staging URL: https://$dns:$port  (environment=staging; consumer-kit: HttpTransport(url, token, \"staging\"))"
