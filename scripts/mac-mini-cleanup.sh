#!/bin/bash
# Mac Mini Rollback Script
# Undoes recent setup changes and restores to near-fresh state
#
# WARNING: This script is under active development and may contain risky,
# destructive operations (removing system tools, killing processes, deleting
# application data). Only run this on environments you are comfortable
# completely resetting. Review each step before executing.

echo "🔄 Starting Mac Mini rollback..."
echo ""
echo "⚠️  WARNING: This script performs destructive operations."
echo "   Only run on environments you are comfortable completely resetting."
echo ""

TOTAL_STEPS=16

# Run a step inside a subshell so that any failure is caught and reported
# without aborting the rest of the script.
#
# The subshell must NOT be placed in an `if` condition or `||` chain because
# Bash silently disables `set -e` (errexit) in those contexts. Instead we run
# it as a plain command and capture its exit code on the next line.
run_step() {
    local step_number="$1"
    local step_label="$2"
    shift 2
    echo "$step_number/$TOTAL_STEPS — $step_label..."
    (set -e; "$@")
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        echo "      ⚠️  Step $step_number failed, continuing..."
    fi
}

step_kill_bun_processes() {
    BUN_PIDS=$(pgrep -f "bun run" 2>/dev/null || true)
    if [ -n "$BUN_PIDS" ]; then
        if ! echo "$BUN_PIDS" | xargs kill -9 2>&1; then
            echo "      ⚠️  Warning: Some bun processes could not be killed"
        fi
        echo "      ✅ Killed bun run processes: $BUN_PIDS"
    else
        echo "      ⏭️  No bun run processes found, skipping"
    fi
}

step_uninstall_bun() {
    if [ -d ~/.bun ]; then
        rm -rf ~/.bun
        echo "      ✅ Removed ~/.bun directory"
        # Clean up shell profile references
        for profile in ~/.bashrc ~/.bash_profile ~/.zshrc ~/.zprofile; do
            if [ -f "$profile" ]; then
                if ! sed -i '' '/\.bun/d' "$profile" 2>&1; then
                    echo "      ⚠️  Warning: Failed to clean bun references from $profile"
                fi
            fi
        done
        echo "      ✅ Cleaned bun references from shell profiles"
    else
        echo "      ⏭️  Bun not found, skipping"
    fi
}

step_kill_qdrant_processes() {
    QDRANT_PIDS=$(pgrep -f "qdrant" 2>/dev/null || true)
    if [ -n "$QDRANT_PIDS" ]; then
        if ! echo "$QDRANT_PIDS" | xargs kill -9 2>&1; then
            echo "      ⚠️  Warning: Some qdrant processes could not be killed"
        fi
        echo "      ✅ Killed qdrant processes: $QDRANT_PIDS"
    else
        echo "      ⏭️  No qdrant processes found, skipping"
    fi
}

step_kill_vellum_processes() {
    VELLUM_PIDS=$(pgrep -f "Vellum" 2>/dev/null || true)
    if [ -n "$VELLUM_PIDS" ]; then
        if ! echo "$VELLUM_PIDS" | xargs kill -9 2>&1; then
            echo "      ⚠️  Warning: Some Vellum processes could not be killed"
        fi
        echo "      ✅ Killed Vellum processes: $VELLUM_PIDS"
    else
        echo "      ⏭️  No Vellum processes found, skipping"
    fi
}

step_remove_vellum_dir() {
    if [ -d ~/.vellum ]; then
        rm -rf ~/.vellum
        echo "      ✅ Removed ~/.vellum"
    else
        echo "      ⏭️  No ~/.vellum directory found, skipping"
    fi
}

step_kill_embed_workers() {
    EMBED_PIDS=$(pgrep -f "embed-worker" 2>/dev/null || true)
    if [ -n "$EMBED_PIDS" ]; then
        if ! echo "$EMBED_PIDS" | xargs kill -9 2>&1; then
            echo "       ⚠️  Warning: Some embedding worker processes could not be killed"
        fi
        echo "       ✅ Killed embedding worker processes: $EMBED_PIDS"
    else
        echo "       ⏭️  No embedding worker processes found, skipping"
    fi
}

