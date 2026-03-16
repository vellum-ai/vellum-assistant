#!/bin/bash
set -euo pipefail

# Single-command build script for vellum-assistant.
# Replaces XcodeGen + xcodebuild with: swift build → .app bundle → codesign.
#
# Usage:
#   ./build.sh                Build debug .app
#   ./build.sh run            Build + launch + watch for changes (auto-rebuild)
#   ./build.sh release        Build release .app
#   ./build.sh binaries       Build only Bun binaries (daemon, CLI, gateway)
#   ./build.sh test [args]    Run tests (no .app needed); forwards extra args to `swift test`
#   ./build.sh clean          Remove build artifacts
#   ./build.sh lint           Build with strict concurrency (catches CI-only errors locally)
#   ./build.sh release-application  Build release, package into DMG, install to /Applications
#                                    (simulates CI distribution pipeline without notarization)
#
# Flags:
#   --universal        Cross-compile Bun binaries for arm64 + x64 (universal binary via lipo)
#
# Environment variables (for CI):
#   DISPLAY_VERSION   Override CFBundleShortVersionString (default: 0.1.0)
#   BUILD_VERSION     Override CFBundleVersion (default: 1)
#   SIGN_IDENTITY     Override code signing identity
#   VELLUM_PLATFORM_URL  Override managed sign-in platform URL for app launches

# ---------------------------------------------------------------------------
# swift_with_retry — run a swift command with retries for transient SPM
# package-resolution failures (e.g. network timeouts downloading binary
# artifacts). Retries up to MAX_ATTEMPTS times with a short delay.
# ---------------------------------------------------------------------------
swift_with_retry() {
    local max_attempts="${SWIFT_RETRY_ATTEMPTS:-3}"
    local attempt=1
    local _pch_cleaned=0
    local _stderr_log
    _stderr_log=$(mktemp)
    # FIFO for stderr streaming. Process substitutions (2> >(tee ...)) are
    # not tracked by `wait` in bash < 4.4 (macOS ships 3.2), so tee could
    # still be writing when grep reads the log. A named pipe with an explicit
    # tee PID gives correct synchronization on all bash versions.
    local _fifo_dir
    _fifo_dir=$(mktemp -d)
    local _fifo="$_fifo_dir/stderr.fifo"
    mkfifo "$_fifo"
    trap "rm -rf '$_stderr_log' '$_fifo_dir'" RETURN
    while true; do
        local _cmd_exit=0
        tee "$_stderr_log" >&2 < "$_fifo" &
        local _tee_pid=$!
        "$@" 2>"$_fifo" || _cmd_exit=$?
        wait "$_tee_pid"
        if [ "$_cmd_exit" -eq 0 ]; then
            return 0
        fi
        # Auto-clean stale PCH module cache (happens when switching between
        # worktrees that share the same .build directory via symlink).
        if [ "$_pch_cleaned" -eq 0 ] && grep -q "PCH was compiled with module cache path" "$_stderr_log" 2>/dev/null; then
            echo "warning: stale module cache detected, cleaning and retrying..."
            find -L "$SCRIPT_DIR/../.build" -type d -name "ModuleCache" -exec rm -rf {} + 2>/dev/null || true
            _pch_cleaned=1
            continue
        fi
        if [ "$attempt" -ge "$max_attempts" ]; then
            echo "ERROR: swift command failed after $max_attempts attempts: $*"
            return 1
        fi
        echo "warning: swift command failed (attempt $attempt/$max_attempts), retrying in 10s..."
        sleep 10
        attempt=$((attempt + 1))
    done
}

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
FRAMEWORKS_DIR="$CONTENTS/Frameworks"

# Version (overridable via env for CI, defaults to Package.swift)
if [ -z "${DISPLAY_VERSION:-}" ]; then
    DISPLAY_VERSION=$(sed -n 's/^let appVersion = "\(.*\)"/\1/p' "$SCRIPT_DIR/../Package.swift" 2>/dev/null | head -1)
    DISPLAY_VERSION="${DISPLAY_VERSION:-0.1.0}"
fi
BUILD_VERSION="${BUILD_VERSION:-1}"

# Parse arguments: command + optional flags
UNIVERSAL_BUILD=false
CMD="build"
CMD_SET=false
CMD_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --universal) UNIVERSAL_BUILD=true ;;
        *)
            if [ "$CMD_SET" = false ]; then
                CMD="$arg"
                CMD_SET=true
            else
                CMD_ARGS+=("$arg")
            fi
            ;;
    esac
done

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

    # Fall back to any valid codesigning identity (e.g. self-signed)
    if [ -z "$SIGN_IDENTITY" ]; then
        SIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
            | grep -v "valid identities found" \
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

# Source directories for Bun binaries
ASSISTANT_SRC_DIR="$SCRIPT_DIR/../../assistant"
CLI_SRC_DIR="$SCRIPT_DIR/../../cli"
GATEWAY_SRC_DIR="$SCRIPT_DIR/../../gateway"

# Packages that must stay external in compiled Bun binaries.
# playwright-core has optional requires (electron, chromium-bidi) that cannot
# be resolved at bundle time.  Mark them external so bun --compile skips them.
BUN_EXTERNAL_FLAGS=(--external electron --external "chromium-bidi/*")

