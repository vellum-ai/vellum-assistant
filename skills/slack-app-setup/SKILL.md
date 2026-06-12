---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode. Pre-fills a one-click manifest URL so the user only has to name, save, and copy three tokens.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "Slack App Setup"
    includes: ["guardian-verify-setup"]
---

You are helping your user connect a Slack bot to the Vellum Assistant via Socket Mode.

The flow has four user actions: **click**, **install**, **copy tokens**, **verify**. The skill's job is to keep it that short — every other detail is pre-baked into the manifest the user creates from a single URL.

**Set expectations once:** "We're creating a custom Slack app for your assistant — your own bot identity, avatar, and name. The link below pre-configures every scope, event, and setting; you just name it and save."

## ⚡ DO THIS FIRST

1. Check existing credentials (Step 0) — Slack may already be connected.
2. Generate the manifest URL via the bundled script (Step 1) — **never hand-write the manifest**, JSON or otherwise.
3. Collect tokens through `credential_store` prompts — **never accept tokens pasted in chat**.

## ⛔ DO NOT

- Do **NOT** write the manifest yourself. The script is the only source of truth for scopes/events/settings. A hand-rolled manifest will be missing pieces and setup will fail silently downstream.
- Do **NOT** show YAML or raw JSON to the user — show the link.
- Do **NOT** ask the user to paste tokens in chat — always route through the secure `credential_store` prompt.
- Do **NOT** paste the raw URL as plain text — render it as a markdown link, the encoded URL is long and will wrap.

## Value Classification

| Value      | Type       | Storage method            | Secret? |
| ---------- | ---------- | ------------------------- | ------- |
| App Token  | Credential | `credential_store` prompt | **Yes** |
| Bot Token  | Credential | `credential_store` prompt | **Yes** |
| User Token | Credential | `credential_store` prompt | **Yes** |

## Step 0: Check Existing Configuration

Call `credential_store` with `action: "list"` (no other arguments). Scan the result for entries with `service: "slack_channel"` and note which of `app_token`, `bot_token`, `user_token` are present.

| `app_token` | `bot_token` | `user_token` | What to do |
| --- | --- | --- | --- |
| ✅ | ✅ | ✅ | Fully configured. Offer to show status or reconfigure. |
| ✅ | ✅ | ❌ | Bot-only visibility. Offer Step 2c to add the user token. |
| ✅ or ❌ (one missing) | ✅ or ❌ | any | Resume from the missing step. |
| ❌ | ❌ | any | Continue to Step 1. An orphan `user_token` will be replaced. |

`user_token` is **optional**; missing it is not blocking.

## Step 1: Create the Slack App (One Click)

Infer the bot identity yourself — do not ask the user to confirm before generating the link.

- **Bot name:** your assigned assistant name. If unset, prompt the user to name you first.
- **Description:** `Assistant for {guardianName}`, from the current user context / `users/default.md`.

Run the bundled script — env vars carry the inputs so quoting can never break the URL:

```
bash {
  command: "BOT_NAME='<bot_name>' BOT_DESC='<description>' bun run skills/slack-app-setup/scripts/build-manifest-url.ts"
  activity: "to generate the Slack app manifest link"
}
```

Output is JSON: `{ "ok": true, "data": { "url": "..." } }`. Extract `data.url`.

**Render it as a markdown link** — do not paste the raw URL:

> [Click here to create your Slack app](URL)

Tell the user: *"Click the link, pick your workspace, click **Create**. All scopes, events, and Socket Mode are pre-configured — you don't need to touch anything on the creation page."*

Wait for confirmation before continuing.

## Step 2: Tokens (One Page Each)

### Step 2a — App-Level Token (Basic Information page)

Slack lands the user on **Basic Information** after Create. Tell them:

> Scroll to **App-Level Tokens** → **Generate Token and Scopes** → name it "Socket Mode" → add scope `connections:write` → **Generate**. Copy the token (starts with `xapp-`).

Collect securely:

- `credential_store` `action: "prompt"`, `service: "slack_channel"`, `field: "app_token"`, `label: "App-Level Token"`, `placeholder: "xapp-..."`, `description: "Paste the App-Level Token you just generated"`

### Step 2b — Install + Bot Token

Tell the user:

> In the left sidebar → **Install App** → **Install to Workspace** → **Allow**. The page that loads shows your **Bot User OAuth Token** (`xoxb-...`) and possibly a **User OAuth Token** (`xoxp-...`). Copy the bot token.

Collect securely:

- `credential_store` `action: "prompt"`, `service: "slack_channel"`, `field: "bot_token"`, `label: "Bot User OAuth Token"`, `placeholder: "xoxb-..."`, `description: "From Install App page — the Bot User OAuth Token"`

### Step 2c — User Token (optional, same page)

If the Install App page also shows a **User OAuth Token**, collect it for full triage visibility (lets the assistant see every channel the user is in, not just channels the bot was added to). If it's not shown, skip.

- `credential_store` `action: "prompt"`, `service: "slack_channel"`, `field: "user_token"`, `label: "User OAuth Token"`, `placeholder: "xoxp-..."`, `description: "From Install App page — the User OAuth Token (optional, for full channel visibility)"`

Tell the user the user token is optional and they can add it later.

## Step 3: Verify Identity

Load the **guardian-verify-setup** skill:

- `skill_load` with `skill: "guardian-verify-setup"`.

If the user wants to skip, continue to Step 4 and let them know they can run it later by saying *"verify me on slack"*.

## Step 4: Report Success

If identity was verified:

> Setup complete!
> ✅ App created
> ✅ Tokens configured
> ✅ Connection active
> ✅ Connection tested
> {triage_line}
>
> Connected: @{botUsername} in {workspace}
> Channels: @mention the bot in any channel to add it, or use `/invite @{botUsername}`. DMs work immediately.
> Identity: verified

If identity was skipped, swap the last two lines for:

> ⬜ Connection tested — say "verify me on slack" to finish later.
> …
> Identity: skipped

`{triage_line}` is:

- `✅ Triage visibility: full (can read all your channels)` if a user token was collected,
- `⬜ Triage visibility: bot-only (only channels the bot is a member of) — collect a user token anytime to enable full triage` otherwise.

## If Something Fails

**Bot doesn't respond in a channel.** The bot must be a member. @mention it (Slack will prompt "Add Them") or `/invite @{botUsername}`.

**Socket Mode keeps disconnecting.** The app token is revoked or expired. Regenerate it in **Basic Information → App-Level Tokens** and re-run the `app_token` prompt.

**Token rejected on prompt.** The handler validates on entry. Re-prompt; double-check you copied the right value (bot token starts `xoxb-`, app token `xapp-`, user token `xoxp-`).

**Messages not arriving.** Verify **Event Subscriptions → Subscribe to bot events** includes `message.channels`. The manifest pre-configures it, but it can be edited out by hand.

**No Bot User OAuth Token on the Install App page.** The app was likely created without the manifest. Verify **OAuth & Permissions → Scopes → Bot Token Scopes** is populated; if empty, start over from Step 1 — do not hand-edit scopes.

## Clearing Credentials

To disconnect, prefer the Settings UI path — it clears both the secure tokens and the workspace metadata together, matching the in-app Settings handler.
