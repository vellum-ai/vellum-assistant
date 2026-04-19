#!/usr/bin/env bash
#
# build-meet-bot-image.sh — Build the meet-bot container image locally.
#
# This is the dev-loop image build; CI has its own publishing pipeline. It
# tags the image as `vellum-meet-bot:dev` so local smoke tests can reference
# a stable tag without colliding with whatever CI produces.
#
# The build context is the REPO ROOT (not `skills/meet-join/bot/`) because
# the bot depends on the workspace-relative package `skills/meet-join/contracts`
# via a `file:../contracts` entry in package.json. Setting the context to the
# repo root lets the Dockerfile COPY that sibling package in before running
# `bun install`. The companion `skills/meet-join/bot/Dockerfile.dockerignore`
# keeps the effective context small by ignoring everything outside the
# paths we actually need. It is named `Dockerfile.dockerignore` (rather
# than `.dockerignore`) so it takes precedence over the existing repo-root
# `.dockerignore` file, which targets other images.
#
# --platform linux/amd64 is required because google-chrome-stable ships
# amd64 only — on arm64 Macs Docker would otherwise pick arm64 and fail to
# install Chrome.
#
# Usage:
#   ./scripts/build-meet-bot-image.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

docker build --platform linux/amd64 -t vellum-meet-bot:dev -f skills/meet-join/bot/Dockerfile .
