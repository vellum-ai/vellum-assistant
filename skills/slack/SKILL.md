---
name: slack
description: Send, read, and manage Slack messages
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "Slack"
---

You help users interact with their Slack workspace.

**Sending text is its own command: `assistant channels send`.** It posts through the same path a reply takes, so the message is threaded where you name a thread, rendered the way your other messages are, and recorded in the chat's conversation once Slack acknowledges it. That record is what lets you see later what you said, and what lets a reaction or an edit on that post find it again.

**Everything else is the Slack Web API via `assistant oauth request`**: reading, searching, reactions, opening a DM, uploading a file, and any method with no first-class command. Use relative Slack API method paths such as `/conversations.history`; the provider supplies the Slack host.

A message posted with `/chat.postMessage` reaches Slack but leaves no record, so you will not find it afterwards and nothing can resolve a reaction to it. Use the send command for text, and reach for `chat.postMessage` only for a shape the send command does not carry, such as Block Kit.

**In a Slack turn, the reply is the door.** When you are already answering in a chat, just reply; that reply is delivered and recorded for you. The send command is for posting somewhere you are not, or at a time nobody asked.

## Which provider to pass

Two Slack credentials can exist. They act as different identities and reach different things, so the right one depends on the operation, not only on which is configured.

| Provider        | Sends                      | Acts as       | Reaches                                           |
| --------------- | -------------------------- | ------------- | ------------------------------------------------- |
| `slack_channel` | the bot token              | the assistant | channels the bot has joined                       |
| `slack`         | the installer's user token | that person   | channels that person is in, and `search.messages` |

**Posting: `slack_channel`.** The send command always posts as the bot, which is the assistant's own identity, and takes no provider. The distinction still matters for a Web API post: a message sent through `slack` arrives from the person who connected it, not from the assistant. Where that is the only credential present, say so before posting rather than posting as them silently.

**`search.messages`: `slack` only.** It is a user-token method. `--provider slack_channel` sends the bot token even on an install that stored a user token, so it cannot serve search at all.

**Everything else: whichever is present**, preferring `slack_channel` when both are. Reach differs rather than one being better: the bot sees channels it was invited to, the user token sees channels that person belongs to.

A workspace has only `slack` when Slack was connected as an integration without running the setup wizard, which means no bot. `oauth status <provider>` reports whether a given one holds a connection. Passing a provider that holds none fails with a not-configured error rather than falling back on its own.

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

## Sending a message

The send command names the channel, the chat, and the text. It takes no provider and no token.

```bash
assistant channels send slack C0123456789 --text "Hello from the assistant!"
```

Add `--thread <ts>` to post inside a thread, `--plain` to send the text verbatim instead of the channel's rich rendering, and `--json` for a machine-readable result naming every message id Slack acknowledged and the conversation the post was recorded in.

The command refuses a channel it cannot address before anything is sent, and reports a failure rather than a success when Slack does not acknowledge the post. If it reports that the outcome is unknown, the message may still have gone out: check the chat before sending again.

## Making Slack API Calls

Use `assistant oauth request` to call any Slack Web API method. Auth is handled transparently: the provider injects its own token, which is the bot's for `slack_channel` and the installer's for `slack`. Pass relative method paths; do not include a host.

This is the only way to call the Slack Web API. Never fetch a Slack token yourself (`assistant credentials reveal`, an environment variable, a pasted value) and never call `slack.com/api` with `curl` or any other HTTP client: a token that reaches a shell command line is written into the transcript and the tool log, where no redaction applies. `assistant oauth request` sends the token from inside the assistant and never shows it to you. The command's name is the name of the authenticated-request command, not a description of the credential: for `slack_channel` it sends the bot token the setup wizard stored, and no OAuth flow is involved; `slack` is the separate OAuth integration that acts as the person who connected it.

