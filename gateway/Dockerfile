# Bun binary source (pinned to SHA digest for immutable reference)
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun

# Build stage
FROM debian:trixie@sha256:3352c2e13876c8a5c5873ef20870e1939e73cb9a3c1aeba5e3e72172a85ce9ed AS builder

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

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

COPY --from=builder --chown=gateway:gateway /app /app

RUN mkdir -p /gateway-security && chown gateway:gateway /gateway-security

USER gateway

EXPOSE 7830

ENV GATEWAY_PORT=7830

CMD ["bun", "run", "src/index.ts"]
