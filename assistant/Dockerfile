# Use debian as base image
FROM debian:bookworm AS builder

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

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Final stage
FROM debian:bookworm AS runner

WORKDIR /app

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
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install bun in runner stage too
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Create non-root user that also has sudo access so it can like install stuff
RUN groupadd --system --gid 1001 assistant && \
    useradd --system --uid 1001 --gid assistant --create-home --shell /bin/bash assistant && \
    echo "assistant ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Copy from builder
COPY --from=builder /app /app

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
RUN mv /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# Configure apt/dpkg to install future packages to /data
RUN mkdir -p /data/dpkg/info /data/dpkg/updates /data/dpkg/triggers && \
    mkdir -p /data/usr/bin /data/usr/lib /data/usr/share && \
    chown -R assistant:assistant /data/dpkg /data/usr

# Create dpkg configuration for using /data as install prefix
RUN echo 'Dir::State "/data/dpkg";' > /etc/apt/apt.conf.d/99data-dir && \
    echo 'Dir::State::status "/data/dpkg/status";' >> /etc/apt/apt.conf.d/99data-dir && \
    echo 'Dir::Cache "/data/apt/cache";' >> /etc/apt/apt.conf.d/99data-dir && \
    echo 'DPkg::Options {"--instdir=/data/usr";"--admindir=/data/dpkg";"--force-not-root";"--force-bad-path";};' >> /etc/apt/apt.conf.d/99data-dir && \
    mkdir -p /data/apt/cache && \
    touch /data/dpkg/status && \
    chown -R assistant:assistant /data/apt /data/dpkg

ENV PATH="/data/usr/bin:/data/usr/sbin:${PATH}"
ENV LD_LIBRARY_PATH="/data/usr/lib:/data/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH}"

USER assistant

# Expose ports:
EXPOSE 3001

ENV RUNTIME_HTTP_PORT=3001
ENV VELLUM_DAEMON_SOCKET=/home/assistant/.vellum/vellum.sock
ENV BASE_DATA_DIR=/data

# Run the daemon + http server
CMD ["bun", "run", "src/daemon/main.ts"]
