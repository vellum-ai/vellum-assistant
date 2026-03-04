---
name: "Trusted Contacts"
description: "Manage trusted contacts and invite links — list, allow, revoke, block users, and create/list/revoke invite links for Telegram and voice (phone call) channels"
user-invocable: true
metadata: { "vellum": { "emoji": "\ud83d\udc65" } }
---

You are helping your user manage trusted contacts and invite links for the Vellum Assistant. Trusted contacts control who is allowed to send messages to the assistant through external channels like Telegram, SMS, and voice (phone calls). Invite links let the guardian share a Telegram deep link that automatically grants access when opened. Voice invites let the guardian authorize a specific phone number to call in — the invitee must call from that phone number AND enter a one-time numeric code. Use Vellum CLI for status/list retrieval, and use gateway control-plane `curl` calls for mutating actions.

## Prerequisites

- Use the injected `INTERNAL_GATEWAY_BASE_URL` for gateway API calls.
- Use gateway control-plane routes only: this skill calls `/v1/contacts`, `/v1/ingress/*`, and `/v1/integrations/telegram/config` on the gateway, never the daemon runtime port directly.
- The bearer token is available as the `$GATEWAY_AUTH_TOKEN` environment variable for control-plane `curl` requests.

## Concepts

- **Member**: A user identity (external user ID or chat ID) from a specific channel that has been registered with a policy.
- **Policy**: Controls what the member can do — `allow` (can message freely) or `deny` (blocked from messaging).
- **Status**: The member's lifecycle state — `active` (currently effective), `revoked` (access removed), or `blocked` (explicitly denied).
- **Source channel**: The messaging platform the contact uses (e.g., `telegram`, `sms`, `voice`).
- **Invite link**: A shareable Telegram deep link that, when opened by someone, automatically grants them trusted-contact access. Each invite has a token, usage limits, and optional expiration.
- **Voice invite**: An invite bound to a specific phone number for phone-call access. The guardian provides the invitee's phone number (E.164 format, e.g., `+15551234567`), and the system generates a numeric code. The invitee must call from that exact phone number AND enter the code when prompted. Both conditions must be met — the call must originate from the bound number, and the correct code must be entered. Voice invites do not have a Telegram-style deep link and do not use `/start` payload tokens. SMS-based invites are not supported.

## Available Actions

### 1. List trusted contacts

Use this to show the user who currently has access, or to look up a specific contact.

```bash
vellum integrations ingress members --json
```

Optional query parameters for filtering:

- `--role <role>` — filter by role (default: `contact`; use `guardian` to list guardians)
- `--limit <limit>` — maximum number of contacts to return

Example:

```bash
vellum integrations ingress members --role contact --json
```

The response contains `{ ok: true, contacts: [...] }` where each contact has:

- `id` — unique contact ID
- `role` — the contact's role (`contact`, `guardian`)
- `displayName` — human-readable name
- `channels` — array of channel entries, each with:
  - `id` — channel ID (needed for status/policy changes)
  - `channel` — the channel type (e.g., `telegram`, `sms`, `voice`)
  - `externalUserId` — the user's ID on that channel
  - `externalChatId` — the chat ID on that channel
  - `displayName` — channel-specific display name
  - `username` — channel username (e.g., Telegram @handle)
  - `status` — current status (`active`, `revoked`, `blocked`, etc.)
  - `policy` — current policy (`allow`, `deny`, `escalate`)
- `createdAt` — when the contact was added

**Presenting results**: Format the contact list as a readable table or list. Include display name, role, and per-channel status/policy. If no contacts exist, tell the user their contact list is empty.

### 2. Allow a user (add trusted contact)

Use this when the user wants to grant someone access to message the assistant. **Always confirm with the user before executing this action.**

Ask the user: _"I'll add [name/identifier] on [channel] as an allowed contact. Should I proceed?"_

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -d '{
    "sourceChannel": "<channel>",
    "externalUserId": "<user_id>",
    "displayName": "<display_name>",
    "policy": "allow",
    "status": "active"
  }'
