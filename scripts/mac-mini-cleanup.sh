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

# 1. Remove the SSH public key that was added via ssh-copy-id
echo "1/14 — Removing authorized SSH keys..."
if [ -f ~/.ssh/authorized_keys ]; then
    rm ~/.ssh/authorized_keys
    echo "      ✅ Removed ~/.ssh/authorized_keys"
else
    echo "      ⏭️  No authorized_keys file found, skipping"
fi

# 2. Restore default sshd_config (undo PubkeyAuthentication/PasswordAuthentication changes)
echo "2/14 — Restoring default sshd_config..."
if [ -f /etc/ssh/sshd_config ] && [ -f ~/cleanup/sshd_config_original ]; then
    sudo cp ~/cleanup/sshd_config_original /etc/ssh/sshd_config
    echo "      ✅ Reverted sshd_config changes"
elif [ ! -f ~/cleanup/sshd_config_original ]; then
    echo "      ⏭️  No backup sshd_config_original found, skipping"
else
    echo "      ⏭️  No sshd_config found, skipping"
fi

# 3. Reload SSH daemon
echo "3/14 — Reloading SSH daemon..."
sudo launchctl unload /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
sudo launchctl load /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
echo "      ✅ SSH daemon reloaded"

# 4. Uninstall git
echo "4/14 — Uninstalling git..."
if command -v brew &>/dev/null && brew list git &>/dev/null; then
    brew uninstall git
    echo "      ✅ Git uninstalled via Homebrew"
elif [ -d /Library/Developer/CommandLineTools ] && command -v git &>/dev/null && \
     [[ "$(command -v git)" == /Library/Developer/CommandLineTools/* || "$(xcode-select -p 2>/dev/null)" == /Library/Developer/CommandLineTools ]]; then
    sudo rm -rf /Library/Developer/CommandLineTools
    echo "      ✅ Removed Xcode Command Line Tools (included git)"
else
    echo "      ⏭️  Git not found or not from a removable source, skipping"
fi

# 5. Kill any processes running via "bun run"
echo "5/14 — Killing bun run processes..."
BUN_PIDS=$(pgrep -f "bun run" 2>/dev/null || true)
if [ -n "$BUN_PIDS" ]; then
    echo "$BUN_PIDS" | xargs kill -9 2>/dev/null || true
    echo "      ✅ Killed bun run processes: $BUN_PIDS"
else
    echo "      ⏭️  No bun run processes found, skipping"
fi

# 6. Uninstall bun
echo "6/14 — Uninstalling bun..."
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

# 7. Kill any qdrant processes
echo "7/14 — Killing qdrant processes..."
QDRANT_PIDS=$(pgrep -f "qdrant" 2>/dev/null || true)
if [ -n "$QDRANT_PIDS" ]; then
    echo "$QDRANT_PIDS" | xargs kill -9 2>/dev/null || true
    echo "      ✅ Killed qdrant processes: $QDRANT_PIDS"
else
    echo "      ⏭️  No qdrant processes found, skipping"
fi

# 8. Kill any Vellum processes
echo "8/14 — Killing Vellum processes..."
VELLUM_PIDS=$(pgrep -f "Vellum" 2>/dev/null || true)
if [ -n "$VELLUM_PIDS" ]; then
    echo "$VELLUM_PIDS" | xargs kill -9 2>/dev/null || true
    echo "      ✅ Killed Vellum processes: $VELLUM_PIDS"
else
    echo "      ⏭️  No Vellum processes found, skipping"
fi

# 9. Remove ~/.vellum directory
echo "9/14 — Removing ~/.vellum directory..."
if [ -d ~/.vellum ]; then
    rm -rf ~/.vellum
    echo "      ✅ Removed ~/.vellum"
else
    echo "      ⏭️  No ~/.vellum directory found, skipping"
fi

# 10. Kill any embedding worker processes
echo "10/14 — Killing embedding worker processes..."
EMBED_PIDS=$(pgrep -f "embed-worker" 2>/dev/null || true)
if [ -n "$EMBED_PIDS" ]; then
    echo "$EMBED_PIDS" | xargs kill -9 2>/dev/null || true
    echo "       ✅ Killed embedding worker processes: $EMBED_PIDS"
else
    echo "       ⏭️  No embedding worker processes found, skipping"
fi

# 11. Remove ~/.vellum.lock.json
echo "11/14 — Removing ~/.vellum.lock.json..."
if [ -f ~/.vellum.lock.json ]; then
    rm -f ~/.vellum.lock.json
    echo "      ✅ Removed ~/.vellum.lock.json"
else
    echo "      ⏭️  No ~/.vellum.lock.json found, skipping"
fi

# 12. Remove Vellum.app
echo "12/14 — Removing /Applications/Vellum.app..."
if [ -d /Applications/Vellum.app ]; then
    rm -rf /Applications/Vellum.app
    echo "       ✅ Removed /Applications/Vellum.app"
else
    echo "       ⏭️  No Vellum.app found, skipping"
fi

# 13. Remove ms-playwright browser installations
echo "13/14 — Removing ms-playwright browser caches..."
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

# 14. Remove Vellum from the Dock
echo "14/14 — Removing Vellum from the Dock..."
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

echo ""
echo "🚀 Rollback complete. Mac Mini is back to clean state."
