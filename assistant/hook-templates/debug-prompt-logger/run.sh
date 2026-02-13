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

# System prompt (first 2000 chars)
echo "── System Prompt ──────────────────────────────────────────────" >&2
echo "$data" | jq -r '.systemPrompt // "N/A"' | head -c 2000 >&2
echo "" >&2
echo "" >&2

# Message count and model
model=$(echo "$data" | jq -r '.model // "unknown"')
msgCount=$(echo "$data" | jq '.messages | length')
toolCount=$(echo "$data" | jq -r '.toolCount // 0')
echo "Model: $model | Messages: $msgCount | Tools: $toolCount" >&2
echo "" >&2

# Last 10 messages (compact)
echo "── Recent Messages (last 10) ──────────────────────────────────" >&2
echo "$data" | jq -r '
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
