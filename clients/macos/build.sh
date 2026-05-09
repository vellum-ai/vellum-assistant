#!/bin/bash

# Ensure bash semantics even when invoked through another shell (e.g. `sh`).
# The script uses bash arrays and other bash-specific features.
if [ -z "${BASH_VERSION:-}" ]; then
    exec /bin/bash "$0" "$@"
fi

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
#   VELLUM_DOCS_BASE_URL Override docs base URL for in-app docs links (e.g. staging)
#   SKIP_BUN_REBUILD    Set to 1 to skip Bun binary staleness checks (use pre-built binaries as-is)
#   VELLUM_ENVIRONMENT   Runtime environment (local|dev|test|staging|production).
#                        Auto-set by build command if not provided. See AGENTS.md.
#   SENTRY_DSN_MACOS     Sentry DSN for the macOS app project (omit to disable)
#   SENTRY_DSN_ASSISTANT Sentry DSN for the assistant/daemon project (omit to disable)
#   SU_FEED_URL          Sparkle appcast URL for auto-updates (default: Vellum GitHub releases)

# ---------------------------------------------------------------------------
# swift_with_retry — run a swift command with retries for transient SPM
# package-resolution failures (e.g. network timeouts downloading binary
# artifacts). Retries up to MAX_ATTEMPTS times with a short delay.
# ---------------------------------------------------------------------------
restore_failed_dirty_spm_checkouts() {
    local stdout_log="$1"
    local stderr_log="$2"
    local clients_dir
    clients_dir="$(cd "$SCRIPT_DIR/.." && pwd)"
    local checkouts_dir="$clients_dir/.build/checkouts"
    local restored_dirty=1

    [ -d "$checkouts_dir" ] || return 1

    for checkout in "$checkouts_dir"/*; do
        [ -d "$checkout/.git" ] || continue

        if ! git -C "$checkout" diff --quiet --ignore-submodules -- 2>/dev/null || \
           ! git -C "$checkout" diff --cached --quiet --ignore-submodules -- 2>/dev/null || \
           [ -n "$(git -C "$checkout" ls-files --others --exclude-standard 2>/dev/null)" ]; then
            local physical_checkout
            physical_checkout="$(cd "$checkout" && pwd -P 2>/dev/null || printf '%s' "$checkout")"
            if ! grep -Fq "$checkout/" "$stderr_log" 2>/dev/null && \
               ! grep -Fq "$physical_checkout/" "$stderr_log" 2>/dev/null && \
               ! grep -Fq "$checkout/" "$stdout_log" 2>/dev/null && \
               ! grep -Fq "$physical_checkout/" "$stdout_log" 2>/dev/null; then
                continue
            fi
            echo "warning: dirty SPM checkout detected, restoring pinned package source: $(basename "$checkout")"
            git -C "$checkout" restore --source=HEAD --staged --worktree . 2>/dev/null || return 1
            git -C "$checkout" clean -fd 2>/dev/null || return 1
            restored_dirty=0
        fi
    done

    return "$restored_dirty"
}

swift_with_retry() {
    local max_attempts="${SWIFT_RETRY_ATTEMPTS:-3}"
    local attempt=1
    local _pch_cleaned=0
    local _build_cleaned=0
    local _artifact_cleaned=0
    local _dirty_checkout_cleaned=0
    local _stdout_log
    _stdout_log=$(mktemp)
    local _stderr_log
    _stderr_log=$(mktemp)
    # FIFOs for output streaming. Process substitutions (2> >(tee ...)) are
    # not tracked by `wait` in bash < 4.4 (macOS ships 3.2), so tee could
    # still be writing when grep reads the logs. Named pipes with explicit
    # tee PIDs give correct synchronization on all bash versions.
    local _fifo_dir
    _fifo_dir=$(mktemp -d)
    local _stdout_fifo="$_fifo_dir/stdout.fifo"
    local _stderr_fifo="$_fifo_dir/stderr.fifo"
    mkfifo "$_stdout_fifo" "$_stderr_fifo"
    trap "rm -rf '$_stdout_log' '$_stderr_log' '$_fifo_dir'" RETURN
    while true; do
        local _cmd_exit=0
        tee "$_stdout_log" < "$_stdout_fifo" &
        local _stdout_tee_pid=$!
        tee "$_stderr_log" >&2 < "$_stderr_fifo" &
        local _tee_pid=$!
        "$@" >"$_stdout_fifo" 2>"$_stderr_fifo" || _cmd_exit=$?
        wait "$_stdout_tee_pid"
        wait "$_tee_pid"
        if [ "$_cmd_exit" -eq 0 ]; then
            return 0
        fi
        # Auto-clean stale module caches when switching between worktrees that
        # share a .build directory via symlink. Swift surfaces this as either:
        # - "PCH was compiled with module cache path ..."
        # - "module 'X' is defined in both ..."
        if [ "$_pch_cleaned" -eq 0 ] && grep -Eq "PCH was compiled with module cache path|is defined in both" "$_stderr_log" 2>/dev/null; then
            echo "warning: stale module cache detected (path mismatch or duplicate module), cleaning and retrying..."
            find -L "$SCRIPT_DIR/../.build" -type d -name "ModuleCache" -exec rm -rf {} + 2>/dev/null || true
            [ -d "$SPM_MODULE_CACHE" ] && rm -rf "$SPM_MODULE_CACHE"
            _pch_cleaned=1
            continue
        fi
        # Auto-clean stale SPM artifact paths when an XCFramework reference
        # points at a deleted worktree. SPM bakes absolute paths into
        # workspace-state.json, debug.yaml, and build.db; with a shared
        # .build (via worktree symlink), removing the worktree that last
        # built leaves those entries pointing at a path that no longer
        # exists, and SPM has no way to re-resolve on its own.
        if [ "$_build_cleaned" -eq 0 ] && grep -q "XCFramework Info.plist not found" "$_stderr_log" 2>/dev/null; then
            echo "warning: stale SPM build cache detected (XCFramework path points to missing worktree), cleaning .build and retrying..."
            rm -rf "$SCRIPT_DIR/../.build"
            _build_cleaned=1
            continue
        fi
        # Auto-clean stale SPM binary artifacts when a previous download was
        # interrupted, leaving a partial entry that blocks the re-download.
        # SPM surfaces this as:
        #   error: failed downloading '<url>' which is required by binary
        #   target '<name>': <path> already exists in file system
        # Common on hosted CI runners with rotated/partial caches.
        if [ "$_artifact_cleaned" -eq 0 ] && grep -q "already exists in file system" "$_stderr_log" 2>/dev/null; then
            echo "warning: stale SPM binary artifact detected, cleaning and retrying..."
            sed -nE 's/.*: (\/.+) already exists in file system.*/\1/p' "$_stderr_log" 2>/dev/null \
                | sort -u \
                | while IFS= read -r _stale_path; do
                    [ -n "$_stale_path" ] && rm -rf "$_stale_path"
                done
            _artifact_cleaned=1
            continue
        fi
        # SwiftPM checkouts are generated cache contents. If one is edited
        # locally, SwiftPM keeps reusing it and can fail in dependency source
        # before package resolution has a chance to restore the pinned version.
        if [ "$_dirty_checkout_cleaned" -eq 0 ] && restore_failed_dirty_spm_checkouts "$_stdout_log" "$_stderr_log"; then
            echo "warning: restored dirty SPM checkout cache, retrying..."
            [ -d "$SPM_MODULE_CACHE" ] && rm -rf "$SPM_MODULE_CACHE"
            _dirty_checkout_cleaned=1
            continue
        fi
        # Signal 5 (SIGTRAP) is a non-transient crash (e.g. WebKit
        # teardown in headless CI). Retrying won't help — let the
        # caller handle it.
        if grep -q "unexpected signal code 5" "$_stderr_log" 2>/dev/null; then
            return "$_cmd_exit"
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

# Derive a per-repo module cache path so parallel worktrees (which share
# the same .build directory via symlink) don't race on PCH files.
# Uses a hash of the repo root's real path to produce a short, stable slug.
_repo_root="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

# Source .env from repo root for local dev convenience (CI sets env vars directly).
# Existing environment variables take precedence over .env values.
_dotenv="$_repo_root/.env"
if [ -f "$_dotenv" ]; then
    while IFS='=' read -r key value; do
        # Skip comments and blank lines
        [[ -z "$key" || "$key" == \#* ]] && continue
        # Strip surrounding quotes from value
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        # Only set if not already in the environment
        if [ -z "${!key+x}" ]; then
            export "$key=$value"
        fi
    done < "$_dotenv"
fi

_cache_slug="$(printf '%s' "$_repo_root" | md5 -q 2>/dev/null || printf '%s' "$_repo_root" | md5sum | cut -d' ' -f1)"
SPM_MODULE_CACHE="/tmp/spm-module-cache/${_cache_slug}"
MODULE_CACHE_FLAGS="-Xswiftc -module-cache-path -Xswiftc $SPM_MODULE_CACHE -Xcc -fmodules-cache-path=$SPM_MODULE_CACHE -Xcxx -fmodules-cache-path=$SPM_MODULE_CACHE"

BUNDLE_ID="com.vellum.vellum-assistant"
APP_NAME="vellum-assistant"
KATA_KERNEL_VERSION="3.17.0"
KATA_KERNEL_ARCHIVE_URL="${KATA_KERNEL_ARCHIVE_URL:-https://github.com/kata-containers/kata-containers/releases/download/$KATA_KERNEL_VERSION/kata-static-$KATA_KERNEL_VERSION-arm64.tar.xz}"
# When bumping KATA_KERNEL_VERSION, update both SHAs:
#   Archive: curl -sL "$KATA_KERNEL_ARCHIVE_URL" | shasum -a 256 (more recent releases will have the SHA on github)
#   Kernel:  tar -xJf archive.tar.xz && shasum -a 256 opt/kata/share/kata-containers/vmlinux.container
KATA_KERNEL_ARCHIVE_SHA256="647c7612e6edf789d5e14698c48c99d8bac15ad139ffaa1c8bb7d229f748d181"
KATA_KERNEL_SHA256="67bac9f416af4cdc9b151e4ba4962d6515e0ad7acc53816761cf964aa6af6ea0"
KATA_KERNEL_CACHE_DIR="${KATA_KERNEL_CACHE_DIR:-$SCRIPT_DIR/.container-cache/kata-$KATA_KERNEL_VERSION-arm64}"
KATA_KERNEL_ARCHIVE_PATH="$KATA_KERNEL_CACHE_DIR/kata.tar.xz"
KATA_KERNEL_PATH="$KATA_KERNEL_CACHE_DIR/vmlinux.container"

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

# Version (overridable via env for CI, defaults to Package.swift)
if [ -z "${DISPLAY_VERSION:-}" ]; then
    DISPLAY_VERSION=$(sed -n 's/^let appVersion = "\(.*\)"/\1/p' "$SCRIPT_DIR/../Package.swift" 2>/dev/null | head -1)
    DISPLAY_VERSION="${DISPLAY_VERSION:-0.1.0}"
    # For local dev builds (build/run), append a -local.TIMESTAMP suffix so
    # each hot-reload produces a distinguishable version string, similar to
    # CI's -dev.N.SHA format.
    if [ "$CMD" = "build" ] || [ "$CMD" = "run" ]; then
        _local_ts=$(date +"%Y%m%d%H%M%S")
        _local_sha=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
        DISPLAY_VERSION="${DISPLAY_VERSION}-local.${_local_ts}.${_local_sha}"
    fi
fi
BUILD_VERSION="${BUILD_VERSION:-1}"

# Signing identity (overridable via env for CI)
# Auto-detect any valid code signing certificate in keychain.
# macOS 26+ enforces Launch Constraints that reject ad-hoc signed apps with
# security-sensitive entitlements — a real signing identity is required.
if [ -z "${SIGN_IDENTITY:-}" ]; then
    # Helper: list valid (non-revoked, non-expired) codesigning identities.
    # Filters out entries flagged by the keychain as CSSMERR_TP_CERT_REVOKED,
    # CSSMERR_TP_CERT_EXPIRED, or other CSSMERR errors, plus the summary line.
    _valid_codesign_identities() {
        security find-identity -v -p codesigning 2>/dev/null \
            | grep -v -E "(CSSMERR_|valid identities found)" \
            || true
    }

    if command -v security >/dev/null 2>&1; then
        # Try Developer ID Application first (for distribution)
        SIGN_IDENTITY=$(_valid_codesign_identities \
            | grep "Developer ID Application" | head -1 \
            | sed 's/.*"\(.*\)"/\1/' || true)

        # Fall back to Apple Development certificate (for local dev)
        if [ -z "$SIGN_IDENTITY" ]; then
            SIGN_IDENTITY=$(_valid_codesign_identities \
                | grep -E "(Apple Development|Mac Developer)" | head -1 \
                | sed 's/.*"\(.*\)"/\1/' || true)
        fi

        # Fall back to any valid codesigning identity (e.g. self-signed)
        if [ -z "$SIGN_IDENTITY" ]; then
            SIGN_IDENTITY=$(_valid_codesign_identities \
                | head -1 \
                | sed 's/.*"\(.*\)"/\1/' || true)
        fi

        # No valid certificate found — create a self-signed one for local dev.
        # macOS 26+ requires a non-empty codeSigningID for apps that claim
        # security-sensitive entitlements (virtualization, audio-input, etc.).
        # A self-signed cert satisfies this without Apple Developer enrollment.
        if [ -z "$SIGN_IDENTITY" ] && command -v openssl >/dev/null 2>&1; then
            _CERT_CN="Vellum Local Development"
            # Check if we already created this cert in a previous build
            if ! _valid_codesign_identities | grep -q "$_CERT_CN"; then
                echo ""
                echo "No codesigning certificate found in keychain."
                echo "Creating self-signed certificate '$_CERT_CN' for local development..."
                echo "(This is a one-time operation — the cert persists in your login keychain.)"
                echo ""
                _CERT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vellum-cert.XXXXXX")
                cat > "$_CERT_DIR/cert.conf" << 'CERTEOF'
[req]
distinguished_name = req_dn
x509_extensions = codesign_ext
prompt = no
[req_dn]
CN = Vellum Local Development
[codesign_ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CERTEOF
                if openssl req -x509 -newkey rsa:2048 \
                    -keyout "$_CERT_DIR/key.pem" -out "$_CERT_DIR/cert.pem" \
                    -days 3650 -nodes -config "$_CERT_DIR/cert.conf" 2>/dev/null && \
                   openssl pkcs12 -export -in "$_CERT_DIR/cert.pem" \
                    -inkey "$_CERT_DIR/key.pem" -out "$_CERT_DIR/cert.p12" \
                    -passout pass: 2>/dev/null && \
                   security import "$_CERT_DIR/cert.p12" \
                    -k ~/Library/Keychains/login.keychain-db \
                    -T /usr/bin/codesign -P "" 2>/dev/null; then
                    echo "Certificate '$_CERT_CN' created and imported into login keychain."
                    echo ""
                else
                    echo "Warning: Failed to create self-signed certificate." >&2
                    echo "         You may need to create one manually or install an Apple Development cert." >&2
                    echo ""
                fi
                rm -rf "$_CERT_DIR"
            fi
            # Pick up the newly-created (or previously-created) cert
            SIGN_IDENTITY=$(_valid_codesign_identities \
                | grep "$_CERT_CN" | head -1 \
                | sed 's/.*"\(.*\)"/\1/' || true)
        fi
    fi

    # Final fallback: ad-hoc signing. Works on macOS ≤15 but will be rejected
    # by macOS 26+ for apps with security-sensitive entitlements.
    if [ -z "$SIGN_IDENTITY" ]; then
        SIGN_IDENTITY="-"
        # Warn on macOS 26+ where ad-hoc signing causes launch failures
        _macos_major=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1 || echo "0")
        if [ "$_macos_major" -ge 26 ] 2>/dev/null; then
            echo "" >&2
            echo "WARNING: Using ad-hoc code signing on macOS $_macos_major." >&2
            echo "  macOS 26+ rejects ad-hoc signed apps with security entitlements." >&2
            echo "  The app will likely crash on launch with 'Launch Constraint Violation'." >&2
            echo "" >&2
            echo "  To fix, do ONE of:" >&2
            echo "    1. Install openssl: brew install openssl" >&2
            echo "       (Re-run this script and it will auto-create a signing cert)" >&2
            echo "    2. Open Xcode → Settings → Accounts → Apple ID → Manage Certificates → +" >&2
            echo "       (Creates a free Apple Development certificate)" >&2
            echo "" >&2
        fi
    fi
fi

# Export SIGN_IDENTITY so nested invocations (watch mode) inherit it
export SIGN_IDENTITY

# Source directories for Bun binaries
ASSISTANT_SRC_DIR="$SCRIPT_DIR/../../assistant"
CLI_SRC_DIR="$SCRIPT_DIR/../../cli"
GATEWAY_SRC_DIR="$SCRIPT_DIR/../../gateway"
CES_SRC_DIR="$SCRIPT_DIR/../../credential-executor"
# Repo-level first-party skill catalog (skills/catalog.json + skill dirs).
# Shipped with the app so the daemon can install catalog skills without a
# running platform. node_modules and build artifacts are excluded.
SKILLS_SRC_DIR="$SCRIPT_DIR/../../skills"

# Pinned Bun version (source of truth: repo-root `.tool-versions`). A
# standalone copy of this exact Bun binary ships inside the .app at
# Contents/Resources/bun so the daemon can spawn first-party skills
# (e.g. meet-join via MeetHostSupervisor) via `bun run <skill>/register.ts`
# without relying on a user-installed Bun.
BUN_VERSION=$(awk '$1 == "bun" { print $2 }' "$SCRIPT_DIR/../../.tool-versions" 2>/dev/null)
BUN_VERSION="${BUN_VERSION:-1.3.11}"
# Cache directory for the downloaded standalone bun binary so repeated
# builds do not re-download. Keyed by version so a bumped .tool-versions
# naturally invalidates stale binaries.
BUN_BUNDLE_CACHE_DIR="$SCRIPT_DIR/.bun-bundle-cache/${BUN_VERSION}"

# Packages that must stay external in compiled Bun binaries.
# playwright-core has optional requires (electron, chromium-bidi) that cannot
# be resolved at bundle time.  Mark them external so bun --compile skips them.
# @resvg/resvg-js contains a platform-specific native .node addon; bun --compile
# bundles and extracts it at runtime, but macOS rejects the dlopen because the
# extracted binary's Team ID differs from the main process.  Externalising it
# lets the lazy wrapper in avatar/resvg-lazy.ts handle the missing module.
BUN_EXTERNAL_FLAGS=(--external electron --external "chromium-bidi/*" --external "@resvg/resvg-js" --external "@resvg/resvg-js-darwin-arm64" --external "@resvg/resvg-js-darwin-x64")

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
# install_shared_packages — install node_modules for every first-party package
# that the assistant/cli/gateway binaries import from. They reference these via
# file: deps (or direct relative imports) that point at TypeScript source, so
# the packages need their own node_modules for transitive deps (e.g. zod) to
# resolve during tsc/bun build. Must run before any build_bun_binary invocation,
# from any build mode.
# ---------------------------------------------------------------------------
install_shared_packages() {
    command -v bun &>/dev/null || return 0
    local repo_root="$SCRIPT_DIR/../.."
    local pkg_dirs=("$repo_root"/packages/*/)
    # The daemon imports MeetServiceSchema from skills/meet-join/config-schema.ts
    # and the meet-join contracts, so the skill needs node_modules for `zod` to
    # resolve during the bundle step.
    pkg_dirs+=("$repo_root/skills/meet-join/")
    for pkg_dir in "${pkg_dirs[@]}"; do
        [ -f "${pkg_dir}package.json" ] || continue
        (cd "$pkg_dir" && bun install --frozen-lockfile 2>/dev/null || bun install)
    done
}

# ---------------------------------------------------------------------------
# _fetch_single_bun — download + extract a single-arch bun into
# $BUN_BUNDLE_CACHE_DIR/bun-<target> (where <target> is darwin-aarch64 or
# darwin-x64). Idempotent: returns the cached path immediately if present.
# Echoes the absolute path on success; returns non-zero on failure.
# ---------------------------------------------------------------------------
_fetch_single_bun() {
    local target="$1"
    local bun_binary="$BUN_BUNDLE_CACHE_DIR/bun-${target}"
    if [ -x "$bun_binary" ]; then
        echo "$bun_binary"
        return 0
    fi

    mkdir -p "$BUN_BUNDLE_CACHE_DIR"
    local zip_path="$BUN_BUNDLE_CACHE_DIR/bun-${target}.zip"
    local url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${target}.zip"

    echo "Downloading bun ${BUN_VERSION} (${target}) for app bundle..." >&2
    if ! curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 \
            --output "$zip_path" "$url"; then
        echo "ERROR: failed to download bun binary from $url" >&2
        return 1
    fi

    local extract_dir
    extract_dir=$(mktemp -d "$BUN_BUNDLE_CACHE_DIR/extract.XXXXXX")
    if ! unzip -o -q "$zip_path" -d "$extract_dir"; then
        echo "ERROR: failed to extract bun zip" >&2
        rm -rf "$extract_dir"
        return 1
    fi

    local extracted="$extract_dir/bun-${target}/bun"
    if [ ! -f "$extracted" ]; then
        echo "ERROR: bun binary missing after extraction at $extracted" >&2
        rm -rf "$extract_dir"
        return 1
    fi
    mv "$extracted" "$bun_binary"
    chmod +x "$bun_binary"
    rm -rf "$extract_dir" "$zip_path"

    echo "$bun_binary"
}

# ---------------------------------------------------------------------------
# fetch_bundled_bun — stage a standalone `bun` binary at the version pinned
# in `.tool-versions` and cache it under `.bun-bundle-cache/` for reuse
# across builds. Echoes the absolute path to the cached binary on success;
# returns non-zero and logs to stderr on failure.
#
# Usage: fetch_bundled_bun <aarch64|x64|universal>
#
# The target MUST be derived from the app architecture being packaged, not
# the host — release CI builds x64 artifacts on ARM runners, so picking by
# `uname -m` would ship ARM-only bun inside an x64 .app and Intel Macs
# would hit "bad CPU type in executable" at daemon-spawn time.
#
# For `universal`, both single-arch binaries are downloaded and combined
# into a fat Mach-O via `lipo -create`, mirroring `build_bun_binary`'s
# universal path.
#
# The copy staged here is the one that gets signed and shipped inside
# `<App>.app/Contents/Resources/bun` so that the daemon (running from the
# compiled binary, where `process.execPath` is the daemon itself rather
# than bun) can spawn external skill processes.
# ---------------------------------------------------------------------------
fetch_bundled_bun() {
    local target_arch="$1"
    if [ -z "$target_arch" ]; then
        echo "ERROR: fetch_bundled_bun requires target arch (aarch64|x64|universal)" >&2
        return 1
    fi

    case "$target_arch" in
        aarch64)
            _fetch_single_bun "darwin-aarch64"
            ;;
        x64)
            _fetch_single_bun "darwin-x64"
            ;;
        universal)
            local fat_binary="$BUN_BUNDLE_CACHE_DIR/bun-universal"
            if [ -x "$fat_binary" ]; then
                echo "$fat_binary"
                return 0
            fi
            local arm_binary x64_binary
            arm_binary=$(_fetch_single_bun "darwin-aarch64") || return 1
            x64_binary=$(_fetch_single_bun "darwin-x64") || return 1
            if ! lipo -create "$arm_binary" "$x64_binary" -output "$fat_binary"; then
                echo "ERROR: lipo failed to build universal bun binary" >&2
                return 1
            fi
            chmod +x "$fat_binary"
            echo "$fat_binary"
            ;;
        *)
            echo "ERROR: unsupported bundled-bun target arch: $target_arch" >&2
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# emit_meet_join_manifest — run the skill's `emit-manifest` script to
# produce `<output>/manifest.json` describing the tools/routes/shutdown
# hooks the skill will register at runtime. Consumed by the daemon's
# manifest loader (PR 28) to proxy-register a shipped skill without
# loading its full code into the daemon process.
# ---------------------------------------------------------------------------
emit_meet_join_manifest() {
    local output_path="$1"
    local skill_dir="$SKILLS_SRC_DIR/meet-join"
    if [ ! -f "$skill_dir/scripts/emit-manifest.ts" ]; then
        echo "WARNING: emit-manifest.ts not found at $skill_dir/scripts/ — skipping manifest" >&2
        return 0
    fi
    if ! command -v bun &>/dev/null; then
        echo "WARNING: bun not on PATH — skipping meet-join manifest emission" >&2
        return 0
    fi
    mkdir -p "$(dirname "$output_path")"
    (cd "$skill_dir" && bun run scripts/emit-manifest.ts --output "$output_path")
}

# ---------------------------------------------------------------------------
# build_binaries — build all Bun binaries (daemon, assistant CLI, CLI, gateway,
# and chrome native host helper).
#
# Installs dependencies once per source directory upfront, then compiles all
# all binaries in parallel to reduce wall-clock time.
# ---------------------------------------------------------------------------
build_binaries() {
    command -v bun &>/dev/null || { echo "ERROR: bun is required but not found"; exit 1; }

    # Pre-install dependencies once per source directory so parallel builds
    # don't race on the same node_modules.
    echo "Installing dependencies..."
    install_shared_packages
    (cd "$ASSISTANT_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    (cd "$CLI_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    (cd "$GATEWAY_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    (cd "$CES_SRC_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
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

    # Embed VELLUM_ENVIRONMENT at compile time so all binaries know their
    # runtime context without any filesystem lookup. VELLUM_ENVIRONMENT is
    # exported by build.sh before calling build_binaries(), so it is always
    # set here (local|dev|test|staging|production).
    local env_flags=()
    if [ -n "${VELLUM_ENVIRONMENT:-}" ]; then
        env_flags=(--define "process.env.VELLUM_ENVIRONMENT='$VELLUM_ENVIRONMENT'")
        daemon_flags+=("${env_flags[@]}")
        cli_flags+=("${env_flags[@]}")
    fi

    # Build binaries in parallel. Each writes to its own output
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
        "$SCRIPT_DIR/cli-bin" "vellum-cli" "${env_flags[@]}" &
    pids+=($!)

    SKIP_BUN_INSTALL=1 build_bun_binary "$GATEWAY_SRC_DIR" "$GATEWAY_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/gateway-bin" "vellum-gateway" "${env_flags[@]}" &
    pids+=($!)

    SKIP_BUN_INSTALL=1 build_bun_binary "$CES_SRC_DIR" "$CES_SRC_DIR/src/main.ts" \
        "$SCRIPT_DIR/ces-bin" "credential-executor" "${env_flags[@]}" &
    pids+=($!)

    for pid in "${pids[@]}"; do
        wait "$pid" || failures=$((failures + 1))
    done
    if [ "$failures" -gt 0 ]; then
        echo "ERROR: $failures binary build(s) failed"
        exit 1
    fi

    # Post-build: copy WASM assets that bun --compile doesn't embed.
    # tree-sitter is used by the gateway (risk classification), not the daemon.
    cp "$GATEWAY_SRC_DIR/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$SCRIPT_DIR/gateway-bin/"
    cp "$GATEWAY_SRC_DIR/node_modules/tree-sitter-bash/tree-sitter-bash.wasm" "$SCRIPT_DIR/gateway-bin/"
    rm -rf "$SCRIPT_DIR/daemon-bin/node_modules"
    rm -rf "$SCRIPT_DIR/daemon-bin/bundled-skills"
    cp -R "$ASSISTANT_SRC_DIR/src/config/bundled-skills" "$SCRIPT_DIR/daemon-bin/bundled-skills"
    rm -rf "$SCRIPT_DIR/daemon-bin/first-party-skills"
    rsync -a \
        --exclude='node_modules/' \
        --exclude='*.tsbuildinfo' \
        --exclude='dist/' \
        --exclude='build/' \
        --exclude='.git/' \
        "$SKILLS_SRC_DIR/" "$SCRIPT_DIR/daemon-bin/first-party-skills/"
    # Emit meet-join manifest next to its shipped sources so the daemon's
    # manifest loader (PR 28) can proxy-register the skill without loading
    # its code into the daemon process.
    emit_meet_join_manifest \
        "$SCRIPT_DIR/daemon-bin/first-party-skills/meet-join/manifest.json"
    rm -rf "$SCRIPT_DIR/daemon-bin/templates"
    cp -R "$ASSISTANT_SRC_DIR/src/prompts/templates" "$SCRIPT_DIR/daemon-bin/templates"
    rm -rf "$SCRIPT_DIR/daemon-bin/compact-prompts"
    cp -R "$ASSISTANT_SRC_DIR/src/context/prompts" "$SCRIPT_DIR/daemon-bin/compact-prompts"
    rm -rf "$SCRIPT_DIR/daemon-bin/brain-graph"
    mkdir -p "$SCRIPT_DIR/daemon-bin/brain-graph"
    cp "$ASSISTANT_SRC_DIR/src/runtime/routes/brain-graph/brain-graph.html" "$SCRIPT_DIR/daemon-bin/brain-graph/"
}

bundle_kata_kernel() {
    mkdir -p "$KATA_KERNEL_CACHE_DIR"

    if [ ! -f "$KATA_KERNEL_PATH" ]; then
        echo "Downloading Kata $KATA_KERNEL_VERSION ARM64 kernel..."
        curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 \
            --output "$KATA_KERNEL_ARCHIVE_PATH" "$KATA_KERNEL_ARCHIVE_URL"

        echo "Verifying Kata kernel archive checksum..."
        local actual_sha256
        actual_sha256=$(shasum -a 256 "$KATA_KERNEL_ARCHIVE_PATH" | awk '{print $1}')
        if [ "$actual_sha256" != "$KATA_KERNEL_ARCHIVE_SHA256" ]; then
            echo "ERROR: SHA-256 mismatch for Kata kernel archive" >&2
            echo "  Expected: $KATA_KERNEL_ARCHIVE_SHA256" >&2
            echo "  Actual:   $actual_sha256" >&2
            rm -f "$KATA_KERNEL_ARCHIVE_PATH"
            exit 1
        fi

        echo "Extracting Kata kernel..."
        local temp_extract
        temp_extract=$(mktemp -d "$KATA_KERNEL_CACHE_DIR/extract.XXXXXX")
        tar -xJf "$KATA_KERNEL_ARCHIVE_PATH" -C "$temp_extract"
        cp -L "$temp_extract/opt/kata/share/kata-containers/vmlinux.container" "$KATA_KERNEL_PATH"
        rm -rf "$temp_extract"
        rm -f "$KATA_KERNEL_ARCHIVE_PATH"
    fi

    echo "Verifying Kata kernel checksum..."
    local actual_kernel_sha256
    actual_kernel_sha256=$(shasum -a 256 "$KATA_KERNEL_PATH" | awk '{print $1}')
    if [ "$actual_kernel_sha256" != "$KATA_KERNEL_SHA256" ]; then
        echo "ERROR: SHA-256 mismatch for Kata kernel" >&2
        echo "  Expected: $KATA_KERNEL_SHA256" >&2
        echo "  Actual:   $actual_kernel_sha256" >&2
        rm -f "$KATA_KERNEL_PATH"
        exit 1
    fi

    echo "Bundling Kata kernel..."
    mkdir -p "$KATA_KERNEL_BUNDLE_DIR"
    cp "$KATA_KERNEL_PATH" "$KATA_KERNEL_BUNDLE_DIR/vmlinux.container"
}

# Default VELLUM_ENVIRONMENT based on build command (overridable via env).
# See AGENTS.md "Build Environment" for the full matrix.
# This must run before the early-exit commands (test, lint, clean, binaries)
# so that swift test inherits the correct value.
if [ -z "${VELLUM_ENVIRONMENT:-}" ]; then
    # Local web/platform overrides imply local full-stack development
    # (`vel up`), even when VELLUM_ENVIRONMENT itself is not set.
    _platform_override="${VELLUM_PLATFORM_URL:-}"
    _web_override="${VELLUM_WEB_URL:-}"
    if [[ "$_platform_override" =~ ^http://(localhost|127\.0\.0\.1|[^/]+\.localhost)(:[0-9]+)?$ ]] || \
       [[ "$_web_override" =~ ^http://(localhost|127\.0\.0\.1|[^/]+\.localhost)(:[0-9]+)?$ ]]; then
        VELLUM_ENVIRONMENT="local"
    else
        case "$CMD" in
            test)                          VELLUM_ENVIRONMENT="test" ;;
            release|release-application)
                # Staging releases have a prerelease suffix in DISPLAY_VERSION
                # (e.g. "0.6.0-staging.3"); clean semver means production.
                if [[ "${DISPLAY_VERSION:-}" == *-staging* ]]; then
                    VELLUM_ENVIRONMENT="staging"
                else
                    VELLUM_ENVIRONMENT="production"
                fi
                ;;
            *)                             VELLUM_ENVIRONMENT="dev" ;;
        esac
    fi
fi
export VELLUM_ENVIRONMENT
echo "VELLUM_ENVIRONMENT=$VELLUM_ENVIRONMENT"

# For local builds, auto-generate a monotonically increasing BUILD_VERSION
# from the timestamp so Sparkle can determine "newer" via numeric comparison.
# CI-driven builds set BUILD_VERSION explicitly; this only affects the default.
if [ "$BUILD_VERSION" = "1" ] && [ "$VELLUM_ENVIRONMENT" = "local" ]; then
    BUILD_VERSION=$(date +%Y%m%d%H%M%S)
fi

case "$CMD" in
    test)
        echo "Running tests..."
        if [ ${#CMD_ARGS[@]} -eq 0 ]; then
            SWIFT_TEST_ARGS=(--filter vellum_assistantTests)
        else
            SWIFT_TEST_ARGS=("${CMD_ARGS[@]}")
        fi
        # Capture output to a temp file instead of a bash variable so that
        # embedded null bytes (e.g. from crash diagnostics) don't truncate
        # the content — bash variables silently drop everything after NUL.
        TEST_OUTPUT_FILE=$(mktemp)
        set +e
        swift_with_retry swift test $MODULE_CACHE_FLAGS "${SWIFT_TEST_ARGS[@]}" > "$TEST_OUTPUT_FILE" 2>&1
        TEST_EXIT=$?
        set -e
        cat "$TEST_OUTPUT_FILE"

        if [ $TEST_EXIT -eq 0 ]; then
            rm -f "$TEST_OUTPUT_FILE"
            exit 0
        fi

        # swift test may exit non-zero due to a WebKit SIGTRAP (signal 5) in
        # headless CI even when every test assertion passes.  Tolerate that
        # specific case so flaky WebKit process cleanup doesn't fail the build.
        # Grep against the file directly (not a bash variable or here-string)
        # to avoid null-byte truncation issues.
        if grep -q "unexpected signal code 5" "$TEST_OUTPUT_FILE" && \
           ! grep -qE "with [1-9][0-9]* failure" "$TEST_OUTPUT_FILE"; then
            echo "warning: swift test exited with signal code 5 (WebKit headless crash) but all test assertions passed."
            rm -f "$TEST_OUTPUT_FILE"
            exit 0
        fi

        rm -f "$TEST_OUTPUT_FILE"
        exit $TEST_EXIT
        ;;
    lint)
        echo "Linting (strict concurrency)..."
        swift_with_retry swift build --product "$APP_NAME" -Xswiftc -strict-concurrency=complete $MODULE_CACHE_FLAGS
        echo "Lint passed."
        exit 0
        ;;
    clean)
        echo "Cleaning..."
        rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/../.build"
        rm -rf "$SCRIPT_DIR/daemon-bin" "$SCRIPT_DIR/assistant-bin" "$SCRIPT_DIR/cli-bin" "$SCRIPT_DIR/gateway-bin" "$SCRIPT_DIR/ces-bin"
        rm -rf "$SPM_MODULE_CACHE"
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
        # Also clean compiled Bun binaries to prevent architecture mismatches
        # (e.g. arm64 binaries from a previous build being bundled into an x86_64 release).
        # Skip when SKIP_BUN_REBUILD=1, since pre-built binaries are intentionally provided.
        if [ "${SKIP_BUN_REBUILD:-}" != "1" ]; then
            rm -rf "$SCRIPT_DIR/daemon-bin" "$SCRIPT_DIR/assistant-bin" "$SCRIPT_DIR/cli-bin" "$SCRIPT_DIR/gateway-bin" "$SCRIPT_DIR/ces-bin"
        fi
    fi
fi

# Derive a per-environment bundle ID so that non-production builds are
# isolated from each other (separate preferences, log stream filters, etc.).
# Production keeps the bare identifier; everything else gets a suffix.
case "$VELLUM_ENVIRONMENT" in
    production) ;; # keep default BUNDLE_ID
    *)          BUNDLE_ID="com.vellum.vellum-assistant-${VELLUM_ENVIRONMENT}" ;;
esac
echo "BUNDLE_ID=$BUNDLE_ID"

# Derive a per-environment URL scheme for native auth callbacks.
# Matches the iOS xcconfig pattern (App-Dev.xcconfig → vellum-assistant-dev,
# App-Staging.xcconfig → vellum-assistant-staging, App.xcconfig → vellum-assistant).
case "$VELLUM_ENVIRONMENT" in
    production) BUNDLE_URL_SCHEME="vellum-assistant" ;;
    *)          BUNDLE_URL_SCHEME="vellum-assistant-${VELLUM_ENVIRONMENT}" ;;
esac
echo "BUNDLE_URL_SCHEME=$BUNDLE_URL_SCHEME"

# ---------------------------------------------------------------------------
# Resolve dock display name from the environment-scoped XDG config directory.
# Mirrors VellumPaths.configDir (Swift) and getConfigDir() (TS):
#   production  → $XDG_CONFIG_HOME/vellum/dock-display-name
#   <env>       → $XDG_CONFIG_HOME/vellum-<env>/dock-display-name
# ---------------------------------------------------------------------------
_XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
case "$VELLUM_ENVIRONMENT" in
    production) _VELLUM_CONFIG_DIR="$_XDG_CONFIG_HOME/vellum" ;;
    *)          _VELLUM_CONFIG_DIR="$_XDG_CONFIG_HOME/vellum-${VELLUM_ENVIRONMENT}" ;;
esac
_DOCK_LABEL_FILE="$_VELLUM_CONFIG_DIR/dock-display-name"
# Compute environment-aware default name: "Vellum" for production, "Vellum <Env>" otherwise.
case "$VELLUM_ENVIRONMENT" in
    production) _DEFAULT_DISPLAY_NAME="Vellum" ;;
    *)          _ENV_LABEL="$(echo "${VELLUM_ENVIRONMENT:0:1}" | tr '[:lower:]' '[:upper:]')${VELLUM_ENVIRONMENT:1}"
                _DEFAULT_DISPLAY_NAME="Vellum ${_ENV_LABEL}" ;;
esac
if [ -z "${BUNDLE_DISPLAY_NAME:-}" ] && [ -f "$_DOCK_LABEL_FILE" ]; then
    _SAVED_NAME="$(cat "$_DOCK_LABEL_FILE" 2>/dev/null | tr -d '\n')"
    # Reject names containing XML-reserved chars (&, <, >) or path separators (/)
    # that would produce invalid Info.plist XML or break file paths.
    if [[ "${_SAVED_NAME:-}" =~ [/\<\>\&] ]]; then
        echo "Warning: dock-display-name contains unsafe characters, falling back to '${_DEFAULT_DISPLAY_NAME}'" >&2
        BUNDLE_DISPLAY_NAME="$_DEFAULT_DISPLAY_NAME"
    else
        BUNDLE_DISPLAY_NAME="${_SAVED_NAME:-$_DEFAULT_DISPLAY_NAME}"
    fi
fi
BUNDLE_DISPLAY_NAME="${BUNDLE_DISPLAY_NAME:-$_DEFAULT_DISPLAY_NAME}"
# macOS stores process names in p_comm[MAXCOMLEN+1] where MAXCOMLEN=16.
# Names longer than 16 characters are silently truncated by the kernel,
# which breaks pgrep -x matching and the instance-kill logic below.
if [ "${#BUNDLE_DISPLAY_NAME}" -gt 16 ]; then
    echo "Warning: BUNDLE_DISPLAY_NAME '${BUNDLE_DISPLAY_NAME}' is ${#BUNDLE_DISPLAY_NAME} chars (max 16 for pgrep -x)" >&2
fi
APP_DIR="$SCRIPT_DIR/dist/$BUNDLE_DISPLAY_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
FRAMEWORKS_DIR="$CONTENTS/Frameworks"
KATA_KERNEL_BUNDLE_DIR="$RESOURCES_DIR/DeveloperVM"
echo "BUNDLE_DISPLAY_NAME=$BUNDLE_DISPLAY_NAME"

# ---------------------------------------------------------------------------
# Defense in depth: remove sibling .app bundles in dist/ that share our
# bundle ID. Different `BUNDLE_DISPLAY_NAME` values produce different bundle
# paths but share `CFBundleIdentifier`, so a previous build under a different
# display name (e.g. a persona name like "Jarvis.app") sits next to the new
# one. Both can be launched and registered with Launch Services, producing
# duplicate Dock entries with the same identity. AppBundleRenamer.swift has
# the same cleanup but only runs on the sign-out / no-assistants path.
# ---------------------------------------------------------------------------
for stale in "$SCRIPT_DIR/dist"/*.app; do
    [ -d "$stale" ] || continue
    [ "$stale" = "$APP_DIR" ] && continue
    stale_id=$(plutil -extract CFBundleIdentifier raw "$stale/Contents/Info.plist" 2>/dev/null || true)
    if [ "$stale_id" = "$BUNDLE_ID" ]; then
        echo "Removing stale bundle with matching ID: $stale"
        rm -rf "$stale"
    fi
done

# ---------------------------------------------------------------------------
# Local Sparkle configuration
#
# For local builds, point the Sparkle appcast at a localhost route served by
# the Next.js web app and generate a local-only EdDSA keypair for signing.
# This allows testing the full Sparkle upgrade flow without touching CI.
# ---------------------------------------------------------------------------
if [ "$VELLUM_ENVIRONMENT" = "local" ] && [ -z "${SU_FEED_URL:-}" ]; then
    _SPARKLE_DIR="$_VELLUM_CONFIG_DIR/sparkle"
    _SPARKLE_KEY_FILE="$_SPARKLE_DIR/ed25519-key.pem"
    _SPARKLE_PUB_FILE="$_SPARKLE_DIR/ed25519-public.pem"

    # Resolve the web app URL for the appcast feed.
    _LOCAL_WEB_URL="${VELLUM_WEB_URL:-http://localhost:3000}"
    export SU_FEED_URL="${_LOCAL_WEB_URL}/api/local-builds/appcast.xml"

    # Generate a local-only EdDSA keypair if one doesn't exist yet.
    # Requires `generate_keys` from `brew install sparkle`.
    if [ ! -f "$_SPARKLE_KEY_FILE" ]; then
        _GEN_KEYS=$(command -v generate_keys 2>/dev/null || true)
        if [ -z "$_GEN_KEYS" ]; then
            _GEN_KEYS=$(find /opt/homebrew/Caskroom/sparkle /usr/local/Caskroom/sparkle \
                -name generate_keys -type f 2>/dev/null | head -1 || true)
        fi
        if [ -n "$_GEN_KEYS" ]; then
            echo "Generating local Sparkle EdDSA keypair..."
            mkdir -p "$_SPARKLE_DIR"
            _KEY_OUTPUT=$("$_GEN_KEYS" 2>&1 || true)
            # generate_keys outputs the private key to stdout and public key on a
            # separate line. Newer versions may write to a file directly.
            # The tool stores keys in ~/.config/sparkle by default — copy them.
            _SPARKLE_DEFAULT_DIR="$HOME/.config/sparkle"
            if [ -f "$_SPARKLE_DEFAULT_DIR/ed25519-key.pem" ]; then
                cp "$_SPARKLE_DEFAULT_DIR/ed25519-key.pem" "$_SPARKLE_KEY_FILE"
                echo "Copied private key to $_SPARKLE_KEY_FILE"
            fi
            # Extract the public key from generate_keys output
            _PUB_KEY=$(echo "$_KEY_OUTPUT" | sed -n 's/.*SUPublicEDKey.*=.*"\([^"]*\)".*/\1/p' | head -1)
            if [ -n "$_PUB_KEY" ]; then
                echo "$_PUB_KEY" > "$_SPARKLE_PUB_FILE"
                echo "Local Sparkle public key: $_PUB_KEY"
            fi
        else
            echo "Note: generate_keys not found — install with 'brew install sparkle' for local Sparkle signing"
        fi
    fi

    # Set the public key for Info.plist if we have one
    if [ -f "$_SPARKLE_PUB_FILE" ]; then
        export SU_PUBLIC_ED_KEY=$(cat "$_SPARKLE_PUB_FILE")
    fi

    # Poll for updates every 60s locally (default is 3600s / 1 hour).
    export SU_SCHEDULED_CHECK_INTERVAL=60

    echo "SU_FEED_URL=$SU_FEED_URL"
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
    SWIFT_FLAGS="$SWIFT_FLAGS --product $APP_NAME $MODULE_CACHE_FLAGS"
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

# Install shared packages (packages/*) before any direct build_bun_binary call
# below. The 'binaries' subcommand handles this via build_binaries(), but
# build|run|release|release-application fall through to direct invocations and
# would otherwise fail to resolve transitive deps (e.g. zod) from
# packages/service-contracts on a fresh clone.
if [ "${SKIP_BUN_REBUILD:-}" != "1" ]; then
    install_shared_packages
fi

# Auto-build daemon binary if missing or stale (source changed) and bun is available.
# When SKIP_BUN_REBUILD=1 (set by CI after cross-compiling binaries for a specific
# target arch), skip staleness checks entirely to avoid overwriting pre-built
# binaries with host-arch binaries.
DAEMON_BIN_NEEDS_BUILD=false
if [ "${SKIP_BUN_REBUILD:-}" != "1" ] && [ -d "$ASSISTANT_SRC_DIR/src" ] && command -v bun &>/dev/null; then
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

# Always refresh first-party catalog skills from the repo-level skills/ dir
# so the daemon can install catalog entries without a running platform.
if [ -d "$SKILLS_SRC_DIR" ] && [ -f "$SKILLS_SRC_DIR/catalog.json" ]; then
    mkdir -p "$SCRIPT_DIR/daemon-bin"
    rm -rf "$SCRIPT_DIR/daemon-bin/first-party-skills"
    rsync -a \
        --exclude='node_modules/' \
        --exclude='*.tsbuildinfo' \
        --exclude='dist/' \
        --exclude='build/' \
        --exclude='.git/' \
        "$SKILLS_SRC_DIR/" "$SCRIPT_DIR/daemon-bin/first-party-skills/"
    # Emit meet-join manifest next to its shipped sources so the daemon's
    # manifest loader (PR 28) can proxy-register the skill without loading
    # its code into the daemon process.
    emit_meet_join_manifest \
        "$SCRIPT_DIR/daemon-bin/first-party-skills/meet-join/manifest.json"
fi

# Always refresh non-JS assets from source (not embedded by bun --compile)
mkdir -p "$SCRIPT_DIR/daemon-bin"
if [ -d "$ASSISTANT_SRC_DIR/src/prompts/templates" ]; then
    rm -rf "$SCRIPT_DIR/daemon-bin/templates"
    cp -R "$ASSISTANT_SRC_DIR/src/prompts/templates" "$SCRIPT_DIR/daemon-bin/templates"
fi
if [ -d "$ASSISTANT_SRC_DIR/src/context/prompts" ]; then
    rm -rf "$SCRIPT_DIR/daemon-bin/compact-prompts"
    cp -R "$ASSISTANT_SRC_DIR/src/context/prompts" "$SCRIPT_DIR/daemon-bin/compact-prompts"
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
if [ "${SKIP_BUN_REBUILD:-}" != "1" ] && [ -d "$ASSISTANT_SRC_DIR/src" ] && command -v bun &>/dev/null; then
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
    local_assistant_flags=("${BUN_EXTERNAL_FLAGS[@]}")
    build_bun_binary "$ASSISTANT_SRC_DIR" "$ASSISTANT_SRC_DIR/src/index.ts" \
        "$SCRIPT_DIR/assistant-bin" "vellum-assistant" "${local_assistant_flags[@]}"
fi

# Also rebuild if assistant CLI binary changed or newly added
if [ -f "$SCRIPT_DIR/assistant-bin/vellum-assistant" ]; then
    if [ ! -f "$MACOS_DIR/vellum-assistant" ] || [ "$SCRIPT_DIR/assistant-bin/vellum-assistant" -nt "$MACOS_DIR/vellum-assistant" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build CLI binary if missing or stale (source changed) and bun is available
CLI_BIN_NEEDS_BUILD=false
if [ "${SKIP_BUN_REBUILD:-}" != "1" ] && [ -d "$CLI_SRC_DIR/src" ] && command -v bun &>/dev/null; then
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
if [ "${SKIP_BUN_REBUILD:-}" != "1" ] && [ -d "$GATEWAY_SRC_DIR/src" ] && command -v bun &>/dev/null; then
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
# Always refresh WASM assets (not embedded by bun --compile).
# These must be copied even when the gateway binary is reused from a previous build.
if [ -d "$SCRIPT_DIR/gateway-bin" ] && [ -d "$GATEWAY_SRC_DIR/node_modules/web-tree-sitter" ]; then
    cp "$GATEWAY_SRC_DIR/node_modules/web-tree-sitter/web-tree-sitter.wasm" "$SCRIPT_DIR/gateway-bin/"
    cp "$GATEWAY_SRC_DIR/node_modules/tree-sitter-bash/tree-sitter-bash.wasm" "$SCRIPT_DIR/gateway-bin/"
fi

# Also rebuild if gateway binary changed or newly added
if [ -f "$SCRIPT_DIR/gateway-bin/vellum-gateway" ]; then
    if [ ! -f "$MACOS_DIR/vellum-gateway" ] || [ "$SCRIPT_DIR/gateway-bin/vellum-gateway" -nt "$MACOS_DIR/vellum-gateway" ]; then
        NEEDS_REBUILD=true
    fi
fi

# Auto-build credential-executor (CES) binary if missing or stale.
# The compiled binary is bundled alongside the daemon in Contents/MacOS/ so
# the packaged app can locate it without requiring a separate install.
CES_BIN_NEEDS_BUILD=false
if [ "${SKIP_BUN_REBUILD:-}" != "1" ] && [ -d "$CES_SRC_DIR/src" ] && command -v bun &>/dev/null; then
    if [ ! -f "$SCRIPT_DIR/ces-bin/credential-executor" ]; then
        CES_BIN_NEEDS_BUILD=true
    elif [ -n "$(find "$CES_SRC_DIR/src" -name '*.ts' -newer "$SCRIPT_DIR/ces-bin/credential-executor" -print -quit 2>/dev/null)" ]; then
        CES_BIN_NEEDS_BUILD=true
    elif [ "$CES_SRC_DIR/package.json" -nt "$SCRIPT_DIR/ces-bin/credential-executor" ] || \
         [ "$CES_SRC_DIR/bun.lock" -nt "$SCRIPT_DIR/ces-bin/credential-executor" ]; then
        CES_BIN_NEEDS_BUILD=true
    fi
fi
if [ "$CES_BIN_NEEDS_BUILD" = true ]; then
    build_bun_binary "$CES_SRC_DIR" "$CES_SRC_DIR/src/main.ts" \
        "$SCRIPT_DIR/ces-bin" "credential-executor"
fi

# Also rebuild if CES binary changed or newly added
if [ -f "$SCRIPT_DIR/ces-bin/credential-executor" ]; then
    if [ ! -f "$MACOS_DIR/credential-executor" ] || [ "$SCRIPT_DIR/ces-bin/credential-executor" -nt "$MACOS_DIR/credential-executor" ]; then
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
        # Create an 'assistant' symlink so `which assistant` inside any subprocess
        # spawned by the app resolves to the bundled binary rather than a
        # globally installed version (e.g. ~/.bun/bin/assistant).
        ln -sf "vellum-assistant" "$MACOS_DIR/assistant"
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
        # Bundle WASM assets into Resources (not embedded by bun --compile).
        # tree-sitter is used by the gateway for risk classification.
        for wasm in "$SCRIPT_DIR/gateway-bin/"*.wasm; do
            [ -f "$wasm" ] && cp "$wasm" "$RESOURCES_DIR/"
        done
    else
        echo "No gateway binary at $GATEWAY_BIN — skipping (dev mode)"
    fi

    # Copy bundled credential-executor (CES) binary (if available).
    # The daemon locates this via `dirname(process.execPath)` — see
    # getLocalBinarySearchPaths() in assistant/src/credential-execution/executable-discovery.ts.
    CES_BIN="$SCRIPT_DIR/ces-bin/credential-executor"
    if [ -f "$CES_BIN" ]; then
        echo "Bundling credential-executor binary..."
        cp "$CES_BIN" "$MACOS_DIR/credential-executor"
        chmod +x "$MACOS_DIR/credential-executor"
    else
        echo "No credential-executor binary at $CES_BIN — skipping (dev mode)"
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

# Always refresh first-party catalog skills in the app bundle.
if [ -d "$SCRIPT_DIR/daemon-bin/first-party-skills" ]; then
    rm -rf "$RESOURCES_DIR/first-party-skills"
    cp -R "$SCRIPT_DIR/daemon-bin/first-party-skills" "$RESOURCES_DIR/first-party-skills"
fi

# Stage a standalone `bun` binary inside the .app so the daemon can spawn
# external first-party skill processes (e.g. meet-host via
# MeetHostSupervisor in PR 27) via `bun run <skill>/register.ts`. The
# version is pinned to `.tool-versions` via BUN_VERSION above. The binary
# is signed explicitly below (the MacOS-sweep only covers Contents/MacOS).
#
# Target arch MUST match the app being packaged, not the host. Release CI
# builds x64 .app artifacts on ARM runners; picking by `uname -m` would
# ship ARM-only bun inside an x64 app. Resolution order:
#   UNIVERSAL_BUILD=true          -> universal (lipo fat binary)
#   RELEASE_ARCH_FLAGS=--arch arm64   -> aarch64
#   RELEASE_ARCH_FLAGS=--arch x86_64  -> x64
#   else (dev build)              -> host arch
BUNDLED_BUN_TARGET_ARCH=""
if [ "$UNIVERSAL_BUILD" = true ]; then
    BUNDLED_BUN_TARGET_ARCH="universal"
elif [ -n "${RELEASE_ARCH_FLAGS:-}" ]; then
    _release_arch=$(echo "$RELEASE_ARCH_FLAGS" | sed -n 's/.*--arch \([^ ]*\).*/\1/p')
    case "$_release_arch" in
        arm64|aarch64) BUNDLED_BUN_TARGET_ARCH="aarch64" ;;
        x86_64|x64)    BUNDLED_BUN_TARGET_ARCH="x64" ;;
    esac
fi
if [ -z "$BUNDLED_BUN_TARGET_ARCH" ]; then
    case "$(uname -m)" in
        arm64|aarch64) BUNDLED_BUN_TARGET_ARCH="aarch64" ;;
        x86_64)        BUNDLED_BUN_TARGET_ARCH="x64" ;;
        *)
            echo "WARNING: unsupported host arch $(uname -m) for bundled bun; defaulting to aarch64" >&2
            BUNDLED_BUN_TARGET_ARCH="aarch64"
            ;;
    esac
fi

# Unconditionally overwrite so a `.tool-versions` bump (or an arch change)
# always propagates. The prior mtime gate could skip the copy when the
# cached zip's embedded timestamp predated the existing bundled binary,
# silently shipping an outdated bun.
if bundled_bun_path=$(fetch_bundled_bun "$BUNDLED_BUN_TARGET_ARCH"); then
    echo "Bundling standalone bun ${BUN_VERSION} (${BUNDLED_BUN_TARGET_ARCH})..."
    cp "$bundled_bun_path" "$RESOURCES_DIR/bun"
    chmod +x "$RESOURCES_DIR/bun"
else
    echo "WARNING: failed to stage bundled bun binary; external skill spawn will fall back to PATH/bun-runtime" >&2
fi

# Always refresh non-JS assets in app bundle (not embedded by bun --compile)
if [ -d "$SCRIPT_DIR/daemon-bin/templates" ]; then
    rm -rf "$RESOURCES_DIR/templates"
    cp -R "$SCRIPT_DIR/daemon-bin/templates" "$RESOURCES_DIR/templates"
fi
if [ -d "$SCRIPT_DIR/daemon-bin/compact-prompts" ]; then
    rm -rf "$RESOURCES_DIR/compact-prompts"
    cp -R "$SCRIPT_DIR/daemon-bin/compact-prompts" "$RESOURCES_DIR/compact-prompts"
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

TTS_PROVIDER_CATALOG="$SCRIPT_DIR/../../meta/tts-provider-catalog.json"
if [ -f "$TTS_PROVIDER_CATALOG" ]; then
    cp "$TTS_PROVIDER_CATALOG" "$RESOURCES_DIR/tts-provider-catalog.json"
fi
LLM_PROVIDER_CATALOG="$SCRIPT_DIR/../../meta/llm-provider-catalog.json"
if [ -f "$LLM_PROVIDER_CATALOG" ]; then
    cp "$LLM_PROVIDER_CATALOG" "$RESOURCES_DIR/llm-provider-catalog.json"
fi
# Bundle Dockerfiles into Contents/Resources/dockerfiles/ for debug builds
# so that the CLI's findRepoRoot() can locate them when running from a
# packaged DMG.  This enables `vellum hatch --remote docker` to work
# without a full source checkout (the CLI detects the missing source tree
# and falls back to pulling pre-built images instead of building locally).
if [ "$CONFIG" = "debug" ]; then
    REPO_ROOT="$SCRIPT_DIR/../.."
    for svc in assistant credential-executor gateway; do
        if [ -f "$REPO_ROOT/$svc/Dockerfile" ]; then
            mkdir -p "$RESOURCES_DIR/dockerfiles/$svc"
            cp "$REPO_ROOT/$svc/Dockerfile" "$RESOURCES_DIR/dockerfiles/$svc/Dockerfile"
        fi
    done
fi

# Generate character-components.json for pre-daemon avatar rendering
CHAR_COMP_SRC="$ASSISTANT_SRC_DIR/src/avatar/character-components.ts"
if command -v bun &>/dev/null && [ -f "$CHAR_COMP_SRC" ]; then
    echo "Generating character-components.json..."
    bun -e "import { getCharacterComponents } from '$CHAR_COMP_SRC'; process.stdout.write(JSON.stringify(getCharacterComponents()))" > "$RESOURCES_DIR/character-components.json"
fi

# Bundle the developer VM kernel directly into the app so the macOS client can
# boot the hello-world VM without a first-run kernel download.
bundle_kata_kernel

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
COMMIT_SHA_PLIST=""
if [ -n "${COMMIT_SHA:-}" ]; then
    COMMIT_SHA_PLIST=$(cat <<EOF
    <key>VellumCommitSHA</key>
    <string>$COMMIT_SHA</string>
EOF
)
fi


LSE_ENVIRONMENT_PLIST=""
_LSE_ENTRIES=""
if [ -n "${VELLUM_DOCS_BASE_URL:-}" ]; then
    DOCS_BASE_URL_OVERRIDE="${VELLUM_DOCS_BASE_URL%/}"
    # XML-escape ampersand/lt/gt before embedding into Info.plist so a
    # malformed override (e.g. one containing `&` in a URL path) cannot
    # corrupt the entire plist and prevent the app from launching.
    # Note: the sibling SENTRY_DSN_* blocks below have the same unescaped
    # pattern; that's a pre-existing concern that should be addressed in
    # a separate cleanup PR.
    DOCS_BASE_URL_OVERRIDE="${DOCS_BASE_URL_OVERRIDE//&/&amp;}"
    DOCS_BASE_URL_OVERRIDE="${DOCS_BASE_URL_OVERRIDE//</&lt;}"
    DOCS_BASE_URL_OVERRIDE="${DOCS_BASE_URL_OVERRIDE//>/&gt;}"
    echo "Embedding app docs base URL override: $DOCS_BASE_URL_OVERRIDE"
    _LSE_ENTRIES+="
        <key>VELLUM_DOCS_BASE_URL</key>
        <string>$DOCS_BASE_URL_OVERRIDE</string>"
fi
if [ -n "${VELLUM_PLATFORM_URL:-}" ]; then
    PLATFORM_URL_OVERRIDE="${VELLUM_PLATFORM_URL%/}"
    PLATFORM_URL_OVERRIDE="${PLATFORM_URL_OVERRIDE//&/&amp;}"
    PLATFORM_URL_OVERRIDE="${PLATFORM_URL_OVERRIDE//</&lt;}"
    PLATFORM_URL_OVERRIDE="${PLATFORM_URL_OVERRIDE//>/&gt;}"
    echo "Embedding VELLUM_PLATFORM_URL override: $PLATFORM_URL_OVERRIDE"
    _LSE_ENTRIES+="
        <key>VELLUM_PLATFORM_URL</key>
        <string>$PLATFORM_URL_OVERRIDE</string>"
fi
if [ -n "${VELLUM_WEB_URL:-}" ]; then
    WEB_URL_OVERRIDE="${VELLUM_WEB_URL%/}"
    WEB_URL_OVERRIDE="${WEB_URL_OVERRIDE//&/&amp;}"
    WEB_URL_OVERRIDE="${WEB_URL_OVERRIDE//</&lt;}"
    WEB_URL_OVERRIDE="${WEB_URL_OVERRIDE//>/&gt;}"
    echo "Embedding VELLUM_WEB_URL override: $WEB_URL_OVERRIDE"
    _LSE_ENTRIES+="
        <key>VELLUM_WEB_URL</key>
        <string>$WEB_URL_OVERRIDE</string>"
fi
if [ "$CONFIG" = "debug" ]; then
    echo "Embedding VELLUM_FLAG_PLATFORM_HOSTED_ENABLED for debug build"
    _LSE_ENTRIES+="
        <key>VELLUM_FLAG_PLATFORM_HOSTED_ENABLED</key>
        <string>1</string>"
    echo "Embedding VELLUM_FLAG_LOCAL_DOCKER_ENABLED for debug build"
    _LSE_ENTRIES+="
        <key>VELLUM_FLAG_LOCAL_DOCKER_ENABLED</key>
        <string>1</string>"
fi
_LSE_ENTRIES+="
        <key>VELLUM_ENVIRONMENT</key>
        <string>$VELLUM_ENVIRONMENT</string>"
if [ -n "${SENTRY_DSN_MACOS:-}" ]; then
    echo "Embedding SENTRY_DSN_MACOS"
    _LSE_ENTRIES+="
        <key>SENTRY_DSN_MACOS</key>
        <string>$SENTRY_DSN_MACOS</string>"
fi
if [ -n "${SENTRY_DSN_ASSISTANT:-}" ]; then
    echo "Embedding SENTRY_DSN_ASSISTANT"
    _LSE_ENTRIES+="
        <key>SENTRY_DSN_ASSISTANT</key>
        <string>$SENTRY_DSN_ASSISTANT</string>"
fi
if [ -n "$_LSE_ENTRIES" ]; then
    LSE_ENVIRONMENT_PLIST=$(cat <<EOF
    <key>LSEnvironment</key>
    <dict>$_LSE_ENTRIES
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
    $LSE_ENVIRONMENT_PLIST
    $COMMIT_SHA_PLIST
    <key>LSMinimumSystemVersion</key>
    <string>15.0</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.productivity</string>
    <key>NSScreenRecordingUsageDescription</key>
    <string>Vellum needs Screen Recording access to see what's on your screen during computer use tasks.</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Vellum needs microphone access to transcribe voice commands.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Vellum uses speech recognition to convert voice commands into tasks.</string>
    <key>SUFeedURL</key>
    <string>${SU_FEED_URL:-https://github.com/vellum-ai/vellum-assistant/releases/latest/download/appcast.xml}</string>
    <key>SUPublicEDKey</key>
    <string>${SU_PUBLIC_ED_KEY:-}</string>
    <key>SUEnableAutomaticChecks</key>
    <true/>
    <key>SUAutomaticallyUpdate</key>
    <true/>
    <key>SUScheduledCheckInterval</key>
    <integer>${SU_SCHEDULED_CHECK_INTERVAL:-3600}</integer>
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
                <string>$BUNDLE_URL_SCHEME</string>
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

# Resolve per-environment icon source. Falls back to production if no
# environment-specific override exists.
ICONS_DIR="$SCRIPT_DIR/build-resources/icons"
if [ -d "$ICONS_DIR/$VELLUM_ENVIRONMENT" ]; then
    ICON_SOURCE_DIR="$ICONS_DIR/$VELLUM_ENVIRONMENT"
elif [ -d "$ICONS_DIR/production" ]; then
    ICON_SOURCE_DIR="$ICONS_DIR/production"
else
    ICON_SOURCE_DIR=""
fi

# Always compile asset catalog (fast, ensures AppIcon changes are picked up)
# AppIcon.icon is a Xcode-26 Icon Composer bundle — actool reads it alongside
# the xcassets and emits both the layered Liquid Glass iconstack for macOS Tahoe
# and backward-compatible raster fallbacks for macOS 15 into Assets.car.
XCASSETS="$SCRIPT_DIR/vellum-assistant/Resources/Assets.xcassets"
APP_ICON="$SCRIPT_DIR/build-resources/AppIcon.icon"

# Overlay environment-specific icon into the .icon bundle so both actool
# (Assets.car / Liquid Glass) and the .icns generation use the correct source.
if [ -n "$ICON_SOURCE_DIR" ]; then
    mkdir -p "$APP_ICON/Assets"
    cp "$ICON_SOURCE_DIR/icon.json" "$APP_ICON/icon.json"
    cp -R "$ICON_SOURCE_DIR/Assets/" "$APP_ICON/Assets/"
fi
if [ -d "$XCASSETS" ]; then
    ACTOOL_INPUTS=("$XCASSETS")
    if [ -d "$APP_ICON" ]; then
        ACTOOL_INPUTS+=("$APP_ICON")
    fi
    # Compile the asset catalog. Retry on transient actool crashes
    # (AssetCatalogAgent-AssetRuntime can segfault on some runner images).
    # If the .icon bundle causes persistent failures, fall back to
    # compiling the .xcassets alone — the .icns generation below handles
    # Finder/DMG icons independently.
    ACTOOL_MAX_ATTEMPTS=3
    ACTOOL_SUCCESS=0
    for attempt in $(seq 1 $ACTOOL_MAX_ATTEMPTS); do
        rm -f "$RESOURCES_DIR/Assets.car"
        if ACTOOL_OUTPUT=$(xcrun actool "${ACTOOL_INPUTS[@]}" \
            --compile "$RESOURCES_DIR" \
            --platform macosx \
            --minimum-deployment-target 15.0 \
            --app-icon AppIcon \
            --output-partial-info-plist /dev/null \
            2>&1); then
            ACTOOL_SUCCESS=1
            break
        fi
        if [ -f "$RESOURCES_DIR/Assets.car" ]; then
            echo "actool exited non-zero but Assets.car was produced on attempt $attempt; continuing."
            ACTOOL_SUCCESS=1
            break
        fi
        echo "actool attempt $attempt/$ACTOOL_MAX_ATTEMPTS failed without producing Assets.car; retrying."
    done
    if [ "$ACTOOL_SUCCESS" != "1" ] && [ "${#ACTOOL_INPUTS[@]}" -gt 1 ]; then
        echo "actool failed with .icon bundle; retrying with .xcassets only."
        rm -f "$RESOURCES_DIR/Assets.car"
        if xcrun actool "$XCASSETS" \
            --compile "$RESOURCES_DIR" \
            --platform macosx \
            --minimum-deployment-target 15.0 \
            --app-icon AppIcon \
            --output-partial-info-plist /dev/null \
            2>&1; then
            ACTOOL_SUCCESS=1
        elif [ -f "$RESOURCES_DIR/Assets.car" ]; then
            echo "actool (.xcassets-only) exited non-zero but Assets.car was produced; continuing."
            ACTOOL_SUCCESS=1
        fi
    fi
    if [ "$ACTOOL_SUCCESS" != "1" ]; then
        echo "actool failed to produce Assets.car after all attempts:"
        echo "$ACTOOL_OUTPUT"
        exit 1
    fi
fi

# Generate AppIcon.icns from SVG source for Finder/DMG icon display.
# actool with .icon bundles only emits into Assets.car — it does not produce a
# standalone .icns.  Finder and create-dmg rely on CFBundleIconFile → .icns,
# so we render one from the same SVG source that Icon Composer uses.
# Always regenerate when an icon source directory is resolved — the Swift
# script is fast and this avoids stale icns after environment switches.
if [ -d "$APP_ICON" ] && [ -n "$ICON_SOURCE_DIR" ]; then
    echo "Generating AppIcon.icns from SVG..."

    ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
    mkdir -p "$ICONSET_DIR"

    # Render a 1024x1024 master PNG using an inline Swift script.
    # This is consistent with how dmg/generate-background.swift works.
    MASTER_PNG=$(mktemp /tmp/appicon-master-XXXXXX).png
    swift - "$APP_ICON" "$MASTER_PNG" <<'SWIFT_SCRIPT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let iconDir = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]

// --- Parse icon.json ---
let jsonPath = iconDir + "/icon.json"
let jsonData = try! Data(contentsOf: URL(fileURLWithPath: jsonPath))
let json = try! JSONSerialization.jsonObject(with: jsonData) as! [String: Any]

// Fill color
let fillDict = json["fill"] as! [String: Any]
let solidStr = fillDict["solid"] as! String  // "display-p3:0.12941,0.42353,0.21569,1.00000"

let colorParts = solidStr.split(separator: ":")[1].split(separator: ",").map { CGFloat(Double($0)!) }
let fillColor = CGColor(
    colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!,
    components: colorParts
)!

// Layer position: scale and translation
let groups = json["groups"] as! [[String: Any]]
let layers = groups[0]["layers"] as! [[String: Any]]
let layer = layers[0]
let position = layer["position"] as! [String: Any]
let scale = CGFloat(position["scale"] as! Double)
let translationPts = position["translation-in-points"] as! [Double]
let txPoints = CGFloat(translationPts[0])
let tyPoints = CGFloat(translationPts[1])

// SVG filename from layer image-name
let imageName = layer["image-name"] as! String
let svgPath = iconDir + "/Assets/" + imageName

// --- Parse SVG path ---
let svgString = try! String(contentsOfFile: svgPath, encoding: .utf8)
// Extract the path d attribute from the SVG
let dRange = svgString.range(of: "d=\"")!
let afterD = svgString[dRange.upperBound...]
let closingQuote = afterD.firstIndex(of: "\"")!
let pathData = String(afterD[..<closingQuote])

// Parse SVG viewBox for coordinate mapping
let vbRange = svgString.range(of: "viewBox=\"")!
let afterVB = svgString[vbRange.upperBound...]
let vbClose = afterVB.firstIndex(of: "\"")!
let vbParts = String(afterVB[..<vbClose]).split(separator: " ").map { CGFloat(Double($0)!) }
let svgWidth = vbParts[2]
let svgHeight = vbParts[3]

// --- Build CGPath from SVG path data ---
func parseSVGPath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    let chars = Array(d)
    var i = 0
    var currentX: CGFloat = 0
    var currentY: CGFloat = 0

    func skipWhitespaceAndCommas() {
        while i < chars.count && (chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\r" || chars[i] == "\t") {
            i += 1
        }
    }

    func parseNumber() -> CGFloat {
        skipWhitespaceAndCommas()
        var numStr = ""
        if i < chars.count && (chars[i] == "-" || chars[i] == "+") {
            numStr.append(chars[i]); i += 1
        }
        while i < chars.count && (chars[i] >= "0" && chars[i] <= "9" || chars[i] == ".") {
            numStr.append(chars[i]); i += 1
        }
        return CGFloat(Double(numStr) ?? 0)
    }

    var lastCmd: Character = " "

    while i < chars.count {
        skipWhitespaceAndCommas()
        if i >= chars.count { break }

        // Determine the command: explicit letter or implicit repetition
        var cmd: Character
        if chars[i].isLetter {
            cmd = chars[i]; i += 1
        } else {
            // Implicit repetition: reuse last command (M promotes to L per SVG spec)
            cmd = lastCmd
            if cmd == "M" { cmd = "L" }
            if cmd == "m" { cmd = "l" }
        }
        lastCmd = cmd

        switch cmd {
        case "M":
            let x = parseNumber(); let y = parseNumber()
            path.move(to: CGPoint(x: x, y: y))
            currentX = x; currentY = y
        case "m":
            let dx = parseNumber(); let dy = parseNumber()
            currentX += dx; currentY += dy
            path.move(to: CGPoint(x: currentX, y: currentY))
        case "L":
            let x = parseNumber(); let y = parseNumber()
            path.addLine(to: CGPoint(x: x, y: y))
            currentX = x; currentY = y
        case "l":
            let dx = parseNumber(); let dy = parseNumber()
            currentX += dx; currentY += dy
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "H":
            currentX = parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "h":
            currentX += parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "V":
            currentY = parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "v":
            currentY += parseNumber()
            path.addLine(to: CGPoint(x: currentX, y: currentY))
        case "C":
            let x1 = parseNumber(); let y1 = parseNumber()
            let x2 = parseNumber(); let y2 = parseNumber()
            let x = parseNumber(); let y = parseNumber()
            path.addCurve(to: CGPoint(x: x, y: y),
                          control1: CGPoint(x: x1, y: y1),
                          control2: CGPoint(x: x2, y: y2))
            currentX = x; currentY = y
        case "c":
            let dx1 = parseNumber(); let dy1 = parseNumber()
            let dx2 = parseNumber(); let dy2 = parseNumber()
            let dx = parseNumber(); let dy = parseNumber()
            path.addCurve(to: CGPoint(x: currentX + dx, y: currentY + dy),
                          control1: CGPoint(x: currentX + dx1, y: currentY + dy1),
                          control2: CGPoint(x: currentX + dx2, y: currentY + dy2))
            currentX += dx; currentY += dy
        case "Q":
            let x1 = parseNumber(); let y1 = parseNumber()
            let x = parseNumber(); let y = parseNumber()
            path.addQuadCurve(to: CGPoint(x: x, y: y),
                              control: CGPoint(x: x1, y: y1))
            currentX = x; currentY = y
        case "q":
            let dx1 = parseNumber(); let dy1 = parseNumber()
            let dx = parseNumber(); let dy = parseNumber()
            path.addQuadCurve(to: CGPoint(x: currentX + dx, y: currentY + dy),
                              control: CGPoint(x: currentX + dx1, y: currentY + dy1))
            currentX += dx; currentY += dy
        case "Z", "z":
            path.closeSubpath()
        default:
            // Skip unrecognized commands by advancing past their arguments
            while i < chars.count && !chars[i].isLetter { i += 1 }
        }
    }
    return path
}

// --- Render 1024x1024 PNG ---
let size = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.displayP3)!

guard let ctx = CGContext(
    data: nil, width: size, height: size,
    bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("Failed to create bitmap context") }

let s = CGFloat(size)

// Draw macOS squircle rounded-rect background with the green fill.
// Apple's macOS icon shape uses ~22.37% corner radius (continuous corners).
let iconRect = CGRect(x: 0, y: 0, width: s, height: s)
let cornerRadius = s * 0.2237
let bgPath = CGPath(roundedRect: iconRect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
ctx.addPath(bgPath)
ctx.setFillColor(fillColor)
ctx.fillPath()

// Draw the white V centered with scale and translation from icon.json.
// Icon Composer coordinates: origin is center of the 1024x1024 canvas,
// Y-axis points up, and scale is relative to the SVG's native size.

// Scale from points to pixels (icon.json uses a 1024-point canvas)
let svgPixelWidth = svgWidth * scale
let svgPixelHeight = svgHeight * scale

// Center the scaled SVG on the canvas, then apply translation
let offsetX = (s - svgPixelWidth) / 2.0 + txPoints
// Flip Y: CGContext uses bottom-left origin with Y-up, but SVG uses top-left
// origin with Y-down. Flip the context to match SVG coordinate convention.
// icon.json translation Y=25 means 25pt upward in Icon Composer;
// in our now-flipped top-left-origin context, upward = negative Y.
let offsetY = (s - svgPixelHeight) / 2.0 - tyPoints

ctx.saveGState()
// Flip to top-left origin (matching SVG coordinates)
ctx.translateBy(x: 0, y: s)
ctx.scaleBy(x: 1, y: -1)
// Move to where the SVG should be drawn, then scale the SVG coordinates
ctx.translateBy(x: offsetX, y: offsetY)
ctx.scaleBy(x: scale, y: scale)
let vPath = parseSVGPath(pathData)
ctx.addPath(vPath)
ctx.setFillColor(.white)
ctx.fillPath()
ctx.restoreGState()

// Write PNG
guard let image = ctx.makeImage() else { fatalError("Failed to create CGImage") }
let url = URL(fileURLWithPath: outputPath)
guard let dest = CGImageDestinationCreateWithURL(
    url as CFURL, UTType.png.identifier as CFString, 1, nil
) else { fatalError("Failed to create image destination") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("Failed to write PNG") }
SWIFT_SCRIPT

    if [ ! -f "$MASTER_PNG" ]; then
        echo "Error: Failed to generate master icon PNG"
        exit 1
    fi

    # Generate all required icon sizes from the 1024x1024 master.
    # iconutil requires: 16, 32, 128, 256, 512 at 1x and 2x (10 files).
    for SIZE in 16 32 128 256 512; do
        DOUBLE=$((SIZE * 2))
        sips -z "$SIZE" "$SIZE" "$MASTER_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}.png" > /dev/null
        sips -z "$DOUBLE" "$DOUBLE" "$MASTER_PNG" --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" > /dev/null
    done

    # Produce the .icns file
    iconutil --convert icns --output "$RESOURCES_DIR/AppIcon.icns" "$ICONSET_DIR"

    # Clean up
    rm -rf "$(dirname "$ICONSET_DIR")"
    rm -f "$MASTER_PNG"

    echo "Generated AppIcon.icns"
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
        -target "${QL_TARGET_ARCH}-apple-macosx15.0" \
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
        -target "${QL_TARGET_ARCH}-apple-macosx15.0" \
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

# Strip extended attributes (com.apple.FinderInfo, com.apple.ResourceFork,
# com.apple.provenance, etc.) that codesign rejects with "resource fork,
# Finder information, or similar detritus not allowed". These can accumulate
# from Finder interactions, file copies, or SPM package resolution.
# Ensure all files are writable first — SPM resource bundles (PrivacyInfo.xcprivacy,
# font files) are read-only from the build cache.
chmod -R u+w "$APP_DIR" 2>/dev/null || true
xattr -cr "$APP_DIR" 2>/dev/null || true

# 6. Code sign
echo "Signing with: $SIGN_IDENTITY"

# Sign components explicitly (Apple's recommended approach instead of --deep)
# This ensures nested binaries with specific entitlements aren't overwritten

# Hardened runtime (--options runtime) is required on macOS 26+ (Tahoe). Without
# it the kernel enforces a Launch Constraint Violation (CODESIGNING code 4) that
# immediately kills the process before any code executes. We enable it for ALL
# builds — release AND debug/local.
#
# Timestamp: release builds with a real identity use Apple's timestamp server
# (required for notarization). Debug/local builds use --timestamp=none to
# explicitly opt out — otherwise, when re-signing Sparkle's pre-timestamped XPC
# services, codesign implicitly tries to preserve the timestamp by contacting
# Apple's server, and if unreachable the build fails with "A timestamp was
# expected but was not found".
#
# Entitlements: debug builds inject com.apple.security.get-task-allow so LLDB
# can attach under hardened runtime. This is the same pattern Xcode uses for
# Debug configurations.
if [ "$CONFIG" = "release" ] && [ "$SIGN_IDENTITY" != "-" ]; then
    CODESIGN_TS_FLAGS=(--timestamp --options runtime)
    APP_ENTITLEMENTS_PATH="$SCRIPT_DIR/app-entitlements.plist"
    DAEMON_ENTITLEMENTS_PATH="$SCRIPT_DIR/daemon-entitlements.plist"
else
    CODESIGN_TS_FLAGS=(--timestamp=none --options runtime)
    # Generate debug entitlements with get-task-allow for debugger attachment
    _DEBUG_ENT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vellum-ent.XXXXXX")
    APP_ENTITLEMENTS_PATH="$_DEBUG_ENT_DIR/app-entitlements.plist"
    DAEMON_ENTITLEMENTS_PATH="$_DEBUG_ENT_DIR/daemon-entitlements.plist"
    cp "$SCRIPT_DIR/app-entitlements.plist" "$APP_ENTITLEMENTS_PATH"
    cp "$SCRIPT_DIR/daemon-entitlements.plist" "$DAEMON_ENTITLEMENTS_PATH"
    /usr/libexec/PlistBuddy -c "Add :com.apple.security.get-task-allow bool true" "$APP_ENTITLEMENTS_PATH"
    /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$APP_ENTITLEMENTS_PATH"
    /usr/libexec/PlistBuddy -c "Add :com.apple.security.get-task-allow bool true" "$DAEMON_ENTITLEMENTS_PATH"
fi

# Sign Sparkle.framework — must sign nested binaries inside-out before the outer framework
if [ -d "$FRAMEWORKS_DIR/Sparkle.framework" ]; then
    FW_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" "${CODESIGN_TS_FLAGS[@]}")

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
    QLTHUMB_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${QLTHUMB_SIGN_FLAGS[@]}" "$QLTHUMB_APPEX"
    echo "VellumQLThumbnail.appex signed"
fi

# Sign Quick Look Preview extension (must be signed before outer app bundle)
QLPREV_APPEX="$CONTENTS/PlugIns/VellumQLPreview.appex"
if [ -d "$QLPREV_APPEX" ]; then
    QLPREV_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${QLPREV_SIGN_FLAGS[@]}" "$QLPREV_APPEX"
    echo "VellumQLPreview.appex signed"
fi

# Sign Bun-compiled binaries with daemon entitlements. These are JavaScript
# executables produced by `bun build --compile` that require JIT and unsigned
# executable memory to run under hardened runtime.
if [ -f "$MACOS_DIR/vellum-cli" ]; then
    CLI_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$DAEMON_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${CLI_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-cli"
    echo "CLI binary signed with entitlements"
fi

if [ -f "$MACOS_DIR/vellum-gateway" ]; then
    GATEWAY_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$DAEMON_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${GATEWAY_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-gateway"
    echo "Gateway binary signed with entitlements"
fi

if [ -f "$MACOS_DIR/credential-executor" ]; then
    CES_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$DAEMON_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${CES_SIGN_FLAGS[@]}" "$MACOS_DIR/credential-executor"
    echo "credential-executor binary signed with entitlements"
fi

if [ -f "$MACOS_DIR/vellum-assistant" ]; then
    ASSISTANT_BIN_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$DAEMON_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${ASSISTANT_BIN_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-assistant"
    echo "Assistant binary signed with entitlements"
fi

# Embedding runtime node_modules are no longer bundled (downloaded post-hatch).

# Sign any additional regular files directly under Contents/MacOS.
# This protects against future unsigned loose files in incremental dev builds.
if [ -d "$MACOS_DIR" ]; then
    EXTRA_FILE_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" "${CODESIGN_TS_FLAGS[@]}")
    find "$MACOS_DIR" -maxdepth 1 -type f \
        ! -name "$BUNDLE_DISPLAY_NAME" \
        ! -name "vellum-daemon" \
        ! -name "vellum-assistant" \
        ! -name "vellum-cli" \
        ! -name "vellum-gateway" \
        ! -name "credential-executor" \
        -exec codesign "${EXTRA_FILE_SIGN_FLAGS[@]}" {} \;
fi

# Sign daemon binary with its own entitlements (JIT, network)
if [ -f "$MACOS_DIR/vellum-daemon" ]; then
    DAEMON_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$DAEMON_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${DAEMON_SIGN_FLAGS[@]}" "$MACOS_DIR/vellum-daemon"
    echo "Daemon binary signed with entitlements"
fi

# Sign the bundled bun runtime with the same entitlements as the daemon.
# Bun is a JS runtime that JITs code and opens network sockets, so it
# needs allow-jit, allow-unsigned-executable-memory, and network.client
# to pass hardened runtime checks when the daemon spawns it as a child.
if [ -f "$RESOURCES_DIR/bun" ]; then
    BUN_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$DAEMON_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
    codesign "${BUN_SIGN_FLAGS[@]}" "$RESOURCES_DIR/bun"
    echo "Bundled bun runtime signed with entitlements"
fi

# Pre-flight: detect stray files in the .app bundle root that would cause
# codesign to fail with the cryptic "unsealed contents present in the bundle
# root" error. Only Contents/ belongs at the top level of a macOS .app bundle.
STRAY_ITEMS=()
for item in "$APP_DIR"/* "$APP_DIR"/.*; do
    [ -e "$item" ] || continue
    case "$(basename "$item")" in
        .|..|Contents) continue ;;
    esac
    STRAY_ITEMS+=("$(basename "$item")")
done
if [ ${#STRAY_ITEMS[@]} -gt 0 ]; then
    echo ""
    echo "warning: Removing unexpected items from .app bundle root (stale build artifacts):"
    printf '  - %s\n' "${STRAY_ITEMS[@]}"
    for item in "${STRAY_ITEMS[@]}"; do
        rm -rf "$APP_DIR/$item"
    done
fi

# Sign the outer app bundle with entitlements (without --deep to preserve nested signatures)
APP_SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY" --entitlements "$APP_ENTITLEMENTS_PATH" "${CODESIGN_TS_FLAGS[@]}")
codesign "${APP_SIGN_FLAGS[@]}" "$APP_DIR"

# Clean up temp debug entitlements directory (created for non-release builds)
if [ -n "${_DEBUG_ENT_DIR:-}" ] && [ -d "$_DEBUG_ENT_DIR" ]; then
    rm -rf "$_DEBUG_ENT_DIR"
fi

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

# 6b. Register local build manifest
#
# For local builds, record a manifest entry so the localhost downloads page
# can discover and serve previous builds. Each build gets a JSON file under
# $_VELLUM_CONFIG_DIR/builds/ keyed by BUILD_VERSION, and a companion ZIP
# of the .app bundle for download.
if [ "$VELLUM_ENVIRONMENT" = "local" ] && [ -d "$APP_DIR" ]; then
    _BUILDS_DIR="$_VELLUM_CONFIG_DIR/builds/macos"
    mkdir -p "$_BUILDS_DIR"

    # DISPLAY_VERSION is unique per local build (e.g. 0.6.6-local.20260429143709.b8d2555c5).
    # BUILD_VERSION defaults to "1" for local builds and would overwrite on every build.
    _BUILD_ZIP="$_BUILDS_DIR/${DISPLAY_VERSION}.zip"
    _BUILD_MANIFEST="$_BUILDS_DIR/${DISPLAY_VERSION}.json"

    # Create ZIP of the .app bundle (ditto preserves macOS metadata + code signatures)
    echo "Registering local build $DISPLAY_VERSION (build $BUILD_VERSION)..."
    if command -v ditto &>/dev/null; then
        ditto -c -k --keepParent "$APP_DIR" "$_BUILD_ZIP"
    else
        (cd "$SCRIPT_DIR/dist" && zip -r -q "$_BUILD_ZIP" "$BUNDLE_DISPLAY_NAME.app")
    fi

    _BUILD_SHA=$(git -C "$SCRIPT_DIR/../.." rev-parse HEAD 2>/dev/null | head -c 10)
    _BUILD_ARCH=$(uname -m)
    _BUILD_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    _BUILD_SIZE=$(stat -f%z "$_BUILD_ZIP" 2>/dev/null || stat -c%s "$_BUILD_ZIP" 2>/dev/null || echo "0")

    # Sign the ZIP with the local Sparkle EdDSA key (if available).
    _ED_SIGNATURE=""
    _SPARKLE_KEY_FILE="${_VELLUM_CONFIG_DIR}/sparkle/ed25519-key.pem"
    if [ -f "$_SPARKLE_KEY_FILE" ]; then
        _SIGN_UPDATE=$(command -v sign_update 2>/dev/null || true)
        if [ -z "$_SIGN_UPDATE" ]; then
            _SIGN_UPDATE=$(find /opt/homebrew/Caskroom/sparkle /usr/local/Caskroom/sparkle \
                -name sign_update -type f 2>/dev/null | head -1 || true)
        fi
        if [ -n "$_SIGN_UPDATE" ]; then
            _SIGN_OUTPUT=$("$_SIGN_UPDATE" "$_BUILD_ZIP" --ed-key-file "$_SPARKLE_KEY_FILE" 2>&1 || true)
            _ED_SIGNATURE=$(echo "$_SIGN_OUTPUT" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')
            if [ -n "$_ED_SIGNATURE" ]; then
                echo "Sparkle signature generated"
            else
                echo "Warning: sign_update ran but no signature parsed"
            fi
        fi
    fi

    cat > "$_BUILD_MANIFEST" << MANIFEST_EOF
{
  "version": "$DISPLAY_VERSION",
  "buildVersion": "$BUILD_VERSION",
  "displayName": "$BUNDLE_DISPLAY_NAME",
  "bundleId": "$BUNDLE_ID",
  "timestamp": "$_BUILD_TIMESTAMP",
  "commitSha": "$_BUILD_SHA",
  "architecture": "$_BUILD_ARCH",
  "zipPath": "$_BUILD_ZIP",
  "zipSize": $_BUILD_SIZE,
  "edSignature": "$_ED_SIGNATURE"
}
MANIFEST_EOF

    echo "Build registered: $_BUILD_MANIFEST"
    echo "Build ZIP: $_BUILD_ZIP ($(du -h "$_BUILD_ZIP" | cut -f1))"

    # Prune old builds — keep the latest 10
    _build_count=$(ls -1 "$_BUILDS_DIR"/*.json 2>/dev/null | wc -l)
    if [ "$_build_count" -gt 10 ]; then
        ls -1t "$_BUILDS_DIR"/*.json | tail -n +11 | while read -r old_manifest; do
            old_zip="${old_manifest%.json}.zip"
            rm -f "$old_manifest" "$old_zip"
        done
        echo "Pruned old builds (keeping latest 10)"
    fi
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

    # Kill any running instance that shares our bundle ID (SIGTERM for
    # clean shutdown). We match by reading each candidate's Info.plist
    # rather than by process name, so a production app
    # (com.vellum.vellum-assistant) is never killed by a dev build
    # (com.vellum.vellum-assistant-dev), and vice versa. An unrelated
    # third-party app named "Vellum" (e.g. vellum.pub) is also ignored.
    _kill_targets=""
    while IFS= read -r line; do
        read -r pid exe_path <<< "$line"
        [ -n "$pid" ] || continue
        case "$exe_path" in
            */Contents/MacOS/*) ;;
            *) continue ;;
        esac
        bundle_root=${exe_path%/Contents/MacOS/*}
        other_id=$(plutil -extract CFBundleIdentifier raw "$bundle_root/Contents/Info.plist" 2>/dev/null || true)
        [ "$other_id" = "$BUNDLE_ID" ] || continue
        _kill_targets+="$pid $exe_path"$'\n'
    done < <(ps -ax -o pid=,comm=)
    _kill_targets=${_kill_targets%$'\n'}

    if [ -n "$_kill_targets" ]; then
        echo "Stopping existing instance(s) (bundle ID $BUNDLE_ID):"
        echo "$_kill_targets" | sed 's/^/  /'
        echo "$_kill_targets" | awk '{print $1}' | xargs kill 2>/dev/null || true
        # Wait for clean exit (max 2 seconds)
        for i in {1..20}; do
            still_running=false
            while IFS= read -r pid_line; do
                read -r _pid _ <<< "$pid_line"
                kill -0 "$_pid" 2>/dev/null && still_running=true && break
            done <<< "$_kill_targets"
            $still_running || break
            sleep 0.1
        done
        # Force-kill any stragglers — re-read ps and re-match the bundle
        # ID so we never SIGKILL a PID that was reused by an unrelated
        # process since the original snapshot.
        if $still_running; then
            echo "Force-killing remaining instance(s)..."
            survivors=""
            while IFS= read -r line; do
                read -r pid exe_path <<< "$line"
                [ -n "$pid" ] || continue
                case "$exe_path" in
                    */Contents/MacOS/*) ;;
                    *) continue ;;
                esac
                bundle_root=${exe_path%/Contents/MacOS/*}
                other_id=$(plutil -extract CFBundleIdentifier raw "$bundle_root/Contents/Info.plist" 2>/dev/null || true)
                [ "$other_id" = "$BUNDLE_ID" ] || continue
                survivors+="$pid "
            done < <(ps -ax -o pid=,comm=)
            if [ -n "$survivors" ]; then
                echo "$survivors" | xargs kill -9 2>/dev/null || true
            fi
            sleep 0.3
        fi
    fi

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
    case "$VELLUM_ENVIRONMENT" in
        production) DMG_FILENAME="vellum-assistant.dmg" ;;
        *)          DMG_FILENAME="vellum-assistant-${VELLUM_ENVIRONMENT}.dmg" ;;
    esac
    DMG_PATH="$DMG_BUILD_DIR/$DMG_FILENAME"
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
            --volname "$BUNDLE_DISPLAY_NAME" \
            "${DMG_BG_ARGS[@]}" \
            --window-pos 200 120 \
            --window-size 660 500 \
            --icon-size 80 \
            --text-size 10 \
            --icon "$BUNDLE_DISPLAY_NAME.app" 200 200 \
            --icon "Applications" 460 200 \
            --hide-extension "$BUNDLE_DISPLAY_NAME.app" \
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
        hdiutil create -volname "$BUNDLE_DISPLAY_NAME" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_PATH"
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

    # Kill running instance before replacing (scoped to our bundle ID so
    # a dev build doesn't kill production or vice versa).
    _install_targets=""
    while IFS= read -r line; do
        read -r pid exe_path <<< "$line"
        [ -n "$pid" ] || continue
        case "$exe_path" in
            */Contents/MacOS/*) ;;
            *) continue ;;
        esac
        bundle_root=${exe_path%/Contents/MacOS/*}
        other_id=$(plutil -extract CFBundleIdentifier raw "$bundle_root/Contents/Info.plist" 2>/dev/null || true)
        [ "$other_id" = "$BUNDLE_ID" ] || continue
        _install_targets+="$pid "
    done < <(ps -ax -o pid=,comm=)
    _install_targets=${_install_targets% }
    if [ -n "$_install_targets" ]; then
        echo "Stopping running $BUNDLE_DISPLAY_NAME (bundle ID $BUNDLE_ID)..."
        echo "$_install_targets" | xargs kill 2>/dev/null || true
        for i in {1..10}; do
            all_gone=true
            for _pid in $_install_targets; do
                kill -0 "$_pid" 2>/dev/null && all_gone=false && break
            done
            $all_gone && break
            sleep 0.1
        done
    fi

    MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -noverify | tail -1 | awk -F'\t' '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $NF); print $NF}')
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
