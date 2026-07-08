# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# Build stage
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun (pinned version)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
ENV PATH="/root/.bun/bin:${PATH}"

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

RUN bun install --frozen-lockfile --ignore-scripts \
    --filter='./credential-executor'

# Runtime stage
FROM debian:trixie-slim@sha256:1d3c811171a08a5adaa4a163fbafd96b61b87aa871bbc7aa15431ac275d3d430 AS runner

WORKDIR /app/credential-executor

RUN apt-get update && apt-get install -y \
    ca-certificates \
    e2fsprogs \
    mount \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Create non-root user
RUN groupadd --system --gid 1001 ces && \
    useradd --system --uid 1001 --gid ces --create-home ces

COPY --from=builder --chown=ces:ces /app /app

# Copy source after installing dependencies for better layer caching.
COPY --chown=ces:ces packages/service-contracts /app/packages/service-contracts
COPY --chown=ces:ces packages/credential-storage /app/packages/credential-storage
COPY --chown=ces:ces packages/egress-proxy /app/packages/egress-proxy
COPY --chown=ces:ces credential-executor ./

# Pre-create /ces-data so the non-root ces user can write to it
# when no PVC volume is mounted (e.g., direct docker run)
RUN mkdir -p /ces-data && chown ces:ces /ces-data

# Pre-create /ces-security for credential key storage (keys.enc, store.key)
RUN mkdir -p /ces-security && chown ces:ces /ces-security

COPY packages/block-volume-bootstrap/scripts/*.sh /usr/local/bin/
RUN chmod +x \
    /usr/local/bin/vellum-block-volume-common.sh \
    /usr/local/bin/vellum-block-volume-init.sh \
    /usr/local/bin/vellum-block-volume-mount.sh \
    /usr/local/bin/vellum-block-volume-resize.sh

USER ces

EXPOSE 8090

ENV CES_MODE=managed
ENV CES_HEALTH_PORT=8090

CMD ["bun", "run", "src/main.ts"]
