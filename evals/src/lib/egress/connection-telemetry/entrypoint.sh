#!/bin/sh
#
# Connection-telemetry sidecar entrypoint. Enables conntrack byte
# accounting (best-effort — fails silently if the kernel sysctl isn't
# writable, in which case the tailer still emits records but with
# zero byte counters), then execs the Python tailer.

set -eu

# `nf_conntrack_acct` enables packet/byte counters on every conntrack
# entry. It's a system-wide sysctl, not netns-scoped, so writing it
# from the sidecar's user-netns affects host conntrack behavior — but
# requires `--cap-add NET_ADMIN` and the sysctl to actually be writable
# from this container (Docker hides it by default unless the sidecar
# also has `--privileged` or the sysctl is bind-mounted in). When
# writable, the tailer's connection records carry real byte counts;
# when not, they carry zeros and a `acct=false` field so downstream
# tooling can disambiguate.
if sysctl -w net.netfilter.nf_conntrack_acct=1 >/dev/null 2>&1; then
  echo "[connection-telemetry] nf_conntrack_acct=1 enabled" >&2
  export TELEMETRY_ACCT_ENABLED=true
else
  echo "[connection-telemetry] could not enable nf_conntrack_acct (need --privileged or sysctl bind-mount) — byte counts will be zero" >&2
  export TELEMETRY_ACCT_ENABLED=false
fi

: "${TELEMETRY_OUTPUT_PATH:?TELEMETRY_OUTPUT_PATH not set}"

# Ensure the output file exists so flock-style consumers can hold an fd
# even before the first connection lands. The harness pre-creates it
# from the host side too, but the sidecar runs in a different netns and
# may see the file as freshly created if the bind-mount only just
# resolved.
touch "$TELEMETRY_OUTPUT_PATH" || true

exec python3 /opt/telemetry/connection_tailer.py
