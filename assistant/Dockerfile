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
    procps \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Install a vellum CLI launcher backed by the bundled local cli package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/cli/src/index.ts "$@"\n' > /usr/local/bin/vellum && \
    chmod +x /usr/local/bin/vellum

# Create non-root user that also has sudo access so it can like install stuff
RUN groupadd --system --gid 1001 assistant && \
    useradd --system --uid 1001 --gid assistant --create-home --shell /bin/bash assistant && \
    echo "assistant ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up data directory
RUN mkdir -p /home/assistant/.vellum /data && \
    chown -R assistant:assistant /home/assistant/.vellum /data && \
    chmod a+rwx /data

# Update PATH for assistant user
ENV PATH="/home/assistant/.bun/bin:/data/bin:${PATH}"

# Configure package managers to use /data
ENV BUN_INSTALL="/data/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV PYTHONUSERBASE="/data/.python"
ENV PATH="${PYTHONUSERBASE}/bin:${PATH}"

# Configure apt/dpkg to install future packages to /data.
# The actual /data directories are created at container startup by entrypoint.sh
# because /data is typically a mounted volume that hides build-time contents.
RUN echo 'Dir::State "/data/dpkg";' > /etc/apt/apt.conf.d/99data-dir && \
    echo 'Dir::State::status "/data/dpkg/status";' >> /etc/apt/apt.conf.d/99data-dir && \
    echo 'Dir::Cache "/data/apt/cache";' >> /etc/apt/apt.conf.d/99data-dir && \
    echo 'DPkg::Options {"--instdir=/data/usr";"--admindir=/data/dpkg";"--force-not-root";"--force-bad-path";};' >> /etc/apt/apt.conf.d/99data-dir

ENV PATH="/data/usr/bin:/data/usr/sbin:${PATH}"
ENV LD_LIBRARY_PATH="/data/usr/lib:/data/usr/lib/x86_64-linux-gnu:/data/usr/lib/aarch64-linux-gnu"

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

# Run the daemon + http server
ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "run", "src/daemon/main.ts"]
