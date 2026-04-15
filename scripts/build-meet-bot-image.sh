#!/usr/bin/env bash
#
# build-meet-bot-image.sh — Build the meet-bot container image locally.
#
# This is the dev-loop image build; CI has its own publishing pipeline. It
# tags the image as `vellum-meet-bot:dev` so local smoke tests can reference
# a stable tag without colliding with whatever CI produces.
#
# Usage:
#   ./scripts/build-meet-bot-image.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

docker build -t vellum-meet-bot:dev -f meet-bot/Dockerfile meet-bot/