step_remove_vellum_lock() {
    if [ -f ~/.vellum.lock.json ]; then
        rm -f ~/.vellum.lock.json
        echo "      ✅ Removed ~/.vellum.lock.json"
    else
        echo "      ⏭️  No ~/.vellum.lock.json found, skipping"
    fi
}

step_remove_cli_symlinks() {
    CLI_REMOVED=false
    for dir in /usr/local/bin "$HOME/.local/bin"; do
        for cmd in vellum assistant; do
            LINK="$dir/$cmd"
            if [ -L "$LINK" ]; then
                rm -f "$LINK"
                echo "       ✅ Removed symlink $LINK"
                CLI_REMOVED=true
            fi
        done
    done
    if [ "$CLI_REMOVED" = false ]; then
        echo "       ⏭️  No CLI symlinks found, skipping"
    fi
}

step_remove_vellum_apps() {
    VELLUM_APP_REMOVED=false
    for app in "/Applications/Vellum.app" "/Applications/Vellum (Staging).app"; do
        if [ -d "$app" ]; then
            rm -rf "$app"
            echo "       ✅ Removed $app"
            VELLUM_APP_REMOVED=true
        fi
    done
    if [ "$VELLUM_APP_REMOVED" = false ]; then
        echo "       ⏭️  No Vellum apps found, skipping"
    fi
}

