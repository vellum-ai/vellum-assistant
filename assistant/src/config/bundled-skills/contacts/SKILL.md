---
name: contacts
description: Manage contacts, communication channels, access control, and invite links
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "👥"
  vellum:
    display-name: "Contacts"
    activation-hints:
      - "Look up contact info before asking the user for email addresses or phone numbers"
      - "User wants to manage who can message the assistant, or create/revoke invite links"
---

Manage the user's contacts, relationship graph, access control (trusted contacts), and invite links. This skill covers contact CRUD with multi-channel tracking, controlling who can message the assistant through external channels (Telegram, phone), and creating/managing invite links that grant access.

## Contact Management

### Create or update a contact

Create a new contact or update an existing one in the relationship graph. Use this to track people the user interacts with across channels.

```bash
assistant contacts upsert --display-name "<name>" --notes "<notes>" --channels '<json_array>' --json
```

To update an existing contact, include the `--id` flag.

Required flags:

- `--display-name` -- the contact's name

Optional flags:

- `--id` -- contact ID to update (omit to create new, or auto-match by channel address)
- `--notes` -- free-text notes about this contact (e.g. relationship, communication preferences, response expectations)
- `--role` -- contact role: `contact` or `guardian` (default: `contact`)
- `--contact-type` -- contact type: `human` or `assistant` (default: `human`)
- `--channels` -- JSON array of channel objects, each with `type`, `address`, and optional `isPrimary`, `externalUserId`, `externalChatId`, `status`, `policy`

### Search contacts

Search for contacts by name, channel address, or other criteria.

```bash
assistant contacts list --query "<search_term>" --json
```

Optional flags:

- `--query` -- search by display name (partial match)
- `--channel-address` -- search by channel address (email, phone, handle)
- `--channel-type` -- filter by channel type when searching by address
- `--limit` -- maximum results to return (default 50, max 100)

### Merge contacts

When you discover two contacts are the same person (e.g. same person on email and Slack), merge them to consolidate. Merging:

- Combines all channels from both contacts
- Merges notes from both contacts
- Sums interaction counts
- Deletes the donor contact

```bash
assistant contacts merge <surviving_contact_id> <donor_contact_id> --json
```

## Access Control (Trusted Contacts)

Trusted contacts control who is allowed to send messages to the assistant through external channels like Telegram and voice (phone calls).

### Concepts

- **Contact channel**: A user identity (external user ID or chat ID) on a specific messaging platform, stored as an entry in a contact's `channels` array. Each channel entry has its own `status` and `policy`.
- **Policy**: Controls what the contact channel can do -- `allow` (can message freely) or `deny` (blocked from messaging).
- **Status**: The channel's lifecycle state -- `active` (currently effective), `revoked` (access removed), or `blocked` (explicitly denied).
- **Channel type**: The messaging platform (e.g., `telegram`, `phone`).

### List trusted contacts

Use this to show the user who currently has access, or to look up a specific contact.

```bash
assistant contacts list --json
```

Optional query parameters for filtering:

- `--role <role>` -- filter by role (default: `contact`; use `guardian` to list guardians)
- `--limit <limit>` -- maximum number of contacts to return
- `--query <query>` -- search query to filter contacts

Example:

```bash
assistant contacts list --role contact --json
```

The response contains `{ ok: true, contacts: [...] }` where each contact has:

- `id` -- unique contact ID
- `role` -- the contact's role (`contact`, `guardian`)
- `displayName` -- human-readable name
- `channels` -- array of channel entries, each with:
  - `id` -- channel ID (needed for status/policy changes)
  - `channel` -- the channel type (e.g., `telegram`, `phone`)
  - `externalUserId` -- the user's ID on that channel
  - `externalChatId` -- the chat ID on that channel
  - `displayName` -- channel-specific display name
  - `username` -- channel username (e.g., Telegram @handle)
  - `status` -- current status (`active`, `revoked`, `blocked`, etc.)
  - `policy` -- current policy (`allow`, `deny`, `escalate`)
- `createdAt` -- when the contact was added

**Presenting results**: Format the contact list as a readable table or list. Include display name, role, and per-channel status/policy. If no contacts exist, tell the user their contact list is empty.

### Allow a user (add trusted contact)

Use this when the user wants to grant someone access to message the assistant. **Always confirm with the user before executing this action.**

Ask the user: _"I'll add [name/identifier] on [channel] as an allowed contact. Should I proceed?"_

```bash
assistant contacts upsert --display-name "<display_name>" --channels '[{"type":"<channel>","address":"<user_id>","externalUserId":"<user_id>","status":"active","policy":"allow"}]' --json
```

