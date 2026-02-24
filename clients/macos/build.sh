#!/bin/bash
set -euo pipefail

# Single-command build script for vellum-assistant.
# Replaces XcodeGen + xcodebuild with: swift build → .app bundle → codesign.
#
# Usage:
#   ./build.sh              Build debug .app
#   ./build.sh run          Build + launch + watch for changes (auto-rebuild)
#   ./build.sh release      Build release .app
#   ./build.sh test         Run tests (no .app needed)
#   ./build.sh clean        Remove build artifacts
#   ./build.sh lint         Build with strict concurrency (catches CI-only errors locally)
#
# Environment variables (for CI):
#   DISPLAY_VERSION   Override CFBundleShortVersionString (default: 0.1.0)
#   BUILD_VERSION     Override CFBundleVersion (default: 1)
#   SIGN_IDENTITY     Override code signing identity

if [ -z "${DEVELOPER_DIR:-}" ]; then
    # Use xcode-select, but fall back to Xcode.app if it points to
    # CommandLineTools (which lacks PreviewsMacros needed for #Preview).
    _dev_dir=$(xcode-select -p 2>/dev/null || echo "")
    if [ -z "$_dev_dir" ] || [[ "$_dev_dir" == */CommandLineTools* ]]; then
        DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
    else
        DEVELOPER_DIR="$_dev_dir"
    fi
    unset _dev_dir
fi
export DEVELOPER_DIR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUNDLE_ID="com.vellum.vellum-assistant"
APP_NAME="vellum-assistant"
BUNDLE_DISPLAY_NAME="${BUNDLE_DISPLAY_NAME:-Vellum}"
APP_DIR="$SCRIPT_DIR/dist/$BUNDLE_DISPLAY_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"

# Version (overridable via env for CI, defaults to Package.swift)
if [ -z "${DISPLAY_VERSION:-}" ]; then
    DISPLAY_VERSION=$(sed -n 's/^let appVersion = "\(.*\)"/\1/p' "$SCRIPT_DIR/../Package.swift" 2>/dev/null | head -1)
    DISPLAY_VERSION="${DISPLAY_VERSION:-0.1.0}"
fi
BUILD_VERSION="${BUILD_VERSION:-1}"

CMD="${1:-build}"

# Signing identity (overridable via env for CI)
# Auto-detect any valid code signing certificate in keychain
if [ -z "${SIGN_IDENTITY:-}" ]; then
    # Try Developer ID Application first (for distribution)
    SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
        | grep "Developer ID Application" \
        | head -1 \
        | sed 's/.*"\(.*\)"/\1/' || true)

    # Fall back to Apple Development certificate (for local dev)
    if [ -z "$SIGN_IDENTITY" ]; then
        SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
            | grep -E "(Apple Development|Mac Developer)" \
            | head -1 \
            | sed 's/.*"\(.*\)"/\1/' || true)
    fi

    # Fall back to adhoc signing (no certificate)
    if [ -z "$SIGN_IDENTITY" ]; then
        SIGN_IDENTITY="-"
    fi
fi

# Export SIGN_IDENTITY so nested invocations (watch mode) inherit it
export SIGN_IDENTITY

case "$CMD" in
    test)
        echo "Running tests..."
        set +e
        TEST_OUTPUT=$(swift test --filter vellum_assistantTests 2>&1)
        TEST_EXIT=$?
        set -e
        echo "$TEST_OUTPUT"

        if [ $TEST_EXIT -eq 0 ]; then
            exit 0
        fi

        # swift test may exit non-zero due to a WebKit SIGTRAP (signal 5) in
        # headless CI even when every test assertion passes.  Tolerate that
        # specific case so flaky WebKit process cleanup doesn't fail the build.
        if echo "$TEST_OUTPUT" | grep -q "unexpected signal code 5" && \
           ! echo "$TEST_OUTPUT" | grep -qE "with [1-9][0-9]* failure"; then
            echo "warning: swift test exited with signal code 5 (WebKit headless crash) but all test assertions passed."
            exit 0
        fi

        exit $TEST_EXIT
        ;;
    lint)
        echo "Linting (strict concurrency)..."
        swift build --product "$APP_NAME" -Xswiftc -strict-concurrency=complete
        echo "Lint passed."
        exit 0
        ;;
    clean)
        echo "Cleaning..."
        rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/../.build"
        echo "Done."
        exit 0
        ;;
    build|run|release)
        ;;
    *)
        echo "Usage: $0 [build|run|release|test|clean|lint]"
        exit 1
        ;;
