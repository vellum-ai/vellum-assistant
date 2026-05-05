# Use debian as base image
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install bun (pinned version)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
ENV PATH="/root/.bun/bin:${PATH}"

# Copy shared packages needed by assistant's repo-local dependencies
COPY packages/ces-client ./packages/ces-client
COPY packages/service-contracts ./packages/service-contracts
COPY packages/credential-storage ./packages/credential-storage
COPY packages/egress-proxy ./packages/egress-proxy
COPY packages/gateway-client ./packages/gateway-client
COPY packages/skill-host-contracts ./packages/skill-host-contracts
COPY packages/slack-text ./packages/slack-text
COPY packages/twilio-client ./packages/twilio-client

# Install deps for shared packages that have their own file: dependencies.
# Without this, bun's module resolution at runtime walks up from e.g.
# packages/ces-client/src/ and never finds the transitive dependency
# (ces-contracts) because only assistant/node_modules gets populated.
RUN cd /app/packages/ces-client && bun install --frozen-lockfile
RUN cd /app/packages/gateway-client && bun install --frozen-lockfile

# Install assistant dependencies first for cache reuse
COPY assistant/package.json assistant/bun.lock ./assistant/
RUN cd /app/assistant && bun install --frozen-lockfile

# Copy bundled first-party skills and install their deps. The repo-root
# .dockerignore is the single source of truth for which skills (and which
# files within them) ship in the assistant image -- adding or removing a
# bundled skill is a .dockerignore edit, not a Dockerfile edit.
COPY skills ./skills
RUN set -eu; for pkg in /app/skills/*/package.json; do \
      [ -e "$pkg" ] || continue; \
      dir="$(dirname "$pkg")"; \
      echo "Installing dependencies for $dir"; \
      (cd "$dir" && (bun install --frozen-lockfile 2>/dev/null || bun install)); \
    done

# Copy assistant source so emit-manifest can resolve the skill's remaining
# `../../assistant/src/...` imports while walking the register() module
# graph. Those imports disappear when skill-isolation Phase 1 completes
# (plan PR 18); the collector host short-circuits before any runtime path
# touches them, so the emitted manifest is correct in the meantime.
COPY assistant ./assistant

# Emit the meet-join manifest consumed by the daemon-side loader to
# register proxy tools/routes without importing the skill in-process.
RUN bun run /app/skills/meet-join/scripts/emit-manifest.ts \
      --output /app/skills/meet-join/manifest.json

# Final stage
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS runner

WORKDIR /app/assistant

# Install runtime dependencies for Playwright and tree-sitter
RUN apt-get update && apt-get install -y \
    bubblewrap \
    ca-certificates \
    curl \
    ffmpeg \
    fonts-freefont-ttf \
    g++ \
    git \
    htop \
    jq \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libfreetype6 \
    libgbm1 \
    libharfbuzz0b \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxtst6 \
    lsof \
    make \
    openssl \
    procps \
    python3 \
    sqlite3 \
    sudo \
    unzip \
    uuid-runtime \
    vim \
    xclip \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

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

USER root

EXPOSE 3001

ENV RUNTIME_HTTP_PORT=3001
ENV IS_CONTAINERIZED=true

# Copy installed deps, shared packages, bundled skills, assistant source,
# and the generated meet-join manifest from the builder stage.
COPY --from=builder /app /app

RUN chmod +x /app/assistant/docker-entrypoint.sh

# Run the daemon + http server
CMD ["/app/assistant/docker-entrypoint.sh"]
