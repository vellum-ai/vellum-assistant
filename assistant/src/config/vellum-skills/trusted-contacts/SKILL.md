---
name: "Trusted Contacts"
description: "Manage trusted contacts and Telegram invite links — list, allow, revoke, block users, and create/list/revoke invite links for external channels"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udc65"}}
---

You are helping your user manage trusted contacts and invite links for the Vellum Assistant. Trusted contacts control who is allowed to send messages to the assistant through external channels like Telegram and SMS. Invite links let the guardian share a Telegram deep link that automatically grants access when opened. All operations go through the gateway HTTP API using `curl` with bearer auth.

## Prerequisites

- Use the injected `INTERNAL_GATEWAY_BASE_URL` for gateway API calls in this skill. Do not hardcode hosts or ports.
- Use gateway control-plane routes only: this skill calls `/v1/ingress/*` and `/v1/integrations/telegram/config` on the gateway, never the daemon runtime port directly.
- The bearer token is stored at `~/.vellum/http-token`. Read it with: `TOKEN=$(cat ~/.vellum/http-token)`.

## Concepts

- **Member**: A user identity (external user ID or chat ID) from a specific channel that has been registered with a policy.
- **Policy**: Controls what the member can do — `allow` (can message freely) or `deny` (blocked from messaging).
- **Status**: The member's lifecycle state — `active` (currently effective), `revoked` (access removed), or `blocked` (explicitly denied).
- **Source channel**: The messaging platform the contact uses (e.g., `telegram`, `sms`).
- **Invite link**: A shareable Telegram deep link that, when opened by someone, automatically grants them trusted-contact access. Each invite has a token, usage limits, and optional expiration.

## Available Actions

### 1. List trusted contacts

Use this to show the user who currently has access, or to look up a specific contact.

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members" \
  -H "Authorization: Bearer $TOKEN"
```

Optional query parameters for filtering:
- `sourceChannel` — filter by channel (e.g., `telegram`, `sms`)
- `status` — filter by status (`active`, `revoked`, `blocked`)
- `policy` — filter by policy (`allow`, `deny`)

Example with filters:
```bash
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members?sourceChannel=telegram&status=active" \
  -H "Authorization: Bearer $TOKEN"
```

The response contains `{ ok: true, members: [...] }` where each member has:
- `id` — unique member ID (needed for revoke/block operations)
- `sourceChannel` — the channel (e.g., `telegram`)
- `externalUserId` — the user's ID on that channel
- `externalChatId` — the chat ID on that channel
- `displayName` — human-readable name
- `username` — channel username (e.g., Telegram @handle)
- `status` — current status
- `policy` — current policy
- `createdAt` — when the member was added

**Presenting results**: Format the member list as a readable table or list. Include display name (or username/user ID as fallback), channel, status, and policy. If no members exist, tell the user their contact list is empty.

### 2. Allow a user (add trusted contact)

Use this when the user wants to grant someone access to message the assistant. **Always confirm with the user before executing this action.**

Ask the user: *"I'll add [name/identifier] on [channel] as an allowed contact. Should I proceed?"*

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
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

Ask the user: *"I'll revoke access for [name/identifier]. They will no longer be able to message the assistant. Should I proceed?"*

First, list members to find the member's `id`, then revoke:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X DELETE "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members/<member_id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "<optional reason>"}'
```

Replace `<member_id>` with the member's `id` from the list response.

### 4. Block a user

Use this when the user wants to explicitly block someone. Blocking is stronger than revoking — it marks the contact as actively denied. **Always confirm with the user before executing this action.**

Ask the user: *"I'll block [name/identifier]. They will be permanently denied from messaging the assistant. Should I proceed?"*

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/members/<member_id>/block" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason": "<optional reason>"}'
```

### 5. Create a Telegram invite link

Use this when the guardian wants to invite someone to message the assistant on Telegram without needing their user ID upfront. The invite link is a shareable Telegram deep link — when someone opens it, they automatically get trusted-contact access.

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "sourceChannel": "telegram",
    "maxUses": 1,
    "note": "<optional note, e.g. the person it is for>"
  }'
```

Optional fields:
- `maxUses` — how many times the link can be used (default: 1). Use a higher number for group invites.
- `expiresInMs` — expiration time in milliseconds from now (e.g., `86400000` for 24 hours). Defaults to 7 days (`604800000`) if omitted.
- `note` — a human-readable label for the invite (e.g., "For Mom", "Family group").

The response contains `{ ok: true, invite: { id, token, ... } }`. The `token` field is the raw invite token — it is only returned at creation time and cannot be retrieved later.

**Building the shareable link**: After creating the invite, look up the Telegram bot username so you can build the deep link. Query the Telegram integration config:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/telegram/config" \
  -H "Authorization: Bearer $TOKEN"
```

The response includes `botUsername`. Use it to construct the deep link:

```
https://t.me/<botUsername>?start=iv_<token>
```

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
TOKEN=$(cat ~/.vellum/http-token)
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites?sourceChannel=telegram" \
  -H "Authorization: Bearer $TOKEN"
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

Ask the user: *"I'll revoke the invite link [note or ID]. It will no longer be usable. Should I proceed?"*

First, list invites to find the invite's `id`, then revoke:

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s -X DELETE "$INTERNAL_GATEWAY_BASE_URL/v1/ingress/invites/<invite_id>" \
  -H "Authorization: Bearer $TOKEN"
```

Replace `<invite_id>` with the invite's `id` from the list response.

## Confirmation Requirements

**All mutating actions (allow, revoke, block, revoke invite) require explicit user confirmation before execution.** This is a safety measure — modifying who can access the assistant should always be a deliberate choice. Creating an invite link does not require confirmation since it does not grant access until someone opens it.

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
  - `sourceChannel is required for create` — when creating an invite, always pass `"sourceChannel": "telegram"`.
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
