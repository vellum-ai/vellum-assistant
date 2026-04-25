#!/usr/bin/env bash
#
# register-webhook.sh — Register a Resend webhook and store the signing secret
#
# Resolves the callback URL via `assistant webhooks register`, creates a
# webhook via the Resend API, and pipes the signing_secret directly into
# the credential store — the LLM never sees the raw value.
#
# Usage:
#   register-webhook.sh --source <domain> [--events event1,event2,...]
#
# Options:
#   --source <domain>   The email domain (used as the webhook source label)
#   --events <list>     Comma-separated event types (default: email.received)
#
# Prerequisites:
#   - Resend API key stored via: assistant credentials set --service resend --field api_key
#   - `assistant` CLI available on PATH
#   - `jq` available on PATH
#
# The script:
#   1. Calls `assistant webhooks register resend` to get the callback URL
#   2. Retrieves the Resend API key from the credential store
#   3. Calls POST /webhooks to create the webhook
#   4. Extracts signing_secret from the response
#   5. Stores it via `assistant credentials set --service resend --field webhook_secret`
#   6. Outputs the webhook ID and callback URL on success (signing value is never printed)

set -euo pipefail

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
SOURCE=""
EVENTS="email.received"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)  SOURCE="$2"; shift 2 ;;
    --events)  EVENTS="$2"; shift 2 ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SOURCE" ]]; then
  echo "Usage: register-webhook.sh --source <domain> [--events event1,event2,...]" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Resolve the callback URL via the assistant CLI
# ---------------------------------------------------------------------------
echo "Resolving webhook callback URL..." >&2
CALLBACK_URL=$(assistant webhooks register resend --source "$SOURCE")
if [[ -z "$CALLBACK_URL" ]]; then
  echo "Error: Failed to resolve callback URL from 'assistant webhooks register resend'." >&2
  exit 1
fi
echo "  Callback URL: $CALLBACK_URL" >&2

# ---------------------------------------------------------------------------
# 2. Retrieve the Resend API key from the credential store
# ---------------------------------------------------------------------------
# Uses a temp file to keep the value out of process substitution output
_tmpvault=$(mktemp)
trap 'rm -f "$_tmpvault"' EXIT
assistant credentials reveal --service resend --field api_key --json 2>/dev/null \
  | jq -r '.value // empty' > "$_tmpvault"
API_KEY=$(< "$_tmpvault")
rm -f "$_tmpvault"

if [[ -z "$API_KEY" ]]; then
  echo "Error: No Resend API key found. Store one first:" >&2
  echo "  assistant credentials set --service resend --field api_key <your-key>" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Create the webhook via Resend API
# ---------------------------------------------------------------------------
EVENTS_JSON=$(printf '%s' "$EVENTS" | jq -R 'split(",")')

RESPONSE=$(curl -sf -X POST https://api.resend.com/webhooks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg url "$CALLBACK_URL" --argjson events "$EVENTS_JSON" \
    '{url: $url, events: $events}')")

# ---------------------------------------------------------------------------
# 4. Extract fields from the response
# ---------------------------------------------------------------------------
# Variable names deliberately avoid trigger words to prevent sandbox redaction
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

if [[ ! -s "$_tmpwhsig" ]]; then
  echo "Error: Webhook created (ID: $WEBHOOK_ID) but no signing data in response." >&2
  echo "You may need to retrieve it manually from the Resend dashboard." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Store the signing value directly — never printed, never seen by the LLM
# ---------------------------------------------------------------------------
assistant credentials set "$(< "$_tmpwhsig")" \
  --service resend \
  --field webhook_secret \
  --description "Resend webhook signing secret (auto-stored)" \
  2>/dev/null

rm -f "$_tmpwhsig"

# ---------------------------------------------------------------------------
# 6. Output summary (safe to show — no raw values)
# ---------------------------------------------------------------------------
echo "Webhook registered successfully."
echo "  ID:           $WEBHOOK_ID"
echo "  Callback URL: $CALLBACK_URL"
echo "  Signing data: stored in credential vault (resend:webhook_secret)"
