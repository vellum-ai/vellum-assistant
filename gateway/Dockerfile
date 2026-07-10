# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# Bun binary source (pinned to SHA digest for immutable reference)
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun

# Build stage
FROM debian:trixie@sha256:3352c2e13876c8a5c5873ef20870e1939e73cb9a3c1aeba5e3e72172a85ce9ed AS builder

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# We must include every workspace member's manifest to validate and install the
# workspace lockfile via --frozen-lockfile.
# Note that we don't need source code to resolve cross-workspace dependencies.
COPY package.json bun.lock ./
COPY patches ./patches
COPY clients/macos/package.json ./clients/macos/
COPY clients/web/package.json ./clients/web/
COPY cli/package.json ./cli/
COPY gateway/package.json ./gateway/
COPY credential-executor/package.json ./credential-executor/
COPY assistant/package.json ./assistant/
COPY assistant/src/api/package.json ./assistant/src/api/
COPY --parents packages/*/package.json ./

RUN bun install --frozen-lockfile --ignore-scripts --production \
    --filter='./gateway'

# Runtime stage
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS runner

WORKDIR /app

RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    ca-certificates \
    e2fsprogs \
    iproute2 \
    mount \
    procps \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun

RUN groupadd --system --gid 1001 gateway && \
    useradd --system --uid 1001 --gid gateway --create-home gateway

COPY --from=builder --chown=gateway:gateway /app /app

# Copy source after installing dependencies for better layer caching.
COPY --chown=gateway:gateway packages/assistant-client /app/packages/assistant-client
COPY --chown=gateway:gateway packages/ces-client /app/packages/ces-client
COPY --chown=gateway:gateway packages/download-validation /app/packages/download-validation
COPY --chown=gateway:gateway packages/gateway-client /app/packages/gateway-client
COPY --chown=gateway:gateway packages/ipc-server-utils /app/packages/ipc-server-utils
COPY --chown=gateway:gateway packages/service-contracts /app/packages/service-contracts
COPY --chown=gateway:gateway packages/slack-text /app/packages/slack-text
COPY --chown=gateway:gateway packages/twilio-client /app/packages/twilio-client
COPY --chown=gateway:gateway gateway /app/gateway

RUN mkdir -p /gateway-security && chown gateway:gateway /gateway-security

COPY packages/block-volume-bootstrap/scripts/*.sh /usr/local/bin/
RUN chmod +x \
    /usr/local/bin/vellum-block-volume-common.sh \
    /usr/local/bin/vellum-block-volume-init.sh \
    /usr/local/bin/vellum-block-volume-mount.sh \
    /usr/local/bin/vellum-block-volume-resize.sh

USER gateway

# RISK: gateway moved from /app to /app/gateway. The k8s command is
# workdir-relative and still works; anything using old absolute /app/...
# gateway paths breaks. Canary before fleet rollout.
WORKDIR /app/gateway

EXPOSE 7830

ENV GATEWAY_PORT=7830

CMD ["bun", "--smol", "run", "src/index.ts"]
