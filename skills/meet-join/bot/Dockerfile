# meet-bot container image.
#
# Runs the Meet bot inside a Debian-based Bun image with Xvfb (virtual
# display), PulseAudio (virtual audio devices), google-chrome-stable (for
# Chrome extension support required by the Chrome extension based
# meet-join architecture), and ffmpeg for future audio capture/encoding
# needs.
#
# The real Meet-join + audio-capture logic lands in later PRs of the
# meet-phase-1 plan; this image just needs to build cleanly and boot
# `bun src/main.ts` to completion so CI can smoke-test the structure.
#
# NOTE: google-chrome-stable ships amd64 only. This image must be built
# with --platform linux/amd64 — enforced in scripts/build-meet-bot-image.sh.
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
#   Xvfb + PulseAudio: virtual display and audio stack for headless Chrome.
#   dbus-x11:          required at runtime by Chrome.
#   ffmpeg:            audio/video encoding for transcript + recording paths.
#   fonts-liberation/libvulkan1/xdg-utils: google-chrome-stable runtime deps.
#   libnss3/libgbm1/libasound2: Chrome shared-library dependencies.
#   wget + gnupg:      required to fetch Google's apt signing key and configure
#                      the google-chrome repo (see next RUN).
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 \
    ffmpeg \
    fonts-liberation \
    gnupg \
    libasound2 \
    libgbm1 \
    libnss3 \
    libvulkan1 \
    pulseaudio \
    pulseaudio-utils \
    wget \
    xdg-utils \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install google-chrome-stable from Google's official apt repo. We use Chrome
# (not Chromium) because the Chrome extension based meet-join architecture
# requires Chrome's extension support. Per CLAUDE.md's Docker dependencies
# rule, package versions are NOT pinned — rely on the base-image digest for
# reproducibility.
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/bot

# Copy the sibling workspace package BEFORE the bot's package.json install
# so the `file:../contracts` dep in package.json resolves.
COPY skills/meet-join/contracts /app/contracts

# Install JS dependencies first so Docker can cache the layer when only
# source files change.
COPY skills/meet-join/bot/package.json skills/meet-join/bot/bun.lock skills/meet-join/bot/tsconfig.json ./
RUN bun install --frozen-lockfile

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

RUN mkdir -p /etc/opt/chrome/native-messaging-hosts \
  && bun scripts/render-nmh-manifest.ts \
       /etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json \
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
