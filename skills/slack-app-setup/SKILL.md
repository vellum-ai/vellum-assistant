---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode with one-click app creation and identity verification
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    display-name: "Slack App Setup"
    includes: ["guardian-verify-setup"]
---

You are helping your user connect a Slack bot to the Vellum Assistant via Socket Mode.

**Before starting, set expectations:** "We're creating a custom Slack app for your assistant — this gives you your own bot identity, avatar, and name in Slack. There are a few steps to get through, but most of it is automated."

**CRITICAL: This skill contains exact commands to run. You MUST execute the bash commands as written — do NOT improvise, summarize, or "walk through manually." The manifest, scopes, and settings are precise. If you skip the bash command and show raw YAML/JSON instead, the manifest will be incomplete and setup will fail.**

## Value Classification

| Value         | Type       | Storage method            | Secret? |
| ------------- | ---------- | ------------------------- | ------- |
| App Token     | Credential | `credential_store` prompt | **Yes** |
| Bot Token     | Credential | `credential_store` prompt | **Yes** |
| User Token    | Credential | `credential_store` prompt | **Yes** |

- All credentials are collected via `credential_store` prompt — never accept them pasted in plaintext chat.

# Setup Steps

## Step 0: Check Existing Configuration

Before starting setup, check whether Slack is already configured by listing stored credentials:

- Call `credential_store` with `action: "list"` (no other arguments).

The result is a JSON array where each entry has at minimum `credential_id`, `service`, and `field`. The `list` action only returns credentials whose secret is still present in secure storage, so an entry's presence is a reliable signal that the token is stored.

Scan the array for entries matching `service: "slack_channel"` and determine which of the following `field` values are present:

- `app_token`
- `bot_token`
- `user_token`

Then branch on the state of `app_token` and `bot_token` first (those are the required pair), and treat `user_token` as a secondary dimension:

- If `app_token` and `bot_token` are **both** present:
  - If `user_token` is also present — Slack is fully configured with full triage visibility. Offer to show status or reconfigure.
  - If `user_token` is missing — Slack is connected with **bot-only visibility**. Offer to collect the user token now (Step 2) to enable full triage visibility across all channels the user is in. The user token is optional; if they decline, leave the setup as-is.
