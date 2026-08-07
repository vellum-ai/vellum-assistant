#!/usr/bin/env sh
# Regenerates the two converter inputs this package does not build on its own.
#
# 1. The .d.ts tree. @vellumai/design-library ships TypeScript source (exports
#    point at src/), so there is no declaration tree for the converter to
#    discover components or extract prop types from. tsc emits one into dist/.
#    package.json's publishConfig.types points the converter at it.
#
# 2. The compiled stylesheet. Component styling is Tailwind v4 utility CSS that
#    only exists once a Tailwind-aware bundler has compiled it; the package
#    itself ships none. The reference Storybook build is that compiled output,
#    so its stylesheet and font assets are staged into dist/ and consumed via
#    cfg.cssEntry. Fonts must sit beside the stylesheet: url() refs resolve
#    relative to the cssEntry's own directory, bounded to the package dir.
#
# Requires .design-sync/sb-reference to have been built first.
set -eu

root=$(git rev-parse --show-toplevel)
pkg="$root/packages/design-library"
assets="$root/.design-sync/sb-reference/assets"

if [ ! -d "$assets" ]; then
  echo "prepare-build: missing $assets — build the reference storybook first:" >&2
  echo "  cd packages/design-library && npx storybook build -c .storybook -o \"$root/.design-sync/sb-reference\"" >&2
  exit 1
fi

cd "$pkg"

bunx tsc src/index.ts --declaration --emitDeclarationOnly --outDir dist \
  --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 \
  --skipLibCheck --esModuleInterop --resolveJsonModule

set -- "$assets"/iframe-*.css
if [ ! -f "$1" ]; then
  echo "prepare-build: no iframe-*.css in $assets" >&2
  exit 1
fi
cat "$@" > dist/ds-styles.css

# Brand fonts (DM Sans / DM Mono / Instrument Serif) and any other font assets
# the compiled stylesheet references by relative url().
find "$assets" -maxdepth 1 -type f \( -name '*.ttf' -o -name '*.woff2' -o -name '*.woff' \) \
  -exec cp {} dist/ \;

echo "prepare-build: dist/ds-styles.css $(wc -c < dist/ds-styles.css) bytes, $(find dist -maxdepth 1 -name '*.ttf' -o -maxdepth 1 -name '*.woff2' | wc -l | tr -d ' ') font file(s)"