step_remove_playwright() {
    PW_FOUND=false
    # Default macOS cache location
    if [ -d "$HOME/Library/Caches/ms-playwright" ]; then
        rm -rf "$HOME/Library/Caches/ms-playwright"
        echo "       ✅ Removed ~/Library/Caches/ms-playwright"
        PW_FOUND=true
    fi
    # Linux default cache location (in case the script is run on Linux)
    if [ -d "$HOME/.cache/ms-playwright" ]; then
        rm -rf "$HOME/.cache/ms-playwright"
        echo "       ✅ Removed ~/.cache/ms-playwright"
        PW_FOUND=true
    fi
    # Custom location via PLAYWRIGHT_BROWSERS_PATH
    if [ -n "$PLAYWRIGHT_BROWSERS_PATH" ] && [ -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
        rm -rf "$PLAYWRIGHT_BROWSERS_PATH"
        echo "       ✅ Removed custom Playwright browsers path: $PLAYWRIGHT_BROWSERS_PATH"
        PW_FOUND=true
    fi
    if [ "$PW_FOUND" = false ]; then
        echo "       ⏭️  No ms-playwright installations found, skipping"
    fi
}

step_clear_vellum_defaults() {
    VELLUM_DEFAULTS_DOMAIN="com.vellum.vellum-assistant"
    if defaults read "$VELLUM_DEFAULTS_DOMAIN" &>/dev/null; then
        defaults delete "$VELLUM_DEFAULTS_DOMAIN"
        echo "       ✅ Cleared UserDefaults for $VELLUM_DEFAULTS_DOMAIN"
    else
        echo "       ⏭️  No UserDefaults found for $VELLUM_DEFAULTS_DOMAIN, skipping"
    fi
}

step_clear_sparkle_defaults() {
    SPARKLE_DEFAULTS_DOMAIN="com.vellum.vellum-assistant.Sparkle"
    if defaults read "$SPARKLE_DEFAULTS_DOMAIN" &>/dev/null; then
        defaults delete "$SPARKLE_DEFAULTS_DOMAIN"
        echo "       ✅ Cleared UserDefaults for $SPARKLE_DEFAULTS_DOMAIN"
    else
        echo "       ⏭️  No UserDefaults found for $SPARKLE_DEFAULTS_DOMAIN, skipping"
    fi
}

step_remove_dock_entry() {
    DOCK_PLIST="$HOME/Library/Preferences/com.apple.dock.plist"
    if [ -f "$DOCK_PLIST" ]; then
        # Find and remove any Vellum entry from persistent-apps in the Dock plist
        DOCK_APPS=$(/usr/libexec/PlistBuddy -c "Print :persistent-apps" "$DOCK_PLIST" 2>/dev/null | grep -c "Vellum" || true)
        if [ "$DOCK_APPS" -gt 0 ]; then
            # Iterate in reverse to safely remove entries by index
            NUM_ENTRIES=$(/usr/libexec/PlistBuddy -c "Print :persistent-apps" "$DOCK_PLIST" 2>/dev/null | grep -c "Dict" || echo "0")
            for ((i=NUM_ENTRIES-1; i>=0; i--)); do
                LABEL=$(/usr/libexec/PlistBuddy -c "Print :persistent-apps:$i:tile-data:file-label" "$DOCK_PLIST" 2>/dev/null || true)
                if [[ "$LABEL" == *"Vellum"* ]]; then
                    /usr/libexec/PlistBuddy -c "Delete :persistent-apps:$i" "$DOCK_PLIST"
                    echo "       ✅ Removed Vellum from Dock persistent apps (index $i)"
                fi
            done
            if ! killall Dock 2>&1; then
                echo "       ⚠️  Warning: Could not restart Dock"
            else
                echo "       ✅ Dock restarted"
            fi
        else
            echo "       ⏭️  Vellum not found in Dock, skipping"
        fi
    else
        echo "       ⏭️  No Dock plist found, skipping"
    fi
}

step_uninstall_docker() {
    DOCKER_REMOVED=false
    if [ -d "/Applications/Docker.app" ]; then
        # Quit Docker if running
        if ! osascript -e 'quit app "Docker"' 2>&1; then
            echo "       ⚠️  Warning: Could not quit Docker.app — it may not be running"
        fi
        sleep 2
        rm -rf /Applications/Docker.app
        echo "       ✅ Removed /Applications/Docker.app"
        DOCKER_REMOVED=true
    fi
    # Remove Docker data and config directories
    for docker_dir in "$HOME/Library/Group Containers/group.com.docker" \
                       "$HOME/Library/Containers/com.docker.docker" \
                       "$HOME/Library/Application Support/Docker Desktop" \
                       "$HOME/.docker"; do
        if [ -d "$docker_dir" ]; then
            rm -rf "$docker_dir"
            echo "       ✅ Removed $docker_dir"
            DOCKER_REMOVED=true
        fi
    done
    # Remove docker binaries — use `which` to find the actual location, plus check known paths
    DOCKER_BINS_TO_CHECK="docker docker-compose docker-credential-desktop docker-credential-ecr-login docker-credential-osxkeychain"
    for docker_bin in $DOCKER_BINS_TO_CHECK; do
        # Try `which` first to find the actual install location
        DOCKER_BIN_PATH=$(which "$docker_bin" 2>/dev/null || true)
        if [ -n "$DOCKER_BIN_PATH" ] && [ -f "$DOCKER_BIN_PATH" ]; then
            rm -f "$DOCKER_BIN_PATH"
            echo "       ✅ Removed $DOCKER_BIN_PATH"
            DOCKER_REMOVED=true
        fi
        # Also check known install locations in case they weren't on PATH
        for known_dir in /usr/local/bin /opt/homebrew/bin "$HOME/.vellum/bin"; do
            if [ -f "$known_dir/$docker_bin" ] || [ -L "$known_dir/$docker_bin" ]; then
                rm -f "$known_dir/$docker_bin"
                echo "       ✅ Removed $known_dir/$docker_bin"
                DOCKER_REMOVED=true
            fi
        done
    done
    if [ "$DOCKER_REMOVED" = false ]; then
        echo "       ⏭️  Docker not found, skipping"
    fi
}

step_uninstall_colima() {
    COLIMA_REMOVED=false
    # Find colima binary — try `which`, then known paths
    COLIMA_BIN=$(which colima 2>/dev/null || true)
    if [ -z "$COLIMA_BIN" ]; then
        for known_dir in /usr/local/bin /opt/homebrew/bin "$HOME/.vellum/bin"; do
            if [ -f "$known_dir/colima" ]; then
                COLIMA_BIN="$known_dir/colima"
                break
            fi
        done
    fi
    if [ -n "$COLIMA_BIN" ]; then
        if ! "$COLIMA_BIN" stop 2>&1; then
            echo "       ⚠️  Warning: 'colima stop' failed — VM may not have been running"
        fi
        if ! "$COLIMA_BIN" delete --force 2>&1; then
            echo "       ⚠️  Warning: 'colima delete --force' failed — will clean up state directories manually"
        else
            echo "       ✅ Stopped and deleted Colima VM"
        fi
        COLIMA_REMOVED=true
    fi
    if [ -d "$HOME/.colima" ]; then
        rm -rf "$HOME/.colima"
        echo "       ✅ Removed ~/.colima"
        COLIMA_REMOVED=true
    fi
    # Also remove Lima's internal state in case 'colima delete' failed to clean up
    if [ -d "$HOME/.lima" ]; then
        rm -rf "$HOME/.lima"
        echo "       ✅ Removed ~/.lima"
        COLIMA_REMOVED=true
    fi
    # Remove colima and lima binaries from all known locations
    for colima_bin_name in colima lima limactl; do
        FOUND_PATH=$(which "$colima_bin_name" 2>/dev/null || true)
        if [ -n "$FOUND_PATH" ] && [ -f "$FOUND_PATH" ]; then
            rm -f "$FOUND_PATH"
            echo "       ✅ Removed $FOUND_PATH"
            COLIMA_REMOVED=true
        fi
        for known_dir in /usr/local/bin /opt/homebrew/bin "$HOME/.vellum/bin"; do
            if [ -f "$known_dir/$colima_bin_name" ] || [ -L "$known_dir/$colima_bin_name" ]; then
                rm -f "$known_dir/$colima_bin_name"
                echo "       ✅ Removed $known_dir/$colima_bin_name"
                COLIMA_REMOVED=true
            fi
        done
    done
    if [ "$COLIMA_REMOVED" = false ]; then
        echo "       ⏭️  Colima not found, skipping"
    fi
}

step_uninstall_homebrew() {
    # Find brew binary — try `which`, then check known install locations directly
    BREW_BIN=$(which brew 2>/dev/null || true)
    if [ -z "$BREW_BIN" ]; then
        for known_brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
            if [ -f "$known_brew" ]; then
                BREW_BIN="$known_brew"
                break
            fi
        done
    fi
    if [ -n "$BREW_BIN" ]; then
        # Use Homebrew's official uninstall script
        if ! NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)" 2>&1; then
            echo "       ⚠️  Warning: Homebrew uninstall script failed — cleaning up directories manually"
        fi
        # Clean up any remaining Homebrew directories
        for brew_dir in /usr/local/Homebrew /usr/local/Caskroom /usr/local/Cellar /opt/homebrew; do
            if [ -d "$brew_dir" ]; then
                rm -rf "$brew_dir"
                echo "       ✅ Removed $brew_dir"
            fi
        done
        echo "       ✅ Uninstalled Homebrew"
    else
        echo "       ⏭️  Homebrew not found, skipping"
    fi
}

