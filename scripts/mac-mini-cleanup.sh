#!/bin/bash
# Mac Mini Rollback Script
# Undoes recent setup changes and restores to near-fresh state
#
# WARNING: This script is under active development and may contain risky,
# destructive operations (removing system tools, killing processes, deleting
# application data). Only run this on environments you are comfortable
# completely resetting. Review each step before executing.

set -e

echo "🔄 Starting Mac Mini rollback..."
echo ""
echo "⚠️  WARNING: This script performs destructive operations."
echo "   Only run on environments you are comfortable completely resetting."
echo ""

TOTAL_STEPS=16

# 1. Kill any processes running via "bun run"
echo "1/$TOTAL_STEPS — Killing bun run processes..."
BUN_PIDS=$(pgrep -f "bun run" 2>/dev/null || true)
if [ -n "$BUN_PIDS" ]; then
    echo "$BUN_PIDS" | xargs kill -9 2>/dev/null || true
    echo "      ✅ Killed bun run processes: $BUN_PIDS"
else
    echo "      ⏭️  No bun run processes found, skipping"
fi

# 2. Uninstall bun
echo "2/$TOTAL_STEPS — Uninstalling bun..."
if [ -d ~/.bun ]; then
    rm -rf ~/.bun
    echo "      ✅ Removed ~/.bun directory"
    # Clean up shell profile references
    for profile in ~/.bashrc ~/.bash_profile ~/.zshrc ~/.zprofile; do
        if [ -f "$profile" ]; then
            sed -i '' '/\.bun/d' "$profile" 2>/dev/null || true
        fi
    done
    echo "      ✅ Cleaned bun references from shell profiles"
else
    echo "      ⏭️  Bun not found, skipping"
fi

# 3. Kill any qdrant processes
echo "3/$TOTAL_STEPS — Killing qdrant processes..."
QDRANT_PIDS=$(pgrep -f "qdrant" 2>/dev/null || true)
if [ -n "$QDRANT_PIDS" ]; then
    echo "$QDRANT_PIDS" | xargs kill -9 2>/dev/null || true
    echo "      ✅ Killed qdrant processes: $QDRANT_PIDS"
else
    echo "      ⏭️  No qdrant processes found, skipping"
fi

# 4. Kill any Vellum processes
echo "4/$TOTAL_STEPS — Killing Vellum processes..."
VELLUM_PIDS=$(pgrep -f "Vellum" 2>/dev/null || true)
if [ -n "$VELLUM_PIDS" ]; then
    echo "$VELLUM_PIDS" | xargs kill -9 2>/dev/null || true
    echo "      ✅ Killed Vellum processes: $VELLUM_PIDS"
else
    echo "      ⏭️  No Vellum processes found, skipping"
fi

# 5. Remove ~/.vellum directory
echo "5/$TOTAL_STEPS — Removing ~/.vellum directory..."
if [ -d ~/.vellum ]; then
    rm -rf ~/.vellum
    echo "      ✅ Removed ~/.vellum"
else
    echo "      ⏭️  No ~/.vellum directory found, skipping"
fi

# 6. Kill any embedding worker processes
echo "6/$TOTAL_STEPS — Killing embedding worker processes..."
EMBED_PIDS=$(pgrep -f "embed-worker" 2>/dev/null || true)
if [ -n "$EMBED_PIDS" ]; then
    echo "$EMBED_PIDS" | xargs kill -9 2>/dev/null || true
    echo "       ✅ Killed embedding worker processes: $EMBED_PIDS"
else
    echo "       ⏭️  No embedding worker processes found, skipping"
fi

# 7. Remove ~/.vellum.lock.json
echo "7/$TOTAL_STEPS — Removing ~/.vellum.lock.json..."
if [ -f ~/.vellum.lock.json ]; then
    rm -f ~/.vellum.lock.json
    echo "      ✅ Removed ~/.vellum.lock.json"
else
    echo "      ⏭️  No ~/.vellum.lock.json found, skipping"
fi

# 8. Remove CLI symlinks (vellum, assistant) from /usr/local/bin and ~/.local/bin
echo "8/$TOTAL_STEPS — Removing CLI symlinks..."
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

# 9. Remove Vellum apps
echo "9/$TOTAL_STEPS — Removing Vellum apps from /Applications..."
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

# 10. Remove ms-playwright browser installations
echo "10/$TOTAL_STEPS — Removing ms-playwright browser caches..."
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