# ---------------------------------------------------------------------------
# build_bun_binary — compile a TypeScript project to a native binary via Bun.
#
# Usage: build_bun_binary <src_dir> <entry_point> <output_dir> <output_name> [extra_flags...]
#
# When --universal is set, cross-compiles for arm64 + x64 and produces a fat
# binary via lipo. Otherwise compiles for the current architecture only.
# ---------------------------------------------------------------------------
build_bun_binary() {
    local src_dir="$1" entry="$2" out_dir="$3" out_name="$4"
    shift 4

    mkdir -p "$out_dir"
    if [ "${SKIP_BUN_INSTALL:-}" != "1" ]; then
        (cd "$src_dir" && bun install --frozen-lockfile 2>/dev/null || bun install)
    fi

    local build_flags=(--compile "$@")

    if [ "$UNIVERSAL_BUILD" = true ]; then
        echo "Building $out_name (universal)..."
        bun build "${build_flags[@]}" --target=bun-darwin-arm64 "$entry" \
            --outfile "$out_dir/${out_name}-arm64"
        bun build "${build_flags[@]}" --target=bun-darwin-x64 "$entry" \
            --outfile "$out_dir/${out_name}-x64"
        lipo -create \
            "$out_dir/${out_name}-arm64" \
            "$out_dir/${out_name}-x64" \
            -output "$out_dir/$out_name"
        rm "$out_dir/${out_name}-arm64" "$out_dir/${out_name}-x64"
    else
        echo "Building $out_name..."
        bun build "${build_flags[@]}" "$entry" --outfile "$out_dir/$out_name"
    fi

    chmod +x "$out_dir/$out_name"
    echo "$out_name built: $out_dir/$out_name"
    [ "$UNIVERSAL_BUILD" = true ] && file "$out_dir/$out_name" || true
}