Required flags:

- `--display-name` -- human-readable name for the contact
- `--channels` -- at least one channel entry with:
  - `type` -- the channel type (e.g., `telegram`)
  - `address` -- the channel-specific identifier
  - `externalUserId` -- the user's ID on that channel (or `externalChatId` for chat-based channels)
  - `status` -- set to `"active"` for immediate access
  - `policy` -- set to `"allow"` to grant messaging access

If the user provides a name but not an external ID, explain that you need the channel-specific user ID or chat ID to create the contact entry. For Telegram, this is a numeric user ID.

### Revoke a user (remove access)

Use this when the user wants to remove someone's access. **Always confirm with the user before executing this action.**

Ask the user: _"I'll revoke access for [name/identifier]. They will no longer be able to message the assistant. Should I proceed?"_

First, list contacts to find the channel's `id` (each entry in a contact's `channels` array has an `id` field -- visible in `assistant contacts list --json` output), then revoke:

**Important**: Before revoking, check the channel's current `status`. If the channel is **blocked**, do not attempt to revoke it -- blocking is stronger than revoking. Inform the user that the contact is already blocked and revoking is not applicable. Only channels with `active` or `pending` status can be revoked.

```bash
assistant contacts channels update-status <channel_id> --status revoked --reason "<optional reason>" --json
```

Replace `<channel_id>` with the channel's `id` from the contact's `channels` array.

### Block a user

Use this when the user wants to explicitly block someone. Blocking is stronger than revoking -- it marks the contact as actively denied. **Always confirm with the user before executing this action.**

Ask the user: _"I'll block [name/identifier]. They will be permanently denied from messaging the assistant. Should I proceed?"_

```bash
assistant contacts channels update-status <channel_id> --status blocked --reason "<optional reason>" --json
```

Replace `<channel_id>` with the channel's `id` from the contact's `channels` array (visible in `assistant contacts list --json` output).


## Invite Links

Invite links let the guardian share a link or code that automatically grants access when used. Telegram invites use a deep link; voice invites use a phone number + numeric code; email, WhatsApp, and Slack invites use a 6-digit code that the invitee sends to the assistant on the respective channel.

**Every invite must be bound to a contact.** Before creating an invite, look up the contact with `assistant contacts list` or create one with `assistant contacts upsert`, then pass the contact's `id` via the required `--contact-id` flag.

### Create a Telegram invite link

Use this when the guardian wants to invite someone to message the assistant on Telegram without needing their user ID upfront. The invite link is a shareable Telegram deep link -- when someone opens it, they automatically get trusted-contact access.

**Important**: The shell snippet below emits a `<vellum-sensitive-output>` directive containing the raw invite token. The tool executor automatically strips this directive and replaces the raw token with a placeholder so the LLM never sees it. The placeholder is resolved back to the real token in the final assistant reply.

```bash
INVITE_JSON=$(assistant contacts invites create --source-channel telegram --contact-id "<contact_id>" --max-uses 1 --note "<optional note, e.g. the person it is for>" --json)

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
  BOT_USERNAME=$(assistant config get telegram.botUsername)
  if [ -z "$BOT_USERNAME" ] || [ "$BOT_USERNAME" = "(not set)" ]; then
    echo "error:no_share_url_or_bot_username"
    exit 1
  fi
  INVITE_URL="https://t.me/$BOT_USERNAME?start=iv_$INVITE_TOKEN"
fi

echo "<vellum-sensitive-output kind=\"invite_code\" value=\"$INVITE_TOKEN\" />"
echo "$INVITE_URL"
```

Required flags:

- `--source-channel` -- must be `telegram`
- `--contact-id` -- the ID of the contact this invite is for. Look up or create the contact first with `assistant contacts list` or `assistant contacts upsert`.

Optional flags:

- `--max-uses` -- how many times the link can be used (default: 1). Use a higher number for group invites.
- `--expires-in-ms` -- expiration time in milliseconds from now (e.g., `86400000` for 24 hours). Defaults to 7 days (`604800000`) if omitted.
- `--note` -- a human-readable label for the invite (e.g., "For Mom", "Family group").

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

### Create a voice invite

Use this when the guardian wants to authorize a specific phone number to call the assistant. Voice invites are identity-bound: the invitee must call from the specified phone number AND enter a one-time numeric code.

**Important**: The response includes a `voiceCode` field that is only returned at creation time and cannot be retrieved later. Extract and present it clearly.

```bash
assistant contacts invites create --source-channel phone --contact-id "<contact_id>" --expected-external-user-id "<phone_E164>" --friend-name "<invitee_name>" --guardian-name "<guardian_name>" --max-uses 1 --note "<optional note, e.g. the person it is for>" --json
```

