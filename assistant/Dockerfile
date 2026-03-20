# Use debian as base image
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Copy shared packages needed by assistant's repo-local dependencies
COPY packages/ces-contracts ./packages/ces-contracts
COPY packages/credential-storage ./packages/credential-storage
COPY packages/egress-proxy ./packages/egress-proxy

# Install assistant dependencies first for cache reuse
COPY assistant/package.json assistant/bun.lock ./assistant/
RUN cd /app/assistant && bun install --frozen-lockfile

# Copy source
COPY assistant ./assistant

# Copy meta directory (provider-env-vars.json is imported at runtime by secure-keys.ts)
COPY meta ./meta

# Final stage
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS runner

WORKDIR /app/assistant

# Install runtime dependencies for Playwright and tree-sitter
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ca-certificates \
    python3 \
    libnss3 \
    libfreetype6 \
    libharfbuzz0b \
    fonts-freefont-ttf \
    make \
    g++ \
    git \
    sudo \
    bubblewrap \
    htop \
    procps \
    && rm -rf /var/lib/apt/lists/*

## Alias bwrap to bubblewrap
RUN ln -sf /usr/bin/bwrap /usr/bin/bubblewrap

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Install assistant CLI launcher backed by the bundled assistant package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/assistant/src/index.ts "$@"\n' > /usr/local/bin/assistant && \
    chmod +x /usr/local/bin/assistant

# Create non-root user that also has sudo access so it can like install stuff
RUN groupadd --system --gid 1001 assistant && \
    useradd --system --uid 1001 --gid assistant --create-home --shell /bin/bash assistant && \
    echo "assistant ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up assistant home directory for local state (device.json, etc.)
RUN mkdir -p /home/assistant/.vellum && \
    chown -R assistant:assistant /home/assistant/.vellum

# Update PATH for assistant user
ENV PATH="/home/assistant/.bun/bin:${PATH}"

# Configure package managers to use assistant home
ENV BUN_INSTALL="/home/assistant/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV PYTHONUSERBASE="/home/assistant/.python"
ENV PATH="${PYTHONUSERBASE}/bin:${PATH}"

# Ensure the CES bootstrap socket volume is writable by the non-root CES user.
RUN mkdir -p /run/ces-bootstrap && chmod 777 /run/ces-bootstrap

USER assistant

EXPOSE 3001

ENV RUNTIME_HTTP_PORT=3001
ENV IS_CONTAINERIZED=true

# Copy from builder
COPY --from=builder /app /app

# Run the daemon + http server
CMD ["bun", "run", "src/daemon/main.ts"]
