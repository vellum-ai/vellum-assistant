#!/bin/sh
# Apply iptables policy for the recording egress jail.
#
# Two layers:
#
#   1. DROP-by-default OUTPUT filter. Loopback, conntrack-established,
#      and DNS are allowed; everything else is dropped UNLESS it is
#      mitmproxy's own outbound traffic (matched by UID). mitmproxy is
#      the single egress point — every other outbound TCP/443 flow is
#      bounced into it by the NAT REDIRECT (layer 2) and re-emitted by
#      mitmproxy's own upstream legs, which the UID-owner ACCEPT below
#      lets through to whatever IP the host resolved.
#
#      We deliberately do NOT install per-IP ACCEPT rules for the
#      allowlisted hosts. The previous design resolved ALLOW_HOSTS to
#      IPv4s ONCE at container start (`getent ahostsv4`) and pinned an
#      ACCEPT per IP. api.anthropic.com rotates IPs with low TTLs, so
#      minutes into a run the daemon dials a fresh IP: the NAT REDIRECT
#      still bounces it into mitmproxy, but mitmproxy's upstream connect
#      to the rotated IP hit the default DROP and every LLM call failed
#      with "Connection error". Allowlist enforcement now lives at the
#      proxy layer (addon.py matches `request.pretty_host` against
#      ALLOW_HOSTS), so the filter table only needs to let mitmproxy
#      reach any IP — DNS rotation can no longer strand a flow.
#
#   2. NAT OUTPUT REDIRECT — bounce outbound TCP/443 to mitmproxy's
#      listening port (default 8443) so the mitmproxy proc terminates
#      TLS, records usage, enforces the hostname allowlist, and
#      re-emits allowed requests upstream. The REDIRECT must NOT apply
#      to mitmproxy's own outbound traffic; we exempt it by UID with
#      `! -m owner --uid-owner <MITM_UID>` (a RETURN that precedes the
#      REDIRECT).
#
# Run as the entrypoint of the recording sidecar; this script must
# finish before `mitmdump` is exec'd so the rules are in place.

set -eu

# ALLOW_HOSTS is no longer consumed by this script — hostname allowlist
# enforcement moved to the proxy layer (addon.py). We still require it
# here as a fail-loud misconfig guard: it is the env contract the addon
# depends on, and a sidecar booted without it would silently let the
# addon block every request once mocking misses. Keeping the guard
# central means the failure surfaces in `docker logs <jail-name>`
# regardless of which layer ultimately reads the value.
ALLOW_HOSTS="${ALLOW_HOSTS:-}"
MITM_UID="${MITM_UID:-1000}"
MITM_PORT="${MITM_PORT:-8443}"

if [ -z "$ALLOW_HOSTS" ]; then
  echo "ALLOW_HOSTS is required" >&2
  exit 64
fi

# ---- filter table: outbound DROP-by-default. Only loopback,
# conntrack-established, DNS, and mitmproxy's own upstream legs egress;
# everything else is bounced into mitmproxy by the NAT REDIRECT below.
iptables -F OUTPUT
iptables -P OUTPUT DROP
# Accept by destination *before* the `-o lo` rule: on some kernels
# (notably colima's macOS Virtualization.Framework VM), the filter
# OUTPUT chain's `-o` interface match is evaluated against the
# pre-routing interface, not the post-DNAT one. That means packets the
# NAT OUTPUT REDIRECT below rewrites from `<dest>:443` to
# `127.0.0.1:<MITM_PORT>` still see `-o eth0` here and fall through to
# the default DROP — silently breaking mitmproxy interception.
# Matching by destination IP catches the DNAT'd loopback packets
# regardless of which interface the kernel reports. Keep the `-o lo`
# rule below as a defensive belt-and-suspenders for any non-loopback-
# destined traffic mitmproxy emits over lo (none today, but cheap).
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
# REDIRECTed 443 packets re-enter this chain with their destination
# rewritten to a local address and dport set to $MITM_PORT. Which local
# address depends on the kernel: classic behavior is 127.0.0.1 (caught
# by the 127.0.0.0/8 rule above), but some VM kernels (Docker Desktop /
# colima) rewrite to the egress interface's primary address instead,
# which matches neither rule above and would fall through to the DROP.
# Accept by (local dst, mitm dport) to be robust across both.
iptables -A OUTPUT -p tcp --dport "$MITM_PORT" -m addrtype --dst-type LOCAL -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
# mitmproxy's upstream legs reach whatever IP the host resolved for an
# allowlisted host. This replaces the old per-IP ALLOW_HOSTS ACCEPT
# loop, which broke under DNS rotation (a fresh IP minutes into a run
# had no matching ACCEPT and hit the default DROP). The hostname
# allowlist is enforced at the proxy layer (addon.py), so this broad
# UID-scoped ACCEPT is safe: only mitmproxy runs as $MITM_UID, and it
# only forwards requests whose host is in ALLOW_HOSTS.
iptables -A OUTPUT -m owner --uid-owner "$MITM_UID" -j ACCEPT

# ---- nat table: REDIRECT 443 → mitmproxy, exempting mitmproxy itself.
#
# Order matters: the exemption ACCEPT-equivalent (RETURN) must precede
# the REDIRECT so packets that are MITM-originated don't loop. The
# exemption is matched by the mitmproxy process UID inside this
# container's user namespace.
#
# NEVER flush this chain (`-t nat -F OUTPUT`): Docker's embedded DNS
# (the 127.0.0.11 resolver in /etc/resolv.conf) is implemented as
# dockerd-installed DNAT rules in this same chain, mapping
# 127.0.0.11:53 to the resolver's real per-container port. Flushing
# the chain silently destroys DNS for the entire shared netns — every
# warm connection keeps working until it dies, then every new
# connection fails with a resolution timeout that surfaces as
# "Connection error" minutes into a run. (Found live; this was the
# root cause of all-provider-calls-failing mid-eval.) Instead, delete
# exactly our own rules if present (idempotent re-apply), then append.
iptables -t nat -D OUTPUT -p tcp --dport 443 -m owner --uid-owner "$MITM_UID" -j RETURN 2>/dev/null || true
iptables -t nat -D OUTPUT -p tcp --dport 443 -j REDIRECT --to-port "$MITM_PORT" 2>/dev/null || true
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
# proxy has no upstream connections to disturb. The flush must come
# AFTER the NAT REDIRECT is installed — flushing before would just let
# pre-jail flows re-establish on the still-unredirected path. Best-
# effort: a flush failure must not take down the jail (recording
# degrades to the pre-existing behaviour rather than breaking egress
# entirely).
conntrack -F >/dev/null 2>&1 \
  && echo "recording-jail: flushed pre-jail conntrack flows" >&2 \
  || echo "recording-jail: conntrack flush unavailable (pre-jail flows may bypass)" >&2

# Sanity: confirm a working rule listing went out so a misconfig is
# easy to spot in the sidecar logs.
echo "recording-jail: iptables installed; mitmproxy uid=$MITM_UID port=$MITM_PORT" >&2
iptables -t nat -L OUTPUT -n --line-numbers >&2
iptables -L OUTPUT -n --line-numbers >&2
