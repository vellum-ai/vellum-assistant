#!/bin/bash
set -e

echo "🚀 Vellum Assistant Setup"
echo "========================="
echo ""

# Install bun if not already installed
if ! command -v bun &> /dev/null; then
    echo "📦 Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    BUN_PATH_LINE='export BUN_INSTALL="$HOME/.bun"'
    BUN_EXPORT_LINE='export PATH="$BUN_INSTALL/bin:$PATH"'

    for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -f "$RC_FILE" ]; then
            if ! grep -q 'BUN_INSTALL' "$RC_FILE"; then
                echo "" >> "$RC_FILE"
                echo "# bun" >> "$RC_FILE"
                echo "$BUN_PATH_LINE" >> "$RC_FILE"
                echo "$BUN_EXPORT_LINE" >> "$RC_FILE"
            fi
        fi
    done

    echo "✅ bun installed"
else
    echo "✅ bun already installed"
fi

# Get the absolute path to the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VEL_DIR="$PROJECT_ROOT/vel"
SYMLINK_DIR="$HOME/.local/bin"
SYMLINK_PATH="$SYMLINK_DIR/vel"

# Setup vel CLI
echo "🛠️  Setting up vel CLI..."
cd "$VEL_DIR"
bun install

# Create wrapper script directory
mkdir -p "$SYMLINK_DIR"

# Write wrapper script that runs vel from source via bun
echo "🔗 Installing vel wrapper script..."
cat > "$SYMLINK_PATH" << 'WRAPPER'
#!/bin/bash

resolve_bun() {
  if command -v bun &> /dev/null; then
    command -v bun
    return
  fi

  local bun_path="$HOME/.bun/bin/bun"
  if [ -x "$bun_path" ]; then
    echo "$bun_path"
    return
  fi

  return 1
}

BUN_BIN=$(resolve_bun) || {
  echo "error: bun is not installed" >&2
  echo "" >&2
  echo "  Install it with:  curl -fsSL https://bun.sh/install | bash" >&2
  echo "" >&2
  echo "  Then re-run:  vel $*" >&2
  exit 1
}

WRAPPER
# Append the exec line with the resolved VEL_DIR path baked in
echo "exec \"\$BUN_BIN\" run \"$VEL_DIR/src/index.ts\" \"\$@\"" >> "$SYMLINK_PATH"
chmod +x "$SYMLINK_PATH"
echo "✅ vel installed"

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$SYMLINK_DIR:"* ]]; then
    echo ""
    echo "⚠️  Note: $SYMLINK_DIR is not in your PATH"
    echo "   Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
fi

cd "$PROJECT_ROOT"

# Ensure vel is available even if ~/.local/bin isn't in PATH yet
export PATH="$SYMLINK_DIR:$PATH"

# Run vel setup for remaining steps
vel setup
