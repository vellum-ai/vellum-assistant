---
name: slack
description: Read, send, and manage Slack messages via the Web API
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "Slack"
---

You help users interact with their Slack workspace. All Slack operations use the **Slack Web API** directly via `assistant oauth request --provider slack_channel` -- there are no dedicated Slack tools. Use relative Slack API method paths such as `/chat.postMessage`; the provider supplies the Slack host.

## Resolution Scripts

Use these scripts to resolve Slack channel and user names to IDs. Results are cached locally so repeated lookups are free (no API calls).

| Command                                                          | Description                                      |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `bun skills/slack/scripts/slack-resolve.ts channel <name>`       | Resolve a channel name to its ID                 |
| `bun skills/slack/scripts/slack-resolve.ts user <name-or-email>` | Resolve a user display name or email to their ID |
| `bun skills/slack/scripts/slack-resolve.ts channels [--refresh]` | List all cached channels, or refresh the cache   |

All scripts return JSON:

- **Success**: `{ "ok": true, "data": { "id": "C...", "name": "general", ... } }`
- **Failure**: `{ "ok": false, "error": "..." }`

The cache is stored locally under `$VELLUM_WORKSPACE_DIR/data/slack-skill/`. On first use the script fetches all channels/users from Slack and caches them. Subsequent lookups read from the cache with no API calls. Pass `--refresh` to force a refresh.

## Making Slack API Calls

Use `assistant oauth request --provider slack_channel` to call any Slack Web API method. Auth is handled transparently -- the provider injects the bot token automatically. Pass relative method paths; do not include a host.

General pattern:

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C123","text":"Hello world"}' \
  /chat.postMessage --json
```

The model knows the full Slack API from training data. Refer to https://api.slack.com/methods for the complete list of available endpoints.

### Send a message

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","text":"Hello from the assistant!"}' \
  /chat.postMessage --json
```

### Read channel history

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","limit":20}' \
  /conversations.history --json
```

### Read thread replies

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","ts":"1716000000.000001"}' \
  /conversations.replies --json
```

### Add a reaction

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","timestamp":"1716000000.000001","name":"thumbsup"}' \
  /reactions.add --json
```

### Send with blocks (rich formatting)

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{
    "channel":"C0123456789",
    "text":"Fallback text",
    "blocks":[
      {"type":"header","text":{"type":"plain_text","text":"Weekly Update"}},
      {"type":"section","text":{"type":"mrkdwn","text":"*Project Alpha*: on track\n*Project Beta*: needs review"}}
    ]
  }' \
  /chat.postMessage --json
```

### Upload a file

File uploads use a multi-step flow: get an upload URL, upload the file, then complete the upload.

```bash
# Step 1: Get an upload URL
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"filename":"notes.txt","length":42}' \
  /files.getUploadURLExternal --json

# Step 2: Upload file content to the returned upload_url (use curl directly)
# Step 3: Complete the upload
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"files":[{"id":"FILE_ID","title":"Meeting Notes"}],"channel_id":"C0123456789"}' \
  /files.completeUploadExternal --json
```

### Search messages

```bash
assistant oauth request --provider slack_channel \
  "/search.messages?query=project+launch+in%3A%23general" --json
```

### Open a DM

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"users":"U0123456789"}' \
  /conversations.open --json
```

## Typical Workflow

1. **Resolve the channel**: `bun skills/slack/scripts/slack-resolve.ts channel general` to get the channel ID.
2. **Call the API**: Use `assistant oauth request --provider slack_channel` with that ID for the actual operation (send, read, react, etc.).
3. **For DMs**: Use `bun skills/slack/scripts/slack-resolve.ts user <name>` to get the user ID, then `conversations.open` to get the DM channel ID, then `chat.postMessage` to send the message.

## User Resolution

When you need to send a DM or look up a Slack user by name, check contacts first to avoid redundant API calls:

1. **Before calling the resolve script**: Use `contact_search` with `query: "<name>"` and `channel_type: "slack"`. If a matching contact has `externalUserId` (Slack user ID) and `externalChatId` (DM channel ID), skip the API lookups and use those IDs directly with `chat.postMessage` via `assistant oauth request --provider slack_channel`.

   When `contact_search` returns notes for the recipient, use them to inform the message's tone, formality, and content. Contact notes capture relationship context and communication preferences that should shape how you write to this person.

2. **After resolving via script**: When you had to use `slack-resolve.ts user` or `conversations.open` to resolve a user, save the contact with `contact_upsert` so you can find them by name next time. External Slack IDs (user ID, DM channel ID) are cached automatically by the messaging layer and should not be passed through `contact_upsert`.

## Privacy Rules

**Channel privacy must be respected at all times:**

- Check `is_private` on each channel before sharing content elsewhere
- Private channel content must NEVER be shared to other channels, DMs, or external destinations
- If the user asks to share private channel content, explain why you can't and offer alternatives (summarize the topic without quoting, ask the user to share manually)
- Public channel content can be shared with attribution ("From #channel: ...")
- Always confirm with the user before sending content to any destination

## Threading

When responding to messages from Slack channels, replies should be threaded. Pass `thread_ts` to `chat.postMessage` to reply in a thread rather than posting a new top-level message:

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","text":"Replying in thread","thread_ts":"1716000000.000001"}' \
  /chat.postMessage --json
```

## Connection

Before making any Slack API calls, verify that Slack is connected. If not connected, load the **slack-app-setup** skill (`skill_load` with `skill: "slack-app-setup"`) and follow its guided flow. Do NOT improvise setup instructions -- the `slack-app-setup` skill is the single source of truth. Slack uses Socket Mode and does not require redirect URLs or any OAuth flow.

## Error Handling

If a Slack API call fails due to missing or invalid credentials -- for example, an error indicating that the token is missing or invalid -- do NOT attempt to fix the credentials manually. Instead, load the **slack-app-setup** skill (`skill_load` with `skill: "slack-app-setup"`) and follow its guided flow to set up or reconnect Slack. Tell the user something like "Slack needs to be reconnected" and start the setup skill.

## Delivery Notes

- For rich content (digests, reports, formatted summaries): use `chat.postMessage` with blocks via `assistant oauth request --provider slack_channel`
- For short alerts: `assistant notifications send` via `bash` is fine -- it lets the notification router pick the best channel
- For scheduled tasks: always include an explicit Slack API call to deliver results, otherwise output only lives in the conversation log
