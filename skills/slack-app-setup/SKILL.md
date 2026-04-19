---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode with guided app creation and identity verification
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    display-name: "Slack App Setup"
    includes: ["guardian-verify-setup"]
---

You are helping your user connect a Slack bot to the Vellum Assistant via Socket Mode. Walk through each step below.

**Before starting, set expectations:** "We're creating a custom Slack app for your assistant — this gives you your own bot identity, avatar, and name in Slack. There are a few steps to get through, but most of it is automated."

**CRITICAL: Follow these steps strictly in order. Do NOT combine steps or skip ahead.**

## Value Classification

| Value         | Type       | Storage method            | Secret? |
| ------------- | ---------- | ------------------------- | ------- |
| App Token     | Credential | `credential_store` prompt | **Yes** |
| Client ID     | Credential | `credential_store` prompt | **Yes** |
| Client Secret | Credential | `credential_store` prompt | **Yes** |
| Bot Token     | Credential | OAuth (automatic)         | **Yes** |
| User Token    | Credential | OAuth (automatic)         | **Yes** |

- App Token, Client ID, and Client Secret are collected via `credential_store` prompt — never accept them pasted in plaintext chat.
- Bot Token and User Token are captured automatically via the OAuth install flow.

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
  - If `user_token` is missing — Slack is connected with **bot-only visibility**. Offer to collect the user token now (Step 3) to enable full triage visibility across all channels the user is in. The user token is optional; if they decline, leave the setup as-is.
