#!/bin/sh
# Apply iptables policy for the recording egress jail.
#
# Two layers:
#
#   1. DROP-by-default OUTPUT filter (same as the non-recording jail) —
#      only the configured ALLOW_HOSTS keep outbound 443/80 access. The
#      mitmproxy process inside this container is itself an outbound
#      client to api.anthropic.com etc., so it needs the same allowlist.
#
#   2. NAT OUTPUT REDIRECT — bounce outbound TCP/443 to mitmproxy's
#      listening port (default 8443) so the mitmproxy proc terminates
#      TLS, records usage, and re-emits the request upstream. The
#      REDIRECT must NOT apply to mitmproxy's own outbound traffic; we
#      exempt it by UID with `! -m owner --uid-owner <MITM_UID>`.
#
# Run as the entrypoint of the recording sidecar; this script must
# finish before `mitmdump` is exec'd so the rules are in place.

set -eu

ALLOW_HOSTS="${ALLOW_HOSTS:-}"
MITM_UID="${MITM_UID:-1000}"
MITM_PORT="${MITM_PORT:-8443}"

if [ -z "$ALLOW_HOSTS" ]; then
  echo "ALLOW_HOSTS is required" >&2
  exit 64
fi

# ---- filter table: outbound allowlist (block-by-default; only the
# resolved ALLOW_HOSTS IPs may egress)
iptables -F OUTPUT
iptables -P OUTPUT DROP
# Accept by destination *before* the `-o lo` rule: on some kernels
# (notably colima's macOS Virtualization.Framework VM), the filter
# OUTPUT chain's `-o` interface match is evaluated against the
# pre-routing interface, not the post-DNAT one. That means packets the
# NAT OUTPUT REDIRECT below rewrites from `<allowed_ip>:443` to
# `127.0.0.1:<MITM_PORT>` still see `-o eth0` here and fall through to
# the default DROP — silently breaking mitmproxy interception.
# Matching by destination IP catches the DNAT'd loopback packets
# regardless of which interface the kernel reports. Keep the `-o lo`
# rule below as a defensive belt-and-suspenders for any non-loopback-
# destined traffic mitmproxy emits over lo (none today, but cheap).
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

OLD_IFS="$IFS"
IFS=','
for host in $ALLOW_HOSTS; do
  IFS="$OLD_IFS"
  host=$(printf '%s' "$host" | tr -d '[:space:]')
  [ -n "$host" ] || continue

  getent ahostsv4 "$host" | awk '{print $1}' | sort -u | while read -r ip; do
    [ -n "$ip" ] || continue
    iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ip" --dport 80 -j ACCEPT
  done
  IFS=','
done
IFS="$OLD_IFS"

# ---- nat table: REDIRECT 443 → mitmproxy, exempting mitmproxy itself.
#
# Order matters: the exemption ACCEPT-equivalent (RETURN) must precede
# the REDIRECT so packets that are MITM-originated don't loop. The
# exemption is matched by the mitmproxy process UID inside this
# container's user namespace.
iptables -t nat -F OUTPUT
iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner --uid-owner "$MITM_UID" -j RETURN
iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port "$MITM_PORT"

# Sanity: confirm a working rule listing went out so a misconfig is
# easy to spot in the sidecar logs.
echo "recording-jail: iptables installed; mitmproxy uid=$MITM_UID port=$MITM_PORT" >&2
iptables -t nat -L OUTPUT -n --line-numbers >&2
iptables -L OUTPUT -n --line-numbers >&2
