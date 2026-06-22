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

# PLUGIN_FIXTURES_DIR is left empty when unset — the addon checks for
# the env var directly and skips mocking when absent, so we don't need
# a fallback path here.
export MITM_UID MITM_PORT RECORDING_OUTPUT_PATH PLUGIN_FIXTURES_DIR

# Phase 1: install iptables rules in this container's network namespace.
/opt/recording/apply-recording-jail.sh

# Make sure the output directory exists and is writable by the mitmproxy user.
mkdir -p "$(dirname "$RECORDING_OUTPUT_PATH")"
touch "$RECORDING_OUTPUT_PATH"
chown -R "$MITM_UID":"$MITM_UID" "$(dirname "$RECORDING_OUTPUT_PATH")"

# Copy mitmproxy CA to the host-mounted recording dir so the evals
# harness can `docker cp` it into the assistant container's trust
# store before any plugin install runs. The CA is pre-generated at
# image build time and copied to /opt/recording/mitmproxy-conf/ (a
# non-VOLUME path) so it survives container start. Without it landing
# in the assistant container, the TLS handshake to api.anthropic.com /
# api.github.com / raw.githubusercontent.com fails closed and the
# addon never sees the request.
if [ -f /opt/recording/mitmproxy-conf/mitmproxy-ca-cert.pem ]; then
  cp /opt/recording/mitmproxy-conf/mitmproxy-ca-cert.pem /recording/mitmproxy-ca-cert.pem
  chmod 644 /recording/mitmproxy-ca-cert.pem
fi

# Phase 2: drop privileges and run mitmdump in transparent mode.
# `--mode transparent` makes mitmproxy honor the iptables REDIRECT.
# `--listen-port $MITM_PORT` matches the REDIRECT target.
# `--showhost` makes the request URL use the original Host header so
#   the addon sees `api.anthropic.com` not the rewritten dest.
# `--allow-hosts <regex>` restricts TLS interception to the hosts the
#   addon records or mocks: the model providers whose usage it parses
#   (Anthropic `/v1/messages`; Fireworks `/chat/completions`) and, when
#   plugin fixtures are mounted, GitHub Contents + Raw so the
#   mock-github handler can synthesize plugin-install responses. Every
#   other host gets pure-TCP passthrough, which matters because:
#   (a) the CA cert is only trusted by the assistant container
#       (docker-jail.ts installs it post-hatch); gateway +
#       credential-executor share the netns but don't trust the CA.
#       The intercepted model hosts are dialed only by the assistant,
#       so MITM'ing them never touches gateway/CES TLS. Large
#       dependency or model-weight downloads on other allowlisted hosts
#       stay in passthrough so the fetching client validates the
#       genuine upstream certificate.
#   (b) the addon only synthesizes/parses these specific hosts;
#       intercepting other providers is gross waste with no recording
#       or mocking payoff.
#   When ALLOW_HOSTS is empty, fall back to api.anthropic.com.
# `--set block_global=false` allows transparent-mode traffic from
#   localhost (the assistant container shares netns with us).
ALLOW_HOSTS="${ALLOW_HOSTS:-api.anthropic.com}"
if [ -n "${PLUGIN_FIXTURES_DIR:-}" ]; then
  RECORDING_TLS_HOSTS_RE="${RECORDING_TLS_HOSTS_RE:-^(api\\.anthropic\\.com|api\\.fireworks\\.ai|api\\.github\\.com|raw\\.githubusercontent\\.com):443$}"
else
  RECORDING_TLS_HOSTS_RE="${RECORDING_TLS_HOSTS_RE:-^(api\\.anthropic\\.com|api\\.fireworks\\.ai):443$}"
fi

exec su -s /bin/sh -c "exec mitmdump \
  --mode transparent \
  --listen-port \"$MITM_PORT\" \
  --showhost \
  --allow-hosts \"$RECORDING_TLS_HOSTS_RE\" \
  --set block_global=false \
  --set confdir=/opt/recording/mitmproxy-conf \
  --scripts /opt/recording/addon.py" mitmproxy