Required flags:

- `--source-channel` -- must be `phone`
- `--contact-id` -- the ID of the contact this invite is for. Look up or create the contact first with `assistant contacts list` or `assistant contacts upsert`.
- `--expected-external-user-id` -- the invitee's phone number in E.164 format (e.g., `+15551234567`)
- `--friend-name` -- the invitee's display name (e.g., "Mom", "Dr. Smith"). Used during the voice verification call to personalize the experience.
- `--guardian-name` -- the guardian's display name (e.g., "Alex"). Used during the voice verification call so the invitee knows who invited them.

Optional flags:

- `--max-uses` -- how many times the code can be used (default: 1)
- `--expires-in-ms` -- expiration time in milliseconds from now (e.g., `86400000` for 24 hours). Defaults to 7 days if omitted.
- `--note` -- a human-readable label for the invite (e.g., "For Mom", "Dr. Smith")

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

### Create an email invite

Use this when the guardian wants to invite someone to message the assistant via email. Email invites use a 6-digit code - the invitee sends the code to the assistant's email address to redeem access.

```bash
assistant contacts invites create --source-channel email --contact-id "<contact_id>" --contact-name "<invitee_name>" --max-uses 1 --note "<optional note, e.g. the person it is for>" --json
```

Required flags:

- `--source-channel` -- must be `email`
- `--contact-id` -- the ID of the contact this invite is for. Look up or create the contact first with `assistant contacts list` or `assistant contacts upsert`.

The response contains `{ ok: true, invite: { id, token, inviteCode, guardianInstruction, channelHandle, ... } }`.

- `inviteCode` is the 6-digit code the invitee must send to redeem the invite. It is only returned at creation time.
- `guardianInstruction` is a generated instruction telling the guardian how to share the invite.
- `channelHandle` is the assistant's email address (e.g. `hello@domain.agentmail.to`).

**Presenting to the guardian**: Give the guardian the invite code and the assistant's email address:

> Email invite created for **<contact_name>**:
>
> **Invite code: `<inviteCode>`**
>
> Tell them to send an email to **<channelHandle>** with the code **<inviteCode>** in the body. Once verified, they will be added as a trusted contact and can email the assistant directly.
>
> This code can be used <maxUses> time(s)<and expires in X hours/days if applicable>.

If the assistant's email address is not available (AgentMail not configured), tell the guardian they need to set up email integration first.

### Create a WhatsApp invite

Use this when the guardian wants to invite someone to message the assistant on WhatsApp. WhatsApp invites use a 6-digit code - the invitee sends the code to the assistant's WhatsApp number to redeem access.

```bash
assistant contacts invites create --source-channel whatsapp --contact-id "<contact_id>" --contact-name "<invitee_name>" --max-uses 1 --note "<optional note, e.g. the person it is for>" --json
```

Required flags:

- `--source-channel` -- must be `whatsapp`
- `--contact-id` -- the ID of the contact this invite is for. Look up or create the contact first with `assistant contacts list` or `assistant contacts upsert`.

The response contains `{ ok: true, invite: { id, token, inviteCode, guardianInstruction, channelHandle?, ... } }`.

- `inviteCode` is the 6-digit code the invitee must send to redeem the invite.
- `guardianInstruction` is a generated instruction telling the guardian how to share the invite.
- `channelHandle` (optional) is the assistant's WhatsApp display phone number. It is only present when a display number is configured via `whatsapp.phoneNumber` in workspace config.

**Presenting to the guardian**: If `channelHandle` is present, give the guardian the invite code and the assistant's WhatsApp number:

> WhatsApp invite created for **<contact_name>**:
>
> **Invite code: `<inviteCode>`**
>
> Tell them to send a WhatsApp message to **<channelHandle>** with the code **<inviteCode>**. Once verified, they will be added as a trusted contact and can message the assistant on WhatsApp directly.
>
> This code can be used <maxUses> time(s)<and expires in X hours/days if applicable>.

If `channelHandle` is absent, present the invite code and tell the guardian to share the code with the invitee, instructing them to send it to the assistant on WhatsApp (without citing a specific number).

If the assistant's WhatsApp integration is not configured at all (Meta WhatsApp Business API credentials missing), tell the guardian they need to set up WhatsApp integration first.

### Create a Slack invite

Use this when the guardian wants to invite someone to message the assistant on Slack. Slack invites use a 6-digit code -- the invitee sends the code as a direct message to the assistant's Slack bot to redeem access.

