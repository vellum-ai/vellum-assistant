# Bun binary source (pinned to SHA digest for immutable reference)
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun

# Build stage
FROM debian:trixie@sha256:3352c2e13876c8a5c5873ef20870e1939e73cb9a3c1aeba5e3e72172a85ce9ed AS builder

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Copy shared packages needed by gateway's repo-local dependencies
COPY packages/assistant-client ./packages/assistant-client
COPY packages/ces-client ./packages/ces-client
COPY packages/ipc-server-utils ./packages/ipc-server-utils
COPY packages/service-contracts ./packages/service-contracts
COPY packages/slack-text ./packages/slack-text
COPY packages/twilio-client ./packages/twilio-client

# Install deps for shared packages that have their own file: dependencies.
RUN cd /app/packages/ces-client && bun install --frozen-lockfile

# Install gateway dependencies first for cache reuse
COPY gateway/package.json gateway/bun.lock ./gateway/
RUN cd /app/gateway && bun install --frozen-lockfile --production

# Copy source
COPY gateway ./gateway

# Runtime stage
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS runner

WORKDIR /app

RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    ca-certificates \
    iproute2 \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun

RUN groupadd --system --gid 1001 gateway && \
    useradd --system --uid 1001 --gid gateway --create-home gateway

COPY --from=builder --chown=gateway:gateway /app/gateway /app
# `bun install` materializes repo-local file: dependencies as symlinks in
# node_modules pointing at absolute paths in the builder stage.
# Copy the sibling packages into the runner so the symlinks resolve.
COPY --from=builder --chown=gateway:gateway /app/packages /app/packages

RUN mkdir -p /gateway-security && chown gateway:gateway /gateway-security

USER gateway

EXPOSE 7830

ENV GATEWAY_PORT=7830

CMD ["bun", "run", "src/index.ts"]
