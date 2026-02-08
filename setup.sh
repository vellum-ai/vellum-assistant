#!/bin/bash
set -e

echo "🚀 Vellum Assistant Setup"
echo "========================="
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    echo "Please install Node.js and npm first: https://nodejs.org/"
    exit 1
fi

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
VEL_EXECUTABLE="$VEL_DIR/dist/index.js"
SYMLINK_DIR="$HOME/.local/bin"
SYMLINK_PATH="$SYMLINK_DIR/vel"

# Setup vel CLI
echo "🛠️  Setting up vel CLI..."
cd "$VEL_DIR"
npm install
npm run build

# Create symlink directory if it doesn't exist
mkdir -p "$SYMLINK_DIR"

# Check if symlink already exists and points to the correct location
if [ -L "$SYMLINK_PATH" ]; then
    CURRENT_TARGET=$(readlink "$SYMLINK_PATH")
    EXPECTED_TARGET="$VEL_EXECUTABLE"
    
    if [ "$CURRENT_TARGET" = "$EXPECTED_TARGET" ]; then
        echo "✅ vel symlink already configured correctly"
    else
        echo "🔄 Updating vel symlink..."
        rm "$SYMLINK_PATH"
        ln -s "$VEL_EXECUTABLE" "$SYMLINK_PATH"
        chmod +x "$SYMLINK_PATH"
        echo "✅ vel symlink updated"
    fi
elif [ -e "$SYMLINK_PATH" ]; then
    echo "🔄 Replacing existing $SYMLINK_PATH..."
    rm "$SYMLINK_PATH"
    ln -s "$VEL_EXECUTABLE" "$SYMLINK_PATH"
    chmod +x "$SYMLINK_PATH"
    echo "✅ vel symlink created"
else
    echo "🔗 Creating vel symlink..."
    ln -s "$VEL_EXECUTABLE" "$SYMLINK_PATH"
    chmod +x "$SYMLINK_PATH"
    echo "✅ vel symlink created"
fi

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
