#!/bin/bash
# Build a test DMG locally and open it in Finder.
# Run from clients/macos/:  ./dmg/test-dmg.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Check for create-dmg
if ! command -v create-dmg &>/dev/null; then
  echo "create-dmg not found. Install with: brew install create-dmg"
  exit 1
fi

# Build the app if it doesn't exist
APP_PATH="dist/Vellum.app"
if [ ! -d "$APP_PATH" ]; then
  echo "Building app..."
  ./build.sh release
fi

# Use pre-generated background (fall back to generating if missing)
mkdir -p build
if [ -f "dmg/dmg-background@2x.png" ]; then
  echo "Using pre-generated DMG background..."
  cp dmg/dmg-background@2x.png build/dmg-background@2x.png
else
  echo "Generating DMG background..."
  swift dmg/generate-background.swift build/dmg-background@2x.png
fi

# Stage files
DMG_STAGING="build/dmg-staging"
rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING"
cp -R "$APP_PATH" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

# Remove old test DMG if present
DMG_PATH="build/test.dmg"
rm -f "$DMG_PATH"

# Create DMG
echo "Creating DMG..."
create-dmg \
  --volname "Vellum" \
  --background "build/dmg-background@2x.png" \
  --window-pos 200 120 \
  --window-size 660 400 \
  --icon-size 128 \
  --text-size 10 \
  --icon "Vellum.app" 175 190 \
  --icon "Applications" 530 190 \
  --hide-extension "Vellum.app" \
  --no-internet-enable \
  "$DMG_PATH" \
  "$DMG_STAGING/" \
|| {
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 2 ] && [ -f "$DMG_PATH" ]; then
    echo "create-dmg exited with warning (code 2), but DMG was created successfully"
  else
    echo "create-dmg failed with exit code $EXIT_CODE"
    exit $EXIT_CODE
  fi
}

echo "DMG created at $DMG_PATH"
open "$DMG_PATH"
