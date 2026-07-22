#!/usr/bin/env bash
# generate-icon.sh — Render the per-environment Linux app icon.
#
# Reads VELLUM_ENVIRONMENT (default: local) and renders the matching icon from
# build-resources/icons/{env}/ into build/icon.png. The macOS shell renders the
# same sources into a .icns via a Swift/CoreGraphics renderer; Linux has no
# CoreGraphics, so this composites the solid background (icon.json `fill.solid`)
# and the white-V foreground with librsvg + ImageMagick — the same tools the
# desktop-environment icon pipeline already relies on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-local}"
ICONS_DIR="$APP_DIR/build-resources/icons"

if [ -d "$ICONS_DIR/$VELLUM_ENVIRONMENT" ]; then
  ICON_SOURCE_DIR="$ICONS_DIR/$VELLUM_ENVIRONMENT"
elif [ -d "$ICONS_DIR/production" ]; then
  echo "generate-icon: no icons for '$VELLUM_ENVIRONMENT', falling back to production"
  ICON_SOURCE_DIR="$ICONS_DIR/production"
else
  echo "generate-icon: no icon sources found at $ICONS_DIR" >&2
  exit 1
fi

echo "generate-icon: using $VELLUM_ENVIRONMENT icon from $ICON_SOURCE_DIR"

command -v rsvg-convert >/dev/null 2>&1 || {
  echo "generate-icon: required tool 'rsvg-convert' not found on PATH" >&2
  exit 1
}

# ImageMagick 7 ships the unified `magick` binary; ImageMagick 6 (e.g. Ubuntu's
# `imagemagick` package) ships `convert`. Accept either — the args are identical.
if command -v magick >/dev/null 2>&1; then
  MAGICK=(magick)
elif command -v convert >/dev/null 2>&1; then
  MAGICK=(convert)
else
  echo "generate-icon: ImageMagick not found (need 'magick' or 'convert')" >&2
  exit 1
fi

ICON_JSON="$ICON_SOURCE_DIR/icon.json"
FOREGROUND_SVG="$ICON_SOURCE_DIR/Assets/white-V.svg"
ICON_SIZE=1024

# Parse the `fill.solid` background from icon.json — format
# `display-p3:<r>,<g>,<b>,<a>` with components in 0..1. The narrow-gamut Linux
# icon renders the components straight into sRGB; the small gamut shift on a
# flat brand colour is imperceptible at icon scale.
FILL_COMPONENTS="$(grep -o 'display-p3:[0-9.,]*' "$ICON_JSON" | head -n1 | cut -d: -f2)"
if [ -z "$FILL_COMPONENTS" ]; then
  echo "generate-icon: could not read fill.solid from $ICON_JSON" >&2
  exit 1
fi
IFS=',' read -r FR FG FB _FA <<<"$FILL_COMPONENTS"
to255() { awk -v v="$1" 'BEGIN { printf "%d", (v * 255) + 0.5 }'; }
BG_COLOR="rgb($(to255 "$FR"),$(to255 "$FG"),$(to255 "$FB"))"

OUTPUT_DIR="$APP_DIR/build"
mkdir -p "$OUTPUT_DIR"

FOREGROUND_PNG="$(mktemp /tmp/vellum-icon-fg-XXXXXX.png)"
trap 'rm -f "$FOREGROUND_PNG"' EXIT

rsvg-convert -w "$ICON_SIZE" -h "$ICON_SIZE" "$FOREGROUND_SVG" -o "$FOREGROUND_PNG"

"${MAGICK[@]}" -size "${ICON_SIZE}x${ICON_SIZE}" "xc:$BG_COLOR" \
  "$FOREGROUND_PNG" -gravity center -composite \
  -strip \
  "PNG32:$OUTPUT_DIR/icon.png"

echo "generate-icon: wrote $OUTPUT_DIR/icon.png (${ICON_SIZE}x${ICON_SIZE}, background $BG_COLOR)"
