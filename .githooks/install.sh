#!/bin/bash

# Install git hooks from .githooks directory to the repo's hooks path.
# Works for both regular checkouts and git worktrees.

HOOKS_DIR=".githooks"

echo "Installing git hooks..."

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: Not in a git repository root directory"
    exit 1
fi

GIT_HOOKS_DIR="$(git rev-parse --git-path hooks)"
if [ -z "$GIT_HOOKS_DIR" ]; then
    echo "Error: Unable to resolve git hooks directory"
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
