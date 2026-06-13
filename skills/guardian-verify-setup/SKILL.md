---
name: guardian-verify-setup
description: Set up channel verification for phone, Telegram, Slack, or email channels via outbound verification flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔐"
  vellum:
    category: "integrations"
    display-name: "Guardian Verify Setup"
    activation-hints:
      - "Any guardian verification intent -> load this skill exclusively"
      - '"help me verify my identity" = verification request'
    avoid-when:
      - "Don't load phone-calls for verification intents"
      - "If the user already specified a channel, do not re-ask"
---

You are helping your user set up channel verification for a messaging channel (phone, Telegram, Slack, or email). This links their identity for verified message delivery on the chosen channel. Use the `assistant channel-verification-sessions` CLI for all verification operations.

## When to Use

Load this skill when:

- The user says "verify me", "verify my identity", "set up verification", "verify my [phone/telegram/slack/email]", or any equivalent identity-handshake intent.
- Another skill is wiring up a channel and needs to bind the guardian's identity to it (e.g., `slack-app-setup` invokes this skill at the end of Slack setup so the user can prove ownership of the configured workspace).

Do not load this skill for:

- Generic "set up X" intents where X is not a guardian channel (use the channel-specific setup skill instead).
- Phone-CALLS intent (use the phone-calls skill — those are outbound calls the assistant makes, not verification handshakes).

## Prerequisites

- Run shell commands for this skill with `bash`.
- Keep narration minimal: execute required calls first, then provide a concise status update. Do not narrate internal install/check/load chatter unless something fails.

## Step 1: Confirm Channel

Ask the user which channel they want to verify:

- **phone** -- verify a phone number for voice calls
- **telegram** -- verify a Telegram account
- **slack** -- verify a Slack account
- **email** -- verify an email address

**Skip the prompt and proceed directly with the named channel when:**

- The user's intent already specifies a channel (e.g. "verify my phone number for voice calls", "verify me on Slack").
- This skill is loaded from another skill that has already established the channel (e.g., `slack-app-setup` finishes configuring Slack then loads this skill — `slack` is already the channel; do not re-prompt the user for which channel after they just spent the prior steps configuring one).

⚠️ CRITICAL — point of action: **Do not re-prompt for channel when it is already determined.** Re-prompting after a parent skill has just configured a channel makes the user feel like the assistant forgot the previous five minutes of setup.

## Step 2: Collect Destination

Based on the chosen channel, ask for the required destination:

- **Phone**: Ask for their phone number. Accept any common format (e.g. +15551234567, (555) 123-4567, 555-123-4567). The API normalizes it to E.164.
- **Email**: Ask for their email address. The bot will send a verification code to that address.
- **Telegram**: Ask for their Telegram chat ID (numeric) or @handle. Explain:
  - If they know their numeric chat ID, provide it directly. The bot will send the code to that chat.
  - If they only know their @handle, the flow uses a bootstrap deep-link that they must click first.