- If exactly **one** of `app_token` or `bot_token` is present — offer to resume setup from the missing step. (If a `user_token` is also present, leave it in place; it will be re-validated against the bot's workspace once setup completes.)
- If **neither** `app_token` nor `bot_token` is present — continue to Step 1. (If a `user_token` is present without a paired bot/app, it is orphaned from a prior incomplete setup. Tell the user it will be replaced during this run, and proceed.)

Note: `user_token` is optional. Missing `user_token` is **not** blocking — setup is considered complete with just the app and bot tokens (bot-only visibility).

## Step 1: Generate Manifest & Create Slack App

Ask the user what they'd like to name their Slack bot and optionally provide a short description. Use their answers (or sensible defaults) to generate the manifest creation URL.

**IMPORTANT — use `bash` to build the manifest and URL programmatically.** Do NOT manually interpolate the user's name into a JSON string — special characters (quotes, backslashes, slashes, etc.) will break the JSON or the URL. Instead, run a `bash` command that passes the name and description via environment variables (so the shell never interprets user input) and uses `bun -e` with `JSON.stringify` and `encodeURIComponent` to safely build the JSON and URL.

Run this `bash` command, setting `BOT_NAME` and `BOT_DESC` to the user's chosen values:

```
bash {
  command: "BOT_NAME='<user_name>' BOT_DESC='<user_description>' bun -e \"const name = process.env.BOT_NAME; const desc = process.env.BOT_DESC; const manifest = { display_information: { name, description: desc, background_color: '#1a1a2e' }, features: { app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false }, bot_user: { display_name: name, always_online: true } }, oauth_config: { scopes: { bot: ['app_mentions:read','assistant:write','channels:history','channels:join','channels:read','chat:write','files:read','files:write','groups:history','groups:read','im:history','im:read','im:write','mpim:history','mpim:read','reactions:read','reactions:write','users:read'], user: ['channels:history','channels:read','groups:history','groups:read','im:history','im:read','mpim:history','mpim:read','users:read','search:read','reactions:read'] } }, settings: { event_subscriptions: { bot_events: ['app_mention','message.channels','message.groups','message.im','message.mpim','reaction_added'] }, interactivity: { is_enabled: true }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false } }; const url = 'https://api.slack.com/apps?new_app=1&manifest_json=' + encodeURIComponent(JSON.stringify(manifest)); console.log(url);\""
  activity: "to generate the Slack app manifest link"
}
```

Replace `<user_name>` and `<user_description>` with the user's chosen values inside the single quotes. If a value contains a single quote, escape it as `'\''` (closes the quote, adds an escaped literal quote, reopens the quote).

The command outputs a ready-to-click URL. Present it to the user: "Click this link to create your Slack app. It's pre-configured with all the right permissions, events, and Socket Mode. Just select your workspace and click **Create**."

Wait for the user to confirm they've created the app before proceeding.

## Step 2: Add Redirect URL

After creating the app, tell the user to navigate to **OAuth & Permissions** in the sidebar, then scroll to **Redirect URLs** and:

1. Click **Add New Redirect URL**
2. Enter: `http://localhost:17322/oauth/callback`
3. Click **Add**, then click **Save URLs**

This enables the automated OAuth install in Step 3. Wait for the user to confirm before proceeding.

## Step 3: Collect Credentials & Install via OAuth

The user should navigate back to **Basic Information**. We need three values from this page, then we'll automate the rest.

### Step 3a: App Token

Tell the user to scroll to **App-Level Tokens** on the Basic Information page, then:

1. Click **Generate Token and Scopes**
2. Token name: "Socket Mode" (or any name they prefer)
3. Add scope: `connections:write`
4. Click **Generate**

Collect the app token securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "app_token"`, `label: "App-Level Token"`, `placeholder: "xapp-..."`, `description: "Paste the App-Level Token you just generated"`

If it succeeds, continue. If it returns an error, ask the user to re-enter the token.

### Step 3b: Client ID

Tell the user to scroll to **App Credentials** on the same Basic Information page. The Client ID is displayed there.

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "client_id"`, `label: "Client ID"`, `description: "From Basic Information > App Credentials"`

### Step 3c: Client Secret

The Client Secret is right below the Client ID on the same page (the user may need to click "Show" to reveal it).

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "client_secret"`, `label: "Client Secret"`, `placeholder: "starts with a long alphanumeric string"`, `description: "From Basic Information > App Credentials (click Show to reveal)"`

### Step 3d: Run OAuth Install

Now that all three credentials are stored, trigger the automated OAuth install. This opens the user's browser to Slack's authorization page — they just click **Allow**.

Tell the user: "Opening your browser now — just select your workspace and click **Allow** to install the app."

Then call the OAuth install endpoint via the gateway:

```
bash {
  command: "curl -s -X POST ${INTERNAL_GATEWAY_BASE_URL}/v1/integrations/slack/channel/oauth-install -H 'Content-Type: application/json'"
  activity: "to run the Slack OAuth install flow"
  timeout: 360000
}
```

This endpoint reads the stored Client ID and Client Secret, opens a browser to Slack's OAuth consent screen, and automatically captures the bot token and user token when the user clicks **Allow**. It blocks until the user completes authorization (up to 5 minutes).

Parse the JSON response:

- If `success: true` — bot and user tokens were captured and stored automatically. Continue to Step 4.
- If `success: false` — show the `error` field and troubleshoot. Common issues:
  - "Client ID not found" / "Client Secret not found" — re-collect the missing credential via Step 3b/3c.
  - "OAuth flow failed: OAuth2 loopback callback timed out" — the user didn't complete authorization in time. Re-run Step 3d.
  - "OAuth flow failed: OAuth2 authorization denied" — the user clicked Cancel or the workspace requires admin approval.

After the OAuth install succeeds, show the user their setup progress:

"Setup progress:
✅ App created
✅ Tokens configured (bot + user tokens captured automatically)
✅ Connection active
⬜ Connection tested

Almost there — let's do a quick test!"

## Step 4: Test Your Connection

Now let's test the connection by verifying the user can receive messages from the bot. This confirms everything works and links the user's Slack identity for future message delivery.

Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user explicitly wants to skip this step, proceed to Step 5, but let them know they can always verify later by saying "verify me on slack".

## Step 5: Report Success

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

- If `hasUserToken` was `true` in the OAuth response: `✅ Triage visibility: full (can read all your channels)`
- If `hasUserToken` was `false`: `⬜ Triage visibility: bot-only (only channels the bot is a member of) — you can collect a user token anytime to enable full triage`

## Troubleshooting

### Bot not responding in channels

The bot must be added to each channel where you want it to listen. @mention the bot in the channel — Slack will prompt "Add Them" — or use `/invite @{botUsername}`.

### Socket Mode disconnects

The app token may be revoked or expired. Regenerate it in your Slack app settings under **Basic Information > App-Level Tokens**, then re-enter via credential_store prompt.

### Token validation fails

Re-enter the token via credential_store prompt. The handler validates tokens on entry — if it rejects the token, double-check you're copying the right value from the Slack app settings.

### Messages not appearing

Verify that `message.channels` event subscription is enabled in your Slack app settings under **Event Subscriptions > Subscribe to bot events**. The manifest pre-configures this, but it can be accidentally removed.

### OAuth install failed

If the OAuth flow fails or times out, re-run Step 3d. Ensure:
- The Client ID and Client Secret are correct (re-collect via credential_store if unsure)
- The Slack app has `http://localhost:17322/oauth/callback` in its OAuth redirect URLs (the manifest pre-configures this)
- No other process is using port 17322

## Implementation Rules

- App Token, Client ID, and Client Secret collection goes through `credential_store` prompts. Do NOT use `ui_show`, `ui_update`, `assistant credentials reveal`, or other mechanisms. Do NOT ask the user to paste them in chat — always use the secure credential prompt.
- Bot Token and User Token are captured automatically by the OAuth install flow. Do NOT ask the user to copy-paste these tokens.
- **Do NOT combine multiple steps into a single message.** Each step must be its own turn in the conversation. Wait for the user to confirm completion before moving on.
- **Do NOT tell the user to manually copy the bot token.** The OAuth flow captures it automatically.

## Clearing Credentials

To disconnect Slack, prefer the Settings UI path so the same Slack settings handler used by Settings clears both secure tokens and workspace metadata together.
