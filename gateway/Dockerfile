# Bun binary source (pinned to SHA digest for immutable reference)
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS bun

# Build stage
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS builder

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Runtime stage
FROM debian:trixie-slim@sha256:1d3c811171a08a5adaa4a163fbafd96b61b87aa871bbc7aa15431ac275d3d430 AS runner

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
