#!/usr/bin/env bash
# Debug Prompt Logger — prints the system prompt and conversation
# history before each LLM call. Runs whenever the hook is installed.

data=$(cat)

echo "" >&2
echo "════════════════════════════════════════════════════════════════" >&2
echo "  PRE-LLM-CALL" >&2
echo "════════════════════════════════════════════════════════════════" >&2
echo "" >&2

# Total output cap (bytes) — prevents unbounded stderr when jq is missing.
MAX_OUTPUT=200000

if ! command -v jq >/dev/null 2>&1; then
  echo "(jq not found — install jq for formatted output)" >&2
  printf '%s' "$data" | head -c "$MAX_OUTPUT" >&2
  echo "" >&2
  echo "════════════════════════════════════════════════════════════════" >&2
  echo "" >&2
  exit 0
fi

# System prompt (capped at 5000 chars to avoid flooding stderr)
echo "── System Prompt ──────────────────────────────────────────────" >&2
printf '%s' "$data" | jq -r '.systemPrompt // "N/A" | if length > 5000 then .[:5000] + "\n…[truncated]" else . end' >&2
echo "" >&2
echo "" >&2

# Message count and model
model=$(printf '%s' "$data" | jq -r '.model // "unknown"')
msgCount=$(printf '%s' "$data" | jq '.messages | length')
toolCount=$(printf '%s' "$data" | jq -r '.toolCount // 0')
echo "Model: $model | Messages: $msgCount | Tools: $toolCount" >&2
echo "" >&2

# All messages — truncate per-field to keep output bounded.
# Max chars per text/tool field (images/files already capped at 1000).
MAX_FIELD=2000

echo "── Messages ───────────────────────────────────────────────────" >&2
printf '%s' "$data" | jq -r --argjson maxf "$MAX_FIELD" '
  def trunc(n): if length > n then .[:n] + "…[truncated]" else . end;
  .messages[] |
  "\(.role): " + (
    if (.content | type) == "string" then
      .content | trunc($maxf)
    elif (.content | type) == "array" then
      [.content[] |
        if .type == "text" then (.text | trunc($maxf))
        elif .type == "image" then "[image: \(.source.media_type // "unknown")] \(.source.data[:1000])..."
        elif .type == "file" then "[file: \(.source.filename // "unknown")] \(.source.data[:1000])..."
        elif .type == "tool_use" then "[tool_use: \(.name)] \(.input | tostring | trunc($maxf))"
        elif .type == "tool_result" then "[tool_result: \(.content // "" | tostring | trunc($maxf))]"
        else "[" + .type + "] " + (. | tostring | trunc($maxf))
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
