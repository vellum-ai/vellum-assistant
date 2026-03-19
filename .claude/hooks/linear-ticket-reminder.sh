#!/bin/bash
# Inject a Linear ticket reminder for specific team members.
# Users NOT in the remind list see nothing added to context.
#
# The remind list lives in .private/linear-remind-emails.txt (gitignored).
# Add one git email per line. To find a teammate's git email:
#   git log --format='%ae' --author=Name | sort -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REMIND_FILE="$REPO_ROOT/.private/linear-remind-emails.txt"

# No remind file → nothing to do
[[ -f "$REMIND_FILE" ]] || exit 0

CURRENT_EMAIL=$(git config user.email 2>/dev/null || echo "")
[[ -n "$CURRENT_EMAIL" ]] || exit 0

while IFS= read -r email; do
  # Skip blank lines and comments
  [[ -z "$email" || "$email" == \#* ]] && continue
  if [[ "$CURRENT_EMAIL" == "$email" ]]; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "IMPORTANT: If you are starting work on a task (feature, bug fix, refactor, etc.), a Linear ticket ID (e.g. JARVIS-123) must be provided so PRs auto-link and auto-close the issue. If no ticket ID appears in this prompt or earlier in the conversation, ask the user for one before proceeding with implementation."
      }
    }'
    exit 0
  fi
done < "$REMIND_FILE"

exit 0