```

Required fields:

- `sourceChannel` — the channel (e.g., `telegram`, `sms`)
- At least one of `externalUserId` or `externalChatId`

Optional fields:

- `displayName` — human-readable name for the contact
- `username` — channel-specific handle (e.g., Telegram @username)

If the user provides a name but not an external ID, explain that you need the channel-specific user ID or chat ID to create the contact entry. For Telegram, this is a numeric user ID; for SMS, this is the phone number in E.164 format.

### 3. Revoke a user (remove access)

Use this when the user wants to remove someone's access. **Always confirm with the user before executing this action.**

Ask the user: _"I'll revoke access for [name/identifier]. They will no longer be able to message the assistant. Should I proceed?"_

First, list members to find the member's `id`, then revoke:

```bash
curl -s -X DELETE "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members/<member_id>" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "<optional reason>"}'
```

Replace `<member_id>` with the member's `id` from the list response.

### 4. Block a user

Use this when the user wants to explicitly block someone. Blocking is stronger than revoking — it marks the contact as actively denied. **Always confirm with the user before executing this action.**

Ask the user: _"I'll block [name/identifier]. They will be permanently denied from messaging the assistant. Should I proceed?"_

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members/<member_id>/block" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -d '{"reason": "<optional reason>"}'
```

### 5. Create a Telegram invite link

Use this when the guardian wants to invite someone to message the assistant on Telegram without needing their user ID upfront. The invite link is a shareable Telegram deep link — when someone opens it, they automatically get trusted-contact access.

**Important**: The shell snippet below emits a `<vellum-sensitive-output>` directive containing the raw invite token. The tool executor automatically strips this directive and replaces the raw token with a placeholder so the LLM never sees it. The placeholder is resolved back to the real token in the final assistant reply.

```bash
INVITE_JSON=$(curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -d '{
    "sourceChannel": "telegram",
    "maxUses": 1,
    "note": "<optional note, e.g. the person it is for>"
  }')

INVITE_TOKEN=$(printf '%s' "$INVITE_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
invite = data.get('invite', {})
print(invite.get('token', ''), end='')
")
INVITE_URL=$(printf '%s' "$INVITE_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
invite = data.get('invite', {})
share = invite.get('share') or {}
print(share.get('url', ''), end='')
")

if [ -z "$INVITE_TOKEN" ]; then
  printf '%s\n' "$INVITE_JSON"
  exit 1
fi

# Prefer backend-provided canonical link when available.
if [ -z "$INVITE_URL" ]; then
  BOT_CONFIG_JSON=$(vellum integrations telegram config --json)
  BOT_USERNAME=$(printf '%s' "$BOT_CONFIG_JSON" | tr -d '\n' | sed -n 's/.*"botUsername"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [ -z "$BOT_USERNAME" ]; then
    echo "error:no_share_url_or_bot_username"
    exit 1
  fi
  INVITE_URL="https://t.me/$BOT_USERNAME?start=iv_$INVITE_TOKEN"
fi

echo "<vellum-sensitive-output kind=\"invite_code\" value=\"$INVITE_TOKEN\" />"
echo "$INVITE_URL"
```

Optional fields:

- `maxUses` — how many times the link can be used (default: 1). Use a higher number for group invites.
- `expiresInMs` — expiration time in milliseconds from now (e.g., `86400000` for 24 hours). Defaults to 7 days (`604800000`) if omitted.
- `note` — a human-readable label for the invite (e.g., "For Mom", "Family group").

The create response contains `{ ok: true, invite: { id, token, share?, ... } }`.

- `token` is the raw invite token and is only returned at creation time.
- `share.url` is the canonical shareable deep link (when channel transport config is available).

Always use `invite.share.url` when present. Do not manually construct `?start=` links if the API already provided one.

**Presenting to the guardian**: Give the guardian the link with clear copy-paste instructions:

> Here's your Telegram invite link:
>
> `https://t.me/<botUsername>?start=iv_<token>`
>
> Share this link with the person you want to invite. When they open it in Telegram and press "Start", they'll automatically be added as a trusted contact and can message the assistant directly.
>
> This link can be used <maxUses> time(s)<and expires in X hours/days if applicable>.

If the Telegram bot username is not available (integration not set up), tell the guardian they need to set up the Telegram integration first using the Telegram Setup skill.

### 6. List invite links

Use this to show the guardian their active (and optionally all) invite links.

