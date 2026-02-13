#!/usr/bin/env bash
# Debug Prompt Logger — prints the system prompt and conversation
# history before each LLM call. Only active when VELLUM_DEBUG=1.

[ "$VELLUM_DEBUG" != "1" ] && exit 0

data=$(cat)

echo "" >&2
echo "════════════════════════════════════════════════════════════════" >&2
echo "  PRE-LLM-CALL" >&2
echo "════════════════════════════════════════════════════════════════" >&2
echo "" >&2

if ! command -v jq >/dev/null 2>&1; then
  echo "(jq not found — install jq for formatted output)" >&2
  printf '%s' "$data" | dd bs=3000 count=1 >&2 2>/dev/null
  echo "" >&2
  echo "════════════════════════════════════════════════════════════════" >&2
  echo "" >&2
  exit 0
fi

# System prompt (first 2000 chars)
echo "── System Prompt ──────────────────────────────────────────────" >&2
printf '%s' "$data" | jq -r '.systemPrompt // "N/A"' | dd bs=2000 count=1 >&2 2>/dev/null
echo "" >&2
echo "" >&2

# Message count and model
model=$(printf '%s' "$data" | jq -r '.model // "unknown"')
msgCount=$(printf '%s' "$data" | jq '.messages | length')
toolCount=$(printf '%s' "$data" | jq -r '.toolCount // 0')
echo "Model: $model | Messages: $msgCount | Tools: $toolCount" >&2
echo "" >&2

# Last 10 messages (compact)
echo "── Recent Messages (last 10) ──────────────────────────────────" >&2
printf '%s' "$data" | jq -r '
  .messages[-10:][] |
  "\(.role): " + (
    if (.content | type) == "string" then
      .content[:200]
    elif (.content | type) == "array" then
      [.content[] |
        if .type == "text" then .text[:200]
        elif .type == "tool_use" then "[tool_use: \(.name)]"
        elif .type == "tool_result" then "[tool_result: \(.content // "" | tostring | .[:100])]"
        else "[" + .type + "]"
        end
      ] | join(" | ")
    else
      "(empty)"
    end
  )
' >&2
echo "" >&2
echo "════════════════════════════════════════════════════════════════" >&2
echo "" >&2