# 11. Clear Vellum desktop app UserDefaults
echo "11/$TOTAL_STEPS — Clearing Vellum desktop app UserDefaults..."
VELLUM_DEFAULTS_DOMAIN="com.vellum.vellum-assistant"
if defaults read "$VELLUM_DEFAULTS_DOMAIN" &>/dev/null; then
    defaults delete "$VELLUM_DEFAULTS_DOMAIN"
    echo "       ✅ Cleared UserDefaults for $VELLUM_DEFAULTS_DOMAIN"
else
    echo "       ⏭️  No UserDefaults found for $VELLUM_DEFAULTS_DOMAIN, skipping"
fi

# 12. Clear Vellum Sparkle auto-updater defaults
echo "12/$TOTAL_STEPS — Clearing Vellum Sparkle updater defaults..."
SPARKLE_DEFAULTS_DOMAIN="com.vellum.vellum-assistant.Sparkle"
if defaults read "$SPARKLE_DEFAULTS_DOMAIN" &>/dev/null; then
    defaults delete "$SPARKLE_DEFAULTS_DOMAIN"
    echo "       ✅ Cleared UserDefaults for $SPARKLE_DEFAULTS_DOMAIN"
else
    echo "       ⏭️  No UserDefaults found for $SPARKLE_DEFAULTS_DOMAIN, skipping"
fi

# 13. Remove Vellum from the Dock
echo "13/$TOTAL_STEPS — Removing Vellum from the Dock..."
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
        killall Dock 2>/dev/null || true
        echo "       ✅ Dock restarted"
    else
        echo "       ⏭️  Vellum not found in Dock, skipping"
    fi
else
    echo "       ⏭️  No Dock plist found, skipping"
fi

# 14. Uninstall Docker
echo "14/$TOTAL_STEPS — Uninstalling Docker..."
DOCKER_REMOVED=false
if [ -d "/Applications/Docker.app" ]; then
    # Quit Docker if running
    osascript -e 'quit app "Docker"' 2>/dev/null || true
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
# Remove Docker CLI symlinks
for docker_bin in docker docker-compose docker-credential-desktop docker-credential-ecr-login docker-credential-osxkeychain; do
    if [ -L "/usr/local/bin/$docker_bin" ]; then
        rm -f "/usr/local/bin/$docker_bin"
        echo "       ✅ Removed /usr/local/bin/$docker_bin symlink"
        DOCKER_REMOVED=true
    fi
done
if [ "$DOCKER_REMOVED" = false ]; then
    echo "       ⏭️  Docker not found, skipping"
fi

# 15. Uninstall Colima
echo "15/$TOTAL_STEPS — Uninstalling Colima..."
COLIMA_REMOVED=false
if command -v colima &>/dev/null; then
    colima stop 2>/dev/null || true
    colima delete --force 2>/dev/null || true
    echo "       ✅ Stopped and deleted Colima VM"
    COLIMA_REMOVED=true
fi
if [ -d "$HOME/.colima" ]; then
    rm -rf "$HOME/.colima"
    echo "       ✅ Removed ~/.colima"
    COLIMA_REMOVED=true
fi
# Remove colima binary (may be in brew or standalone)
if [ -f "/usr/local/bin/colima" ]; then
    rm -f /usr/local/bin/colima
    echo "       ✅ Removed /usr/local/bin/colima"
    COLIMA_REMOVED=true
elif [ -n "$HOMEBREW_PREFIX" ] && [ -f "$HOMEBREW_PREFIX/bin/colima" ]; then
    rm -f "$HOMEBREW_PREFIX/bin/colima"
    echo "       ✅ Removed $HOMEBREW_PREFIX/bin/colima"
    COLIMA_REMOVED=true
elif [ -f "/opt/homebrew/bin/colima" ]; then
    rm -f /opt/homebrew/bin/colima
    echo "       ✅ Removed /opt/homebrew/bin/colima"
    COLIMA_REMOVED=true
fi
if [ "$COLIMA_REMOVED" = false ]; then
    echo "       ⏭️  Colima not found, skipping"
fi

# 16. Uninstall Homebrew
echo "16/$TOTAL_STEPS — Uninstalling Homebrew..."
if command -v brew &>/dev/null; then
    # Use Homebrew's official uninstall script
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)" 2>/dev/null || true
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

echo ""
echo "🚀 Rollback complete. Mac Mini is back to clean state."
