# Build stage
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Runtime stage
FROM debian:trixie-slim@sha256:1d3c811171a08a5adaa4a163fbafd96b61b87aa871bbc7aa15431ac275d3d430 AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun

RUN groupadd --system --gid 1001 proxysidecar && \
    useradd --system --uid 1001 --gid proxysidecar --create-home proxysidecar

COPY --from=builder --chown=proxysidecar:proxysidecar /app /app

USER proxysidecar

# Proxy port
EXPOSE 8080
# Health/readiness port
EXPOSE 8081

ENV PROXY_PORT=8080
ENV PROXY_HEALTH_PORT=8081
ENV PROXY_HOST=0.0.0.0

CMD ["bun", "run", "src/main.ts"]