# ---------------------------------------------------------------------------
# build_binaries — build all Bun binaries (daemon, CLI, gateway).
#
# Installs dependencies once per source directory upfront, then compiles all
# four binaries in parallel to reduce wall-clock time.
# ---------------------------------------------------------------------------
build_binaries() {
    command -v bun &>/dev/null || { echo "ERROR: bun is required but not found"; exit 1; }

    # Pre-install dependencies once per source directory so parallel builds
    # don't race on the same node_modules.
    echo "Installing dependencies..."
    (cd "$ASSISTANT_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    (cd "$CLI_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    (cd "$GATEWAY_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)

    # Shared flags for daemon and assistant CLI
    local daemon_flags=("${BUN_EXTERNAL_FLAGS[@]}")
    if [ -n "${DISPLAY_VERSION:-}" ] && [ "$DISPLAY_VERSION" != "0.1.0" ]; then
        daemon_flags+=(--define "process.env.APP_VERSION='$DISPLAY_VERSION'")
    fi
    if [ -n "${COMMIT_SHA:-}" ]; then
        daemon_flags+=(--define "process.env.COMMIT_SHA='$COMMIT_SHA'")
    fi

    local cli_flags=("${BUN_EXTERNAL_FLAGS[@]}")
    if [ -n "${DISPLAY_VERSION:-}" ] && [ "$DISPLAY_VERSION" != "0.1.0" ]; then
        cli_flags+=(--define "process.env.APP_VERSION='$DISPLAY_VERSION'")
    fi
    if [ -n "${COMMIT_SHA:-}" ]; then
        cli_flags+=(--define "process.env.COMMIT_SHA='$COMMIT_SHA'")
    fi

    # Build all four binaries in parallel. Each writes to its own output
    # directory so there are no filesystem conflicts. SKIP_BUN_INSTALL=1
    # tells build_bun_binary to skip `bun install` (already done above).
    echo "Building binaries in parallel..."
    local pids=() failures=0

    SKIP_BUN_INSTALL=1 build_bun_binary "$ASSISTANT_SRC_DIR" "$ASSISTANT_SRC_DIR/src/daemon/main.ts" \
        "$SCRIPT_DIR/daemon-bin" "vellum-daemon" "${daemon_flags[@]}" &
    pids+=($!)

    SKIP_BUN_INSTALL=1 build_bun_binary "$ASSISTANT_SRC_DIR" "$ASSISTANT_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/assistant-bin" "vellum-assistant" "${cli_flags[@]}" &
    pids+=($!)

    SKIP_BUN_INSTALL=1 build_bun_binary "$CLI_SRC_DIR" "$CLI_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/cli-bin" "vellum-cli" &
    pids+=($!)

    SKIP_BUN_INSTALL=1 build_bun_binary "$GATEWAY_SRC_DIR" "$GATEWAY_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/gateway-bin" "vellum-gateway" &
    pids+=($!)

    for pid in "${pids[@]}"; do
        wait "$pid" || failures=$((failures + 1))
    done
    if [ "$failures" -gt 0 ]; then
        echo "ERROR: $failures binary build(s) failed"
        exit 1
    fi

    # Post-build: copy assets that bun --compile doesn't embed
    cp "$ASSISTANT_SRC_DIR/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$SCRIPT_DIR/daemon-bin/"
    cp "$ASSISTANT_SRC_DIR/node_modules/tree-sitter-bash/tree-sitter-bash.wasm" "$SCRIPT_DIR/daemon-bin/"
    rm -rf "$SCRIPT_DIR/daemon-bin/node_modules"
    rm -rf "$SCRIPT_DIR/daemon-bin/bundled-skills"
    cp -R "$ASSISTANT_SRC_DIR/src/config/bundled-skills" "$SCRIPT_DIR/daemon-bin/bundled-skills"
    rm -rf "$SCRIPT_DIR/daemon-bin/templates"
    cp -R "$ASSISTANT_SRC_DIR/src/prompts/templates" "$SCRIPT_DIR/daemon-bin/templates"
    rm -rf "$SCRIPT_DIR/daemon-bin/hook-templates"
    cp -R "$ASSISTANT_SRC_DIR/hook-templates" "$SCRIPT_DIR/daemon-bin/hook-templates"
    rm -rf "$SCRIPT_DIR/daemon-bin/brain-graph"
    mkdir -p "$SCRIPT_DIR/daemon-bin/brain-graph"
    cp "$ASSISTANT_SRC_DIR/src/runtime/routes/brain-graph/brain-graph.html" "$SCRIPT_DIR/daemon-bin/brain-graph/"
}

case "$CMD" in
    test)
        echo "Running tests..."
        if [ ${#CMD_ARGS[@]} -eq 0 ]; then
            SWIFT_TEST_ARGS=(--filter vellum_assistantTests)
        else
            SWIFT_TEST_ARGS=("${CMD_ARGS[@]}")
        fi
        set +e
        TEST_OUTPUT=$(swift_with_retry swift test "${SWIFT_TEST_ARGS[@]}" 2>&1)
        TEST_EXIT=$?
        set -e
        echo "$TEST_OUTPUT"

        if [ $TEST_EXIT -eq 0 ]; then
            exit 0
        fi

        # swift test may exit non-zero due to a WebKit SIGTRAP (signal 5) in
        # headless CI even when every test assertion passes.  Tolerate that
        # specific case so flaky WebKit process cleanup doesn't fail the build.
        # Use grep with here-strings instead of piping from echo to avoid
        # broken-pipe errors (SIGPIPE) when pipefail is set and the test
        # output is very large — grep -q exits early, killing echo mid-write.
        if grep -q "unexpected signal code 5" <<< "$TEST_OUTPUT" && \
           ! grep -qE "with [1-9][0-9]* failure" <<< "$TEST_OUTPUT"; then
            echo "warning: swift test exited with signal code 5 (WebKit headless crash) but all test assertions passed."
            exit 0
        fi

        exit $TEST_EXIT
        ;;
    lint)
        echo "Linting (strict concurrency)..."
        swift_with_retry swift build --product "$APP_NAME" -Xswiftc -strict-concurrency=complete
        echo "Lint passed."
        exit 0
        ;;
    clean)
        echo "Cleaning..."
        rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/../.build"
        echo "Done."
        exit 0
        ;;
    binaries)
        build_binaries
        echo "All binaries built."
        exit 0
        ;;
    build|run|release|release-application)
        ;;
    *)
        echo "Usage: $0 [build|run|release|release-application|binaries|test|clean|lint]"
        exit 1
        ;;
esac

# release-application implies release build
if [ "$CMD" = "release-application" ]; then
    RELEASE_APP_MODE=true
else
    RELEASE_APP_MODE=false
fi

CONFIG="debug"
SWIFT_FLAGS=""
if [ "$CMD" = "release" ] || [ "$CMD" = "release-application" ]; then
    CONFIG="release"
    SWIFT_FLAGS="-c release ${RELEASE_ARCH_FLAGS:---arch arm64}"
    if [ -n "${PREBUILT_BIN_PATH:-}" ]; then
        # Using prebuilt binaries from parallel CI jobs — only clean dist
        echo "Release build: using prebuilt binaries, cleaning dist only..."
        rm -rf "$SCRIPT_DIR/dist"
    elif [ "${SKIP_CLEAN:-}" = "1" ]; then
        echo "Release build: skipping .build clean (SKIP_CLEAN=1, using cached artifacts)"
        rm -rf "$SCRIPT_DIR/dist"
    else
        # Force clean for release builds to prevent stale artifacts in production
        echo "Release build: forcing clean to ensure no stale artifacts..."
        rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/../.build"
    fi
fi

# 1. Build with SPM (or use prebuilt binaries if PREBUILT_BIN_PATH is set)
if [ -n "${PREBUILT_BIN_PATH:-}" ]; then
    echo "Using prebuilt binaries from $PREBUILT_BIN_PATH"
    BIN_PATH="$(cd "$PREBUILT_BIN_PATH" && pwd)"
    EXECUTABLE="$BIN_PATH/$APP_NAME"
