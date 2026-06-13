# Recording-jail sidecar image.
#
# Layers a transparent-mode mitmproxy on top of the same iptables
# DROP-by-default outbound policy the regular egress jail uses. The
# mitmproxy process intercepts outbound TCP/443 traffic from the
# assistant container (which shares this container's netns via
# `--network container:<assistant>`) and writes per-request LLM usage
# records to a host-mounted NDJSON file for the evals harness to read.
#
# Built locally on first `evals run` — see `docker-jail.ts`'s
# `ensureRecordingJailImage()`. We don't depend on a registry push so
# the workflow stays "git pull, evals run, done."

# `mitmproxy/mitmproxy` is built on Debian and ships mitmdump + the
# Python interpreter. Pinning by digest would be ideal; pinning by
# version tag is close enough for an evals-internal sidecar.
FROM mitmproxy/mitmproxy:11.0.2

USER root

# `iptables` + `iproute2` for the netns policy. `conntrack` lets the
# apply script flush pre-jail flows so connections the assistant opened
# before the jail attached are re-evaluated against the NAT REDIRECT
# rather than bypassing it. `getent` (for hostname resolution in the
# apply script) is in `libc-bin` which is already in the base image.
# `su` is from `util-linux` (also already in base).
RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables iproute2 conntrack \
  && rm -rf /var/lib/apt/lists/*

# The base image already ships a UID-1000 user named `mitmproxy`
# (verified on `mitmproxy/mitmproxy:11.0.2`). Assert that contract holds
# so apply-recording-jail.sh's REDIRECT exemption matches by
# `--uid-owner 1000` consistently; bail loudly at build time if the
# base image ever drops or renumbers it.
RUN id -u mitmproxy >/dev/null 2>&1 \
  && [ "$(id -u mitmproxy)" = "1000" ]

COPY apply-recording-jail.sh entrypoint.sh /opt/recording/
COPY addon.py usage_parser.py mock_github_handler.py /opt/recording/
RUN chmod +x /opt/recording/apply-recording-jail.sh /opt/recording/entrypoint.sh \
  && chown -R mitmproxy:mitmproxy /opt/recording

# Pre-generate the mitmproxy CA at build time. The CA file is needed
# in the assistant container's trust store before any plugin install
# runs — the entrypoint copies it to /recording at startup, then
# docker-jail.ts grabs it from the bind-mount and installs it into
# the assistant container.
#
# mitmproxy generates the CA on first launch in `confdir`. Running
# mitmdump briefly on an unused port forces the cert chain to land on
# disk; we then kill it and assert the file exists so the build fails
# loudly if the upstream image ever changes this behavior. Pinning
# the CA at build means every container instance trusts the same CA
# (acceptable for an eval-local sidecar; would not be for a multi-
# tenant proxy).
RUN su -s /bin/sh -c '\
  mitmdump --set confdir=/home/mitmproxy/.mitmproxy --listen-port 19999 & \
  PID=$!; \
  i=0; \
  while [ ! -f /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem ] && [ $i -lt 50 ]; do \
    sleep 0.1; \
    i=$((i+1)); \
  done; \
  kill $PID 2>/dev/null; \
  wait $PID 2>/dev/null || true; \
  [ -f /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem ]\
' mitmproxy

# Recording output volume target. The `evals run` harness mounts the
# per-run artifacts dir here so mitmproxy writes egress-usage.ndjson
# into the right place. Pre-create as a directory so the bind-mount has
# the correct semantics if it's missing on the host.
RUN mkdir -p /recording \
  && chown mitmproxy:mitmproxy /recording

ENV MITM_UID=1000
ENV MITM_PORT=8443
ENV RECORDING_OUTPUT_PATH=/recording/egress-usage.ndjson

ENTRYPOINT ["/opt/recording/entrypoint.sh"]
