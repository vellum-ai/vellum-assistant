#!/bin/bash
# Inject a Linear ticket reminder for specific team members.
# Users NOT in the remind list see nothing added to context.
#
# Uses GitHub usernames (already public in CODEOWNERS) matched against
# the git email's noreply pattern or the committer name.
# To find a teammate's GitHub username: check CODEOWNERS

REMIND_USERS=(
  "vincent0426"
  "NgoHarrison"
  "alex-nork"
)

CURRENT_EMAIL=$(git config user.email 2>/dev/null || echo "")
CURRENT_NAME=$(git config user.name 2>/dev/null || echo "")

for u in "${REMIND_USERS[@]}"; do
  if [[ "$CURRENT_EMAIL" == *"$u"* || "$CURRENT_NAME" == "$u" ]]; then
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
