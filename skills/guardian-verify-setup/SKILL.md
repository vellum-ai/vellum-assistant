---
name: "Guardian Verify Setup"
description: "Set up guardian verification for SMS, voice, or Telegram channels via outbound verification flow"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udd10"}}
---

You are helping your user set up guardian verification for a messaging channel (SMS, voice, or Telegram). This links their identity as the trusted guardian for the chosen channel. All API calls go through the runtime HTTP API using `curl` with bearer auth.

## Prerequisites

- The runtime HTTP API is available at `http://localhost:7821` (or the configured `RUNTIME_HTTP_PORT`).
- The bearer token is stored at `~/.vellum/http-token`. Read it with: `TOKEN=$(cat ~/.vellum/http-token)`.

## Step 1: Confirm Channel

Ask the user which channel they want to verify:

- **sms** -- verify a phone number for SMS messaging
- **voice** -- verify a phone number for voice calls
- **telegram** -- verify a Telegram account

If the user's intent already specifies a channel (e.g. "verify my phone number for SMS"), skip the prompt and proceed.

## Step 2: Collect Destination

Based on the chosen channel, ask for the required destination:

- **SMS or voice**: Ask for their phone number. Accept any common format (e.g. +15551234567, (555) 123-4567, 555-123-4567). The API normalizes it to E.164.
- **Telegram**: Ask for their Telegram chat ID (numeric) or @handle. Explain:
  - If they know their numeric chat ID, provide it directly. The bot will send the code to that chat.
  - If they only know their @handle, the flow uses a bootstrap deep-link that they must click first.

## Step 3: Start Outbound Verification

Execute the outbound start request:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST http://localhost:7821/v1/integrations/guardian/outbound/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"channel": "<channel>", "destination": "<destination>"}'
```

Replace `<channel>` with `sms`, `voice`, or `telegram`, and `<destination>` with the phone number or Telegram destination.

### On success (`success: true`)

Report the exact next action based on the channel:

- **SMS**: "I've sent a 6-digit verification code to [number]. Reply with the code from that SMS conversation (not here) to complete verification — the code can only be consumed through the SMS channel."
- **Voice**: The response includes a `secret` field with the verification code. Tell the user the code BEFORE the call connects: "I'm calling [number] now. Your verification code is [secret]. When you answer the call, enter this code using your phone's keypad."
- **Telegram with chat ID** (no `telegramBootstrapUrl` in response): "I've sent a verification code to your Telegram. Send the code back to me in the Telegram bot chat to complete verification."
- **Telegram with handle** (`telegramBootstrapUrl` present in response): "Tap this deep-link first: [telegramBootstrapUrl]. After Telegram binds your identity, I'll send your verification code."

After reporting the bootstrap URL for Telegram handle flows, wait for the user to confirm they clicked the link. Then check guardian status (Step 6) to see if the bootstrap completed and a code was sent.

### On error (`success: false`)

Handle each error code:

| Error code | Action |
|---|---|
| `missing_destination` | Ask the user to provide their phone number or Telegram destination. |
| `invalid_destination` | Tell the user the format is invalid. For phone: suggest E.164 format (+15551234567). For Telegram: explain that group chat IDs (negative numbers) are not supported. |
| `already_bound` | Tell the user a guardian is already bound for this channel. Ask if they want to replace it. If yes, re-run the start request with `"rebind": true` added to the JSON body. |
| `pending_bootstrap` | Tell the user there is a pending Telegram bootstrap. They need to click the deep-link first, or cancel and start over. |
| `rate_limited` | Tell the user they have sent too many verification attempts. Ask them to wait and try again later. |
| `no_active_session` | No session is active. Start a new one from Step 3. |
| `unsupported_channel` | Tell the user the channel is not supported. Only sms, voice, and telegram are valid. |
| `no_bot_username` | Telegram bot is not configured. Load and run the `telegram-setup` skill first. |

## Step 4: Handle Resend

If the user says they did not receive the code or asks to resend:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST http://localhost:7821/v1/integrations/guardian/outbound/resend \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"channel": "<channel>"}'
```

On success, tell the user a new code has been sent. On `rate_limited` error, tell them to wait before trying again (the response includes `nextResendAt` as a Unix timestamp). On `pending_bootstrap`, remind them to click the deep-link. On `no_active_session`, start a new session from Step 3.

## Step 5: Handle Cancel

If the user wants to cancel the verification:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST http://localhost:7821/v1/integrations/guardian/outbound/cancel \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"channel": "<channel>"}'
```

Confirm cancellation to the user. On `no_active_session`, tell them there is nothing to cancel.

## Step 6: Check Guardian Status

After the user reports entering the code, verify the binding was created:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s http://localhost:7821/v1/integrations/guardian/status?channel=<channel> \
  -H "Authorization: Bearer $TOKEN"
```

If the response shows the guardian is bound, confirm success: "Guardian verified! Your [channel] identity is now the trusted guardian."

If not yet bound, offer to resend (Step 4) or generate a new session (Step 3).

## Important Notes

- Verification codes expire after 10 minutes. If the session expires, start a new one.
- The resend cooldown is 15 seconds between sends, with a maximum of 5 sends per session.
- Per-destination rate limiting allows up to 10 sends within a 1-hour rolling window.
- Guardian verification is identity-bound: the code can only be consumed by the identity matching the destination provided at start time.
