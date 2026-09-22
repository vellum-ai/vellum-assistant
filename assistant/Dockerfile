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
COPY --parents clients/*/package.json ./
COPY cli/package.json ./cli/
COPY gateway/package.json ./gateway/
COPY credential-executor/package.json ./credential-executor/
COPY assistant/package.json ./assistant/
COPY assistant/src/api/package.json ./assistant/src/api/
COPY --parents packages/*/package.json ./

RUN --mount=type=cache,id=bun-install-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts \
    --filter='./assistant' --filter='./assistant/src/api'

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
    python3-pip \
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

# Desktop system packages persist through container replacement as image layers.
COPY assistant/docker/mousepad/90-vellum.gschema.override /usr/share/glib-2.0/schemas/90-vellum.gschema.override
RUN set -eu; \
    wezterm_version=20240203-110809-5046fc22; \
    case "$(dpkg --print-architecture)" in \
        amd64) wezterm_suffix=Debian12.deb; wezterm_sha256=d3a5c97093fbc0a87e8f9616e44efc4c9503cfc495fd1cfe4ffeff88578d15f8 ;; \
        arm64) wezterm_suffix=Debian12.arm64.deb; wezterm_sha256=351f8791c6e9561d687afa63834a2132de84800dad6e7c3d035cc6518d6c3744 ;; \
        *) echo "Unsupported desktop architecture" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --proto '=https' --proto-redir '=https' \
        --retry 2 --max-time 300 --output /tmp/wezterm.deb \
        "https://github.com/wezterm/wezterm/releases/download/${wezterm_version}/wezterm-${wezterm_version}.${wezterm_suffix}"; \
    printf '%s  /tmp/wezterm.deb\n' "$wezterm_sha256" | sha256sum --check -; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        adwaita-icon-theme \
        at-spi2-core \
        bamfdaemon \
        dbus-daemon \
        dbus-x11 \
        feh \
        fonts-liberation \
        gnome-mines \
        gvfs \
        libcurl4 \
        libegl1 \
        libgl1-mesa-dri \
        libgtk-3-0 \
        libvulkan1 \
        mousepad \
        openbox \
        plank \
        python3 \
        python3-dbus \
        scrot \
        thunar \
        tigervnc-common \
        tigervnc-standalone-server \
        tumbler \
        xauth \
        xcompmgr \
        xdotool \
        xfonts-base \
        xterm \
        /tmp/wezterm.deb; \
    /usr/lib/*/glib-2.0/glib-compile-schemas --strict /usr/share/glib-2.0/schemas; \
    mkdir -p /etc/xdg; \
    awk -v desktop_id=org.xfce.mousepad.desktop \
        'BEGIN { print "[Default Applications]" } /^MimeType=/ { sub(/^MimeType=/, ""); count = split($0, types, ";"); for (i = 1; i <= count; i++) { if (types[i] != "") { print types[i] "=" desktop_id ";" } } }' \
        /usr/share/applications/org.xfce.mousepad.desktop > /etc/xdg/mimeapps.list; \
    wezterm --version; \
    rm -rf /tmp/wezterm.deb /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# Extract Chrome without running package scripts or registering its repository.
RUN set -eu; \
    chrome_version=153.0.8010.36-1; \
    chrome_arch="$(dpkg --print-architecture)"; \
    case "$chrome_arch" in \
        amd64) chrome_sha256=9bb44e33031c2f2857cf36b4343051a12f93058e4b781e3c76313df87f6c8d32 ;; \
        arm64) chrome_sha256=1fcf6ec51a9d52e26ff1ad807225f725be55069ad2b68c5d69361a2746665188 ;; \
        *) echo "Unsupported Chrome architecture" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --proto '=https' --proto-redir '=https' \
        --retry 2 --max-time 300 --output /tmp/chrome.deb \
        "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${chrome_version}_${chrome_arch}.deb"; \
    printf '%s  /tmp/chrome.deb\n' "$chrome_sha256" | sha256sum --check -; \
    dpkg-deb --extract /tmp/chrome.deb /; \
    /opt/google/chrome/chrome --version; \
    rm /tmp/chrome.deb

# Copy bun binary from builder instead of re-installing
COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

COPY --link --from=builder /app /app

# Copy source after installing dependencies for better layer caching.
COPY packages/app-icons /app/packages/app-icons
COPY packages/avatar-catalog /app/packages/avatar-catalog
COPY packages/avatar-manifest /app/packages/avatar-manifest
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

# Resolve production workspace dependencies from the filesystem layout shipped
# in the image.
RUN bun run scripts/smoke-container-workspace-dependencies.ts

# The repo-root .dockerignore decides which skills (and files) ship.
COPY skills /app/skills

# Materialize the git-ignored offline marketplace and reviewed local packages.
# The build installs with --ignore-scripts, so the postinstall sync that creates
# these static imports in development never runs here.
COPY plugins /app/plugins
COPY meta/sync-bundled-copies.ts /app/meta/
RUN cd /app && bun run meta/sync-bundled-copies.ts --plugins-only && \
    bun run assistant/scripts/generate-bundled-plugin-packages.ts

# Install assistant CLI launcher backed by the bundled assistant package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/assistant/src/index.ts "$@"\n' > /usr/local/bin/assistant && \
    chmod +x /usr/local/bin/assistant

# The image ships no Node, so `bunx <pkg>` follows a bin's `#!/usr/bin/env node`
# shebang into this launcher. It hands off to a real Node when one is installed
# later and otherwise runs the bin under Bun with the auto-serve shim preloaded,
# so a CLI whose bundle default-exports an object with `fetch` exits instead of
# being turned into an HTTP server by `bun:main`. Installing it here also stops
# Bun synthesizing its own `node` shim in /tmp/bun-node-<hash> at daemon launch.
RUN ln -s /app/assistant/docker-node-launcher.sh /usr/local/bin/node

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

# apt/apt-get/dpkg must persist like pip: on Kata-family runtimes the wrapper
# routes package operations into the persistent apt chroot.
RUN ln -s /app/assistant/docker-kata-apt-wrapper.sh /usr/local/bin/apt-get && \
    ln -s /app/assistant/docker-kata-apt-wrapper.sh /usr/local/bin/apt && \
    ln -s /app/assistant/docker-kata-apt-wrapper.sh /usr/local/bin/dpkg

# pip must persist like apt: on Kata-family runtimes the wrapper routes root
# installs into the persistent apt chroot.
RUN ln -s /app/assistant/docker-kata-pip.sh /usr/local/bin/pip && \
    ln -s /app/assistant/docker-kata-pip.sh /usr/local/bin/pip3

# .pth files (pip install -e) are only processed for site directories, not
# PYTHONPATH entries — register the persistent chroot dirs as site dirs.
RUN cp /app/assistant/docker-sitecustomize.py /usr/lib/python3/dist-packages/sitecustomize.py

# Reword Debian's stock externally-managed refusal (shipped with python3, so
# this refusal exists on every runtime regardless): `python3 -m pip install`
# bypasses the pip wrappers, so its error must steer users to paths that
# actually work. Venv advice is correct everywhere; the bare `pip install`
# route only persists on kata-family machines, so it is worded conditionally.
RUN printf '%s\n' \
    '[externally-managed]' \
    'Error=This Python environment is part of the container image and does not' \
    ' persist. Create a virtualenv under a persistent directory instead, e.g.' \
    ' `python3 -m venv /workspace/.venv`. On managed machines with a' \
    ' persistent system root, `sudo pip install <pkg>` (not `python3 -m pip`)' \
    ' also persists. Passing --break-system-packages installs into the image' \
    ' rootfs and will NOT survive a machine save or container restart.' \
    > "/usr/lib/python$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')/EXTERNALLY-MANAGED"

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
    /app/assistant/docker-kata-apt-shims.sh \
    /app/assistant/docker-kata-apt-wrapper.sh \
    /app/assistant/docker-kata-chroot-exec.sh \
    /app/assistant/docker-kata-pip.sh \
    /app/assistant/docker-kata-runtime-family.sh \
    /app/assistant/docker-node-launcher.sh \
    /usr/local/bin/vellum-block-volume-common.sh \
    /usr/local/bin/vellum-block-volume-init.sh \
    /usr/local/bin/vellum-block-volume-mount.sh \
    /usr/local/bin/vellum-block-volume-resize.sh

# Run the daemon + http server
CMD ["/app/assistant/docker-entrypoint.sh"]
