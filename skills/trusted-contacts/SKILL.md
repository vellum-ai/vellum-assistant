---
name: "Trusted Contacts"
description: "Manage trusted contacts — list, allow, revoke, and block users who can message the assistant through external channels"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udc65"}}
---

You are helping your user manage trusted contacts for the Vellum Assistant. Trusted contacts control who is allowed to send messages to the assistant through external channels like Telegram and SMS. All operations go through the gateway HTTP API using `curl` with bearer auth.

## Prerequisites

- The gateway API is available at `http://localhost:7830` (or the configured gateway port).
- The bearer token is stored at `~/.vellum/http-token`. Read it with: `TOKEN=$(cat ~/.vellum/http-token)`.

## Concepts

- **Member**: A user identity (external user ID or chat ID) from a specific channel that has been registered with a policy.
- **Policy**: Controls what the member can do — `allow` (can message freely) or `deny` (blocked from messaging).
- **Status**: The member's lifecycle state — `active` (currently effective), `revoked` (access removed), or `blocked` (explicitly denied).
- **Source channel**: The messaging platform the contact uses (e.g., `telegram`, `sms`).

## Available Actions

### 1. List trusted contacts

Use this to show the user who currently has access, or to look up a specific contact.

```bash
TOKEN=$(cat ~/.vellum/http-token)
curl -s http://localhost:7830/v1/ingress/members \
  -H "Authorization: Bearer $TOKEN"
```

Optional query parameters for filtering:
- `sourceChannel` — filter by channel (e.g., `telegram`, `sms`)
- `status` — filter by status (`active`, `revoked`, `blocked`)
- `policy` — filter by policy (`allow`, `deny`)

Example with filters:
```bash
curl -s "http://localhost:7830/v1/ingress/members?sourceChannel=telegram&status=active" \
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
curl -s -X POST http://localhost:7830/v1/ingress/members \
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
curl -s -X DELETE "http://localhost:7830/v1/ingress/members/<member_id>" \
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
curl -s -X POST "http://localhost:7830/v1/ingress/members/<member_id>/block" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason": "<optional reason>"}'
```

## Confirmation Requirements

**All mutating actions (allow, revoke, block) require explicit user confirmation before execution.** This is a safety measure — modifying who can access the assistant should always be a deliberate choice.

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

## Typical Workflows

**"Who can message me?"** — List all active members, present as a formatted list.

**"Add my friend to Telegram"** — Ask for their Telegram user ID (numeric) and optional display name, confirm, then add with `policy: "allow"` and `status: "active"`.

**"Remove [name]'s access"** — List members to find them, confirm the revocation, then delete.

**"Block [name]"** — List members to find them, confirm the block, then execute.

**"Show me blocked contacts"** — List with `status=blocked` filter.
