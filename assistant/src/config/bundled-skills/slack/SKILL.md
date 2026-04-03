---
name: slack
description: Read, send, and manage Slack messages via the Web API
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    display-name: "Slack"
---

You help users interact with their Slack workspace. All Slack operations use the **Slack Web API** directly via the `bash` tool with credential proxy — there are no dedicated Slack tools.

## Making Slack API Calls

Use `bash` with these parameters:

- **`network_mode`**: `"proxied"`
- **`credential_ids`**: `["slack_channel/bot_token"]`

The proxy intercepts requests to `slack.com` and injects the bot token as a `Bearer` header automatically. You never see or handle the token directly.

Example — list channels:

```
bash {
  command: "curl -s https://slack.com/api/conversations.list?types=public_channel,private_channel | jq ."
  network_mode: "proxied"
  credential_ids: ["slack_channel/bot_token"]
  activity: "to list your Slack channels"
}
```

Refer to https://api.slack.com/methods for available endpoints. The bot token scopes configured in the Slack app manifest determine what's accessible.

## Common Operations

### Reading messages

- `conversations.list` — list channels
- `conversations.history` — read recent messages in a channel
- `conversations.replies` — read a full thread
- `users.info` — resolve user IDs to display names

### Sending messages

- `chat.postMessage` — send a message to a channel or DM
- `chat.update` — edit a message the bot previously sent
- `chat.delete` — delete a message the bot previously sent

### Reacting & managing

- `reactions.add` — add an emoji reaction
- `conversations.leave` — leave a channel
- `search.messages` — search across the workspace

### Channel scanning

When the user asks to scan or catch up on Slack:

1. Call `conversations.list` to get active channels, then `conversations.history` for each
2. Present an overview first: channel names, message counts, top threads
3. Offer to drill into specific threads with `conversations.replies`
4. Summarize with attribution: who said what, decisions made, open questions

## User Resolution

When you need to send a DM or look up a Slack user by name, check contacts first to avoid redundant API calls:

1. **Before calling `users.list`**: Use `contact_search` with `query: "<name>"` and `channel_type: "slack"`. If a matching contact has `externalUserId` (Slack user ID) and `externalChatId` (DM channel ID), skip the API lookups and use those IDs directly with `chat.postMessage`.

   When `contact_search` returns notes for the recipient, use them to inform the message's tone, formality, and content. Contact notes capture relationship context and communication preferences that should shape how you write to this person.

2. **After resolving via API**: When you had to call `users.list` or `conversations.open` to resolve a user, save the contact with `contact_upsert` so you can find them by name next time. External Slack IDs (user ID, DM channel ID) are cached automatically by the messaging layer and should not be passed through `contact_upsert`.

## Privacy Rules

**Channel privacy must be respected at all times:**

- Check `is_private` on each channel before sharing content elsewhere
- Private channel content must NEVER be shared to other channels, DMs, or external destinations
- If the user asks to share private channel content, explain why you can't and offer alternatives (summarize the topic without quoting, ask the user to share manually)
- Public channel content can be shared with attribution ("From #channel: ...")
- Always confirm with the user before sending content to any destination

## Delivery Notes

- For rich content (digests, reports, formatted summaries): use the Slack API directly via `chat.postMessage` with blocks
- For short alerts: `send_notification` is fine — it lets the notification router pick the best channel
- For scheduled tasks: always include an explicit Slack API call to deliver results, otherwise output only lives in the conversation log

## Threading

When responding to messages from Slack channels, replies should be threaded. Pass `thread_ts` to `chat.postMessage` to reply in a thread rather than posting a new top-level message.

## Connection

Before making any Slack API calls, verify that Slack is connected. If not connected, load the **slack-app-setup** skill (`skill_load` with `skill: "slack-app-setup"`) and follow its guided flow. Do NOT improvise setup instructions — the `slack-app-setup` skill is the single source of truth. Slack uses Socket Mode and does not require redirect URLs or any OAuth flow.

## Error Handling

If a Slack API call fails due to missing or invalid credentials — for example, an error indicating that `slack_channel/bot_token` is not found, the credential is missing, or the token is invalid — do NOT attempt to fix the credentials manually. Instead, load the **slack-app-setup** skill (`skill_load` with `skill: "slack-app-setup"`) and follow its guided flow to set up or reconnect Slack. Tell the user something like "Slack needs to be reconnected" and start the setup skill.

## Communication Style

- **Be action-oriented.** When the user asks to check Slack, start scanning immediately.
- **Keep it human.** Never mention OAuth, tokens, APIs, proxies, or credential IDs. If something isn't working, say "Slack needs to be reconnected."
- **Show progress.** When scanning multiple channels, tell the user what you're doing.
