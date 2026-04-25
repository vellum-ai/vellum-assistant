#!/usr/bin/env bash
#
# register-webhook.sh — Register a Resend webhook and store the signing secret
#
# Creates a webhook via the Resend API and pipes the signing_secret directly
# into the credential store, so the LLM never sees (or gets redacted from
# seeing) the raw secret value.
#
# Usage:
#   register-webhook.sh <webhook_url> [event1,event2,...]
#
# Arguments:
#   webhook_url   The callback URL to register with Resend
#   events        Comma-separated event types (default: email.received)
#
# Prerequisites:
#   - Resend API key stored via: assistant credentials set --service resend --field api_key
#   - `assistant` CLI available on PATH
#   - `jq` available on PATH
#
# The script:
#   1. Retrieves the Resend API key from the credential store
#   2. Calls POST /webhooks to create the webhook
#   3. Extracts signing_secret from the response
#   4. Stores it via `assistant credentials set --service resend --field webhook_secret`
#   5. Outputs the webhook ID on success (signing secret is never printed)

set -euo pipefail

WEBHOOK_URL="${1:?Usage: register-webhook.sh <webhook_url> [events]}"
EVENTS="${2:-email.received}"

# Build the events JSON array from comma-separated input
EVENTS_JSON=$(printf '%s' "$EVENTS" | jq -R 'split(",")')

# Retrieve the API key from the credential store.
# Uses a temp file to avoid VAR=$(...) pattern that triggers sandbox redaction.
_tmpkey=$(mktemp)
trap 'rm -f "$_tmpkey"' EXIT
assistant credentials reveal --service resend --field api_key --json 2>/dev/null \
  | jq -r '.value // empty' > "$_tmpkey"
API_KEY=$(< "$_tmpkey")
rm -f "$_tmpkey"

if [[ -z "$API_KEY" ]]; then
  echo "Error: No Resend API key found. Store one first:" >&2
  echo "  assistant credentials set --service resend --field api_key <your-key>" >&2
  exit 1
fi

# Create the webhook via Resend API
RESPONSE=$(curl -sf -X POST https://api.resend.com/webhooks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg url "$WEBHOOK_URL" --argjson events "$EVENTS_JSON" \
    '{url: $url, events: $events}')")

# Extract fields from the response via temp files (same redaction workaround).
# Note: variable names deliberately avoid "secret"/"key" to prevent sandbox
# redaction from corrupting this file on read/write.
_tmpid=$(mktemp)
_tmpwhsig=$(mktemp)
trap 'rm -f "$_tmpid" "$_tmpwhsig"' EXIT

printf '%s' "$RESPONSE" | jq -r '.id // empty' > "$_tmpid"
printf '%s' "$RESPONSE" | jq -r '.signing_secret // empty' > "$_tmpwhsig"

WEBHOOK_ID=$(< "$_tmpid")
rm -f "$_tmpid"

if [[ -z "$WEBHOOK_ID" ]]; then
  echo "Error: Failed to create webhook. Response:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

# Read the webhook signing value from the temp file
WHSIG_FILE="$_tmpwhsig"
if [[ ! -s "$WHSIG_FILE" ]]; then
  echo "Error: Webhook created (ID: $WEBHOOK_ID) but no signing data in response." >&2
  echo "You may need to retrieve it manually from the Resend dashboard." >&2
  exit 1
fi

# Store the signing value directly — never printed, never seen by the LLM.
# Read from file and pass as argument to avoid the value appearing in process output.
assistant credentials set "$(< "$WHSIG_FILE")" \
  --service resend \
  --field webhook_secret \
  --description "Resend webhook signing secret (auto-stored)" \
  2>/dev/null

rm -f "$WHSIG_FILE"

# Output only the webhook ID (safe to show)
echo "Webhook registered successfully."
echo "  ID: $WEBHOOK_ID"
echo "  Signing secret: stored in credential vault (resend:webhook_secret)"
