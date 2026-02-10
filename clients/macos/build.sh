#!/bin/bash
set -euo pipefail

# Single-command build script for vellum-assistant.
# Replaces XcodeGen + xcodebuild with: swift build → .app bundle → codesign.
#
# Usage:
#   ./build.sh              Build debug .app
#   ./build.sh run          Build + launch
#   ./build.sh release      Build release .app
#   ./build.sh test         Run tests (no .app needed)
#   ./build.sh clean        Remove build artifacts
#
# Environment variables (for CI):
#   DISPLAY_VERSION   Override CFBundleShortVersionString (default: 0.1.0)
#   BUILD_VERSION     Override CFBundleVersion (default: 1)
#   SIGN_IDENTITY     Override code signing identity

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUNDLE_ID="com.vellum.vellum-assistant"
APP_NAME="vellum-assistant"
APP_DIR="$SCRIPT_DIR/dist/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"

# Version (overridable via env for CI)
DISPLAY_VERSION="${DISPLAY_VERSION:-0.1.0}"
BUILD_VERSION="${BUILD_VERSION:-1}"

# Signing identity (overridable via env for CI)
if [ -z "${SIGN_IDENTITY:-}" ]; then
    SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
        | grep "Developer ID Application" \
        | head -1 \
        | sed 's/.*"\(.*\)"/\1/' || true)
    if [ -z "$SIGN_IDENTITY" ]; then
        SIGN_IDENTITY="-"
    fi
fi

CMD="${1:-build}"

case "$CMD" in
    test)
        echo "Running tests..."
        swift test
        exit 0
        ;;
    clean)
        echo "Cleaning..."
        rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/.build"
        echo "Done."
        exit 0
        ;;
    build|run|release)
        ;;
    *)
        echo "Usage: $0 [build|run|release|test|clean]"
        exit 1
        ;;
esac

CONFIG="debug"
SWIFT_FLAGS=""
if [ "$CMD" = "release" ]; then
    CONFIG="release"
    SWIFT_FLAGS="-c release"
fi

# 1. Build with SPM
echo "Building ($CONFIG)..."
swift build $SWIFT_FLAGS

BIN_PATH=$(swift build $SWIFT_FLAGS --show-bin-path)
EXECUTABLE="$BIN_PATH/$APP_NAME"

if [ ! -f "$EXECUTABLE" ]; then
    echo "ERROR: executable not found at $EXECUTABLE"
    exit 1
fi

# 2. Create .app bundle structure
echo "Packaging $APP_NAME.app..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

# Copy executable
cp "$EXECUTABLE" "$MACOS_DIR/$APP_NAME"

# 3. Generate Info.plist with resolved values
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$DISPLAY_VERSION</string>
    <key>CFBundleVersion</key>
    <string>$BUILD_VERSION</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.productivity</string>
    <key>NSScreenRecordingUsageDescription</key>
    <string>vellum-assistant needs Screen Recording access to see what's on your screen during computer use tasks.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>vellum-assistant needs microphone access to transcribe voice commands.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>vellum-assistant uses speech recognition to convert voice commands into tasks.</string>
</dict>
</plist>
PLIST

# 4. Copy SPM resource bundle (contains Recipes, processed assets)
SPM_BUNDLE="$BIN_PATH/${APP_NAME}_${APP_NAME}.bundle"
if [ -d "$SPM_BUNDLE" ]; then
    cp -R "$SPM_BUNDLE" "$RESOURCES_DIR/"
fi

# 5. Compile asset catalog (if actool is available)
XCASSETS="$SCRIPT_DIR/vellum-assistant/Resources/Assets.xcassets"
if [ -d "$XCASSETS" ]; then
    xcrun actool "$XCASSETS" \
        --compile "$RESOURCES_DIR" \
        --platform macosx \
        --minimum-deployment-target 14.0 \
        --app-icon AppIcon \
        --output-partial-info-plist /dev/null \
        > /dev/null 2>&1 || true
fi

# 6. Code sign
echo "Signing with: $SIGN_IDENTITY"
CODESIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --deep)
if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
    CODESIGN_FLAGS+=(--timestamp --options runtime)
fi
codesign "${CODESIGN_FLAGS[@]}" "$APP_DIR"

echo "Built: $APP_DIR"

# 7. Run if requested
if [ "$CMD" = "run" ]; then
    echo "Launching..."
    # Kill existing instance if running
    pkill -x "$APP_NAME" 2>/dev/null || true
    sleep 0.3
    # Use absolute path to avoid Launch Services opening a stale copy
    "$MACOS_DIR/$APP_NAME" &
    disown
fi