```bash
vellum integrations ingress invites --source-channel telegram --json
```

Optional query parameters:

- `sourceChannel` — filter by channel (e.g., `telegram`)
- `status` — filter by status (`active`, `revoked`, `redeemed`, `expired`)

The response contains `{ ok: true, invites: [...] }` where each invite has:

- `id` — unique invite ID (needed for revoke)
- `sourceChannel` — the channel
- `tokenHash` — hashed token (the raw token is only available at creation time)
- `maxUses` — total allowed uses
- `useCount` — how many times it has been redeemed
- `expiresAt` — expiration timestamp (null if no expiration)
- `status` — current status (`active`, `revoked`, `redeemed`, `expired`)
- `note` — the label set at creation
- `createdAt` — when the invite was created

**Presenting results**: Format as a readable list. Show the note (or "unnamed" as fallback), status, uses remaining (`maxUses - useCount`), and expiration. Highlight active invites and note which ones have been fully used or expired.

### 7. Revoke an invite link

Use this when the guardian wants to cancel an active invite link. **Always confirm before revoking.**

Ask the user: _"I'll revoke the invite link [note or ID]. It will no longer be usable. Should I proceed?"_

First, list invites to find the invite's `id`, then revoke:

```bash
curl -s -X DELETE "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites/<invite_id>" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Replace `<invite_id>` with the invite's `id` from the list response.

### 8. Create a voice invite

Use this when the guardian wants to authorize a specific phone number to call the assistant. Voice invites are identity-bound: the invitee must call from the specified phone number AND enter a one-time numeric code.

**Important**: The response includes a `voiceCode` field that is only returned at creation time and cannot be retrieved later. Extract and present it clearly.

```bash
INVITE_JSON=$(curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -d '{
    "sourceChannel": "voice",
    "expectedExternalUserId": "<phone_number_E164>",
    "friendName": "<invitee display name>",
    "guardianName": "<guardian display name>",
    "maxUses": 1,
    "note": "<optional note, e.g. the person it is for>"
  }')
printf '%s\n' "$INVITE_JSON"
```

Required fields:

- `sourceChannel` — must be `"voice"`
- `expectedExternalUserId` — the invitee's phone number in E.164 format (e.g., `+15551234567`)
- `friendName` — the invitee's display name (e.g., "Mom", "Dr. Smith"). Used during the voice verification call to personalize the experience.
- `guardianName` — the guardian's display name (e.g., "Alex"). Used during the voice verification call so the invitee knows who invited them.

Optional fields:

- `maxUses` — how many times the code can be used (default: 1)
- `expiresInMs` — expiration time in milliseconds from now (e.g., `86400000` for 24 hours). Defaults to 7 days if omitted.
- ~~`voiceCodeDigits`~~ — always 6 digits; this parameter is accepted but ignored
- `note` — a human-readable label for the invite (e.g., "For Mom", "Dr. Smith")

The create response contains `{ ok: true, invite: { id, voiceCode, expectedExternalUserId, friendName, guardianName, ... } }`.

- `voiceCode` is the numeric code the invitee must enter and is only returned at creation time.
- `friendName` and `guardianName` are echoed back in the response.
- Voice invite responses do **not** include `token` or `share.url`. Do not try to build or send a deep link for voice invites.

**Presenting to the guardian**: Give the guardian clear instructions to relay to the invitee:

> Voice invite created for **<phone_number>**:
>
> **Invite code: `<voiceCode>`**
>
> Share these instructions with the person you are inviting:
>
> 1. Call the assistant's phone number from **<phone_number>** (the call must come from this exact number)
> 2. When prompted, enter the code **<voiceCode>**
> 3. Once verified, they will be added as a trusted contact and can call the assistant directly in the future
>
> This code can be used <maxUses> time(s)<and expires in X hours/days if applicable>.

There is no "open link" step for voice invites. The invite is redeemed only during a live phone call from the bound number.

If the user provides a phone number without the `+` country code prefix, ask them to confirm the full E.164 number (e.g., US numbers should be `+1XXXXXXXXXX`).

**Note**: SMS-based invites are not currently supported. Only voice (phone call) invites are available for phone-based access.

### 9. List voice invites

Use this to show the guardian their active voice invites.

```bash
vellum integrations ingress invites --source-channel voice --json
```

Optional query parameters:

- `status` — filter by status (`active`, `revoked`, `redeemed`, `expired`)

The response format is the same as regular invites but voice invites also include:

- `expectedExternalUserId` — the bound phone number
- `voiceCodeDigits` — always 6 (the code itself is not retrievable after creation)
- `token` and `share` are not present for voice invites

**Presenting results**: Format as a readable list. Show the note (or "unnamed" as fallback), bound phone number, status, uses remaining, and expiration. Highlight which invites are still active.

### 10. Revoke a voice invite

Use this when the guardian wants to cancel an active voice invite. **Always confirm before revoking.**

Ask the user: _"I'll revoke the voice invite for [phone number or note]. The code will no longer work. Should I proceed?"_

First, list voice invites to find the invite's `id`, then revoke:

```bash
curl -s -X DELETE "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites/<invite_id>" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Replace `<invite_id>` with the invite's `id` from the list response. The same revoke endpoint is used for both Telegram and voice invites.

