# meet-bot container image.
#
# Runs the Meet bot inside a Debian-based Bun image with Xvfb (virtual
# display), PulseAudio (virtual audio devices), Chromium + Playwright
# dependencies, and ffmpeg for future audio capture/encoding needs.
#
# The real Meet-join + audio-capture logic lands in later PRs of the
# meet-phase-1 plan; this image just needs to build cleanly and boot
# `bun src/main.ts` to completion so CI can smoke-test the structure.

FROM oven/bun:1-debian

WORKDIR /app

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

# Install JS dependencies first so Docker can cache the layer when only
# source files change.
COPY package.json ./
RUN bun install

# Pull Playwright's Chromium build. This is kept separate from apt's
# chromium install so the Playwright-controlled binary stays in sync with
# the `playwright` package version pinned in package.json.
RUN bunx playwright install chromium

COPY src ./src

# The placeholder probe lives at src/health.ts and exits 0; real health
# logic lands in a later PR (see meet-phase-1 plan PR 8).
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD bun src/health.ts || exit 1

CMD ["bun", "src/main.ts"]