- If exactly **one** of `app_token` or `bot_token` is present — offer to resume setup from the missing step. (If a `user_token` is also present, leave it in place; it will be re-validated against the bot's workspace once setup completes.)
- If **neither** `app_token` nor `bot_token` is present — continue to Step 1. (If a `user_token` is present without a paired bot/app, it is orphaned from a prior incomplete setup. Tell the user it will be replaced during this run, and proceed.)

Note: `user_token` is optional. Missing `user_token` is **not** blocking — setup is considered complete with just the app and bot tokens (bot-only visibility).

## Step 1: Create Slack App (One-Click)

Ask the user what they'd like to name their Slack bot and optionally provide a short description. Then generate the manifest creation URL.

**MANDATORY — you MUST run the script below to build the manifest URL.** Do NOT write your own manifest. Do NOT show YAML or JSON to the user. Do NOT tell the user to paste a manifest. The script contains the complete, correct manifest with all required scopes, event subscriptions, and socket mode settings. Running it produces a single pre-filled URL that creates the app with everything configured.

Run this `bash` command, replacing `<user_name>` and `<user_description>` with the user's chosen values:

```
bash {
  command: "bun skills/slack-app-setup/generate-manifest-url.ts '<user_name>' '<user_description>'"
  activity: "to generate the Slack app manifest link"
}
```

If a value contains a single quote, escape it as `'\''` (closes the quote, adds an escaped literal quote, reopens the quote).

The command outputs a ready-to-click URL. **Present it as a markdown link** so the full URL renders as a single clickable element — e.g. `[Click here to create your Slack app](URL)`. Do NOT paste the raw URL as plain text — it is too long and will break across lines, preventing the user from clicking it. Tell them: "Click the link, select your workspace, and click **Create**. All permissions, events, and Socket Mode are pre-configured."

Wait for the user to confirm they've created the app before proceeding.

## Step 2: Collect Credentials

Now collect credentials from the Slack app settings.

### Step 2a: App Token

The app token does not exist yet — the user must generate it. Tell the user: on the Basic Information page, scroll to **App-Level Tokens**, click **Generate Token and Scopes**, name it "Socket Mode", add scope `connections:write`, and click **Generate**. Copy the token (starts with `xapp-`).

Then collect it securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "app_token"`, `label: "App-Level Token"`, `placeholder: "xapp-..."`, `description: "Paste the App-Level Token you just generated"`

### Step 2b: Install App to Workspace

Tell the user: in the left sidebar of your Slack app settings, go to **Install App**, then click **Install to Workspace**. Slack will ask you to authorize — click **Allow**.

After installing, the page will show the **Bot User OAuth Token** (starts with `xoxb-`) and optionally a **User OAuth Token** (starts with `xoxp-`).

### Step 2c: Bot Token

Tell the user to copy the **Bot User OAuth Token** from the Install App page.

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "bot_token"`, `label: "Bot User OAuth Token"`, `placeholder: "xoxb-..."`, `description: "From Install App page — the Bot User OAuth Token"`

### Step 2d: User Token (Optional)

If a **User OAuth Token** is shown on the same page, collect it for full triage visibility. If it's not shown, skip this step — the bot will work with bot-only visibility.

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "user_token"`, `label: "User OAuth Token"`, `placeholder: "xoxp-..."`, `description: "From Install App page — the User OAuth Token (optional, for full channel visibility)"`

Tell the user: the user token is optional — it enables the assistant to see messages in all channels you're in, not just channels the bot has been added to. If they'd rather skip it, that's fine.

## Step 3: Test Your Connection

Now let's test the connection by verifying the user can receive messages from the bot. This confirms everything works and links the user's Slack identity for future message delivery.

Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user explicitly wants to skip this step, proceed to Step 4, but let them know they can always verify later by saying "verify me on slack".

## Step 4: Report Success

Summarize with the completed checklist.

If identity was verified:

"Setup complete!
✅ App created
✅ Tokens configured
✅ Connection active
✅ Connection tested
{triage_line}

Connected: @{botUsername} in {workspace}
Channels: @mention the bot in any channel to add it, or use `/invite @{botUsername}`. DMs work immediately.
Identity: verified"

If identity was skipped:

"Setup complete!
✅ App created
✅ Tokens configured
✅ Connection active
⬜ Connection tested — you can complete this anytime by saying 'verify me on slack'
{triage_line}

Connected: @{botUsername} in {workspace}
Channels: @mention the bot in any channel to add it, or use `/invite @{botUsername}`. DMs work immediately.
Identity: skipped"

For `{triage_line}`, use:

- If a user token was collected in Step 2d: `✅ Triage visibility: full (can read all your channels)`
- If the user skipped the user token: `⬜ Triage visibility: bot-only (only channels the bot is a member of) — you can collect a user token anytime to enable full triage`

## Troubleshooting

### Bot not responding in channels

The bot must be added to each channel where you want it to listen. @mention the bot in the channel — Slack will prompt "Add Them" — or use `/invite @{botUsername}`.

### Socket Mode disconnects

The app token may be revoked or expired. Regenerate it in your Slack app settings under **Basic Information > App-Level Tokens**, then re-enter via credential_store prompt.

### Token validation fails

Re-enter the token via credential_store prompt. The handler validates tokens on entry — if it rejects the token, double-check you're copying the right value from the Slack app settings.

### Messages not appearing

Verify that `message.channels` event subscription is enabled in your Slack app settings under **Event Subscriptions > Subscribe to bot events**. The manifest pre-configures this, but it can be accidentally removed.

### Bot token not showing after install

If the **Install App** page doesn't show a Bot User OAuth Token after installation, the app may not have bot scopes configured. Verify that **OAuth & Permissions > Scopes > Bot Token Scopes** lists the expected scopes (the manifest pre-configures these). If scopes are missing, the app was likely created without the manifest — start over from Step 1.

## Implementation Rules

- **Do NOT improvise or write your own manifest.** The `generate-manifest-url.ts` script in Step 1 contains the only correct manifest. If you show raw YAML/JSON or write a manifest from memory, it WILL be missing scopes, event subscriptions, or socket mode settings and setup will fail.
- **Do NOT skip the script in Step 1.** You must run it to generate the pre-filled URL. The user should never have to paste a manifest — they click a link.
- All credential collection goes through `credential_store` prompts. Do NOT use `ui_show`, `ui_update`, `assistant credentials reveal`, or other mechanisms. Do NOT ask the user to paste tokens in chat — always use the secure credential prompt.

## Clearing Credentials

To disconnect Slack, prefer the Settings UI path so the same Slack settings handler used by Settings clears both secure tokens and workspace metadata together.
