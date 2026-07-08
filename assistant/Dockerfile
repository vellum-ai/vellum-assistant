# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
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
    --filter='./assistant' --filter='./assistant/src/api'

# The repo-root .dockerignore decides which skills (and files) ship.
COPY skills ./skills
RUN set -eu; for pkg in /app/skills/*/package.json; do \
      [ -e "$pkg" ] || continue; \
      dir="$(dirname "$pkg")"; \
      echo "Installing dependencies for $dir"; \
      (cd "$dir" && (bun install --frozen-lockfile 2>/dev/null || bun install)); \
    done


# Final stage
FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS runner

WORKDIR /app/assistant

# Install runtime dependencies for Playwright and tree-sitter
RUN apt-get update && apt-get install -y \
    bubblewrap \
    ca-certificates \
    curl \
    debootstrap \
    debian-archive-keyring \
    debconf \
    e2fsprogs \
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
    mount \
    openssl \
    procps \
    python3 \
    sqlite3 \
    sudo \
    util-linux \
    util-linux-extra \
    unzip \
    uuid-runtime \
    vim \
    wget \
    xclip \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

COPY --from=builder /app /app

# Copy source after installing dependencies for better layer caching.
COPY packages/ces-client /app/packages/ces-client
COPY packages/service-contracts /app/packages/service-contracts
COPY packages/credential-storage /app/packages/credential-storage
COPY packages/egress-proxy /app/packages/egress-proxy
COPY packages/environments /app/packages/environments
COPY packages/gateway-client /app/packages/gateway-client
COPY packages/ipc-server-utils /app/packages/ipc-server-utils
COPY packages/slack-text /app/packages/slack-text
COPY packages/twilio-client /app/packages/twilio-client

COPY assistant /app/assistant

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

RUN printf '%s\n' \
    'if [ -r /app/assistant/docker-kata-apt-env.sh ]; then' \
    '  . /app/assistant/docker-kata-apt-env.sh' \
    'fi' \
    > /etc/profile.d/vellum-kata-apt-root.sh && \
    printf '%s\n' \
    '' \
    'if [ -r /etc/profile.d/vellum-kata-apt-root.sh ]; then' \
    '  . /etc/profile.d/vellum-kata-apt-root.sh' \
    'fi' \
    >> /etc/bash.bashrc && \
    printf '%s\n' \
    '' \
    'if [ -r /etc/profile.d/vellum-kata-apt-root.sh ]; then' \
    '  . /etc/profile.d/vellum-kata-apt-root.sh' \
    'fi' \
    >> /root/.bashrc && \
    printf '%s\n' \
    '' \
    'if [ -r /etc/profile.d/vellum-kata-apt-root.sh ]; then' \
    '  . /etc/profile.d/vellum-kata-apt-root.sh' \
    'fi' \
    >> /home/assistant/.bashrc && \
    chown assistant:assistant /home/assistant/.bashrc

RUN printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '. /app/assistant/docker-kata-runtime-family.sh' \
    'if ! vellum_is_kata_family_runtime; then' \
    '  exec /usr/bin/apt-get "$@"' \
    'fi' \
    'export DEBIAN_FRONTEND=noninteractive' \
    'DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"' \
    '/app/assistant/docker-init-apt-root.sh' \
    'if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt-get" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then' \
    '  exec chroot "${DATA_ROOT}" /usr/bin/apt-get "$@"' \
    'fi' \
    'exec /usr/bin/apt-get "$@"' \
    > /usr/local/bin/apt-get && \
    chmod +x /usr/local/bin/apt-get && \
    printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '. /app/assistant/docker-kata-runtime-family.sh' \
    'if ! vellum_is_kata_family_runtime; then' \
    '  exec /usr/bin/apt "$@"' \
    'fi' \
    'export DEBIAN_FRONTEND=noninteractive' \
    'DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"' \
    '/app/assistant/docker-init-apt-root.sh' \
    'if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/apt" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then' \
    '  exec chroot "${DATA_ROOT}" /usr/bin/apt "$@"' \
    'fi' \
    'exec /usr/bin/apt "$@"' \
    > /usr/local/bin/apt && \
    chmod +x /usr/local/bin/apt && \
    printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '. /app/assistant/docker-kata-runtime-family.sh' \
    'if ! vellum_is_kata_family_runtime; then' \
    '  exec /usr/bin/dpkg "$@"' \
    'fi' \
    'DATA_ROOT="${VELLUM_APT_DATA_ROOT:-/data/system}"' \
    '/app/assistant/docker-init-apt-root.sh' \
    'if [ -x "${DATA_ROOT}/bin/sh" ] && [ -x "${DATA_ROOT}/usr/bin/dpkg" ] && [ -f "${DATA_ROOT}/.rootfs-initialized" ] && ! grep -qs " ${DATA_ROOT} .*noexec" /proc/mounts; then' \
    '  exec chroot "${DATA_ROOT}" /usr/bin/dpkg "$@"' \
    'fi' \
    'exec /usr/bin/dpkg "$@"' \
    > /usr/local/bin/dpkg && \
    chmod +x /usr/local/bin/dpkg

# Ensure the CES bootstrap socket volume is writable by the non-root CES user.
RUN mkdir -p /run/ces-bootstrap && chmod 777 /run/ces-bootstrap

USER root

EXPOSE 3001

ENV RUNTIME_HTTP_PORT=3001
ENV IS_CONTAINERIZED=true

COPY packages/block-volume-bootstrap/scripts/*.sh /usr/local/bin/

RUN chmod +x \
    /app/assistant/docker-entrypoint.sh \
    /app/assistant/docker-init-apt-root.sh \
    /app/assistant/docker-kata-apt-env.sh \
    /app/assistant/docker-kata-runtime-family.sh \
    /usr/local/bin/vellum-block-volume-common.sh \
    /usr/local/bin/vellum-block-volume-init.sh \
    /usr/local/bin/vellum-block-volume-mount.sh \
    /usr/local/bin/vellum-block-volume-resize.sh

# Run the daemon + http server
CMD ["/app/assistant/docker-entrypoint.sh"]
