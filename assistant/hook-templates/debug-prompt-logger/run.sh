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
  printf '%s' "$data" >&2
  echo "" >&2
  echo "════════════════════════════════════════════════════════════════" >&2
  echo "" >&2
  exit 0
fi

# System prompt
echo "── System Prompt ──────────────────────────────────────────────" >&2
printf '%s' "$data" | jq -r '.systemPrompt // "N/A"' >&2
echo "" >&2
echo "" >&2

# Message count and model
model=$(printf '%s' "$data" | jq -r '.model // "unknown"')
msgCount=$(printf '%s' "$data" | jq '.messages | length')
toolCount=$(printf '%s' "$data" | jq -r '.toolCount // 0')
echo "Model: $model | Messages: $msgCount | Tools: $toolCount" >&2
echo "" >&2

# All messages
echo "── Messages ───────────────────────────────────────────────────" >&2
printf '%s' "$data" | jq -r '
  .messages[] |
  "\(.role): " + (
    if (.content | type) == "string" then
      .content
    elif (.content | type) == "array" then
      [.content[] |
        if .type == "text" then .text
        elif .type == "tool_use" then "[tool_use: \(.name)] \(.input | tostring)"
        elif .type == "tool_result" then "[tool_result: \(.content // "" | tostring)]"
        else "[" + .type + "] " + (. | tostring)
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
