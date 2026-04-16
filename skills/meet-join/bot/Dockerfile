# meet-bot container image.
#
# Runs the Meet bot inside a Debian-based Bun image with Xvfb (virtual
# display), PulseAudio (virtual audio devices), Chromium + Playwright
# dependencies, and ffmpeg for future audio capture/encoding needs.
#
# The real Meet-join + audio-capture logic lands in later PRs of the
# meet-phase-1 plan; this image just needs to build cleanly and boot
# `bun src/main.ts` to completion so CI can smoke-test the structure.
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

FROM oven/bun:1.3.9-debian@sha256:d48b40bf0106dc1e94462c7086fbf4e8aab97f0870db2c87a05ecf8765f964df

# System dependencies. Keep this list grouped and sorted so future PRs can
# add/remove packages cleanly.
#
#   Xvfb + PulseAudio: virtual display and audio stack for headless Chromium.
#   dbus-x11:          required at runtime by Chromium under Playwright.
#   chromium:          browser binary (Playwright can also install its own,
#                      but having it in the base image keeps first-run fast).
#   ffmpeg:            audio/video encoding for transcript + recording paths.
#   libnss3/libgbm1/libasound2: Chromium shared-library dependencies that
#                      Playwright's Debian list normally expects to be present.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    dbus-x11 \
    ffmpeg \
    libasound2 \
    libgbm1 \
    libnss3 \
    pulseaudio \
    pulseaudio-utils \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/bot

# Copy the sibling workspace package BEFORE the bot's package.json install
# so the `file:../contracts` dep in package.json resolves.
COPY skills/meet-join/contracts /app/contracts

# Install JS dependencies first so Docker can cache the layer when only
# source files change.
COPY skills/meet-join/bot/package.json skills/meet-join/bot/tsconfig.json ./
RUN bun install

# Pull Playwright's Chromium build. This is kept separate from apt's
# chromium install so the Playwright-controlled binary stays in sync with
# the `playwright` package version pinned in package.json.
RUN bunx playwright install chromium

COPY skills/meet-join/bot/src ./src

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
