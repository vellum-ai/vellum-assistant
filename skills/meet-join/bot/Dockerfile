# meet-bot container image.
#
# Runs the Meet bot inside a Debian-based Bun image with Xvfb (virtual
# display), PulseAudio (virtual audio devices), chromium (Debian package, for
# the `--load-extension` support required by the extension-based meet-join
# architecture — google-chrome-stable silently strips that flag as of
# Chrome 128+), and ffmpeg for future audio capture/encoding needs.
#
# The real Meet-join + audio-capture logic lands in later PRs of the
# meet-phase-1 plan; this image just needs to build cleanly and boot
# `bun src/main.ts` to completion so CI can smoke-test the structure.
#
# NOTE: Meet's BotGuard accepts chromium launched as a plain subprocess
# (no CDP attachment) but rejects Chrome-with-CDP. The image inherits the
# `--platform linux/amd64` build constraint for parity with other amd64
# dependencies — enforced in `scripts/build-meet-bot-image.sh`.
#
# Build context: the REPO ROOT (not `skills/meet-join/bot/`). The bot package
# depends on the sibling workspace package `skills/meet-join/contracts` via
# `file:../contracts` in its package.json. For `bun install` to resolve that
# relative path inside the image, the sibling package has to be copied in
# alongside the bot under the same parent directory. We therefore set
# WORKDIR to `/app/bot`, copy `skills/meet-join/bot/*` into it, and copy
# `skills/meet-join/contracts` to `/app/contracts` so the relative
# `../contracts` reference resolves.
#
# Related files:
#   - `scripts/build-meet-bot-image.sh` sets the context to `.` (repo root).
#   - `skills/meet-join/bot/Dockerfile.dockerignore` narrows the context back
#     down. It is named `Dockerfile.dockerignore` (not `.dockerignore`) so it
#     takes precedence over the existing repo-root `.dockerignore`, which
#     targets different images. See:
#     https://docs.docker.com/build/concepts/context/#dockerignore-files

FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

# System dependencies. Keep this list grouped and sorted so future PRs can
# add/remove packages cleanly.
#
#   Xvfb + PulseAudio: virtual display and audio stack for headless Chromium.
#   ca-certificates:   TLS trust store for any outbound HTTPS the bot makes
#                      at runtime.
#   dbus-x11:          required at runtime by Chromium.
#   ffmpeg:            audio/video encoding for transcript + recording paths.
#                      Also used to convert the avatar renderer's output frames
#                      into Y4M / YU12 for the v4l2loopback virtual camera.
#   fonts-liberation/libvulkan1/xdg-utils: chromium runtime deps.
#   libnss3/libgbm1/libasound2: Chromium shared-library dependencies.
#   v4l2loopback-utils: ships `v4l2-ctl`, used by `src/media/video-device.ts`
#                      to configure the virtual camera's pixel format when the
#                      avatar feature is enabled. The kernel module itself is
#                      loaded on the HOST (see README "Avatar (v4l2loopback)
#                      host setup") — the container only needs the userspace
#                      tooling so it can talk to the bind-mounted
#                      `/dev/video10` node.
#   xdotool:           posts trusted X-server mouse events for buttons that
#                      Meet gates on `event.isTrusted` (the prejoin admission
#                      button is the main one — JS `.click()` from the
#                      extension is silently ignored).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    dbus-x11 \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libgbm1 \
    libnss3 \
    libvulkan1 \
    pulseaudio \
    pulseaudio-utils \
    v4l2loopback-utils \
    xdg-utils \
    xdotool \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install Debian's chromium (NOT google-chrome-stable). As of Chrome 128+,
# google-chrome-stable silently strips the `--load-extension` command-line
# flag ("--load-extension is not allowed in Google Chrome, ignoring"), which
# blocks our extension-based architecture. Chromium keeps the flag working
# and is otherwise indistinguishable to Meet's BotGuard when launched as a
# plain subprocess without CDP attachment. Per CLAUDE.md's Docker
# dependencies rule, package versions are NOT pinned — rely on the
# base-image digest for reproducibility.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/bot

# Copy the sibling workspace package BEFORE the bot's package.json install
# so the `file:../contracts` dep in package.json resolves.
COPY skills/meet-join/contracts /app/contracts

# Copy the sibling `shared/` module. The bot's chrome-launcher and
# video-device modules import `AVATAR_DEVICE_PATH_DEFAULT` via
# `../../../shared/avatar-device-path.js`, which resolves to `/app/shared/`
# from `/app/bot/src/{browser,media}/…`. Without this the bot crashes at
# startup with "Cannot find module './shared/avatar-device-path.js'".
COPY skills/meet-join/shared /app/shared

# Install JS dependencies first so Docker can cache the layer when only
# source files change.
COPY skills/meet-join/bot/package.json skills/meet-join/bot/bun.lock skills/meet-join/bot/tsconfig.json ./
RUN bun install --frozen-lockfile

# The contracts/ directory has no package.json and no node_modules of its own,
# but its TS files import `zod`. Both the bot (at runtime) and the extension
# build (which imports contracts via relative paths) need zod resolvable from
# /app/contracts/. Symlink the bot's node_modules in so Node/Bun's upward
# module resolution finds zod when walking up from /app/contracts/*.ts.
RUN mkdir -p /app/contracts/node_modules \
  && ln -sf /app/bot/node_modules/zod /app/contracts/node_modules/zod

COPY skills/meet-join/bot/src ./src

# Build the Chrome extension and install its dist/ at /app/ext/. The
# chrome-launcher passes `--load-extension=/app/ext` so Chrome picks it
# up on startup. We build inside the image (rather than shipping a
# pre-built dist/ in the repo) so the extension source is the single
# source of truth. `/app/ext-src` is throwaway; the final artefact is
# `/app/ext/` which contains manifest.json, background.js, content.js.
COPY skills/meet-join/meet-controller-ext /app/ext-src
RUN cd /app/ext-src && bun install --frozen-lockfile && bun run build \
  && cp -r /app/ext-src/dist /app/ext \
  && rm -rf /app/ext-src

# Native-messaging host registration: copy the manifest template + renderer
# script into the image, then render the manifest with the extension's ID
# baked in (derived from the sibling extension package's public key). The
# rendered file lands at Chrome's well-known search path so Chromium picks
# it up automatically when it boots inside the container.
COPY skills/meet-join/bot/native-messaging ./native-messaging
COPY skills/meet-join/bot/scripts/render-nmh-manifest.ts ./scripts/render-nmh-manifest.ts
COPY skills/meet-join/meet-controller-ext/manifest.json /tmp/ext-manifest.json

RUN mkdir -p /etc/chromium/native-messaging-hosts \
  && bun scripts/render-nmh-manifest.ts \
       /etc/chromium/native-messaging-hosts/com.vellum.meet.json \
       --ext-manifest /tmp/ext-manifest.json \
       --template /app/bot/native-messaging/com.vellum.meet.json \
  && chmod +x /app/bot/src/native-messaging/nmh-shim.ts \
  && rm /tmp/ext-manifest.json

# The PulseAudio bootstrap script is shelled out to at container start by
# `src/media/pulse.ts`; ensure the executable bit is set in the image so the
# runtime `bash` invocation succeeds. The script is NOT run at build time —
# PulseAudio needs a live container environment (runtime, not image layer).
RUN chmod +x /app/bot/src/media/pulse-setup.sh

# The placeholder probe lives at src/health.ts and exits 0; real health
# logic lands in a later PR (see meet-phase-1 plan PR 8).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun src/health.ts || exit 1

CMD ["bun", "src/main.ts"]