The examples below use `slack_channel`, since reading a channel the bot has joined is what it is for. See [Which provider to pass](#which-provider-to-pass) before reaching for one on a workspace that has no bot, or for `search.messages`.

General pattern:

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","limit":20}' \
  /conversations.history --json
```

The model knows the full Slack API from training data. Refer to https://api.slack.com/methods for the complete list of available endpoints.

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

### Read back what you sent

When someone asks what you sent them earlier ("what did you send me this morning", "quote the digest from yesterday"), look in this order: the current conversation first; then `recall`, which searches your other conversations; then Slack itself, for anything older.

Anything you posted with the send command is recorded in the chat's conversation, so `recall` finds it. A post made with `chat.postMessage` is not, which is why reading Slack back is sometimes the only way to find one.

Reading Slack back is three calls on `slack_channel`. That is your own bot identity, and it is the right one here: a DM with you is your app's own DM, the posts you are looking for were made as the bot, and the history scopes this needs (`im:history`, `mpim:history`, `channels:history`, `groups:history`) are ones the app setup already requests.

1. **Know where you are.** When your `<turn_context>` carries `chat_id` (and `thread_id` for a message in a thread), that is the chat. Otherwise the person's contact record has the DM as `externalChatId` (see User Resolution below).

2. **Read the top level.** `conversations.history` returns only top-level messages, never thread replies. In a DM with you, every proactive post you made (a digest, a notification, a check-in from a run of your own) is top-level and appears here directly. Each thread you have taken part in appears only as its parent, carrying `reply_count`, `latest_reply`, and `reply_users`.

   Do not put the time window you were asked about into `oldest` here: history filters by each parent's own timestamp, and a thread started days ago can hold a reply you made this morning. Read recent parents by count instead, and follow `response_metadata.next_cursor` while the parents are still newer than the window you care about.

   ```bash
   assistant oauth request --provider slack_channel \
     -X POST \
     -d '{"channel":"D0123456789","limit":100}' \
     /conversations.history --json
   ```

3. **Read the threads you replied in.** Your own user id comes from `auth.test` (`user_id` in the response). Keep the parents whose `reply_users` includes it and whose `latest_reply` is not older than the window; fetch each of those threads. The first message returned is the parent, the rest are the replies in order; pick the replies whose `ts` falls in the window, and follow `next_cursor` on a long thread.

   ```bash
   assistant oauth request --provider slack_channel /auth.test --json

   assistant oauth request --provider slack_channel \
     -X POST \
     -d '{"channel":"D0123456789","ts":"1756800000.000100","limit":200}' \
     /conversations.replies --json
   ```

In an agent-style DM, every conversation the person starts with you is its own thread, so what you said in an earlier chat lives in that chat's replies, not in the thread you are answering from now. The parents from step 2 are the list of those chats; step 3 reads the ones you spoke in.

Do not reach for `search.messages` here. It is a user-token method: on `slack_channel` it fails with `not_allowed_token_type`, and on `slack` it would read as the person who connected the integration, with their reach, which is not what re-reading your own DM calls for.

If any of these calls fails with `missing_scope`, the installed app holds fewer scopes than the setup requests. Do not work around it: `assistant channels get slack` re-probes the install and names the missing scopes with the reinstall step, and the **slack-app-setup** skill walks the reconnect.

### Add a reaction

```bash
assistant oauth request --provider slack_channel \
  -X POST \
  -d '{"channel":"C0123456789","timestamp":"1716000000.000001","name":"thumbsup"}' \
  /reactions.add --json
```

### Send with blocks (rich formatting)

The send command renders ordinary markdown the way a reply is rendered, which covers most formatting. Reach for Block Kit only for a structure markdown cannot express, such as headers or buttons, and know that a post made this way is not recorded.

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

File uploads use a multi-step flow: get an upload URL, upload the file, then complete the upload. The send command carries text only, so a file still goes this way.

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

Takes `slack`, not `slack_channel`: `search.messages` is a user-token method, and the bot token cannot call it. A workspace with no `slack` connection cannot search this way; say so instead of reporting an empty result.

```bash
assistant oauth request --provider slack \
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
2. **Post or read**: to say something, use the send command with that ID. For anything else, use `assistant oauth request --provider slack_channel`.
3. **For DMs**: Use `bun skills/slack/scripts/slack-resolve.ts user <name>` to get the user ID, then `conversations.open` to get the DM channel ID, then post to that DM channel ID with the send command.

## User Resolution

When you need to send a DM or look up a Slack user by name, check contacts first to avoid redundant API calls:

1. **Before calling the resolve script**: Use `contact_search` with `query: "<name>"` and `channel_type: "slack"`. If a matching contact has `externalUserId` (Slack user ID) and `externalChatId` (DM channel ID), skip the API lookups and post to the DM channel ID with the send command.

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

When you post into a chat where a conversation is already running, thread it. Name the thread's parent timestamp with `--thread`:

```bash
assistant channels send slack C0123456789 \
  --thread 1716000000.000001 \
  --text "Replying in thread"
```

When you are answering a Slack turn you are already in, reply instead: that reply is threaded and recorded without a command.

## Connection

Before making any Slack API calls, verify that Slack is connected. If not connected, load the **slack-app-setup** skill (`skill_load` with `skill: "slack-app-setup"`) and follow its guided flow. Do NOT improvise setup instructions -- the `slack-app-setup` skill is the single source of truth. Slack uses Socket Mode and does not require redirect URLs or any OAuth flow.

## Error Handling

If a Slack API call fails due to missing or invalid credentials -- for example, an error indicating that the token is missing or invalid -- do NOT attempt to fix the credentials manually. Instead, load the **slack-app-setup** skill (`skill_load` with `skill: "slack-app-setup"`) and follow its guided flow to set up or reconnect Slack. Tell the user something like "Slack needs to be reconnected" and start the setup skill.

## Delivery Notes

- For text, including digests, reports, and formatted summaries: the send command, which records what it posted. Markdown is rendered the way a reply is.
- For a structure markdown cannot express (headers, buttons): `chat.postMessage` with blocks via `assistant oauth request --provider slack_channel`, knowing the post is not recorded.
- For short alerts: `assistant notifications send` via `bash` is fine -- it lets the notification router pick the best channel
- For a task that runs on its own: the **schedule** skill's Delivering Results section covers how a scheduled run delivers what it produced
