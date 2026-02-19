#!/bin/bash
set -euo pipefail

# iOS build script for vellum-assistant-ios.
# Produces a signed .ipa for TestFlight/App Store upload.
#
# Usage:
#   ./build.sh              Build debug (simulator)
#   ./build.sh release      Build release .ipa for TestFlight
#   ./build.sh test         Run iOS tests
#   ./build.sh clean        Remove build artifacts
#
# Environment variables (for CI):
#   DEVELOPMENT_TEAM  Apple team ID (required for release)
#   DISPLAY_VERSION   Override CFBundleShortVersionString (default: from Package.swift)
#   BUILD_VERSION     Override CFBundleVersion (default: 1)
#   SIGN_IDENTITY     Override code signing identity (default: Apple Distribution)

# ── DEVELOPER_DIR ──────────────────────────────────────────────────────
if [ -z "${DEVELOPER_DIR:-}" ]; then
    _dev_dir=$(xcode-select -p 2>/dev/null || echo "")
    if [ -z "$_dev_dir" ] || [[ "$_dev_dir" == */CommandLineTools* ]]; then
        DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
    else
        DEVELOPER_DIR="$_dev_dir"
    fi
    unset _dev_dir
fi
export DEVELOPER_DIR

# ── Paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"

# ── Configuration ──────────────────────────────────────────────────────
BUNDLE_ID="com.vellum.vellum-assistant-ios"
SCHEME="vellum-assistant-ios"
INFOPLIST="$SCRIPT_DIR/Resources/Info.plist"
ENTITLEMENTS="$SCRIPT_DIR/Resources/vellum-assistant-ios.entitlements"

# Version (overridable via env, defaults to Package.swift)
if [ -z "${DISPLAY_VERSION:-}" ]; then
    DISPLAY_VERSION=$(sed -n 's/^let appVersion = "\(.*\)"/\1/p' "$CLIENTS_DIR/Package.swift" 2>/dev/null | head -1)
    DISPLAY_VERSION="${DISPLAY_VERSION:-1.0}"
fi
BUILD_VERSION="${BUILD_VERSION:-1}"

# Signing
SIGN_IDENTITY="${SIGN_IDENTITY:-Apple Distribution}"
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-}"

CMD="${1:-build}"

# ── Commands ───────────────────────────────────────────────────────────
case "$CMD" in
    test)
        echo "Running iOS tests..."
        cd "$CLIENTS_DIR"
        # swift test --filter compiles ALL test targets before filtering at
        # runtime. The macOS test target may crash with fatalError on CI
        # (WebKit headless environment). Tolerate that specific case — same
        # pattern as macos/build.sh.
        set +e
        TEST_OUTPUT=$(swift test --filter vellum_assistant_iosTests 2>&1)
        TEST_EXIT=$?
        set -e
        echo "$TEST_OUTPUT"

        if [ $TEST_EXIT -eq 0 ]; then
            exit 0
        fi

        # Tolerate fatalError / signal-5 crashes from the macOS test target
        # if no actual test failures were reported for the iOS tests.
        if echo "$TEST_OUTPUT" | grep -q "fatalError\|unexpected signal code 5" && \
           ! echo "$TEST_OUTPUT" | grep -qE "with [1-9][0-9]* failure"; then
            echo ""
            echo "warning: swift test exited non-zero due to macOS test target crash (fatalError/signal 5)."
            echo "iOS test assertions passed. See macos/build.sh for the same tolerance pattern."
            exit 0
        fi

        exit $TEST_EXIT
        ;;
    clean)
        echo "Cleaning..."
        rm -rf "$DIST_DIR" "$CLIENTS_DIR/.build"
        echo "Done."
        exit 0
        ;;
    build|release)
        ;;
    *)
        echo "Usage: $0 [build|release|test|clean]"
        exit 1
        ;;
esac

mkdir -p "$DIST_DIR"

# ── Debug build (simulator) ───────────────────────────────────────────
if [ "$CMD" = "build" ]; then
    echo "Building debug (simulator)..."
    cd "$CLIENTS_DIR"
    xcodebuild build \
        -scheme "$SCHEME" \
        -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
        -configuration Debug \
        CODE_SIGNING_ALLOWED=NO \
        -derivedDataPath "$DIST_DIR/DerivedData"
    echo "Debug build complete."
    echo "Binary: $DIST_DIR/DerivedData/Build/Products/Debug-iphonesimulator/$SCHEME"
    exit 0