- **Slack**: Offer to look up the user's Slack member ID automatically to reduce friction:
  1. **Auto-lookup (preferred)**: Ask the user for their Slack display name or @handle, then look up their member ID using the Slack API.

     Set `USER_QUERY` to whatever the user gave you (display name, @handle, or full name — the search matches against all of them). For example, if the user says "find me, I'm @alice", set `USER_QUERY="alice"`. If they say "Alice Example", set `USER_QUERY="Alice Example"`. **Do not leave `USER_QUERY` as a literal `<...>` placeholder string.**

     ```bash
     USER_QUERY="alice"  # ← replace with the actual value the user provided
     USER_QUERY="${USER_QUERY#@}"  # strip leading @ — Slack .name fields have no @ prefix

     # Get the bot token from the credential store
     BOT_TOKEN=$(assistant credentials reveal --service slack_channel --field bot_token)
     if [ -z "$BOT_TOKEN" ]; then
       echo "ERROR: bot_token not found in credential store — fall back to manual entry"
       exit 1
     fi

     # Search for matching users (paginate through all workspace members)
     CURSOR=""
     MATCHES="[]"
     while true; do
       RESPONSE=$(curl -s -H "Authorization: Bearer $BOT_TOKEN" \
         "https://slack.com/api/users.list?limit=200${CURSOR:+&cursor=$CURSOR}")
       PAGE_MATCHES=$(echo "$RESPONSE" | jq --arg q "$USER_QUERY" '[.members[] | select(.deleted == false) | select(.profile.display_name == $q or .name == $q or .profile.display_name_normalized == $q or .real_name == $q) | {id: .id, name: .name, display_name: .profile.display_name, real_name: .real_name}]')
       MATCHES=$(echo "$MATCHES $PAGE_MATCHES" | jq -s 'add')
       CURSOR=$(echo "$RESPONSE" | jq -r '.response_metadata.next_cursor // empty')
       [ -z "$CURSOR" ] && break
     done
     echo "$MATCHES" | jq '.[]'
     ```

     ⚠️ CRITICAL — point of action: **Substitute `USER_QUERY` with the actual user-provided value before running the bash block.** A literal `USER_QUERY="<query>"` or `USER_QUERY="<name>"` matches nothing and burns a `users.list` cycle.

     Result handling:
     - **Single match**: Present it for confirmation: "I found @username (U01ABCDEF) — is that you?" If confirmed, use the `id` value as the destination for Step 3.
     - **Multiple matches**: Present the list (up to 5) and ask the user to pick: "I found a few matches — which one is you?" Use the confirmed `id` as the destination.
     - **No matches**: Tell the user no matches were found. Suggest they double-check the spelling, or fall back to manual entry (see below).

  2. **Fallback to manual entry** if any of the following occur:
     - The `BOT_TOKEN` retrieval fails (the bash block above exits 1 with the "bot_token not found" error)
     - The `users.list` API call fails or returns an error
     - Too many matches are returned (more than 5)
     - The user prefers to enter their ID directly

     For manual entry: ask for their Slack user ID. Explain that this is their Slack member ID (e.g. U01ABCDEF), not their display name or email. They can find it in their Slack profile under "More" > "Copy member ID".

  The bot will send a verification code via Slack DM once the member ID is resolved.

## Step 3: Start Outbound Verification

Execute the outbound start request:

```bash
assistant channel-verification-sessions create --channel <channel> --destination "<destination>" --json
```

Replace `<channel>` with `phone`, `telegram`, `slack`, or `email`, and `<destination>` with the phone number, Telegram destination, Slack user ID, or email address.

### On success (`success: true`)

Report the exact next action based on the channel:

- **Phone**: The response includes a `secret` field with the verification code. Tell the user the code BEFORE the call connects: "I'm calling [number] now. Your verification code is [secret]. When you answer the call, enter this code using your phone's keypad." The `create` command already initiates the voice call. Do NOT place a separate `call_start` call. **After delivering the code, immediately begin the voice auto-check polling loop** (see [Voice Auto-Check Polling](#voice-auto-check-polling) below).
- **Telegram with chat ID** (no `telegramBootstrapUrl` in response): The response includes a `secret` field. Show it in the current chat: "Your verification code is **[secret]**. I've also sent it to your Telegram. Open the Telegram bot chat and reply with that 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3 or resend (Step 4).
- **Telegram with handle** (`telegramBootstrapUrl` present in response): "Tap this deep-link first: [telegramBootstrapUrl]. After Telegram binds your identity, I'll send your verification code."
- **Slack**: The response includes a `secret` field with the verification code. Show it in the current chat: "Your verification code is **[secret]**. I've also sent it to you as a Slack DM. Open the DM from the Vellum bot in Slack and reply with that 6-digit code to complete verification." The DM channel ID is captured automatically during this process for future message delivery. If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3 or resend (Step 4). **After delivering the code, immediately begin the Slack auto-check polling loop** (see [Slack Auto-Check Polling](#slack-auto-check-polling) below).
- **Email**: The response includes a `secret` field with the verification code. Show it in the current chat: "Your verification code is **[secret]**. I've also sent it to your email. Reply to the verification email with only the 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3 or resend (Step 4). **After delivering the code, immediately begin the Email auto-check polling loop** (see [Email Auto-Check Polling](#email-auto-check-polling) below).

After reporting the bootstrap URL for Telegram handle flows, wait for the user to confirm they clicked the link. Then check verification status (Step 6) to see if the bootstrap completed and a code was sent.

### On error (`success: false`)

Handle each error code:

| Error code            | Action                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_destination` | Ask the user to provide their phone number, Telegram destination, or Slack user ID.                                                                                                                                                                                                          |
| `invalid_destination` | Tell the user the format is invalid. For phone: suggest E.164 format (+15551234567). For Telegram: explain that group chat IDs (negative numbers) are not supported. For Slack: explain that the value must be a Slack member ID (e.g. U01ABCDEF). For email: suggest a valid email address. |
| `already_bound`       | Tell the user a verified identity is already bound for this channel. Ask if they want to replace it. If yes, re-run the create command with `--rebind` added.                                                                                                                                |
| `rate_limited`        | Tell the user they have sent too many verification attempts to this destination. Ask them to wait and try again later.                                                                                                                                                                       |
| `unsupported_channel` | Tell the user the channel is not supported. Only phone, telegram, slack, and email are valid.                                                                                                                                                                                                |
| `no_bot_username`     | Telegram bot is not configured. Load and run the `telegram-setup` skill first.                                                                                                                                                                                                               |

## Step 4: Handle Resend

If the user says they did not receive the code or asks to resend:

```bash
assistant channel-verification-sessions resend --channel <channel> --json
```

On success, report the next action based on the channel:

- **Phone**: The resend response includes a fresh `secret` field with a new verification code. Tell the user the new code BEFORE the call connects - just like the initial start flow: "I'm calling [number] again. Your new verification code is [secret]. When you answer the call, enter this code using your phone's keypad." The `resend` command already initiates the voice call. Do NOT place a separate `call_start` call. **After delivering the code, immediately begin the voice auto-check polling loop** (see [Voice Auto-Check Polling](#voice-auto-check-polling) below).
- **Telegram**: The resend response includes a fresh `secret` field. Show the new code in the current chat: "Your new verification code is **[secret]**. I've also sent it to your Telegram. Open the Telegram bot chat and reply with that 6-digit code to complete verification." If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3.
- **Slack**: The resend response includes a fresh `secret` field. Show the new code in the current chat: "Your new verification code is **[secret]**. I've also sent it to you as a Slack DM. Reply to the DM with that 6-digit code to complete verification. (resent)" If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3. **After delivering the code, immediately begin the Slack auto-check polling loop** (see [Slack Auto-Check Polling](#slack-auto-check-polling) below).
- **Email**: The resend response includes a fresh `secret` field. Show the new code in the current chat: "Your new verification code is **[secret]**. I've also sent it to your email. Reply to the verification email with only the 6-digit code to complete verification. (resent)" If the response does not contain a `secret` field, treat this as a control-plane error: tell the user something went wrong and ask them to retry from Step 3. **After delivering the code, immediately begin the Email auto-check polling loop** (see [Email Auto-Check Polling](#email-auto-check-polling) below).

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

3. If the response shows `bound: true`: immediately send a proactive success message in the current chat - "Voice verification complete! Your phone number is now verified." Stop polling.
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

3. If the response shows `bound: true`: immediately send a proactive success message in the current chat - "Slack verification complete! Your Slack account is now verified. The DM channel has been captured for future message delivery." Stop polling.
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

## Email Auto-Check Polling

For **email** verification: after telling the user their code and instructing them to reply to the verification email (in Step 3 or Step 4), proactively poll for completion so the user gets instant confirmation.

**Polling procedure:**

1. Wait ~20 seconds after delivering the code (to give the user time to check their email and reply).
2. Check the binding status via Vellum CLI:

```bash
assistant channel-verification-sessions status --channel email --json
```

3. If the response shows `bound: true`: immediately send a proactive success message in the current chat - "Email verification complete! Your email address is now verified." Stop polling.
4. If not yet bound: wait ~20 seconds and poll again.
5. Continue polling for up to **3 minutes** (approximately 9 attempts). Email is slower than chat, so a longer timeout is appropriate.
6. If the 3-minute timeout is reached without `bound: true`: proactively tell the user - "I've been checking for about 3 minutes but verification hasn't completed yet. The code may have expired or the reply wasn't received. Would you like me to resend a new code (Step 4) or start a new session (Step 3)?"

**Rebind guard:**
When in a **rebind flow**, apply the same guard as Slack/voice: only report success when BOTH `bound: true` AND `verificationSessionId` is absent from the response.

**Important polling rules:**

- Do NOT require the user to ask "did it work?" - the whole point is proactive confirmation.
- If the user sends a message while polling is in progress, handle their message normally.

## Step 6: Check Verification Status

After the user reports entering the code, verify the binding was created. Set `CHANNEL` to the channel currently being verified before running:

```bash
CHANNEL=""  # ← MUST set to one of: phone, telegram, slack, email
if [ -z "$CHANNEL" ]; then echo "ERROR: CHANNEL not set"; exit 1; fi
assistant channel-verification-sessions status --channel "$CHANNEL" --json
```

⚠️ CRITICAL — point of action: **`CHANNEL` must be set to the channel currently being verified (`phone`, `telegram`, `slack`, or `email`) before running.** The empty-string guard ensures a missed substitution fails safely rather than operating on the wrong channel.

If the response shows the channel is bound, confirm success: "Verification complete! Your [channel] identity is now verified."

If not yet bound, offer to resend (Step 4) or generate a new session (Step 3).

## Step 7: Revoke Verification

If the user wants to remove themselves (or the current verified identity) from a channel, use the revoke endpoint. Set `CHANNEL` to the channel to unbind from before running:

```bash
CHANNEL=""  # ← MUST set to one of: phone, telegram, slack, email
if [ -z "$CHANNEL" ]; then echo "ERROR: CHANNEL not set"; exit 1; fi
assistant channel-verification-sessions revoke --channel "$CHANNEL" --json
```

⚠️ CRITICAL — point of action: **`CHANNEL` must be set to the channel to unbind (`phone`, `telegram`, `slack`, or `email`) before running.** The empty-string guard ensures a missed substitution fails safely rather than accidentally revoking the wrong channel.

### On success (`success: true`)

The response includes `bound: false` after the operation completes. Check the previous binding state to tailor the message:

- If a binding was previously active (i.e., the user explicitly asked to revoke their verified identity): "Verification revoked for [channel]. The previous verified identity no longer has access to this channel."
- If no binding existed (`bound: false` and there was nothing to revoke): "There is no active verification for [channel] - nothing to revoke. Any pending verification challenges have been cleared."

## Important Notes

- Verification codes expire after 10 minutes. If the session expires, start a new one.
- The resend cooldown is 15 seconds between sends, with a maximum of 5 sends per session.
- Per-destination rate limiting allows up to 10 sends within a 1-hour rolling window.
- Channel verification is identity-bound: the code can only be consumed by the identity matching the destination provided at start time.
- **Missing `secret` guardrail**: For voice, Telegram chat-ID, and Slack flows, the API response MUST include a `secret` field. If `secret` is unexpectedly absent from a start or resend response that otherwise indicates success, treat this as a control-plane error. Do NOT fabricate a code or tell the user to proceed without one. Instead, tell the user something went wrong and ask them to retry the start (Step 3) or resend (Step 4).
- **Revoking verification**: To remove the current verified identity from a channel, use the revoke API (Step 7). This revokes the binding AND revokes the verified identity's contact record, so they lose access to the channel. A new identity can then be verified for that channel.
