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

## Value Classification

| Value     | Type       | Storage method            | Secret? |
| --------- | ---------- | ------------------------- | ------- |
| App Token | Credential | `credential_store` prompt | **Yes** |
| Bot Token | Credential | `credential_store` prompt | **Yes** |

- Both tokens are secrets. Always collect via `credential_store` prompt — never accept them pasted in plaintext chat.

# Setup Steps

## Step 0: Check Existing Configuration

Before starting setup, check whether Slack is already configured by calling `credential_store` with `action: "inspect"` for each token:

- Call `credential_store` with `action: "inspect"`, `service: "slack_channel"`, `field: "app_token"`
- Call `credential_store` with `action: "inspect"`, `service: "slack_channel"`, `field: "bot_token"`

- If both credentials have `"hasSecret": true` and the connection is active — Slack is fully configured. Offer to show status or reconfigure.
- If only one token is present — offer to resume setup from the missing step.
- If neither is present — continue to Step 1.

## Step 1: Generate Manifest & Create Slack App

Ask the user what they'd like to name their Slack bot and optionally provide a short description. Use their answers (or sensible defaults) to generate a pre-configured Slack app manifest.

Generate the manifest JSON:

```json
{
  "display_information": {
    "name": "<user's chosen name>",
    "description": "<user's chosen description>",
    "background_color": "#1a1a2e"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "<user's chosen name>",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "files:write",
        "im:history",
        "im:read",
        "im:write",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "message.channels",
        "message.im"
      ]
    },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

After generating the manifest, URL-encode it and construct the create-from-manifest link:

```
https://api.slack.com/apps?new_app=1&manifest_json=<url_encoded_manifest>
```

Present the link to the user: "Click this link to create your Slack app. It's pre-configured with all the right permissions, events, and Socket Mode. Just select your workspace and click **Create**."

Wait for the user to confirm they've created the app before proceeding.

## Step 2: Generate App Token & Collect It

Tell the user to navigate to **Settings > Basic Information > App-Level Tokens** in their newly created Slack app, then:

1. Click **Generate Token and Scopes**
2. Token name: "Socket Mode" (or any name they prefer)
3. Add scope: `connections:write`
4. Click **Generate**

Collect the app token securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "app_token"`, `label: "App-Level Token"`, `placeholder: "xapp-..."`, `description: "Paste the App-Level Token you just generated"`

The `slack_channel` secure prompt already routes through the same Slack settings handler used by Settings. Treat that tool result as authoritative:

- If it succeeds, continue.
- If it returns an error, ask the user to re-enter the token.
- If it returns a warning that the connection is incomplete, that is expected until the bot token is collected.

## Step 3: Install App & Collect Bot Token

Tell the user to navigate to **Settings > Install App** in the sidebar, then click **Install to Workspace** and authorize the requested permissions (already pre-configured from the manifest).

After installation, collect the bot token securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "bot_token"`, `label: "Bot User OAuth Token"`, `placeholder: "xoxb-..."`, `description: "Paste the Bot User OAuth Token shown after installing"`

After the bot-token prompt succeeds, the same Slack settings handler used by Settings has already:

- validated the bot token with Slack
- stored workspace metadata (`teamId`, `teamName`, `botUserId`, `botUsername`)
- activated Socket Mode when both tokens are present

Use the most recent `credential_store` result as the source of truth:

- If it reports the Slack channel is connected, continue.
- If it reports an error, stop and fix that error before moving on.
- If it reports an incomplete setup warning, collect the missing token instead of improvising extra validation commands.

Show the user their setup progress:

"Setup progress:
✅ App created
✅ Tokens configured
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

Connected: @{botUsername} in {workspace}
Channels: Invite the bot to any channel with `/invite @{botUsername}`. DMs work immediately.
Identity: verified"

If identity was skipped:

"Setup complete!
✅ App created
✅ Tokens configured
✅ Connection active
⬜ Connection tested — you can complete this anytime by saying 'verify me on slack'

Connected: @{botUsername} in {workspace}
Channels: Invite the bot to any channel with `/invite @{botUsername}`. DMs work immediately.
Identity: skipped"

## Troubleshooting

### Bot not responding in channels

The bot must be invited to each channel where you want it to listen. Use `/invite @{botUsername}` in the channel.

### Socket Mode disconnects

The app token may be revoked or expired. Regenerate it in your Slack app settings under **Basic Information > App-Level Tokens**, then re-enter via credential_store prompt.

### Token validation fails

Re-enter the token via credential_store prompt. The handler validates tokens on entry — if it rejects the token, double-check you're copying the right value from the Slack app settings.

### Messages not appearing

Verify that `message.channels` event subscription is enabled in your Slack app settings under **Event Subscriptions > Subscribe to bot events**. The manifest pre-configures this, but it can be accidentally removed.

## Implementation Rules

All token collection goes through `credential_store` prompts. Do NOT use `ui_show`, `ui_update`, `assistant credentials reveal`, `curl`, or `assistant config set slack.*` in chat to collect or manipulate tokens. Do NOT ask the user to paste them in chat — always use the secure credential prompt.

## Clearing Credentials

To disconnect Slack, prefer the Settings UI path so the same Slack settings handler clears both secure tokens and workspace metadata together.