fi

# ── Release build (.ipa for TestFlight) ────────────────────────────────
if [ -z "$DEVELOPMENT_TEAM" ]; then
    echo "ERROR: DEVELOPMENT_TEAM is required for release builds."
    echo ""
    echo "Set your Apple team ID:"
    echo "  DEVELOPMENT_TEAM=XXXXXXXXXX ./build.sh release"
    echo ""
    echo "Find your team ID at: https://developer.apple.com/account"
    exit 1
fi

ARCHIVE_PATH="$DIST_DIR/VellumAssistant.xcarchive"
EXPORT_PATH="$DIST_DIR/export"

echo "Building release archive..."
echo "  Version: $DISPLAY_VERSION ($BUILD_VERSION)"
echo "  Team: $DEVELOPMENT_TEAM"
echo "  Identity: $SIGN_IDENTITY"

# Clean previous artifacts
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH"

# Archive with build settings overrides to fix the Generic Archive issue.
# SPM executable targets produce bare Mach-O binaries by default. These
# overrides tell Xcode to produce a proper .app bundle in the archive's
# Products/Applications/ directory, which is required for iOS distribution.
# See: https://developer.apple.com/documentation/technotes/tn3110-resolving-generic-xcode-archive-issue
cd "$CLIENTS_DIR"
xcodebuild archive \
    -scheme "$SCHEME" \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    -configuration Release \
    WRAPPER_EXTENSION=app \
    INSTALL_PATH=/Applications \
    GENERATE_INFOPLIST_FILE=NO \
    INFOPLIST_FILE="$INFOPLIST" \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS" \
    ENABLE_BITCODE=NO \
    MARKETING_VERSION="$DISPLAY_VERSION" \
    CURRENT_PROJECT_VERSION="$BUILD_VERSION"

# ── Verify archive structure ──────────────────────────────────────────
echo "Verifying archive..."
APP_PATH=$(find "$ARCHIVE_PATH/Products/Applications" -name "*.app" -maxdepth 1 2>/dev/null | head -1)

if [ -z "$APP_PATH" ]; then
    echo "ERROR: Archive does not contain an iOS app in Products/Applications/"
    echo ""
    echo "This is a Generic Archive — the build settings overrides may not have worked."
    echo "Inspect the archive with:"
    echo "  find '$ARCHIVE_PATH/Products' -type f"
    echo ""
    echo "See: https://developer.apple.com/documentation/technotes/tn3110-resolving-generic-xcode-archive-issue"
    exit 1
fi
echo "  App: $(basename "$APP_PATH")"

# Check for unexpected items that would make this a generic archive
EXTRA=$(find "$ARCHIVE_PATH/Products" -mindepth 1 -maxdepth 1 -not -name "Applications" 2>/dev/null || true)
if [ -n "$EXTRA" ]; then
    echo "WARNING: Archive contains unexpected items outside Products/Applications/:"
    echo "$EXTRA"
    echo "This may cause export to fail."
fi

# ── Generate exportOptions.plist ──────────────────────────────────────
# Generated dynamically because teamID varies per developer/CI environment.
EXPORT_OPTIONS="$DIST_DIR/exportOptions.plist"
cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>$DEVELOPMENT_TEAM</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>uploadSymbols</key>
    <true/>
    <key>uploadBitcode</key>
    <false/>
    <key>destination</key>
    <string>export</string>
</dict>
</plist>
PLIST

# ── Export .ipa ───────────────────────────────────────────────────────
echo "Exporting .ipa..."
xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportOptionsPlist "$EXPORT_OPTIONS" \
    -exportPath "$EXPORT_PATH"

IPA_FILE=$(find "$EXPORT_PATH" -name "*.ipa" -maxdepth 1 | head -1)
if [ -n "$IPA_FILE" ]; then
    echo ""
    echo "Success! IPA ready for TestFlight upload:"
    echo "  $IPA_FILE"
    echo ""
    echo "Upload to App Store Connect:"
    echo "  xcrun altool --upload-app -f '$IPA_FILE' -t ios -u YOUR_APPLE_ID -p YOUR_APP_PASSWORD"
    echo "  # Or drag into Transporter.app"
else
    echo "WARNING: No .ipa found in export path. Check $EXPORT_PATH for output."
fi
