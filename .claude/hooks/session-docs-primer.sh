#!/bin/bash
# At session start, surface the repo's convention index (every AGENTS.md /
# CLAUDE.md) and direct the agent to read a package's governing docs before
# editing its code. Runs once per session, not per edit. Skips vendored and
# generated trees.

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$project_dir" 2>/dev/null || exit 0

# Bash 3.2 (macOS /bin/bash) has no mapfile/readarray; collect with a read loop.
index=()
while IFS= read -r entry; do
  [ -n "$entry" ] && index+=("$entry")
done < <(
  find . \
    \( -path '*/node_modules' -o -path '*/.git' -o -name worktrees -o -name '.worktrees' -o -name '*-worktrees' -o -name generated -o -name dist -o -name build \) -prune -o \
    \( -name AGENTS.md -o -name CLAUDE.md \) -print 2>/dev/null |
    sed 's|^\./||' | sort
)

[ "${#index[@]}" -gt 0 ] || exit 0

list=$(printf '  - %s\n' "${index[@]}")

msg=$(
  cat <<EOF
Repo conventions live in nested AGENTS.md / CLAUDE.md files and per-package docs/ folders. Before editing code in an area, read its governing docs FIRST and follow the closest, most specific one when rules conflict:
  1. the repo-root AGENTS.md,
  2. the nearest AGENTS.md / CLAUDE.md at or above the file you are editing,
  3. the docs/*.md beside that nearest file (e.g. clients/web/docs/CONVENTIONS.md and clients/web/docs/STYLE_GUIDE.md for web code).
Convention index for this repo:
${list}
EOF
)

jq -n --arg ctx "$msg" '{
  "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": $ctx }
}'
exit 0
