---
name: "Guardian Verify Setup"
description: "Set up guardian verification for SMS, voice, or Telegram channels via outbound verification flow"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udd10"}}
---

You are helping your user set up guardian verification for a messaging channel (SMS, voice, or Telegram). This links their identity as the trusted guardian for the chosen channel. All API calls go through the gateway HTTP API using `curl` with bearer auth.

## Prerequisites

- Use the injected `INTERNAL_GATEWAY_BASE_URL` for gateway API calls in this skill. Do not hardcode hosts or ports.
- Never call the daemon runtime port directly; always call the gateway URL.
- The bearer token is stored at `~/.vellum/http-token`. Read it with: `TOKEN=$(cat ~/.vellum/http-token)`.
- Run shell commands for this skill with `host_bash` (not sandbox `bash`) so host auth/token and gateway routing are reliable.
- Keep narration minimal: execute required calls first, then provide a concise status update. Do not narrate internal install/check/load chatter unless something fails.

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
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/guardian/outbound/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"channel": "<channel>", "destination": "<destination>"}'
```

Replace `<channel>` with `sms`, `voice`, or `telegram`, and `<destination>` with the phone number or Telegram destination.

### On success (`success: true`)

Report the exact next action based on the channel:

- **SMS**: "I've sent a 6-digit verification code to [number]. Reply with the code from that SMS conversation (not here) to complete verification — the code can only be consumed through the SMS channel."
- **Voice**: The response includes a `secret` field with the verification code. Tell the user the code BEFORE the call connects: "I'm calling [number] now. Your verification code is [secret]. When you answer the call, enter this code using your phone's keypad." The `/outbound/start` API call already initiates the voice call. Do NOT place a separate `call_start` call. **After delivering the code, immediately begin the voice auto-check polling loop** (see [Voice Auto-Check Polling](#voice-auto-check-polling) below).
- **Telegram with chat ID** (no `telegramBootstrapUrl` in response): The response includes a `secret` field. Show it in the current chat: "Your verification code is **[secret]**. I've also sent it to your Telegram. Open the Telegram bot chat and reply with that 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3 or resend (Step 4).
- **Telegram with handle** (`telegramBootstrapUrl` present in response): "Tap this deep-link first: [telegramBootstrapUrl]. After Telegram binds your identity, I'll send your verification code."

After reporting the bootstrap URL for Telegram handle flows, wait for the user to confirm they clicked the link. Then check guardian status (Step 6) to see if the bootstrap completed and a code was sent.

### On error (`success: false`)

Handle each error code:

| Error code | Action |
|---|---|
| `missing_destination` | Ask the user to provide their phone number or Telegram destination. |
| `invalid_destination` | Tell the user the format is invalid. For phone: suggest E.164 format (+15551234567). For Telegram: explain that group chat IDs (negative numbers) are not supported. |
| `already_bound` | Tell the user a guardian is already bound for this channel. Ask if they want to replace it. If yes, re-run the start request with `"rebind": true` added to the JSON body. |
| `rate_limited` | Tell the user they have sent too many verification attempts to this destination. Ask them to wait and try again later. |
| `unsupported_channel` | Tell the user the channel is not supported. Only sms, voice, and telegram are valid. |
| `no_bot_username` | Telegram bot is not configured. Load and run the `telegram-setup` skill first. |

## Step 4: Handle Resend

If the user says they did not receive the code or asks to resend:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/guardian/outbound/resend" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"channel": "<channel>"}'
```

On success, report the next action based on the channel:

