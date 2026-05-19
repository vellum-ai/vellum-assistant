# Connection-telemetry sidecar image.
#
# Joins the assistant container's network namespace via
# `--network container:<assistant>` and tails `conntrack -E` to emit
# per-connection NDJSON records (host, port, bytes_sent, bytes_recv,
# duration_ms) on connection close. Independent of mitmproxy — works
# whether or not the recording jail is layered on top.
#
# Why conntrack (not `ss` polling): the recording-jail's iptables
# NAT REDIRECT rewrites outbound TCP/443 destinations to localhost
# before they reach `/proc/net/tcp`, so `ss` only sees the post-NAT
# loopback hop. Conntrack tracks the original pre-NAT 5-tuple plus
# packet/byte counters when `nf_conntrack_acct` is enabled — which is
# exactly what we need for "where did the assistant actually talk to,
# and how much."

FROM python:3.12-alpine

# `conntrack` userland is in conntrack-tools. `iproute2` provides `ip`
# for diagnostics. `tini` ensures we forward SIGTERM cleanly so the
# sidecar shuts down promptly when the harness stops the eval run.
RUN apk add --no-cache conntrack-tools iproute2 tini

COPY connection_tailer.py entrypoint.sh /opt/telemetry/
RUN chmod +x /opt/telemetry/entrypoint.sh

# Output volume target. The evals harness bind-mounts the per-run
# artifacts dir so the tailer can append NDJSON in place.
RUN mkdir -p /telemetry

ENV TELEMETRY_OUTPUT_PATH=/telemetry/egress-connections.ndjson

ENTRYPOINT ["/sbin/tini", "--", "/opt/telemetry/entrypoint.sh"]