```bash
assistant contacts invites create --source-channel slack --contact-id "<contact_id>" --contact-name "<invitee_name>" --max-uses 1 --note "<optional note, e.g. the person it is for>" --json
```

Required flags:

- `--source-channel` -- must be `slack`
- `--contact-id` -- the ID of the contact this invite is for. Look up or create the contact first with `assistant contacts list` or `assistant contacts upsert`.

The response follows the same shape as email and WhatsApp invites (`inviteCode`, `guardianInstruction`, `channelHandle`).

**Presenting to the guardian**: Give the guardian the invite code and instructions for the invitee to send the code as a DM to the assistant's Slack bot.

> Slack invite created for **<contact_name>**:
>
> **Invite code: `<inviteCode>`**
>
> Tell them to send a direct message to the assistant's Slack bot with the code **<inviteCode>**. Once verified, they will be added as a trusted contact and can message the assistant on Slack directly.
>
> This code can be used <maxUses> time(s)<and expires in X hours/days if applicable>.

If the Slack bot is not available (Slack credentials not configured), tell the guardian they need to set up Slack integration first.

### List invites

Use this to show the guardian their active (and optionally all) invite links.

```bash
assistant contacts invites list --source-channel telegram --json
```

For voice invites:

```bash
assistant contacts invites list --source-channel phone --json
```

For email, WhatsApp, or Slack invites:

```bash
assistant contacts invites list --source-channel email --json
assistant contacts invites list --source-channel whatsapp --json
assistant contacts invites list --source-channel slack --json
```

Optional query parameters:

- `--source-channel` -- filter by channel (e.g., `telegram`, `phone`, `email`, `whatsapp`, `slack`)
- `--status` -- filter by status (`active`, `revoked`, `redeemed`, `expired`)

The response contains `{ ok: true, invites: [...] }` where each invite has:

- `id` -- unique invite ID (needed for revoke)
- `sourceChannel` -- the channel
- `tokenHash` -- hashed token (the raw token is only available at creation time)
- `maxUses` -- total allowed uses
- `useCount` -- how many times it has been redeemed
- `expiresAt` -- expiration timestamp (null if no expiration)
- `status` -- current status (`active`, `revoked`, `redeemed`, `expired`)
- `note` -- the label set at creation
- `createdAt` -- when the invite was created

Voice invites also include:

- `expectedExternalUserId` -- the bound phone number
- `voiceCodeDigits` -- always 6 (the code itself is not retrievable after creation)
- `token` and `share` are not present for voice invites

**Presenting results**: Format as a readable list. Show the note (or "unnamed" as fallback), status, uses remaining (`maxUses - useCount`), and expiration. For voice invites, also show the bound phone number. Highlight active invites and note which ones have been fully used or expired.

### Revoke an invite

Use this when the guardian wants to cancel an active invite link or voice invite. **Always confirm before revoking.**

Ask the user: _"I'll revoke the invite [note or ID]. It will no longer be usable. Should I proceed?"_

First, list invites to find the invite's `id`, then revoke:

```bash
assistant contacts invites revoke <invite_id> --json
```

Replace `<invite_id>` with the invite's `id` from the list response. The same revoke command is used for both Telegram and voice invites.

## Google Contacts

Use `google_contacts` to list or search the user's Google Contacts by name or email. Returns name, email, phone, and organization. Requires the `contacts.readonly` OAuth scope - users may need to re-authorize Gmail to grant this additional permission.

## Contact Fields

- **displayName** -- the contact's name (required)
- **notes** -- free-text notes about this contact (e.g. relationship, communication preferences, response expectations)
- **channels** -- list of communication channels (email, slack, whatsapp, phone, telegram, discord, other)

### Channel Types

Supported channel types: `email`, `slack`, `whatsapp`, `phone`, `telegram`, `discord`, `other`

Each channel has:

- **type** -- one of the supported channel types
- **address** -- the channel-specific identifier (email address, phone number, handle, etc.)
- **isPrimary** -- whether this is the primary channel for its type

## Confirmation Requirements

**All mutating actions (allow, revoke, block, revoke invite) require explicit user confirmation before execution.** This is a safety measure -- modifying who can access the assistant should always be a deliberate choice. Creating an invite (Telegram link, voice invite, email invite, WhatsApp invite, or Slack invite) does not require confirmation since it does not grant access until the invitee redeems it.

- Clearly state what action you are about to take and who it affects.
- Wait for the user to confirm before running the command.
- Report the result after execution.

## Error Handling