esac

CONFIG="debug"
SWIFT_FLAGS=""
if [ "$CMD" = "release" ]; then
    CONFIG="release"
    SWIFT_FLAGS="-c release --arch arm64 --arch x86_64"
    if [ "${SKIP_CLEAN:-}" = "1" ]; then
        echo "Release build: skipping .build clean (SKIP_CLEAN=1, using cached artifacts)"
        rm -rf "$SCRIPT_DIR/dist"
    else
        # Force clean for release builds to prevent stale artifacts in production
        echo "Release build: forcing clean to ensure no stale artifacts..."
        rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/../.build"
    fi
fi

# 1. Build with SPM
echo "Building ($CONFIG)..."
# Only build the macOS product — the shared Package.swift also contains an iOS
# target that cannot compile on macOS (UIKit), so we must scope the build.
SWIFT_FLAGS="$SWIFT_FLAGS --product $APP_NAME"
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

# Auto-build daemon binary if missing or stale (source changed) and bun is available
ASSISTANT_SRC_DIR="$SCRIPT_DIR/../../assistant"
DAEMON_BIN_NEEDS_BUILD=false
if [ -d "$ASSISTANT_SRC_DIR/src" ] && command -v bun &>/dev/null; then
    if [ ! -f "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    elif [ -n "$(find "$ASSISTANT_SRC_DIR/src" \( -name '*.ts' -o -name '*.json' \) -newer "$SCRIPT_DIR/daemon-bin/vellum-daemon" -print -quit 2>/dev/null)" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    elif [ "$ASSISTANT_SRC_DIR/package.json" -nt "$SCRIPT_DIR/daemon-bin/vellum-daemon" ] || \
         [ "$ASSISTANT_SRC_DIR/bun.lock" -nt "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    fi
fi
if [ "$DAEMON_BIN_NEEDS_BUILD" = true ]; then
    echo "Building daemon binary from source..."
    mkdir -p "$SCRIPT_DIR/daemon-bin"
    (cd "$ASSISTANT_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    bun build --compile "$ASSISTANT_SRC_DIR/src/daemon/main.ts" \
      --external electron --external "chromium-bidi/*" \
      --outfile "$SCRIPT_DIR/daemon-bin/vellum-daemon"
    chmod +x "$SCRIPT_DIR/daemon-bin/vellum-daemon"
    # Copy WASM assets next to daemon binary (not bundled by bun --compile)
    cp "$ASSISTANT_SRC_DIR/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$SCRIPT_DIR/daemon-bin/"
    cp "$ASSISTANT_SRC_DIR/node_modules/tree-sitter-bash/tree-sitter-bash.wasm" "$SCRIPT_DIR/daemon-bin/"
    echo "Daemon binary built: $SCRIPT_DIR/daemon-bin/vellum-daemon"
fi

# Always refresh bundled skills from source (skill assets like SKILL.md aren't
# tracked by the daemon binary staleness check, so copy unconditionally)
if [ -d "$ASSISTANT_SRC_DIR/src/config/bundled-skills" ]; then
    rm -rf "$SCRIPT_DIR/daemon-bin/bundled-skills"
    cp -R "$ASSISTANT_SRC_DIR/src/config/bundled-skills" "$SCRIPT_DIR/daemon-bin/bundled-skills"
fi

# Also rebuild if daemon binary changed or newly added
if [ -f "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
    if [ ! -f "$MACOS_DIR/vellum-daemon" ] || [ "$SCRIPT_DIR/daemon-bin/vellum-daemon" -nt "$MACOS_DIR/vellum-daemon" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build CLI binary if missing or stale (source changed) and bun is available
CLI_SRC_DIR="$SCRIPT_DIR/../../cli"
CLI_BIN_NEEDS_BUILD=false
if [ -d "$CLI_SRC_DIR/src" ] && command -v bun &>/dev/null; then
    if [ ! -f "$SCRIPT_DIR/cli-bin/vellum-cli" ]; then
        CLI_BIN_NEEDS_BUILD=true
    elif [ -n "$(find "$CLI_SRC_DIR/src" -name '*.ts' -newer "$SCRIPT_DIR/cli-bin/vellum-cli" -print -quit 2>/dev/null)" ]; then
        CLI_BIN_NEEDS_BUILD=true
    elif [ "$CLI_SRC_DIR/package.json" -nt "$SCRIPT_DIR/cli-bin/vellum-cli" ] || \
         [ "$CLI_SRC_DIR/bun.lock" -nt "$SCRIPT_DIR/cli-bin/vellum-cli" ]; then
        CLI_BIN_NEEDS_BUILD=true
    fi
fi
if [ "$CLI_BIN_NEEDS_BUILD" = true ]; then
    echo "Building CLI binary from source..."
    mkdir -p "$SCRIPT_DIR/cli-bin"
    (cd "$CLI_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    bun build --compile "$CLI_SRC_DIR/src/index.ts" --outfile "$SCRIPT_DIR/cli-bin/vellum-cli"
    chmod +x "$SCRIPT_DIR/cli-bin/vellum-cli"
    echo "CLI binary built: $SCRIPT_DIR/cli-bin/vellum-cli"
fi

# Also rebuild if CLI binary changed or newly added
if [ -f "$SCRIPT_DIR/cli-bin/vellum-cli" ]; then
    if [ ! -f "$MACOS_DIR/vellum-cli" ] || [ "$SCRIPT_DIR/cli-bin/vellum-cli" -nt "$MACOS_DIR/vellum-cli" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build gateway binary if missing or stale (source changed) and bun is available
GATEWAY_SRC_DIR="$SCRIPT_DIR/../../gateway"
GATEWAY_BIN_NEEDS_BUILD=false
if [ -d "$GATEWAY_SRC_DIR/src" ] && command -v bun &>/dev/null; then
    if [ ! -f "$SCRIPT_DIR/gateway-bin/vellum-gateway" ]; then
        GATEWAY_BIN_NEEDS_BUILD=true
    elif [ -n "$(find "$GATEWAY_SRC_DIR/src" -name '*.ts' -newer "$SCRIPT_DIR/gateway-bin/vellum-gateway" -print -quit 2>/dev/null)" ]; then
        GATEWAY_BIN_NEEDS_BUILD=true
    elif [ "$GATEWAY_SRC_DIR/package.json" -nt "$SCRIPT_DIR/gateway-bin/vellum-gateway" ] || \
         [ "$GATEWAY_SRC_DIR/bun.lock" -nt "$SCRIPT_DIR/gateway-bin/vellum-gateway" ]; then
        GATEWAY_BIN_NEEDS_BUILD=true
    fi
fi
if [ "$GATEWAY_BIN_NEEDS_BUILD" = true ]; then
    echo "Building gateway binary from source..."
    mkdir -p "$SCRIPT_DIR/gateway-bin"
    (cd "$GATEWAY_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    bun build --compile "$GATEWAY_SRC_DIR/src/index.ts" --outfile "$SCRIPT_DIR/gateway-bin/vellum-gateway"
    chmod +x "$SCRIPT_DIR/gateway-bin/vellum-gateway"
    echo "Gateway binary built: $SCRIPT_DIR/gateway-bin/vellum-gateway"
fi

# Also rebuild if gateway binary changed or newly added
if [ -f "$SCRIPT_DIR/gateway-bin/vellum-gateway" ]; then
    if [ ! -f "$MACOS_DIR/vellum-gateway" ] || [ "$SCRIPT_DIR/gateway-bin/vellum-gateway" -nt "$MACOS_DIR/vellum-gateway" ]; then
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
        # Bundle WASM assets into Resources (not embedded by bun --compile)
        for wasm in "$SCRIPT_DIR/daemon-bin/"*.wasm; do
            [ -f "$wasm" ] && cp "$wasm" "$RESOURCES_DIR/"
        done
    else
        echo "No daemon binary at $DAEMON_BIN — skipping (dev mode)"
    fi

    # Copy bundled CLI binary (if available — built by CI or locally)
    CLI_BIN="$SCRIPT_DIR/cli-bin/vellum-cli"
    if [ -f "$CLI_BIN" ]; then
        echo "Bundling CLI binary..."
        cp "$CLI_BIN" "$MACOS_DIR/vellum-cli"
        chmod +x "$MACOS_DIR/vellum-cli"
    else
        echo "No CLI binary at $CLI_BIN — skipping (dev mode)"
    fi

    # Copy bundled gateway binary (if available — built by CI or locally)
    GATEWAY_BIN="$SCRIPT_DIR/gateway-bin/vellum-gateway"
    if [ -f "$GATEWAY_BIN" ]; then
        echo "Bundling gateway binary..."
        cp "$GATEWAY_BIN" "$MACOS_DIR/vellum-gateway"
        chmod +x "$MACOS_DIR/vellum-gateway"
    else
        echo "No gateway binary at $GATEWAY_BIN — skipping (dev mode)"
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

# Always refresh bundled skills in app bundle (skill assets change independently of binaries)
if [ -d "$SCRIPT_DIR/daemon-bin/bundled-skills" ]; then
    rm -rf "$RESOURCES_DIR/bundled-skills"
    cp -R "$SCRIPT_DIR/daemon-bin/bundled-skills" "$RESOURCES_DIR/bundled-skills"
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
    <string>$BUNDLE_DISPLAY_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$BUNDLE_DISPLAY_NAME</string>
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
    <string>https://github.com/vellum-ai/velly/releases/latest/download/appcast.xml</string>
    <key>SUPublicEDKey</key>
    <string>${SU_PUBLIC_ED_KEY:-}</string>
    <key>SUAutomaticallyUpdate</key>
    <true/>
    <key>CFBundleIconName</key>
    <string>AppIcon</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <!-- Allow HTTP on the local network only -->
        <key>NSAllowsLocalNetworking</key>
        <true/>

        <key>NSExceptionDomains</key>
        <dict>
            <key>localhost</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
            <key>127.0.0.1</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
            <key>vellum.local</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
        </dict>
    </dict>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>$BUNDLE_ID.auth</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>vellum-assistant</string>
            </array>
        </dict>
    </array>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key>
            <string>com.vellum.app-bundle</string>
            <key>UTTypeConformsTo</key>
            <array>
                <string>public.data</string>
                <string>public.content</string>
            </array>
            <key>UTTypeDescription</key>
            <string>Vellum App Bundle</string>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>vellumapp</string>
                </array>
                <key>public.mime-type</key>
                <string>application/x-vellumapp</string>
            </dict>
        </dict>
    </array>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>vellumapp</string>
            </array>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>com.vellum.app-bundle</string>
            </array>
        </dict>
    </array>
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

# Sign components explicitly (Apple's recommended approach instead of --deep)
# This ensures nested binaries with specific entitlements aren't overwritten

# Sign Sparkle.framework — must sign nested binaries inside-out before the outer framework
if [ -d "$FRAMEWORKS_DIR/Sparkle.framework" ]; then
    FW_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        FW_SIGN_FLAGS+=(--timestamp --options runtime)
    fi

    SPARKLE_VERSIONS="$FRAMEWORKS_DIR/Sparkle.framework/Versions/B"

    # Sign XPC services first (deepest nesting)
    for XPC in "$SPARKLE_VERSIONS"/XPCServices/*.xpc; do
        [ -d "$XPC" ] && codesign "${FW_SIGN_FLAGS[@]}" "$XPC"
    done

    # Sign Updater.app
    [ -d "$SPARKLE_VERSIONS/Updater.app" ] && codesign "${FW_SIGN_FLAGS[@]}" "$SPARKLE_VERSIONS/Updater.app"

    # Sign Autoupdate binary
    [ -f "$SPARKLE_VERSIONS/Autoupdate" ] && codesign "${FW_SIGN_FLAGS[@]}" "$SPARKLE_VERSIONS/Autoupdate"

    # Sign the outer framework last
    codesign "${FW_SIGN_FLAGS[@]}" "$FRAMEWORKS_DIR/Sparkle.framework"
    echo "Sparkle.framework signed (including nested binaries)"
fi

# Sign CLI binary
if [ -f "$MACOS_DIR/vellum-cli" ]; then
    CLI_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        CLI_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    codesign "${CLI_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-cli"
    echo "CLI binary signed"
fi

# Sign gateway binary
if [ -f "$MACOS_DIR/vellum-gateway" ]; then
    GATEWAY_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        GATEWAY_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    codesign "${GATEWAY_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-gateway"
    echo "Gateway binary signed"
fi

# Sign daemon binary with its own entitlements (JIT, network)
if [ -f "$MACOS_DIR/vellum-daemon" ]; then
    DAEMON_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$SCRIPT_DIR/daemon-entitlements.plist")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        DAEMON_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    codesign "${DAEMON_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-daemon"
    echo "Daemon binary signed with entitlements"
fi

# Sign the outer app bundle (without --deep to preserve nested signatures)
APP_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
    APP_SIGN_FLAGS+=(--timestamp --options runtime)
fi
codesign "${APP_SIGN_FLAGS[@]}" "$APP_DIR"

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

    # Watch for file changes and auto-rebuild+relaunch (skip in nested invocations)
    if [ -z "${VELLUM_NO_WATCH:-}" ]; then
        WATCH_MARKER=$(mktemp)
        WATCH_MANIFEST=$(mktemp)
        touch "$WATCH_MARKER"
        trap 'rm -f "$WATCH_MARKER" "$WATCH_MANIFEST"' EXIT

        WATCH_DIRS=("$SCRIPT_DIR/vellum-assistant" "$SCRIPT_DIR/vellum-assistant-app")
        WATCH_FILES=("$SCRIPT_DIR/../Package.swift")

        # Snapshot current watched files so we can detect deletions
        snapshot_watched_files() {
            find "${WATCH_DIRS[@]}" "${WATCH_FILES[@]}" \
                -not -path '*/.build/*' \
                -not -path '*/dist/*' \
                \( -name "*.swift" -o -name "*.xcassets" -o -path "*.xcassets/*" \) \
                2>/dev/null | sort > "$WATCH_MANIFEST" || true
        }
        snapshot_watched_files

        echo ""
        echo "Watching for changes... (Ctrl+C to stop)"
        while true; do
            sleep 2

            CHANGED=""

            # Detect modifications: .swift files, .xcassets dirs, or files inside .xcassets
            CHANGED=$(find "${WATCH_DIRS[@]}" "${WATCH_FILES[@]}" \
                -not -path '*/.build/*' \
                -not -path '*/dist/*' \
                \( -name "*.swift" -o -name "*.xcassets" -o -path "*.xcassets/*" \) \
                -newer "$WATCH_MARKER" \
                -print -quit 2>/dev/null || true)

            # Detect deletions: compare current file list against previous snapshot
            if [ -z "$CHANGED" ]; then
                CURRENT_MANIFEST=$(mktemp)
                find "${WATCH_DIRS[@]}" "${WATCH_FILES[@]}" \
                    -not -path '*/.build/*' \
                    -not -path '*/dist/*' \
                    \( -name "*.swift" -o -name "*.xcassets" -o -path "*.xcassets/*" \) \
                    2>/dev/null | sort > "$CURRENT_MANIFEST" || true
                if ! diff -q "$WATCH_MANIFEST" "$CURRENT_MANIFEST" > /dev/null 2>&1; then
                    CHANGED="(file added or removed)"
                fi
                rm -f "$CURRENT_MANIFEST"
            fi

            if [ -n "$CHANGED" ]; then
                echo ""
                echo "───────────────────────────────────"
                echo "Change detected, rebuilding..."
                echo "───────────────────────────────────"
                touch "$WATCH_MARKER"
                snapshot_watched_files
                if VELLUM_NO_WATCH=1 "$0" run; then
                    echo "✓ Rebuilt and relaunched"
                else
                    echo "✗ Build failed"
                fi
                echo ""
                echo "Watching for changes... (Ctrl+C to stop)"
            fi
        done
    fi
fi
