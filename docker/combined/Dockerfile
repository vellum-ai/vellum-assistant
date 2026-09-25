# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# assistant-base is the canonical assistant/Dockerfile target in docker-bake.hcl.
FROM assistant-base AS combined

USER root
WORKDIR /app
COPY gateway /app/gateway
COPY credential-executor /app/credential-executor
COPY packages/assistant-client /app/packages/assistant-client
RUN --mount=type=cache,id=bun-install-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts \
    --filter='./assistant' --filter='./assistant/src/api' \
    --filter='./gateway' --filter='./credential-executor'
RUN /usr/bin/apt-get update && /usr/bin/apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /mnt/assistant /run/vellum-combined \
    && ln -s /mnt/assistant/assistant-data /data \
    && ln -s /mnt/assistant/workspace /workspace
COPY docker/combined/*.py /app/combined/

EXPOSE 7830
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=10s --start-period=300s --retries=3 \
    CMD ["python3", "/app/combined/launcher.py", "check"]
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "python3", "/app/combined/launcher.py"]
CMD ["serve"]
