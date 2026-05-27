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

export MITM_UID MITM_PORT RECORDING_OUTPUT_PATH

# Phase 1: install iptables rules in this container's network namespace.
/opt/recording/apply-recording-jail.sh

# Make sure the output directory exists and is writable by the mitmproxy user.
mkdir -p "$(dirname "$RECORDING_OUTPUT_PATH")"
touch "$RECORDING_OUTPUT_PATH"
chown -R "$MITM_UID":"$MITM_UID" "$(dirname "$RECORDING_OUTPUT_PATH")"

# Phase 2: drop privileges and run mitmdump in transparent mode.
# `--mode transparent` makes mitmproxy honor the iptables REDIRECT.
# `--listen-port $MITM_PORT` matches the REDIRECT target.
# `--showhost` makes the request URL use the original Host header so
#   the addon sees `api.anthropic.com` not the rewritten dest.
# `--allow-hosts <regex>` restricts TLS interception to Anthropic only.
#   Everything else gets pure-TCP passthrough — important because:
#   (a) the CA cert is only baked into the assistant container; gateway
#       + credential-executor share the netns but don't trust the CA,
#       so MITM'ing their outbound calls would break TLS for them.
#   (b) the v1 addon only parses Anthropic responses; intercepting
#       other providers is gross waste with no recording payoff.
#   When ALLOW_HOSTS is empty, fall back to api.anthropic.com.
# `--set block_global=false` allows transparent-mode traffic from
#   localhost (the assistant container shares netns with us).
ALLOW_HOSTS="${ALLOW_HOSTS:-api.anthropic.com}"
RECORDING_TLS_HOSTS_RE="${RECORDING_TLS_HOSTS_RE:-^api\\.anthropic\\.com:443$}"

exec su -s /bin/sh -c "exec mitmdump \
  --mode transparent \
  --listen-port \"$MITM_PORT\" \
  --showhost \
  --allow-hosts \"$RECORDING_TLS_HOSTS_RE\" \
  --set block_global=false \
  --set confdir=/home/mitmproxy/.mitmproxy \
  --scripts /opt/recording/addon.py" mitmproxy
