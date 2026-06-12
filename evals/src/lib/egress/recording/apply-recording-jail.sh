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

# ---- re-evaluate pre-jail flows against the new NAT policy.
#
# This sidecar is started AFTER the assistant containers are already
# running (the harness hatches the assistant, then attaches this jail to
# its netns). During that pre-jail window the assistant daemon opens a
# keep-alive HTTPS connection to its model provider (e.g.
# api.anthropic.com) and pools it. NAT OUTPUT REDIRECT only rewrites the
# first packet of a NEW conntrack flow, and the filter chain accepts
# already-established flows via the ESTABLISHED,RELATED rule above — so a
# connection opened before these rules existed egresses straight to the
# provider, never traversing mitmproxy. The assistant's main inference
# reuses that pooled connection and its tokens/cost go unrecorded, while
# short-lived auxiliary calls (which open fresh post-jail connections)
# are captured. Whether the pooled connection survives to inference time
# depends on the SDK's idle keep-alive timeout, which made the gap
# intermittent.
#
# Flushing conntrack here forces every pre-jail flow to be re-evaluated:
# the next packet on a reused connection is treated as NEW, hits the
# REDIRECT, and the client transparently reconnects through mitmproxy.
# conntrack is network-namespace scoped, so this only affects the
# assistant's own flows, and it runs before `mitmdump` is exec'd so the
# proxy has no upstream connections to disturb. Best-effort: a flush
# failure must not take down the jail (recording degrades to the
# pre-existing behaviour rather than breaking egress entirely).
conntrack -F >/dev/null 2>&1 \
  && echo "recording-jail: flushed pre-jail conntrack flows" >&2 \
  || echo "recording-jail: conntrack flush unavailable (pre-jail flows may bypass)" >&2

# Sanity: confirm a working rule listing went out so a misconfig is
# easy to spot in the sidecar logs.
echo "recording-jail: iptables installed; mitmproxy uid=$MITM_UID port=$MITM_PORT" >&2
iptables -t nat -L OUTPUT -n --line-numbers >&2
iptables -L OUTPUT -n --line-numbers >&2