## Confirmation Requirements

**All mutating actions (allow, revoke, block, revoke invite) require explicit user confirmation before execution.** This is a safety measure — modifying who can access the assistant should always be a deliberate choice. Creating an invite (Telegram link or voice invite) does not require confirmation since it does not grant access until the invitee redeems it.

- Clearly state what action you are about to take and who it affects.
- Wait for the user to confirm before running the curl command.
- Report the result after execution.

## Error Handling

- If a request returns `{ ok: false, error: "..." }`, report the error message to the user.
- Common errors:
  - `sourceChannel is required` — ask the user which channel the contact is on.
  - `At least one of externalUserId or externalChatId is required` — ask the user for the contact's channel-specific identifier.
  - `Member not found or cannot be revoked` — the member ID may be invalid or the member is already revoked.
  - `Member not found or already blocked` — the member ID may be invalid or the member is already blocked.
  - `sourceChannel is required for create` — when creating an invite, always pass `"sourceChannel": "telegram"` for Telegram or `"sourceChannel": "voice"` for voice invites.
  - `expectedExternalUserId is required for voice invites` — voice invites must include the invitee's phone number.
  - `expectedExternalUserId must be in E.164 format` — the phone number must start with `+` followed by country code and number (e.g., `+15551234567`).
  - `friendName is required for voice invites` — voice invites must include the invitee's display name.
  - `guardianName is required for voice invites` — voice invites must include the guardian's display name.
  - `Invite not found or already revoked` — the invite ID may be invalid or the invite is already revoked.

## Typical Workflows

**"Who can message me?"** — List all active members, present as a formatted list.

**"Add my friend to Telegram"** — Ask for their Telegram user ID (numeric) and optional display name, confirm, then add with `policy: "allow"` and `status: "active"`.

**"Remove [name]'s access"** — List members to find them, confirm the revocation, then delete.

**"Block [name]"** — List members to find them, confirm the block, then execute.

**"Show me blocked contacts"** — List with `status=blocked` filter.

**"Create a Telegram invite link"** / **"Invite someone on Telegram"** — Create an invite with `sourceChannel: "telegram"`, look up the bot username, build the deep link, and present it with sharing instructions.

**"Show my invites"** / **"List active invite links"** — List invites filtered by `sourceChannel=telegram`, present active invites with uses remaining and expiration info.

**"Revoke invite"** / **"Cancel invite link"** — List invites to identify the target, confirm, then revoke by ID.

**"Create a voice invite for +15551234567"** — Create a voice invite with `sourceChannel: "voice"` and the given phone number as `expectedExternalUserId`. Present the invite code and instructions: the person must call from that number and enter the code.

**"Let my mom call in"** / **"Invite someone by phone"** — Ask for the phone number in E.164 format, create a voice invite, and present the code + calling instructions.

**"Show my voice invites"** / **"List phone invites"** — List invites filtered by `sourceChannel=voice`, present active invites with bound phone number and expiration info.

**"Revoke voice invite"** / **"Cancel the phone invite for +15551234567"** — List voice invites, identify the target by phone number or note, confirm, then revoke by ID.
