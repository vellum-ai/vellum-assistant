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
#
# Docker installs its embedded-DNS interception as a jump out of the nat
# OUTPUT chain — `-d 127.0.0.11/32 -j DOCKER_OUTPUT` — that DNATs
# 127.0.0.11:53 to the resolver's real high port. `-F OUTPUT` would wipe
# that jump along with anything else, leaving the DOCKER_OUTPUT chain
# intact but unreachable, so every in-netns lookup against 127.0.0.11
# times out (getaddrinfo → EAI_AGAIN). The allowlist's own `getent` above
# runs before the flush and still resolves, which masks the breakage until
# a tenant tries to resolve at request time. Capture the jump and re-add
# it after the flush so DNS keeps working. DNS is port 53 and untouched by
# the :443 REDIRECT, so restoring the jump is orthogonal to interception.
dns_jump=$(iptables -t nat -S OUTPUT | grep -- '-d 127.0.0.11/32 -j DOCKER_OUTPUT' || true)
iptables -t nat -F OUTPUT
if [ -n "$dns_jump" ]; then
  iptables -t nat -A OUTPUT -d 127.0.0.11/32 -j DOCKER_OUTPUT
fi
iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner --uid-owner "$MITM_UID" -j RETURN
iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port "$MITM_PORT"

# ---- re-evaluate any pre-existing flows against the new NAT policy.
#
# Defensive backstop. NAT OUTPUT REDIRECT only rewrites the first packet
# of a NEW conntrack flow, and the filter chain accepts already-open flows
# via the ESTABLISHED,RELATED rule above — so any TCP connection that
# predates these rules would egress straight to the provider, never
# traversing mitmproxy, and its tokens/cost would go unrecorded. When the
# jail owns the network namespace and tenants are born into it, no such
# flow can exist; this flush guarantees correctness even if a tenant
# somehow opens a connection before the rules are fully in place.
#
# Flushing conntrack forces every existing flow to be re-evaluated: the
# next packet on a reused connection is treated as NEW, hits the REDIRECT,
# and the client transparently reconnects through mitmproxy. conntrack is
# network-namespace scoped, so this only affects this namespace's own
# flows, and it runs before `mitmdump` is exec'd so the proxy has no
# upstream connections to disturb. Best-effort: a flush failure must not
# take down the jail (recording degrades to the pre-existing behaviour
# rather than breaking egress entirely).
conntrack -F >/dev/null 2>&1 \
  && echo "recording-jail: flushed pre-jail conntrack flows" >&2 \
  || echo "recording-jail: conntrack flush unavailable (pre-jail flows may bypass)" >&2

# Sanity: confirm a working rule listing went out so a misconfig is
# easy to spot in the sidecar logs.
echo "recording-jail: iptables installed; mitmproxy uid=$MITM_UID port=$MITM_PORT" >&2
iptables -t nat -L OUTPUT -n --line-numbers >&2
iptables -L OUTPUT -n --line-numbers >&2
