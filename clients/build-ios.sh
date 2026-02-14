#!/bin/bash
set -e

# Build script for Vellum Assistant iOS app
# This script uses xcodebuild to properly build the iOS app with bundle configuration

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default to iPhone 15 simulator
SIMULATOR_NAME="${SIMULATOR_NAME:-iPhone 15}"

echo "Building Vellum Assistant iOS app for $SIMULATOR_NAME..."

# Build using xcodebuild (properly handles iOS app bundles)
xcodebuild \
  -scheme vellum-assistant-ios \
  -destination "platform=iOS Simulator,name=$SIMULATOR_NAME" \
  -derivedDataPath .build \
  build

echo "Build complete!"
echo ""
echo "To run the app:"
echo "1. Open Xcode: open Package.swift"
echo "2. Select 'vellum-assistant-ios' scheme"
echo "3. Choose '$SIMULATOR_NAME' or another simulator"
echo "4. Press ⌘R to run"
