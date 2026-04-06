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

# Copy shared packages first (needed for repo-local dependencies)
COPY packages/ces-contracts ./packages/ces-contracts
COPY packages/credential-storage ./packages/credential-storage
COPY packages/egress-proxy ./packages/egress-proxy

# Install credential-executor dependencies with local package resolution
COPY credential-executor/package.json credential-executor/bun.lock* ./credential-executor/
RUN cd /app/credential-executor && bun install --frozen-lockfile

# Copy credential-executor source
COPY credential-executor ./credential-executor

# Runtime stage
FROM debian:trixie-slim@sha256:1d3c811171a08a5adaa4a163fbafd96b61b87aa871bbc7aa15431ac275d3d430 AS runner

WORKDIR /app/credential-executor

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Create non-root user
RUN groupadd --system --gid 1001 ces && \
    useradd --system --uid 1001 --gid ces --create-home ces

# Copy built app from builder
COPY --from=builder --chown=ces:ces /app /app

# Pre-create /ces-data so the non-root ces user can write to it
# when no PVC volume is mounted (e.g., direct docker run)
RUN mkdir -p /ces-data && chown ces:ces /ces-data

# Pre-create /ces-security for credential key storage (keys.enc, store.key)
RUN mkdir -p /ces-security && chown ces:ces /ces-security

USER ces

EXPOSE 8090

ENV CES_MODE=managed
ENV CES_HEALTH_PORT=8090

CMD ["bun", "run", "src/managed-main.ts"]
