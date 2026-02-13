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
BUNDLE_DISPLAY_NAME="Vellum"
APP_DIR="$SCRIPT_DIR/dist/$BUNDLE_DISPLAY_NAME.app"
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
# Get bin path first (fast, doesn't rebuild)
BIN_PATH=$(swift build $SWIFT_FLAGS --show-bin-path)

# Then build (or use cached if nothing changed)
swift build $SWIFT_FLAGS


EXECUTABLE="$BIN_PATH/$APP_NAME"

if [ ! -f "$EXECUTABLE" ]; then
    echo "ERROR: executable not found at $EXECUTABLE"
    exit 1
fi

# 2. Create .app bundle structure
# Check if we need to rebuild the bundle
#
# INCREMENTAL BUILD TRADEOFF:
# We only repackage when source binaries change (executable, daemon, frameworks, bundles).
# This makes rebuilds fast (~4s) but means removed artifacts persist in the .app until 'clean'.
# If you delete a resource bundle, framework, or daemon binary from the source, the old copy
# stays in Contents/ until you run './build.sh clean'. This is intentional — the speed gain
# is worth the occasional manual clean. Always use 'clean' before release builds.
NEEDS_REBUILD=false
if [ ! -f "$MACOS_DIR/$BUNDLE_DISPLAY_NAME" ] || [ "$EXECUTABLE" -nt "$MACOS_DIR/$BUNDLE_DISPLAY_NAME" ]; then
    NEEDS_REBUILD=true
fi

# Also rebuild if daemon binary changed or newly added
if [ -f "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
    if [ ! -f "$MACOS_DIR/vellum-daemon" ] || [ "$SCRIPT_DIR/daemon-bin/vellum-daemon" -nt "$MACOS_DIR/vellum-daemon" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Ensure .app bundle structure exists
FRAMEWORKS_DIR="$CONTENTS/Frameworks"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$FRAMEWORKS_DIR"

if [ "$NEEDS_REBUILD" = true ]; then
    echo "Packaging $BUNDLE_DISPLAY_NAME.app..."

    # Copy executable (renamed to match display name) and add Frameworks rpath
    cp "$EXECUTABLE" "$MACOS_DIR/$BUNDLE_DISPLAY_NAME"
    install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/$BUNDLE_DISPLAY_NAME" 2>/dev/null || true

    # Copy bundled daemon binary (if available — built by CI or locally)
    DAEMON_BIN="$SCRIPT_DIR/daemon-bin/vellum-daemon"
    if [ -f "$DAEMON_BIN" ]; then
        echo "Bundling daemon binary..."
        cp "$DAEMON_BIN" "$MACOS_DIR/vellum-daemon"
        chmod +x "$MACOS_DIR/vellum-daemon"
    else
        echo "No daemon binary at $DAEMON_BIN — skipping (dev mode)"
    fi
else
    echo "Binaries unchanged, skipping binary repackaging"
fi

# Always check frameworks (they change independently via dependency updates)
# Copy Sparkle.framework into bundle (required — it's a dynamic framework)
# Only copy if missing or changed (has its own timestamp check)
# Note: Directory timestamp (-nt) only updates when direct entries are added/removed,
# not when files inside subdirectories change. This is reliable for SPM-built artifacts
# since SPM recreates directories entirely, but manual edits inside .framework bundles
# won't be detected. Use './build.sh clean' if you manually modify frameworks.
SPARKLE_FW="$BIN_PATH/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
    if [ ! -d "$FRAMEWORKS_DIR/Sparkle.framework" ] || [ "$SPARKLE_FW" -nt "$FRAMEWORKS_DIR/Sparkle.framework" ]; then
        echo "Bundling Sparkle.framework..."
        rm -rf "$FRAMEWORKS_DIR/Sparkle.framework"
        cp -R "$SPARKLE_FW" "$FRAMEWORKS_DIR/"
    fi
else
    echo "WARNING: Sparkle.framework not found at $SPARKLE_FW"
fi

# Always check resource bundles (they change independently of binaries)
# Copy SPM resource bundles into Contents/Resources/
# ResourceBundle.swift checks Bundle.main.resourceURL (Contents/Resources/) first,
# then falls back to Bundle.main.bundleURL (for direct `swift run`).
# Only copy if missing or changed (has its own timestamp check)
for SPM_BUNDLE in "$BIN_PATH"/*.bundle; do
    if [ -d "$SPM_BUNDLE" ]; then
        BUNDLE_NAME=$(basename "$SPM_BUNDLE")
        if [ ! -d "$RESOURCES_DIR/$BUNDLE_NAME" ] || [ "$SPM_BUNDLE" -nt "$RESOURCES_DIR/$BUNDLE_NAME" ]; then
            echo "Bundling $BUNDLE_NAME"
            rm -rf "$RESOURCES_DIR/$BUNDLE_NAME"
            cp -R "$SPM_BUNDLE" "$RESOURCES_DIR/"
        fi
    fi
done

# Always regenerate Info.plist (fast, depends on env vars like DISPLAY_VERSION)
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$BUNDLE_DISPLAY_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleName</key>
    <string>Vellum</string>
    <key>CFBundleDisplayName</key>
    <string>Vellum</string>
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
    <string>Vellum needs Screen Recording access to see what's on your screen during computer use tasks.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Vellum needs microphone access to transcribe voice commands.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Vellum uses speech recognition to convert voice commands into tasks.</string>
    <key>SUFeedURL</key>
    <string>https://github.com/alex-nork/vellum-assistant-macos-updates/releases/latest/download/appcast.xml</string>
    <key>SUPublicEDKey</key>
    <string>${SU_PUBLIC_ED_KEY:-}</string>
    <key>SUAutomaticallyUpdate</key>
    <true/>
    <key>CFBundleIconName</key>
    <string>AppIcon</string>
</dict>
</plist>
PLIST

# Always compile asset catalog (fast, ensures AppIcon changes are picked up)
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

# Sign daemon binary separately with its own entitlements (JIT, network)
if [ -f "$MACOS_DIR/vellum-daemon" ]; then
    DAEMON_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$SCRIPT_DIR/daemon-entitlements.plist")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        DAEMON_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    codesign "${DAEMON_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-daemon"
    echo "Daemon binary signed"
fi

# Always use --deep to properly sign nested frameworks
CODESIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --deep)
if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
    CODESIGN_FLAGS+=(--timestamp --options runtime)
fi
codesign "${CODESIGN_FLAGS[@]}" "$APP_DIR"

echo "Built: $APP_DIR"

# 7. Run if requested
if [ "$CMD" = "run" ]; then
    echo "Launching..."
    # Kill existing instance if running (SIGTERM for clean shutdown)
    if pgrep -x "$BUNDLE_DISPLAY_NAME" > /dev/null; then
        pkill -x "$BUNDLE_DISPLAY_NAME" 2>/dev/null || true
        # Wait for clean exit (max 1 second)
        for i in {1..10}; do
            pgrep -x "$BUNDLE_DISPLAY_NAME" > /dev/null || break
            sleep 0.1
        done
    fi
    pkill -x "vellum-assistant" 2>/dev/null || true
    sleep 0.3
    # Launch via `open` so Launch Services registers the bundle —
    # this is required for macOS TCC to associate the app with its
    # bundle ID and show it in System Settings > Privacy & Security.
    open "$APP_DIR"
fi
