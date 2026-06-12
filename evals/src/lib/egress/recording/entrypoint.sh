#!/bin/sh
# Entrypoint for the recording-jail sidecar container.
#
# Runs in two phases:
#   1. As root: apply iptables filter + NAT rules (needs NET_ADMIN).
#   2. Drop to the `mitmproxy` user and exec mitmdump in transparent mode
#      with the recording addon loaded.
#
# The split-user approach is what lets the iptables REDIRECT rule
# exempt mitmproxy's own outbound traffic by UID — see
# apply-recording-jail.sh.

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "entrypoint must start as root (NET_ADMIN required for iptables)" >&2
  exit 64
fi

MITM_UID="${MITM_UID:-1000}"
MITM_PORT="${MITM_PORT:-8443}"
RECORDING_OUTPUT_PATH="${RECORDING_OUTPUT_PATH:-/recording/egress-usage.ndjson}"

# ALLOW_HOSTS is the comma-separated hostname allowlist. It is enforced
# at the proxy layer now (addon.py rejects any request whose
# `pretty_host` isn't in the set with a 403), so it must reach the
# addon's process env. Fall back to api.anthropic.com so a sidecar
# booted without it still permits the only host the recorder parses.
ALLOW_HOSTS="${ALLOW_HOSTS:-api.anthropic.com}"

# PLUGIN_FIXTURES_DIR is left empty when unset — the addon checks for
# the env var directly and skips mocking when absent, so we don't need
# a fallback path here.
export MITM_UID MITM_PORT RECORDING_OUTPUT_PATH PLUGIN_FIXTURES_DIR ALLOW_HOSTS

# Phase 1: install iptables rules in this container's network namespace.
/opt/recording/apply-recording-jail.sh

# Make sure the output directory exists and is writable by the mitmproxy user.
mkdir -p "$(dirname "$RECORDING_OUTPUT_PATH")"
touch "$RECORDING_OUTPUT_PATH"
chown -R "$MITM_UID":"$MITM_UID" "$(dirname "$RECORDING_OUTPUT_PATH")"

# Copy mitmproxy CA to the host-mounted recording dir so the evals
# harness can `docker cp` it into the assistant container's trust
# store before any plugin install runs. The CA is pre-generated at
# image build time (see Dockerfile); without it landing in the
# assistant container, the TLS handshake to api.anthropic.com /
# api.github.com / raw.githubusercontent.com fails closed and the
# addon never sees the request.
if [ -f /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem ]; then
  cp /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem /recording/mitmproxy-ca-cert.pem
  chmod 644 /recording/mitmproxy-ca-cert.pem
fi

# Phase 2: drop privileges and run mitmdump in transparent mode.
# `--mode transparent` makes mitmproxy honor the iptables REDIRECT.
# `--listen-port $MITM_PORT` matches the REDIRECT target.
# `--showhost` makes the request URL use the original Host header so
#   the addon sees `api.anthropic.com` not the rewritten dest.
# `--set block_global=false` allows transparent-mode traffic from
#   localhost (the assistant container shares netns with us).
#
# We deliberately do NOT pass `--allow-hosts`: ALL TLS/443 flows the
# REDIRECT bounces in are intercepted. The allowlist is now enforced in
# the addon's `request` hook (it matches `pretty_host` against
# ALLOW_HOSTS and 403s anything not allowed and not mocked), so the
# proxy no longer needs a TLS-interception regex.
#
# Intercepting every host is safe here because only the ASSISTANT
# container trusts the mitmproxy CA (docker-jail.ts installs it into
# that container's trust store post-hatch). The gateway and
# credential-executor containers do NOT share this netns, so their
# outbound traffic never reaches this proxy and is unaffected by the
# system-wide interception. The old `--allow-hosts` narrowing existed
# to avoid MITM'ing those sibling containers, but they aren't reachable
# here, so the narrowing only ever added a DNS-rotation failure mode
# (a request to a host outside the regex got pure-TCP passthrough and
# then hit the per-IP iptables ACCEPT that DNS rotation had
# invalidated). Removing it lets the proxy own allowlisting end-to-end.
exec su -s /bin/sh -c "exec mitmdump \
  --mode transparent \
  --listen-port \"$MITM_PORT\" \
  --showhost \
  --set block_global=false \
  --set confdir=/home/mitmproxy/.mitmproxy \
  --scripts /opt/recording/addon.py" mitmproxy
