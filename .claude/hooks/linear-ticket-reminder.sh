#!/bin/bash
# Inject a Linear ticket reminder for specific team members.
# Users NOT in the remind list see nothing added to context.
#
# Maintain REMIND_EMAILS below — use git email addresses.
# To find a teammate's git email: git log --format='%ae' --author=Name | sort -u

REMIND_EMAILS=(
  "vincent@vellum.ai"
  "0426vincent@gmail.com"
  "harrison@vellum.ai"
  "harrison.ngo719@gmail.com"
  "48630278+alex-nork@users.noreply.github.com"
  "alexnork@gmail.com"
)

CURRENT_EMAIL=$(git config user.email 2>/dev/null || echo "")

for e in "${REMIND_EMAILS[@]}"; do
  if [[ "$CURRENT_EMAIL" == "$e" ]]; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "IMPORTANT: If you are starting work on a task (feature, bug fix, refactor, etc.), a Linear ticket ID (e.g. JARVIS-123) must be provided so PRs auto-link and auto-close the issue. If no ticket ID appears in this prompt or earlier in the conversation, ask the user for one before proceeding with implementation."
      }
    }'
    exit 0
  fi
done

exit 0
