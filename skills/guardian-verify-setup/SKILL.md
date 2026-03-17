---
name: guardian-verify-setup
description: Set up channel verification for phone, Telegram, or Slack channels via outbound verification flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔐"
  vellum:
    display-name: "Guardian Verify Setup"
    activation-hints:
      - "Any guardian verification intent -> load this skill exclusively"
      - '"help me set myself up as your guardian" = verification request'
    avoid-when:
      - "Don't load phone-calls for verification intents"
      - "If the user already specified a channel, do not re-ask"
---

You are helping your user set up channel verification for a messaging channel (phone, Telegram, or Slack). This links their identity as the trusted guardian for the chosen channel. Use the `assistant channel-verification-sessions` CLI for all verification operations.

## Prerequisites

- Run shell commands for this skill with `bash`.
- Keep narration minimal: execute required calls first, then provide a concise status update. Do not narrate internal install/check/load chatter unless something fails.

## Step 1: Confirm Channel

Ask the user which channel they want to verify:

- **phone** -- verify a phone number for voice calls
- **telegram** -- verify a Telegram account
- **slack** -- verify a Slack account

If the user's intent already specifies a channel (e.g. "verify my phone number for voice calls", "verify me on Slack"), skip the prompt and proceed.

## Step 2: Collect Destination

Based on the chosen channel, ask for the required destination:

- **Phone**: Ask for their phone number. Accept any common format (e.g. +15551234567, (555) 123-4567, 555-123-4567). The API normalizes it to E.164.
- **Telegram**: Ask for their Telegram chat ID (numeric) or @handle. Explain:
  - If they know their numeric chat ID, provide it directly. The bot will send the code to that chat.
  - If they only know their @handle, the flow uses a bootstrap deep-link that they must click first.
- **Slack**: Ask for their Slack user ID. Explain that this is their Slack member ID (e.g. U01ABCDEF), not their display name or email. They can find it in their Slack profile under "More" > "Copy member ID". The bot will send a verification code via Slack DM.

## Step 3: Start Outbound Verification

Execute the outbound start request:

```bash
assistant channel-verification-sessions create --channel <channel> --destination "<destination>" --json
```

Replace `<channel>` with `phone`, `telegram`, or `slack`, and `<destination>` with the phone number, Telegram destination, or Slack user ID.

### On success (`success: true`)

Report the exact next action based on the channel:

- **Phone**: The response includes a `secret` field with the verification code. Tell the user the code BEFORE the call connects: "I'm calling [number] now. Your verification code is [secret]. When you answer the call, enter this code using your phone's keypad." The `create` command already initiates the voice call. Do NOT place a separate `call_start` call. **After delivering the code, immediately begin the voice auto-check polling loop** (see [Voice Auto-Check Polling](#voice-auto-check-polling) below).
- **Telegram with chat ID** (no `telegramBootstrapUrl` in response): The response includes a `secret` field. Show it in the current chat: "Your verification code is **[secret]**. I've also sent it to your Telegram. Open the Telegram bot chat and reply with that 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3 or resend (Step 4).
- **Telegram with handle** (`telegramBootstrapUrl` present in response): "Tap this deep-link first: [telegramBootstrapUrl]. After Telegram binds your identity, I'll send your verification code."
- **Slack**: The response includes a `secret` field with the verification code. Show it in the current chat: "Your verification code is **[secret]**. I've also sent it to you as a Slack DM. Open the DM from the Vellum bot in Slack and reply with that 6-digit code to complete verification." The DM channel ID is captured automatically during this process for future message delivery. If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3 or resend (Step 4). **After delivering the code, immediately begin the Slack auto-check polling loop** (see [Slack Auto-Check Polling](#slack-auto-check-polling) below).

After reporting the bootstrap URL for Telegram handle flows, wait for the user to confirm they clicked the link. Then check verification status (Step 6) to see if the bootstrap completed and a code was sent.

### On error (`success: false`)

Handle each error code:

| Error code            | Action                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_destination` | Ask the user to provide their phone number, Telegram destination, or Slack user ID.                                                                                                                                                                |
| `invalid_destination` | Tell the user the format is invalid. For phone: suggest E.164 format (+15551234567). For Telegram: explain that group chat IDs (negative numbers) are not supported. For Slack: explain that the value must be a Slack member ID (e.g. U01ABCDEF). |
| `already_bound`       | Tell the user a guardian is already bound for this channel. Ask if they want to replace it. If yes, re-run the create command with `--rebind` added.                                                                                               |
| `rate_limited`        | Tell the user they have sent too many verification attempts to this destination. Ask them to wait and try again later.                                                                                                                             |
| `unsupported_channel` | Tell the user the channel is not supported. Only phone, telegram, and slack are valid.                                                                                                                                                             |
| `no_bot_username`     | Telegram bot is not configured. Load and run the `telegram-setup` skill first.                                                                                                                                                                     |

## Step 4: Handle Resend

If the user says they did not receive the code or asks to resend:

```bash
assistant channel-verification-sessions resend --channel <channel> --json
```

On success, report the next action based on the channel:

- **Phone**: The resend response includes a fresh `secret` field with a new verification code. Tell the user the new code BEFORE the call connects - just like the initial start flow: "I'm calling [number] again. Your new verification code is [secret]. When you answer the call, enter this code using your phone's keypad." The `resend` command already initiates the voice call. Do NOT place a separate `call_start` call. **After delivering the code, immediately begin the voice auto-check polling loop** (see [Voice Auto-Check Polling](#voice-auto-check-polling) below).
- **Telegram**: The resend response includes a fresh `secret` field. Show the new code in the current chat: "Your new verification code is **[secret]**. I've also sent it to your Telegram. Open the Telegram bot chat and reply with that 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3.
- **Slack**: The resend response includes a fresh `secret` field. Show the new code in the current chat: "Your new verification code is **[secret]**. I've also sent it to you as a Slack DM. Reply to the DM with that 6-digit code to complete verification. (resent)" If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3. **After delivering the code, immediately begin the Slack auto-check polling loop** (see [Slack Auto-Check Polling](#slack-auto-check-polling) below).

### Resend errors

Handle each error code from the resend endpoint:

| Error code           | Action                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rate_limited`       | Tell the user to wait before trying again (the cooldown is 15 seconds between resends).                                                                                                           |
| `max_sends_exceeded` | Tell the user they have reached the maximum number of resends for this session (5 sends per session). Suggest canceling the current session (Step 5) and starting a new verification from Step 3. |
| `no_destination`     | This should not normally occur during resend. Tell the user to cancel (Step 5) and restart verification from scratch at Step 3.                                                                   |
| `pending_bootstrap`  | Remind the user to click the Telegram deep-link first before a code can be sent.                                                                                                                  |
| `no_active_session`  | No session is active. Start a new one from Step 3.                                                                                                                                                |

## Step 5: Handle Cancel

If the user wants to cancel the verification:

```bash
assistant channel-verification-sessions cancel --channel <channel> --json
```

Confirm cancellation to the user. On `no_active_session`, tell them there is nothing to cancel.

## Voice Auto-Check Polling

For **voice** verification only: after telling the user their code and instructing keypad entry (in Step 3 or Step 4), do NOT wait for the user to report back. Instead, proactively poll for completion so the user gets instant confirmation without having to ask "did it work?"

**Polling procedure:**

1. Wait ~15 seconds after delivering the code (to give the user time to answer the call and enter the code).
2. Check the binding status via Vellum CLI:

```bash
assistant channel-verification-sessions status --channel phone --json
```

3. If the response shows `bound: true`: immediately send a proactive success message in the current chat - "Voice verification complete! Your phone number is now the trusted guardian." Stop polling.
4. If not yet bound: wait ~15 seconds and poll again.
5. Continue polling for up to **2 minutes** (approximately 8 attempts).
6. If the 2-minute timeout is reached without `bound: true`: proactively tell the user - "I've been checking for about 2 minutes but verification hasn't completed yet. The code may have expired or wasn't entered. Would you like me to resend a new code (Step 4) or start a new session (Step 3)?"

**Rebind guard:**
When in a **rebind flow** (i.e., the session creation request included `"rebind": true` because a binding already existed), do NOT treat `bound: true` alone as success. The pre-existing binding will show `bound: true` before the user has entered the new code, which would be a false positive. To guard against this:

- Only report success when BOTH conditions are met: `bound: true` AND `verificationSessionId` is **absent** from the status response. The `verificationSessionId` field is present while a verification session is still active (pending). When the user enters the correct code, the session is consumed and `verificationSessionId` disappears from subsequent status responses. This proves the new outbound session was consumed and the binding is fresh.
- If a poll shows `bound: true` but `verificationSessionId` is still present, the old binding is still active and the new code has not yet been consumed - continue polling.
- Non-rebind flows (fresh verification with no prior binding) are unaffected - the first `bound: true` is trustworthy because there was no prior binding to confuse the result.

**Important polling rules:**

- This polling loop is voice-only. Do NOT poll for Telegram channels (Telegram has its own bot-driven flow). For Slack, use the separate Slack Auto-Check Polling loop below.
- Do NOT require the user to ask "did it work?" - the whole point is proactive confirmation.
- If the user sends a message while polling is in progress, handle their message normally. If their message is about verification status, the next poll iteration will provide the answer.

## Slack Auto-Check Polling

For **Slack** verification: after telling the user their code and instructing them to reply in the Slack DM (in Step 3 or Step 4), proactively poll for completion so the user gets instant confirmation.

**Polling procedure:**

1. Wait ~15 seconds after delivering the code (to give the user time to open the Slack DM and reply with the code).
2. Check the binding status via Vellum CLI:

```bash
assistant channel-verification-sessions status --channel slack --json
```

3. If the response shows `bound: true`: immediately send a proactive success message in the current chat - "Slack verification complete! Your Slack account is now the trusted guardian. The DM channel has been captured for future message delivery." Stop polling.
4. If not yet bound: wait ~15 seconds and poll again.
5. Continue polling for up to **2 minutes** (approximately 8 attempts).
6. If the 2-minute timeout is reached without `bound: true`: proactively tell the user - "I've been checking for about 2 minutes but verification hasn't completed yet. The code may have expired or wasn't entered. Would you like me to resend a new code (Step 4) or start a new session (Step 3)?"

**Rebind guard:**
When in a **rebind flow** (i.e., the session creation request included `"rebind": true` because a binding already existed), do NOT treat `bound: true` alone as success. The pre-existing binding will show `bound: true` before the user has entered the new code, which would be a false positive. To guard against this:

- Only report success when BOTH conditions are met: `bound: true` AND `verificationSessionId` is **absent** from the status response. The `verificationSessionId` field is present while a verification session is still active (pending). When the user enters the correct code, the session is consumed and `verificationSessionId` disappears from subsequent status responses. This proves the new outbound session was consumed and the binding is fresh.
- If a poll shows `bound: true` but `verificationSessionId` is still present, the old binding is still active and the new code has not yet been consumed - continue polling.
- Non-rebind flows (fresh verification with no prior binding) are unaffected - the first `bound: true` is trustworthy because there was no prior binding to confuse the result.

**Important polling rules:**

- Do NOT require the user to ask "did it work?" - the whole point is proactive confirmation.
- If the user sends a message while polling is in progress, handle their message normally.

## Step 6: Check Verification Status

After the user reports entering the code, verify the binding was created:

```bash
CHANNEL="<channel>"
assistant channel-verification-sessions status --channel "$CHANNEL" --json
```

If the response shows the channel is bound, confirm success: "Verification complete! Your [channel] identity is now the trusted guardian."

If not yet bound, offer to resend (Step 4) or generate a new session (Step 3).

## Step 7: Revoke Guardian Binding

If the user wants to remove themselves (or the current guardian) from a channel, use the revoke endpoint:

```bash
assistant channel-verification-sessions revoke --channel <channel> --json
```

Replace `<channel>` with the channel to unbind from (e.g. `phone`, `telegram`, `slack`).

### On success (`success: true`)

The response includes `bound: false` after the operation completes. Check the previous binding state to tailor the message:

- If a binding was previously active (i.e., the user explicitly asked to revoke their guardian): "Guardian binding revoked for [channel]. The previous guardian no longer has access to this channel."
- If no binding existed (`bound: false` and there was nothing to revoke): "There is no active guardian binding for [channel] - nothing to revoke. Any pending verification challenges have been cleared."

## Important Notes

- Verification codes expire after 10 minutes. If the session expires, start a new one.
- The resend cooldown is 15 seconds between sends, with a maximum of 5 sends per session.
- Per-destination rate limiting allows up to 10 sends within a 1-hour rolling window.
- Channel verification is identity-bound: the code can only be consumed by the identity matching the destination provided at start time.
- **Missing `secret` guardrail**: For voice, Telegram chat-ID, and Slack flows, the API response MUST include a `secret` field. If `secret` is unexpectedly absent from a start or resend response that otherwise indicates success, treat this as a control-plane error. Do NOT fabricate a code or tell the user to proceed without one. Instead, tell the user something went wrong and ask them to retry the start (Step 3) or resend (Step 4).
- **Revoking a guardian**: To remove the current guardian from a channel, use the revoke API (Step 7). This revokes the binding AND revokes the guardian's contact record, so they lose access to the channel. A new guardian can then be verified for that channel.
