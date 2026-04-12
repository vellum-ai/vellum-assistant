#!/bin/bash
set -euo pipefail

# iOS build script for vellum-assistant-ios.
# Uses the native .xcodeproj (generated from project.yml via XcodeGen).
# Produces a signed .ipa for TestFlight/App Store upload.
#
# Usage:
#   ./build.sh              Build debug (simulator)
#   ./build.sh run          Build, install, and launch on simulator + open Xcode
#   ./build.sh release      Build release .ipa for TestFlight
#   ./build.sh test         Run iOS tests (via xcodebuild)
#   ./build.sh clean        Remove build artifacts
#
# Environment variables (for CI):
#   DEVELOPMENT_TEAM          Apple team ID (required for release)
#   DISPLAY_VERSION           Override CFBundleShortVersionString (default: from Package.swift)
#   BUILD_VERSION             Override CFBundleVersion (default: 1)
#   PROVISIONING_PROFILE_NAME Override provisioning profile name (default: Vellum Assistant iOS Distribution)
#
# Prerequisites:
#   xcodegen (brew install xcodegen) — the xcodeproj is generated on-the-fly
#
# Migration notes:
#   - Use `open clients/ios/vellum-assistant-ios.xcodeproj` (not Package.swift)
#   - After switching: rm -rf ~/Library/Developer/Xcode/DerivedData/*vellum*
#   - `swift build --product vellum-assistant-ios` no longer works — use xcodebuild

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
SCHEME="VellumAssistantIOS"
PROJECT="$SCRIPT_DIR/vellum-assistant-ios.xcodeproj"

# Version (overridable via env, defaults to Package.swift)
if [ -z "${DISPLAY_VERSION:-}" ]; then
    DISPLAY_VERSION=$(sed -n 's/^let appVersion = "\(.*\)"/\1/p' "$CLIENTS_DIR/Package.swift" 2>/dev/null | head -1)
    DISPLAY_VERSION="${DISPLAY_VERSION:-1.0}"
fi
BUILD_VERSION="${BUILD_VERSION:-1}"

# Signing
DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-}"
PROVISIONING_PROFILE_NAME="${PROVISIONING_PROFILE_NAME:-Vellum Assistant iOS Distribution}"

CMD="${1:-build}"

# ── Commands ───────────────────────────────────────────────────────────
case "$CMD" in
    clean)
        echo "Cleaning..."
        rm -rf "$DIST_DIR" "$CLIENTS_DIR/.build"
        rm -f "$SCRIPT_DIR/Resources/tts-provider-catalog.json"
        echo "Done."
        exit 0
        ;;
    build|run|release|test)
        ;;
    *)
        echo "Usage: $0 [build|run|release|test|clean]"
        exit 1
        ;;
esac

# ── Bundle metadata into Resources/ ──────────────────────────────────
# Copy build-time artifacts from meta/ into the Resources directory so
# XcodeGen includes them in the app bundle.  The macOS build performs
# the equivalent copy into Contents/Resources/ after compilation; iOS
# needs the files present *before* xcodegen so they are listed as
# bundle resources in the generated xcodeproj.
TTS_PROVIDER_CATALOG="$SCRIPT_DIR/../../meta/tts-provider-catalog.json"
if [ -f "$TTS_PROVIDER_CATALOG" ]; then
    cp "$TTS_PROVIDER_CATALOG" "$SCRIPT_DIR/Resources/tts-provider-catalog.json"
fi

# ── Generate xcodeproj ────────────────────────────────────────────────
# Always regenerate from project.yml so the xcodeproj is never stale.
if command -v xcodegen >/dev/null 2>&1; then
    # If a custom provisioning profile name was provided, update project.yml
    # before generating the xcodeproj so it only applies to the app target.
    if [ "$PROVISIONING_PROFILE_NAME" != "Vellum Assistant iOS Distribution" ]; then
        sed -i.bak "s/PROVISIONING_PROFILE_SPECIFIER: .*/PROVISIONING_PROFILE_SPECIFIER: \"$PROVISIONING_PROFILE_NAME\"/" "$SCRIPT_DIR/project.yml"
    fi
    echo "Regenerating xcodeproj from project.yml..."
    (cd "$SCRIPT_DIR" && xcodegen --quiet)
else
    echo "ERROR: xcodegen not found. Install with: brew install xcodegen"
    exit 1
fi

# ── Resolve simulator destination ────────────────────────────────────
# Finds the first available iPhone simulator instead of hardcoding a
# device name that may not exist on every Xcode version.
resolve_simulator_destination() {
    local sim_name
    # Extract the device name from lines like:
    #   "    iPhone 16 Pro (XXXXXXXX-XXXX-...) (Shutdown)"
    #   "    iPhone SE (3rd generation) (XXXXXXXX-XXXX-...) (Shutdown)"
    # Strip the UUID parenthetical and any trailing state like (Booted)/(Shutdown),
    # but preserve parenthesized model qualifiers like "(3rd generation)".
    sim_name=$(xcrun simctl list devices available 2>/dev/null \
        | grep 'iPhone' \
        | sed -n 's/^[[:space:]]*\(iPhone.*\) ([0-9A-Fa-f]\{8\}-.*$/\1/p' \
        | sed 's/[[:space:]]*$//' \
        | head -1 || true)
    if [ -n "$sim_name" ]; then
        echo "platform=iOS Simulator,name=$sim_name"
    else
        echo "ERROR: No available iPhone simulator found. Install one via Xcode > Settings > Platforms." >&2
        return 1
    fi
}

