#!/bin/bash
# Inject a Linear ticket reminder for specific team members.
# Users NOT in the remind list see nothing added to context.
#
# Matches against git user.name (from `git config user.name`).
# To find a teammate's name: git log --format='%an' --author=Name | sort -u

REMIND_NAMES=(
  "Vincent"
  "Harrison Ngo"
  "NgoHarrison"
  "Alex Nork"
)

CURRENT_NAME=$(git config user.name 2>/dev/null || echo "")

for n in "${REMIND_NAMES[@]}"; do
  if [[ "$CURRENT_NAME" == "$n" ]]; then
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