# ── Execute all steps ─────────────────────────────────────────────────────────

run_step 1  "Killing bun run processes"                step_kill_bun_processes
run_step 2  "Uninstalling bun"                         step_uninstall_bun
run_step 3  "Killing qdrant processes"                 step_kill_qdrant_processes
run_step 4  "Killing Vellum processes"                 step_kill_vellum_processes
run_step 5  "Removing ~/.vellum directory"             step_remove_vellum_dir
run_step 6  "Killing embedding worker processes"       step_kill_embed_workers
run_step 7  "Removing ~/.vellum.lock.json"             step_remove_vellum_lock
run_step 8  "Removing CLI symlinks"                    step_remove_cli_symlinks
run_step 9  "Removing Vellum apps from /Applications"  step_remove_vellum_apps
run_step 10 "Removing ms-playwright browser caches"    step_remove_playwright
run_step 11 "Clearing Vellum desktop app UserDefaults" step_clear_vellum_defaults
run_step 12 "Clearing Vellum Sparkle updater defaults" step_clear_sparkle_defaults
run_step 13 "Removing Vellum from the Dock"            step_remove_dock_entry
run_step 14 "Uninstalling Colima"                      step_uninstall_colima
run_step 15 "Uninstalling Docker"                      step_uninstall_docker
run_step 16 "Uninstalling Homebrew"                    step_uninstall_homebrew

echo ""
echo "🚀 Rollback complete. Mac Mini is back to clean state."