else
    echo "Building ($CONFIG)..."
    # Only build the macOS product — the shared Package.swift also contains an iOS
    # target that cannot compile on macOS (UIKit), so we must scope the build.
    SWIFT_FLAGS="$SWIFT_FLAGS --product $APP_NAME"
    # Get bin path first (fast, doesn't rebuild)
    BIN_PATH=$(swift build $SWIFT_FLAGS --show-bin-path)

    # Then build (or use cached if nothing changed)
    swift_with_retry swift build $SWIFT_FLAGS

    EXECUTABLE="$BIN_PATH/$APP_NAME"
fi

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
DAEMON_BIN_NEEDS_BUILD=false
if [ -d "$ASSISTANT_SRC_DIR/src" ] && command -v bun &>/dev/null; then
    if [ ! -f "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    elif [ -n "$(find "$ASSISTANT_SRC_DIR/src" \( -name '*.ts' -o -name '*.json' \) -newer "$SCRIPT_DIR/daemon-bin/vellum-daemon" -print -quit 2>/dev/null)" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    elif [ "$ASSISTANT_SRC_DIR/package.json" -nt "$SCRIPT_DIR/daemon-bin/vellum-daemon" ] || \
         [ "$ASSISTANT_SRC_DIR/bun.lock" -nt "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    elif [ "$SCRIPT_DIR/build.sh" -nt "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
        DAEMON_BIN_NEEDS_BUILD=true
    fi
fi
if [ "$DAEMON_BIN_NEEDS_BUILD" = true ]; then
    local_daemon_flags=("${BUN_EXTERNAL_FLAGS[@]}")
    if [ -n "${DISPLAY_VERSION:-}" ] && [ "$DISPLAY_VERSION" != "0.1.0" ]; then
        local_daemon_flags+=(--define "process.env.APP_VERSION='$DISPLAY_VERSION'")
    fi
    if [ -n "${COMMIT_SHA:-}" ]; then
        local_daemon_flags+=(--define "process.env.COMMIT_SHA='$COMMIT_SHA'")
    fi
    build_bun_binary "$ASSISTANT_SRC_DIR" "$ASSISTANT_SRC_DIR/src/daemon/main.ts" \
        "$SCRIPT_DIR/daemon-bin" "vellum-daemon" "${local_daemon_flags[@]}"
    cp "$ASSISTANT_SRC_DIR/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$SCRIPT_DIR/daemon-bin/"
    cp "$ASSISTANT_SRC_DIR/node_modules/tree-sitter-bash/tree-sitter-bash.wasm" "$SCRIPT_DIR/daemon-bin/"
    # Embedding runtime (onnxruntime-node + @huggingface/transformers) is no longer
    # shipped with the app. It's downloaded post-hatch by EmbeddingRuntimeManager.
    rm -rf "$SCRIPT_DIR/daemon-bin/node_modules"
fi

# Always refresh bundled skills from source (skill assets like SKILL.md aren't
# tracked by the daemon binary staleness check, so copy unconditionally)
if [ -d "$ASSISTANT_SRC_DIR/src/config/bundled-skills" ]; then
    mkdir -p "$SCRIPT_DIR/daemon-bin"
    rm -rf "$SCRIPT_DIR/daemon-bin/bundled-skills"
    cp -R "$ASSISTANT_SRC_DIR/src/config/bundled-skills" "$SCRIPT_DIR/daemon-bin/bundled-skills"
fi

# Always refresh non-JS assets from source (not embedded by bun --compile)
mkdir -p "$SCRIPT_DIR/daemon-bin"
if [ -d "$ASSISTANT_SRC_DIR/src/prompts/templates" ]; then
    rm -rf "$SCRIPT_DIR/daemon-bin/templates"
    cp -R "$ASSISTANT_SRC_DIR/src/prompts/templates" "$SCRIPT_DIR/daemon-bin/templates"
fi
if [ -d "$ASSISTANT_SRC_DIR/hook-templates" ]; then
    rm -rf "$SCRIPT_DIR/daemon-bin/hook-templates"
    cp -R "$ASSISTANT_SRC_DIR/hook-templates" "$SCRIPT_DIR/daemon-bin/hook-templates"
fi
if [ -f "$ASSISTANT_SRC_DIR/src/runtime/routes/brain-graph/brain-graph.html" ]; then
    rm -rf "$SCRIPT_DIR/daemon-bin/brain-graph"
    mkdir -p "$SCRIPT_DIR/daemon-bin/brain-graph"
    cp "$ASSISTANT_SRC_DIR/src/runtime/routes/brain-graph/brain-graph.html" "$SCRIPT_DIR/daemon-bin/brain-graph/"
fi
# Also rebuild if daemon binary changed or newly added
if [ -f "$SCRIPT_DIR/daemon-bin/vellum-daemon" ]; then
    if [ ! -f "$MACOS_DIR/vellum-daemon" ] || [ "$SCRIPT_DIR/daemon-bin/vellum-daemon" -nt "$MACOS_DIR/vellum-daemon" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build assistant CLI binary if missing or stale (source changed) and bun is available
ASSISTANT_CLI_BIN_NEEDS_BUILD=false
if [ -d "$ASSISTANT_SRC_DIR/src" ] && command -v bun &>/dev/null; then
    if [ ! -f "$SCRIPT_DIR/assistant-bin/vellum-assistant" ]; then
        ASSISTANT_CLI_BIN_NEEDS_BUILD=true
    elif [ -n "$(find "$ASSISTANT_SRC_DIR/src" \( -name '*.ts' -o -name '*.json' \) -newer "$SCRIPT_DIR/assistant-bin/vellum-assistant" -print -quit 2>/dev/null)" ]; then
        ASSISTANT_CLI_BIN_NEEDS_BUILD=true
    elif [ "$ASSISTANT_SRC_DIR/package.json" -nt "$SCRIPT_DIR/assistant-bin/vellum-assistant" ] || \
         [ "$ASSISTANT_SRC_DIR/bun.lock" -nt "$SCRIPT_DIR/assistant-bin/vellum-assistant" ]; then
        ASSISTANT_CLI_BIN_NEEDS_BUILD=true
    elif [ "$SCRIPT_DIR/build.sh" -nt "$SCRIPT_DIR/assistant-bin/vellum-assistant" ]; then
        ASSISTANT_CLI_BIN_NEEDS_BUILD=true
    fi
fi
if [ "$ASSISTANT_CLI_BIN_NEEDS_BUILD" = true ]; then
    build_bun_binary "$ASSISTANT_SRC_DIR" "$ASSISTANT_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/assistant-bin" "vellum-assistant" "${BUN_EXTERNAL_FLAGS[@]}"
fi

# Also rebuild if assistant CLI binary changed or newly added
if [ -f "$SCRIPT_DIR/assistant-bin/vellum-assistant" ]; then
    if [ ! -f "$MACOS_DIR/vellum-assistant" ] || [ "$SCRIPT_DIR/assistant-bin/vellum-assistant" -nt "$MACOS_DIR/vellum-assistant" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build CLI binary if missing or stale (source changed) and bun is available
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
    build_bun_binary "$CLI_SRC_DIR" "$CLI_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/cli-bin" "vellum-cli"
fi

# Also rebuild if CLI binary changed or newly added
if [ -f "$SCRIPT_DIR/cli-bin/vellum-cli" ]; then
    if [ ! -f "$MACOS_DIR/vellum-cli" ] || [ "$SCRIPT_DIR/cli-bin/vellum-cli" -nt "$MACOS_DIR/vellum-cli" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build gateway binary if missing or stale (source changed) and bun is available
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
    build_bun_binary "$GATEWAY_SRC_DIR" "$GATEWAY_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/gateway-bin" "vellum-gateway"
fi

# Also rebuild if gateway binary changed or newly added
if [ -f "$SCRIPT_DIR/gateway-bin/vellum-gateway" ]; then
    if [ ! -f "$MACOS_DIR/vellum-gateway" ] || [ "$SCRIPT_DIR/gateway-bin/vellum-gateway" -nt "$MACOS_DIR/vellum-gateway" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Ensure .app bundle structure exists
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
        # Embedding runtime is now downloaded post-hatch (no bundled node_modules)
        rm -rf "$MACOS_DIR/node_modules"
    else
        echo "No daemon binary at $DAEMON_BIN — skipping (dev mode)"
    fi

    # Copy bundled assistant CLI binary (if available — built by CI or locally)
    ASSISTANT_CLI_BIN="$SCRIPT_DIR/assistant-bin/vellum-assistant"
    if [ -f "$ASSISTANT_CLI_BIN" ]; then
        echo "Bundling assistant CLI binary..."
        cp "$ASSISTANT_CLI_BIN" "$MACOS_DIR/vellum-assistant"
        chmod +x "$MACOS_DIR/vellum-assistant"
    else
        echo "No assistant CLI binary at $ASSISTANT_CLI_BIN — skipping (dev mode)"
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

# Always refresh non-JS assets in app bundle (not embedded by bun --compile)
if [ -d "$SCRIPT_DIR/daemon-bin/templates" ]; then
    rm -rf "$RESOURCES_DIR/templates"
    cp -R "$SCRIPT_DIR/daemon-bin/templates" "$RESOURCES_DIR/templates"
fi
if [ -d "$SCRIPT_DIR/daemon-bin/hook-templates" ]; then
    rm -rf "$RESOURCES_DIR/hook-templates"
    cp -R "$SCRIPT_DIR/daemon-bin/hook-templates" "$RESOURCES_DIR/hook-templates"
fi
if [ -d "$SCRIPT_DIR/daemon-bin/brain-graph" ]; then
    rm -rf "$RESOURCES_DIR/brain-graph"
    cp -R "$SCRIPT_DIR/daemon-bin/brain-graph" "$RESOURCES_DIR/brain-graph"
fi
# Always refresh feature flag registry for the bundled gateway.
# The compiled gateway resolves this from Contents/Resources in app layouts.
FEATURE_FLAG_REGISTRY="$SCRIPT_DIR/../../meta/feature-flags/feature-flag-registry.json"
if [ -f "$FEATURE_FLAG_REGISTRY" ]; then
    cp "$FEATURE_FLAG_REGISTRY" "$RESOURCES_DIR/feature-flag-registry.json"
fi
# Generate character-components.json for pre-daemon avatar rendering
CHAR_COMP_SRC="$ASSISTANT_SRC_DIR/src/avatar/character-components.ts"
if command -v bun &>/dev/null && [ -f "$CHAR_COMP_SRC" ]; then
    echo "Generating character-components.json..."
    bun -e "import { getCharacterComponents } from '$CHAR_COMP_SRC'; process.stdout.write(JSON.stringify(getCharacterComponents()))" > "$RESOURCES_DIR/character-components.json"
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

# Default VELLUM_PLATFORM_URL for `run` builds (local dev against dev platform)
if [ "$CMD" = "run" ] && [ -z "${VELLUM_PLATFORM_URL:-}" ]; then
    export VELLUM_PLATFORM_URL="https://dev-assistant.vellum.ai"
fi

# Always regenerate Info.plist (fast, depends on env vars like DISPLAY_VERSION)
LSE_ENVIRONMENT_PLIST=""
if [ -n "${VELLUM_PLATFORM_URL:-}" ]; then
    PLATFORM_URL_OVERRIDE="${VELLUM_PLATFORM_URL%/}"
    echo "Embedding app platform URL override: $PLATFORM_URL_OVERRIDE"
    LSE_ENVIRONMENT_PLIST=$(cat <<EOF
    <key>LSEnvironment</key>
    <dict>
        <key>VELLUM_PLATFORM_URL</key>
        <string>$PLATFORM_URL_OVERRIDE</string>
    </dict>
EOF
)
fi

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
    $LSE_ENVIRONMENT_PLIST
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
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUAutomaticallyUpdate</key>
    <true/>
    <key>CFBundleIconName</key>
    <string>AppIcon</string>
    <key>CFBundleIconFile</key>
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
            <key>UTTypeIconFile</key>
            <string>VellumDocument</string>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>vellum</string>
                </array>
                <key>public.mime-type</key>
                <string>application/x-vellum</string>
            </dict>
        </dict>
    </array>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>vellum</string>
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

# Copy document type icon for .vellum UTI
cp "$SCRIPT_DIR/vellum-assistant/Resources/VellumDocument.icns" "$RESOURCES_DIR/"

# Derive target architecture for Quick Look extensions from RELEASE_ARCH_FLAGS.
# Falls back to host architecture when RELEASE_ARCH_FLAGS is unset (dev builds).
if [ -n "${RELEASE_ARCH_FLAGS:-}" ]; then
    QL_TARGET_ARCH=$(echo "$RELEASE_ARCH_FLAGS" | sed -n 's/.*--arch \([^ ]*\).*/\1/p')
fi
QL_TARGET_ARCH="${QL_TARGET_ARCH:-$(uname -m)}"

# Build and embed Quick Look Thumbnail extension (appex)
QLTHUMB_SRC="$SCRIPT_DIR/VellumQLThumbnail"
if [ -d "$QLTHUMB_SRC" ]; then
    echo "Building VellumQLThumbnail appex..."
    QLTHUMB_APPEX="$CONTENTS/PlugIns/VellumQLThumbnail.appex"
    QLTHUMB_APPEX_CONTENTS="$QLTHUMB_APPEX/Contents"
    QLTHUMB_APPEX_MACOS="$QLTHUMB_APPEX_CONTENTS/MacOS"
    mkdir -p "$QLTHUMB_APPEX_MACOS"

    # Compile the extension as an appex binary.
    # App extensions use NSExtensionMain as the entry point (provided by Foundation).
    # The -Xlinker -e -Xlinker _NSExtensionMain flags tell the linker to use it
    # instead of a regular main() function.
    xcrun swiftc \
        -module-name VellumQLThumbnail \
        -emit-executable \
        -target "${QL_TARGET_ARCH}-apple-macosx14.0" \
        -sdk "$(xcrun --show-sdk-path)" \
        -framework QuickLookThumbnailing \
        -framework AppKit \
        -framework CoreGraphics \
        -Xlinker -e -Xlinker _NSExtensionMain \
        -o "$QLTHUMB_APPEX_MACOS/VellumQLThumbnail" \
        "$QLTHUMB_SRC/ThumbnailProvider.swift"

    # Copy Info.plist
    cp "$QLTHUMB_SRC/Info.plist" "$QLTHUMB_APPEX_CONTENTS/Info.plist"

    echo "VellumQLThumbnail appex built"
fi

# Build and embed Quick Look Preview extension (appex)
QLPREV_SRC="$SCRIPT_DIR/VellumQLPreview"
if [ -d "$QLPREV_SRC" ]; then
    echo "Building VellumQLPreview appex..."
    QLPREV_APPEX="$CONTENTS/PlugIns/VellumQLPreview.appex"
    QLPREV_APPEX_CONTENTS="$QLPREV_APPEX/Contents"
    QLPREV_APPEX_MACOS="$QLPREV_APPEX_CONTENTS/MacOS"
    mkdir -p "$QLPREV_APPEX_MACOS"

    # Compile the extension as an appex binary.
    # App extensions use NSExtensionMain as the entry point (provided by Foundation).
    xcrun swiftc \
        -module-name VellumQLPreview \
        -emit-executable \
        -target "${QL_TARGET_ARCH}-apple-macosx14.0" \
        -sdk "$(xcrun --show-sdk-path)" \
        -framework QuickLookUI \
        -framework UniformTypeIdentifiers \
        -Xlinker -e -Xlinker _NSExtensionMain \
        -o "$QLPREV_APPEX_MACOS/VellumQLPreview" \
        "$QLPREV_SRC/PreviewProvider.swift"

    # Copy Info.plist
    cp "$QLPREV_SRC/Info.plist" "$QLPREV_APPEX_CONTENTS/Info.plist"

    echo "VellumQLPreview appex built"
fi

# Remove transient runtime artifacts that may be written into the app bundle
# during local dev runs (for example qdrant marker files). These are not part
# of the distributable app and can break outer-bundle codesign verification.
rm -f "$MACOS_DIR/.qdrant-initialized"
rm -rf "$MACOS_DIR/snapshots"
find "$MACOS_DIR" -maxdepth 1 \( -type f -o -type s \) \
    \( -name "*.pid" -o -name "*.sock" -o -name "*.log" \) \
    -delete

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
    # --bundle-format framework is required on newer codesign versions because
    # Sparkle's Versions/B layout is ambiguous (could be app or framework).
    # Fall back to plain codesign if the flag isn't supported.
    if codesign --bundle-format framework "${FW_SIGN_FLAGS[@]}" "$FRAMEWORKS_DIR/Sparkle.framework" 2>/dev/null; then
        :
    else
        codesign "${FW_SIGN_FLAGS[@]}" "$FRAMEWORKS_DIR/Sparkle.framework"
    fi
    echo "Sparkle.framework signed (including nested binaries)"
fi

# Sign Quick Look Thumbnail extension (must be signed before outer app bundle)
QLTHUMB_APPEX="$CONTENTS/PlugIns/VellumQLThumbnail.appex"
if [ -d "$QLTHUMB_APPEX" ]; then
    QLTHUMB_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        QLTHUMB_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    codesign "${QLTHUMB_SIGN_FLAGS[@]}" "$QLTHUMB_APPEX"
    echo "VellumQLThumbnail.appex signed"
fi

# Sign Quick Look Preview extension (must be signed before outer app bundle)
QLPREV_APPEX="$CONTENTS/PlugIns/VellumQLPreview.appex"
if [ -d "$QLPREV_APPEX" ]; then
    QLPREV_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        QLPREV_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    codesign "${QLPREV_SIGN_FLAGS[@]}" "$QLPREV_APPEX"
    echo "VellumQLPreview.appex signed"
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

# Embedding runtime node_modules are no longer bundled (downloaded post-hatch).

# Sign any additional regular files directly under Contents/MacOS.
# This protects against future unsigned loose files in incremental dev builds.
if [ -d "$MACOS_DIR" ]; then
    EXTRA_FILE_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
    if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
        EXTRA_FILE_SIGN_FLAGS+=(--timestamp --options runtime)
    fi
    find "$MACOS_DIR" -maxdepth 1 -type f \
        ! -name "$BUNDLE_DISPLAY_NAME" \
        ! -name "vellum-daemon" \
        ! -name "vellum-cli" \
        ! -name "vellum-gateway" \
        -exec codesign "${EXTRA_FILE_SIGN_FLAGS[@]}" {} \;
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

# Generate dSYM debug symbol bundles for Sentry crash symbolication (release only)
if [ "$CONFIG" = "release" ]; then
    echo "Generating dSYM debug symbols..."
    dsymutil "$MACOS_DIR/$BUNDLE_DISPLAY_NAME" -o "$SCRIPT_DIR/dist/$BUNDLE_DISPLAY_NAME.app.dSYM"
    echo "Generated dSYM: dist/$BUNDLE_DISPLAY_NAME.app.dSYM"

    # Note: Sentry.framework is a pre-built binary from SPM and does not contain
    # the .o object files needed by dsymutil. Sentry distributes their own dSYMs
    # separately via their SDK integration — no need to run dsymutil on it.
fi

# 7. Run if requested
if [ "$CMD" = "run" ]; then
    echo "Launching..."
    # Kill any previous build.sh watcher processes so they don't linger
    # after their terminal is closed and trigger surprise rebuilds.
    # Skip when invoked as a nested rebuild (VELLUM_NO_WATCH=1) to avoid
    # killing the parent watcher process.
    if [ -z "${VELLUM_NO_WATCH:-}" ]; then
        my_pid=$$
        for pid in $(pgrep -f "build\.sh run" 2>/dev/null || true); do
            if [ "$pid" != "$my_pid" ]; then
                kill "$pid" 2>/dev/null || true
            fi
        done
    fi

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

    # Stream unified logs from the app in the background so errors are
    # visible in the same terminal. Only start once (skip nested rebuilds).
    if [ -z "${VELLUM_NO_WATCH:-}" ]; then
        LOG_STREAM_PID=""
        echo ""
        echo "Streaming app logs (subsystem: $BUNDLE_ID)..."
        log stream --predicate "subsystem == \"$BUNDLE_ID\"" --level debug &
        LOG_STREAM_PID=$!
    fi

    # Watch for file changes and auto-rebuild+relaunch (skip in nested invocations)
    if [ -z "${VELLUM_NO_WATCH:-}" ]; then
        WATCH_MARKER=$(mktemp)
        WATCH_MANIFEST=$(mktemp)
        touch "$WATCH_MARKER"
        trap 'rm -f "$WATCH_MARKER" "$WATCH_MANIFEST"; [ -n "${LOG_STREAM_PID:-}" ] && kill "$LOG_STREAM_PID" 2>/dev/null || true' EXIT

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
                if VELLUM_NO_WATCH=1 "$SCRIPT_DIR/build.sh" run; then
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

# 8. Package and install to /Applications if release-application
if [ "$RELEASE_APP_MODE" = true ]; then
    echo ""
    echo "═══════════════════════════════════════════"
    echo "  Packaging for local distribution testing"
    echo "═══════════════════════════════════════════"

    DMG_BUILD_DIR="$SCRIPT_DIR/build"
    DMG_PATH="$DMG_BUILD_DIR/vellum-assistant.dmg"
    DMG_STAGING="$DMG_BUILD_DIR/dmg-staging"

    mkdir -p "$DMG_BUILD_DIR"
    rm -rf "$DMG_STAGING" "$DMG_PATH"
    mkdir -p "$DMG_STAGING"

    echo "Creating DMG..."
    cp -R "$APP_DIR" "$DMG_STAGING/"
    ln -s /Applications "$DMG_STAGING/Applications"

    # Use create-dmg if available for a production-like DMG, otherwise fall
    # back to hdiutil which is always available on macOS.
    if command -v create-dmg &>/dev/null; then
        # Use pre-generated DMG background if available
        DMG_BG_FILE="$SCRIPT_DIR/dmg/dmg-background@2x.png"
        DMG_BG_ARGS=()
        if [ -f "$DMG_BG_FILE" ]; then
            DMG_BG_ARGS=(--background "$DMG_BG_FILE")
        else
            # Fall back to generating at runtime if the pre-rendered file is missing
            DMG_BG_SCRIPT="$SCRIPT_DIR/dmg/generate-background.swift"
            if [ -f "$DMG_BG_SCRIPT" ]; then
                swift "$DMG_BG_SCRIPT" "$DMG_BUILD_DIR/dmg-background@2x.png" 2>/dev/null || true
                if [ -f "$DMG_BUILD_DIR/dmg-background@2x.png" ]; then
                    DMG_BG_ARGS=(--background "$DMG_BUILD_DIR/dmg-background@2x.png")
                fi
            fi
        fi

        create-dmg \
            --volname "Vellum" \
            "${DMG_BG_ARGS[@]}" \
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
    else
        echo "(create-dmg not found, using hdiutil — install via 'brew install create-dmg' for production-like DMGs)"
        hdiutil create -volname "Vellum" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_PATH"
    fi

    echo "DMG created: $DMG_PATH"
    ls -lh "$DMG_PATH"

    # Sign the DMG with the same identity used for the app
    if [ "$SIGN_IDENTITY" != "-" ]; then
        echo "Signing DMG..."
        codesign --sign "$SIGN_IDENTITY" --timestamp "$DMG_PATH" 2>/dev/null || \
            codesign --sign "$SIGN_IDENTITY" "$DMG_PATH"
        codesign --verify --verbose "$DMG_PATH"
        echo "DMG signature verified"
    fi

    # Install to /Applications from the DMG (mimics user drag-to-Applications)
    echo ""
    echo "Installing to /Applications..."

    # Kill running instance before replacing
    if pgrep -x "$BUNDLE_DISPLAY_NAME" > /dev/null 2>&1; then
        echo "Stopping running $BUNDLE_DISPLAY_NAME..."
        pkill -x "$BUNDLE_DISPLAY_NAME" 2>/dev/null || true
        for i in {1..10}; do
            pgrep -x "$BUNDLE_DISPLAY_NAME" > /dev/null || break
            sleep 0.1
        done
    fi

    MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -noverify | tail -1 | awk '{print $NF}')
    if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT/$BUNDLE_DISPLAY_NAME.app" ]; then
        echo "ERROR: Failed to mount DMG or find app inside"
        [ -n "$MOUNT_POINT" ] && hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
        exit 1
    fi

    rm -rf "/Applications/$BUNDLE_DISPLAY_NAME.app"
    cp -R "$MOUNT_POINT/$BUNDLE_DISPLAY_NAME.app" "/Applications/$BUNDLE_DISPLAY_NAME.app"
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true

    echo "Installed: /Applications/$BUNDLE_DISPLAY_NAME.app"
    codesign --verify --strict "/Applications/$BUNDLE_DISPLAY_NAME.app" 2>/dev/null && \
        echo "Code signature verified" || \
        echo "warning: code signature verification failed (expected for ad-hoc signed builds)"

    echo ""
    echo "═══════════════════════════════════════════"
    echo "  Done! Launch with:"
    echo "    open /Applications/$BUNDLE_DISPLAY_NAME.app"
    echo ""
    echo "  To test first-launch (hatch) crash:"
    echo "    rm -rf ~/.vellum && open /Applications/$BUNDLE_DISPLAY_NAME.app"
    echo "═══════════════════════════════════════════"

    # Clean up staging
    rm -rf "$DMG_STAGING"
fi