# ── Resolve simulator UUID ──────────────────────────────────────────
# Returns the device UUID of the first available iPhone simulator.
# Used by the `run` command to boot/install/launch via simctl.
resolve_simulator_udid() {
    local udid
    udid=$(xcrun simctl list devices available 2>/dev/null \
        | grep 'iPhone' \
        | sed -n 's/.*\([0-9A-Fa-f]\{8\}-[0-9A-Fa-f]\{4\}-[0-9A-Fa-f]\{4\}-[0-9A-Fa-f]\{4\}-[0-9A-Fa-f]\{12\}\).*/\1/p' \
        | head -1 || true)
    if [ -n "$udid" ]; then
        echo "$udid"
    else
        echo "ERROR: No available iPhone simulator found. Install one via Xcode > Settings > Platforms." >&2
        return 1
    fi
}

# ── Run command (build + install + launch on simulator) ──────────────
if [ "$CMD" = "run" ]; then
    SIM_DEST=$(resolve_simulator_destination)
    SIM_UDID=$(resolve_simulator_udid)
    BUNDLE_ID="ai.vocify-inc.vellum-assistant-ios"

    echo "Building for simulator (destination: $SIM_DEST)..."
    mkdir -p "$DIST_DIR"
    xcodebuild build \
        -project "$PROJECT" \
        -scheme "$SCHEME" \
        -destination "$SIM_DEST" \
        -configuration Debug \
        CODE_SIGNING_ALLOWED=NO \
        -derivedDataPath "$DIST_DIR/DerivedData" \
        MARKETING_VERSION="$DISPLAY_VERSION" \
        CURRENT_PROJECT_VERSION="$BUILD_VERSION"

    # Locate the built .app inside DerivedData
    APP_PATH=$(find "$DIST_DIR/DerivedData/Build/Products/Debug-iphonesimulator" \
        -name "*.app" -maxdepth 1 2>/dev/null | head -1)
    if [ -z "$APP_PATH" ]; then
        echo "ERROR: Could not find built .app in DerivedData."
        exit 1
    fi

    # Boot the simulator (no-op if already booted)
    echo "Booting simulator $SIM_UDID..."
    xcrun simctl boot "$SIM_UDID" 2>/dev/null || true

    # Wait for the simulator to finish booting before installing.
    # simctl boot only initiates boot — bootstatus blocks until ready.
    xcrun simctl bootstatus "$SIM_UDID" -b 2>/dev/null || true

    # Open Simulator.app so the user can see it
    open -a Simulator

    # Install and launch
    echo "Installing $APP_PATH..."
    xcrun simctl install "$SIM_UDID" "$APP_PATH"

    echo "Launching $BUNDLE_ID..."
    # SIMCTL_CHILD_ prefix passes env vars to the launched app
    SIMCTL_CHILD_VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-local}" \
        xcrun simctl launch "$SIM_UDID" "$BUNDLE_ID"

    # Open the Xcode project for debugging / log viewing
    echo "Opening Xcode project..."
    open "$PROJECT"

    echo ""
    echo "App launched on simulator."
    echo "  Xcode is open for debugging — use Debug > Attach to Process > vellum-assistant-ios"
    echo "  to attach the debugger to the running app."
    exit 0
fi

# ── Test command ─────────────────────────────────────────────────────
if [ "$CMD" = "test" ]; then
    SIM_DEST=$(resolve_simulator_destination)
    echo "Running iOS tests (destination: $SIM_DEST)..."
    xcodebuild test \
        -project "$PROJECT" \
        -scheme "$SCHEME" \
        -destination "$SIM_DEST" \
        -configuration Debug \
        CODE_SIGNING_ALLOWED=NO
    exit $?
fi

mkdir -p "$DIST_DIR"

# ── Debug build (simulator) ───────────────────────────────────────────
if [ "$CMD" = "build" ]; then
    echo "Building debug (simulator)..."
    xcodebuild build \
        -project "$PROJECT" \
        -scheme "$SCHEME" \
        -destination 'generic/platform=iOS Simulator' \
        -configuration Debug \
        CODE_SIGNING_ALLOWED=NO \
        -derivedDataPath "$DIST_DIR/DerivedData" \
        MARKETING_VERSION="$DISPLAY_VERSION" \
        CURRENT_PROJECT_VERSION="$BUILD_VERSION"
    echo "Debug build complete."
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

# Clean previous artifacts (including DerivedData to avoid stale asset caches)
rm -rf "$ARCHIVE_PATH" "$EXPORT_PATH" "$DIST_DIR/DerivedData"

# Archive using the native .xcodeproj (Application target produces a proper
# .app bundle in Products/Applications/ without build setting workarounds).
# Signing settings (CODE_SIGN_STYLE, CODE_SIGN_IDENTITY, PROVISIONING_PROFILE_SPECIFIER)
# are set per-target in project.yml so they only apply to the app target and not to
# Swift Package library targets that don't support provisioning profiles.
xcodebuild archive \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    -derivedDataPath "$DIST_DIR/DerivedData" \
    -configuration Release \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
    MARKETING_VERSION="$DISPLAY_VERSION" \
    CURRENT_PROJECT_VERSION="$BUILD_VERSION"

# ── Verify archive structure ──────────────────────────────────────────
echo "Verifying archive..."
APP_PATH=$(find "$ARCHIVE_PATH/Products/Applications" -name "*.app" -maxdepth 1 2>/dev/null | head -1)

if [ -z "$APP_PATH" ]; then
    echo "ERROR: Archive does not contain an iOS app in Products/Applications/"
    echo ""
    echo "Inspect the archive with:"
    echo "  find '$ARCHIVE_PATH/Products' -type f"
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
    <string>app-store-connect</string>
    <key>teamID</key>
    <string>$DEVELOPMENT_TEAM</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>ai.vocify-inc.vellum-assistant-ios</key>
        <string>$PROVISIONING_PROFILE_NAME</string>
    </dict>
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