- **SMS**: "I've sent a new verification code to [number]. Reply with the code from that SMS conversation to complete verification."
- **Voice**: The resend response includes a fresh `secret` field with a new verification code. Tell the user the new code BEFORE the call connects — just like the initial start flow: "I'm calling [number] again. Your new verification code is [secret]. When you answer the call, enter this code using your phone's keypad." The `/outbound/resend` API call already initiates the voice call. Do NOT place a separate `call_start` call. **After delivering the code, immediately begin the voice auto-check polling loop** (see [Voice Auto-Check Polling](#voice-auto-check-polling) below).
- **Telegram**: The resend response includes a fresh `secret` field. Show the new code in the current chat: "Your new verification code is **[secret]**. I've also sent it to your Telegram. Open the Telegram bot chat and reply with that 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3.

### Resend errors

Handle each error code from the resend endpoint:

| Error code | Action |
|---|---|
| `rate_limited` | Tell the user to wait before trying again (the cooldown is 15 seconds between resends). |
| `max_sends_exceeded` | Tell the user they have reached the maximum number of resends for this session (5 sends per session). Suggest canceling the current session (Step 5) and starting a new verification from Step 3. |
| `no_destination` | This should not normally occur during resend. Tell the user to cancel (Step 5) and restart verification from scratch at Step 3. |
| `pending_bootstrap` | Remind the user to click the Telegram deep-link first before a code can be sent. |
| `no_active_session` | No session is active. Start a new one from Step 3. |

## Step 5: Handle Cancel

If the user wants to cancel the verification:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/guardian/outbound/cancel" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"channel": "<channel>"}'
```

Confirm cancellation to the user. On `no_active_session`, tell them there is nothing to cancel.

## Voice Auto-Check Polling

For **voice** verification only: after telling the user their code and instructing keypad entry (in Step 3 or Step 4), do NOT wait for the user to report back. Instead, proactively poll for completion so the user gets instant confirmation without having to ask "did it work?"

**Polling procedure:**

1. Wait ~15 seconds after delivering the code (to give the user time to answer the call and enter the code).
2. Check the binding status:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/guardian/status?channel=voice" \
  -H "Authorization: Bearer $TOKEN"
```

3. If the response shows `bound: true`: immediately send a proactive success message in the current chat — "Voice verification complete! Your phone number is now the trusted guardian." Stop polling.
4. If not yet bound: wait ~15 seconds and poll again.
5. Continue polling for up to **2 minutes** (approximately 8 attempts).
6. If the 2-minute timeout is reached without `bound: true`: proactively tell the user — "I've been checking for about 2 minutes but verification hasn't completed yet. The code may have expired or wasn't entered. Would you like me to resend a new code (Step 4) or start a new session (Step 3)?"

**Rebind guard:**
When in a **rebind flow** (i.e., the `start_outbound` request included `"rebind": true` because a binding already existed), do NOT treat the first `bound: true` poll result as success. The pre-existing binding will already show `bound: true` before the user has entered the new code, which would be a false positive. To guard against this:
- Note the `bound_at` timestamp from the **first** poll response as a baseline.
- Only report success when a subsequent poll shows `bound: true` with a `bound_at` timestamp **strictly newer** than the baseline. This proves the new outbound session was consumed.
- If the status endpoint does not include `bound_at`, fall back to skipping the first poll result entirely and only start evaluating `bound: true` from the **second poll onward** (giving the user time to enter the new code).
- Non-rebind flows (fresh verification with no prior binding) are unaffected — the first `bound: true` is trustworthy.

**Important polling rules:**
- This polling loop is voice-only. Do NOT poll for SMS or Telegram channels (SMS codes are entered through the SMS channel itself; Telegram has its own bot-driven flow).
- Do NOT require the user to ask "did it work?" — the whole point is proactive confirmation.
- If the user sends a message while polling is in progress, handle their message normally. If their message is about verification status, the next poll iteration will provide the answer.

## Step 6: Check Guardian Status

After the user reports entering the code, verify the binding was created:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/guardian/status?channel=<channel>" \
  -H "Authorization: Bearer $TOKEN"
```

If the response shows the guardian is bound, confirm success: "Guardian verified! Your [channel] identity is now the trusted guardian."

If not yet bound, offer to resend (Step 4) or generate a new session (Step 3).

## Important Notes

- Verification codes expire after 10 minutes. If the session expires, start a new one.
- The resend cooldown is 15 seconds between sends, with a maximum of 5 sends per session.
- Per-destination rate limiting allows up to 10 sends within a 1-hour rolling window.
- Guardian verification is identity-bound: the code can only be consumed by the identity matching the destination provided at start time.
- **Missing `secret` guardrail**: For voice and Telegram chat-ID flows, the API response MUST include a `secret` field. If `secret` is unexpectedly absent from a start or resend response that otherwise indicates success, treat this as a control-plane error. Do NOT fabricate a code or tell the user to proceed without one. Instead, tell the user something went wrong and ask them to retry the start (Step 3) or resend (Step 4).
