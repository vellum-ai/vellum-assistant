#!/bin/bash
# Mac Mini Rollback Script
# Undoes recent setup changes and restores to near-fresh state

set -e

echo "🔄 Starting Mac Mini rollback..."
echo ""

# 1. Remove the SSH public key that was added via ssh-copy-id
echo "1/8 — Removing authorized SSH keys..."
if [ -f ~/.ssh/authorized_keys ]; then
    rm ~/.ssh/authorized_keys
    echo "     ✅ Removed ~/.ssh/authorized_keys"
else
    echo "     ⏭️  No authorized_keys file found, skipping"
fi

# 2. Restore default sshd_config (undo PubkeyAuthentication/PasswordAuthentication changes)
echo "2/8 — Restoring default sshd_config..."
if [ -f /etc/ssh/sshd_config ]; then
    sudo cp ~/cleanup/sshd_config_original /etc/ssh/sshd_config
    echo "     ✅ Reverted sshd_config changes"
else
    echo "     ⏭️  No sshd_config found, skipping"
fi

# 3. Reload SSH daemon
echo "3/8 — Reloading SSH daemon..."
sudo launchctl unload /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
sudo launchctl load /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
echo "     ✅ SSH daemon reloaded"

# 4. Uninstall git
echo "4/8 — Uninstalling git..."
if command -v brew &>/dev/null && brew list git &>/dev/null; then
    brew uninstall git
    echo "     ✅ Git uninstalled via Homebrew"
elif command -v git &>/dev/null; then
    echo "     ⚠️  Git is installed but not via Homebrew. May be the Xcode CLT version."
    sudo rm -rf /Library/Developer/CommandLineTools
    echo "     ✅ Git uninstalled via XCode"
else
    echo "     ⏭️  Git not found, skipping"
fi

# 5. Uninstall bun
echo "5/8 — Uninstalling bun..."
if [ -d ~/.bun ]; then
    rm -rf ~/.bun
    echo "     ✅ Removed ~/.bun directory"
    # Clean up shell profile references
    for profile in ~/.bashrc ~/.bash_profile ~/.zshrc ~/.zprofile; do
        if [ -f "$profile" ]; then
            sed -i '' '/\.bun/d' "$profile" 2>/dev/null || true
        fi
    done
    echo "     ✅ Cleaned bun references from shell profiles"
else
    echo "     ⏭️  Bun not found, skipping"
fi

# 6. Kill any processes running via "bun run"
echo "6/8 — Killing bun run processes..."
BUN_PIDS=$(pgrep -f "bun run" 2>/dev/null || true)
if [ -n "$BUN_PIDS" ]; then
    echo "$BUN_PIDS" | xargs kill -9 2>/dev/null || true
    echo "     ✅ Killed bun run processes: $BUN_PIDS"
else
    echo "     ⏭️  No bun run processes found, skipping"
fi

# 7. Kill any processes running via "Vellu"
echo "7/8 — Killing bun run processes..."
VELLUM_PIDS=$(pgrep -f "Vellum" 2>/dev/null || true)
if [ -n "$VELLUM_PIDS" ]; then
    echo "$VELLUM_PIDS" | xargs kill -9 2>/dev/null || true
    echo "     ✅ Killed Vellum processes: $VELLUM_PIDS"
else
    echo "     ⏭️   No Vellum processes found, skipping"
fi

# 8. Delete the Vellum generated artifacts
echo "8/8 — Removing ~/.vellum directory..."
if [ -d ~/.vellum ]; then
    rm -rf ~/.vellum
    rm ~/.vellum.lock.json
    rm -rf /Applications/Vellum.app
    echo "     ✅ Removed Vellum Artifacts"
else
    echo "     ⏭️  No ~/.vellum directory found, skipping"
fi

echo ""
echo "🚀 Rollback complete. Mac Mini is back to clean state."