- If a command returns `{ ok: false, error: "..." }`, report the error message to the user. CLI commands also exit with non-zero status on errors.
- Common errors:
  - `Channel not found` -- the channel ID may be invalid; list contacts to find the correct channel ID.
  - `Channel already revoked` -- the channel has already been revoked.
  - `Channel already blocked` -- the channel has already been blocked.
  - `Cannot revoke a blocked channel` -- the channel is blocked; blocking is stronger than revoking. Tell the user the contact is already blocked.
  - `sourceChannel is required for create` -- when creating an invite, always pass `--source-channel`.
  - `contactId is required for create` -- when creating an invite, always pass `--contact-id`. Look up or create the contact first.
  - `expectedExternalUserId is required for voice invites` -- voice invites must include the invitee's phone number via `--expected-external-user-id`.
  - `expectedExternalUserId must be in E.164 format` -- the phone number must start with `+` followed by country code and number (e.g., `+15551234567`).
  - `friendName is required for voice invites` -- voice invites must include the invitee's display name via `--friend-name`.
  - `guardianName is required for voice invites` -- voice invites must include the guardian's display name via `--guardian-name`.
  - `Invite not found or already revoked` -- the invite ID may be invalid or the invite is already revoked.

## Tips

- Use contact search with `--channel-address` to find contacts by their email, phone, or handle.
- When creating follow-ups, provide a `contact_id` to link the follow-up to a specific contact.
- When merging contacts, the surviving contact gains all channels and merged notes from the donor.

## Typical Workflows

**"Who can message me?"** -- List all contacts with `assistant contacts list --json`, present active channels as a formatted list.

**"Add my friend to Telegram"** -- Ask for their Telegram user ID (numeric) and display name, confirm, then create a contact with `assistant contacts upsert` including a channel entry with `policy: "allow"` and `status: "active"`.

**"Remove [name]'s access"** -- List contacts with `assistant contacts list --json` to find them, identify the channel to revoke, confirm the revocation, then run `assistant contacts channels update-status <channel_id> --status revoked --json`.

**"Block [name]"** -- List contacts with `assistant contacts list --json` to find them, identify the channel to block, confirm the block, then run `assistant contacts channels update-status <channel_id> --status blocked --json`.

**"Show me blocked contacts"** -- List contacts with `assistant contacts list --json` and filter for channels with `status: "blocked"`.

**"Create a Telegram invite link"** / **"Invite someone on Telegram"** -- Look up or create the contact first, then create an invite with `assistant contacts invites create --source-channel telegram --contact-id <contact_id>`, look up the bot username, build the deep link, and present it with sharing instructions.

**"Invite someone by email"** / **"Send an email invite"** -- Look up or create the contact first, then create an invite with `assistant contacts invites create --source-channel email --contact-id <contact_id>`. Present the 6-digit invite code and the assistant's email address. Tell the guardian to share both with the invitee.

**"Invite someone on WhatsApp"** -- Look up or create the contact first, then create an invite with `assistant contacts invites create --source-channel whatsapp --contact-id <contact_id>`. Present the 6-digit invite code. If `channelHandle` is returned, also present the assistant's WhatsApp number; otherwise, tell the guardian to share the code and instruct the invitee to send it to the assistant on WhatsApp.

**"Invite someone on Slack"** -- Look up or create the contact first, then create an invite with `assistant contacts invites create --source-channel slack --contact-id <contact_id>`. Present the 6-digit invite code and tell the guardian to have the invitee DM the code to the assistant's Slack bot.

**"Show my invites"** / **"List active invite links"** -- List invites with `assistant contacts invites list --source-channel telegram --json`, present active invites with uses remaining and expiration info. Use the appropriate `--source-channel` value for other channels.

**"Revoke invite"** / **"Cancel invite link"** -- List invites to identify the target, confirm, then revoke with `assistant contacts invites revoke <invite_id> --json`.

**"Create a voice invite for +15551234567"** -- Look up or create the contact first, then create a voice invite with `assistant contacts invites create --source-channel phone --contact-id <contact_id> --expected-external-user-id "+15551234567" --friend-name "<name>" --guardian-name "<name>"`. Present the invite code and instructions: the person must call from that number and enter the code.

**"Let my mom call in"** / **"Invite someone by phone"** -- Ask for the phone number in E.164 format, look up or create the contact first, then create a voice invite with `assistant contacts invites create --source-channel phone --contact-id <contact_id>`, and present the code + calling instructions.

**"Show my voice invites"** / **"List phone invites"** -- List invites with `assistant contacts invites list --source-channel phone --json`, present active invites with bound phone number and expiration info.

**"Revoke voice invite"** / **"Cancel the phone invite for +15551234567"** -- List voice invites, identify the target by phone number or note, confirm, then revoke with `assistant contacts invites revoke <invite_id> --json`.
