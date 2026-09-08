#!/usr/bin/env bash
# generate-icon.sh: Render the per-environment Linux app icon.
#
# Reads VELLUM_ENVIRONMENT (default: local) and renders the matching icon from
# build-resources/icons/{env}/ into build/icon.png. The macOS shell renders the
# same sources into a .icns via a Swift/CoreGraphics renderer; Linux has no
# CoreGraphics, so this composites the solid background (icon.json `fill.solid`)
# and the white-V foreground with librsvg + ImageMagick, the same tools the
# desktop-environment icon pipeline already relies on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Display P3 to sRGB: linearize with the sRGB EOTF (both spaces share it),
# rotate P3-to-XYZ then XYZ-to-sRGB at D65, re-encode with the sRGB OETF, and
# clamp the out-of-gamut residue the wider P3 primaries can produce. Both the
# render path below and `--print-srgb` call this, so there is one conversion.
p3_to_srgb() {
  awk -v components="${1#display-p3:}" '
    function eotf(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4 }
    function oetf(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * (c ^ (1 / 2.4)) - 0.055 }
    function clamp(c) { return c < 0 ? 0 : (c > 1 ? 1 : c) }
    function quantize(c) { return int(clamp(oetf(c)) * 255 + 0.5) }
    BEGIN {
      split(components, p, ",")
      r = eotf(p[1] + 0); g = eotf(p[2] + 0); b = eotf(p[3] + 0)
      x = 0.4865709486482162 * r + 0.26566769316909306 * g + 0.19821728523436250 * b
      y = 0.2289745640697488 * r + 0.69173852183650640 * g + 0.07928691409374500 * b
      z = 0.0000000000000000 * r + 0.04511338185890264 * g + 1.04394436890097600 * b
      sr =  3.24096994190452260 * x + -1.53738317757009400 * y + -0.49861076029300340 * z
      sg = -0.96924363628087960 * x +  1.87596750150772020 * y +  0.04155505740717559 * z
      sb =  0.05563007969699366 * x + -0.20397695888897652 * y +  1.05697151424287860 * z
      printf "rgb(%d,%d,%d)", quantize(sr), quantize(sg), quantize(sb)
    }
  '
}

# `--print-srgb display-p3:<r>,<g>,<b>,<a>` prints the ground the render path
# would composite and exits, so the drift guard exercises the shipped awk
# instead of a second copy of it. It needs none of the rendering toolchain.
if [ "${1:-}" = "--print-srgb" ]; then
  if [ -z "${2:-}" ]; then
    echo "generate-icon: --print-srgb needs a display-p3 fill" >&2
    exit 1
  fi
  printf '%s\n' "$(p3_to_srgb "$2")"
  exit 0
fi

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
# `imagemagick` package) ships `convert`. Accept either. The args are identical.
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

# Parse the `fill.solid` background from icon.json. Format
# `display-p3:<r>,<g>,<b>,<a>` with components in 0..1. macOS hands the same
# components to CoreGraphics in the Display P3 space, so Linux converts them to
# sRGB rather than reading them as sRGB, which would desaturate every ground.
FILL_COMPONENTS="$(grep -o 'display-p3:[0-9.,]*' "$ICON_JSON" | head -n1 | cut -d: -f2)"
if [ -z "$FILL_COMPONENTS" ]; then
  echo "generate-icon: could not read fill.solid from $ICON_JSON" >&2
  exit 1
fi

BG_COLOR="$(p3_to_srgb "$FILL_COMPONENTS")"

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
