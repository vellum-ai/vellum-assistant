# Use debian as base image
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install assistant and CLI dependencies first for cache reuse
COPY assistant/package.json assistant/bun.lock ./assistant/
RUN cd /app/assistant && bun install --frozen-lockfile

COPY cli/package.json cli/bun.lock ./cli/
RUN cd /app/cli && bun install --frozen-lockfile

# Copy source
COPY assistant ./assistant
COPY cli ./cli

# Final stage
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db AS runner

WORKDIR /app/assistant

# Install runtime dependencies for Playwright and tree-sitter
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    ca-certificates \
    debconf \
    debootstrap \
    debian-archive-keyring \
    python3 \
    libnss3 \
    libfreetype6 \
    libharfbuzz0b \
    fonts-freefont-ttf \
    make \
    g++ \
    git \
    procps \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Install a vellum CLI launcher backed by the bundled local cli package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/cli/src/index.ts "$@"\n' > /usr/local/bin/vellum && \
    chmod +x /usr/local/bin/vellum

# Route apt/dpkg commands into the persistent /data rootfs when available.
RUN printf '%s\n' \
    '#!/usr/bin/env sh' \
    'export DEBIAN_FRONTEND=noninteractive' \
    'if [ -x /data/bin/sh ] && [ -x /data/usr/bin/apt-get ] && [ -f /data/.rootfs-initialized ] && ! grep -qs " /data .*noexec" /proc/mounts; then' \
    '  if [ $# -eq 0 ]; then' \
    '    exec chroot /data /usr/bin/apt-get' \
    '  fi' \
    '  exec chroot /data /usr/bin/apt-get "$@"' \
    'fi' \
    'if [ $# -eq 0 ]; then' \
    '  exec /usr/bin/apt-get' \
    'fi' \
    'exec /usr/bin/apt-get "$@"' \
    > /usr/local/bin/apt-get && \
    chmod +x /usr/local/bin/apt-get && \
    printf '%s\n' \
    '#!/usr/bin/env sh' \
    'export DEBIAN_FRONTEND=noninteractive' \
    'if [ -x /data/bin/sh ] && [ -x /data/usr/bin/apt ] && [ -f /data/.rootfs-initialized ] && ! grep -qs " /data .*noexec" /proc/mounts; then' \
    '  if [ $# -eq 0 ]; then' \
    '    exec chroot /data /usr/bin/apt' \
    '  fi' \
    '  exec chroot /data /usr/bin/apt "$@"' \
    'fi' \
    'if [ $# -eq 0 ]; then' \
    '  exec /usr/bin/apt' \
    'fi' \
    'exec /usr/bin/apt "$@"' \
    > /usr/local/bin/apt && \
    chmod +x /usr/local/bin/apt && \
    printf '%s\n' \
    '#!/usr/bin/env sh' \
    'if [ -x /data/bin/sh ] && [ -x /data/usr/bin/dpkg ] && [ -f /data/.rootfs-initialized ] && ! grep -qs " /data .*noexec" /proc/mounts; then' \
    '  if [ $# -eq 0 ]; then' \
    '    exec chroot /data /usr/bin/dpkg' \
    '  fi' \
    '  exec chroot /data /usr/bin/dpkg "$@"' \
    'fi' \
    'if [ $# -eq 0 ]; then' \
    '  exec /usr/bin/dpkg' \
    'fi' \
    'exec /usr/bin/dpkg "$@"' \
    > /usr/local/bin/dpkg && \
    chmod +x /usr/local/bin/dpkg

# Create non-root user that also has sudo access so it can like install stuff
RUN groupadd --system --gid 1001 assistant && \
    useradd --system --uid 1001 --gid assistant --create-home --shell /bin/bash assistant && \
    echo "assistant ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up data directory
RUN mkdir -p /home/assistant/.vellum /data && \
    chown -R assistant:assistant /home/assistant/.vellum /data && \
    chmod a+rwx /data

# Configure package managers to use /data
ENV BUN_INSTALL="/data/.bun"
ENV PYTHONUSERBASE="/data/.python"
# Update PATH with host tools first, then user/package managers, then /data.
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/assistant/.bun/bin:${BUN_INSTALL}/bin:${PYTHONUSERBASE}/bin:/data/bin:/data/usr/local/sbin:/data/usr/local/bin:/data/usr/sbin:/data/usr/bin:/data/sbin"

ENV DEBIAN_FRONTEND=noninteractive

ENV LD_LIBRARY_PATH="/data/usr/local/lib:/data/usr/lib:/data/usr/lib/x86_64-linux-gnu:/data/usr/lib/aarch64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

USER root

EXPOSE 3001

ENV RUNTIME_HTTP_PORT=3001
ENV BASE_DATA_DIR=/data
ENV IS_CONTAINERIZED=true

# Copy from builder
COPY --from=builder /app /app

# Entrypoint initializes /data directory structure for apt/dpkg on mounted volumes
COPY assistant/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "src/daemon/main.ts"]
