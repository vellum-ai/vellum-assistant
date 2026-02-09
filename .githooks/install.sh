#!/bin/bash

# Install git hooks from .githooks directory to .git/hooks

HOOKS_DIR=".githooks"
GIT_HOOKS_DIR=".git/hooks"

echo "Installing git hooks..."

# Check if we're in a git repository
if [ ! -d ".git" ]; then
    echo "Error: Not in a git repository root directory"
    exit 1
fi

# Create .git/hooks directory if it doesn't exist
mkdir -p "$GIT_HOOKS_DIR"

# Copy all executable files from .githooks to .git/hooks
for hook in "$HOOKS_DIR"/*; do
    # Skip this install script itself
    if [[ "$(basename "$hook")" == "install.sh" ]] || [[ "$(basename "$hook")" == "README.md" ]]; then
        continue
    fi

    # Skip if not a file
    if [ ! -f "$hook" ]; then
        continue
    fi

    hook_name=$(basename "$hook")
    destination="$GIT_HOOKS_DIR/$hook_name"

    cp "$hook" "$destination"
    chmod +x "$destination"

    echo "✅ Installed: $hook_name"
done

echo ""
echo "Git hooks installed successfully!"
echo "These hooks will now run automatically on git operations."
