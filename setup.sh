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
    echo "✅ bun installed"
else
    echo "✅ bun already installed"
fi

# Deduplicate bun PATH entries in shell RC files
for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$RC_FILE" ]; then
        BUN_LINE_COUNT=$(grep -c 'BUN_INSTALL' "$RC_FILE" 2>/dev/null || true)
        if [ "$BUN_LINE_COUNT" -gt 2 ]; then
            echo "🧹 Cleaning duplicate bun entries in $(basename "$RC_FILE")..."
            TEMP_FILE=$(mktemp)
            awk '
                /^# bun$/ { if (bun_block_seen) { skip=1; next } else { bun_block_seen=1 } }
                /^export BUN_INSTALL=/ { if (skip) { next } }
                /^export PATH=.*BUN_INSTALL/ { if (skip) { skip=0; next } }
                { print }
            ' "$RC_FILE" > "$TEMP_FILE"
            mv "$TEMP_FILE" "$RC_FILE"
        fi
        if ! grep -q 'BUN_INSTALL' "$RC_FILE"; then
            echo "" >> "$RC_FILE"
            echo "# bun" >> "$RC_FILE"
            echo 'export BUN_INSTALL="$HOME/.bun"' >> "$RC_FILE"
            echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$RC_FILE"
        fi
    fi
done

# Get the absolute path to the project root
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$PROJECT_ROOT/web"
LEGACY_COMPOSE_PATH="$PROJECT_ROOT/../vellum/docker-compose.yaml"

echo "🧹 Checking for legacy Vellum containers..."
if [ -f "$LEGACY_COMPOSE_PATH" ] && command -v docker &> /dev/null; then
    LEGACY_DIR="$(dirname "$LEGACY_COMPOSE_PATH")"
    LEGACY_RUNNING="$(cd "$LEGACY_DIR" && docker compose ps --format '{{.Name}}' 2>/dev/null || true)"
    if [ -n "$LEGACY_RUNNING" ]; then
        (cd "$LEGACY_DIR" && docker compose down --remove-orphans) || true
    fi
fi

echo "📦 Installing web dependencies..."
cd "$WEB_DIR"
bun install
cd "$PROJECT_ROOT"

# Install git hooks
echo "🔒 Installing git hooks..."
if [ -f ".githooks/install.sh" ]; then
    ./.githooks/install.sh
else
    echo "⚠️  Git hooks installer not found"
fi

echo ""
echo "✅ Setup complete"
echo ""
echo "Next steps:"
echo "  1. Start local services:  docker compose up -d"
echo "  2. Start the web app:     cd web && bun run dev"
