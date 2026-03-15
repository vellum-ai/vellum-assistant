---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode with guided app creation and guardian verification
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

After collection, validate the app token format:

```bash
APP_TOKEN=$(assistant credentials reveal --service slack_channel --field app_token)
if [[ "$APP_TOKEN" != xapp-* ]]; then
  echo "ERROR: App token must start with xapp-"
  assistant credentials delete --service slack_channel --field app_token
  exit 1
fi
echo "App token format valid"
```

If the token does not start with `xapp-`, inform the user it is invalid, delete it, and ask them to re-enter (repeat the collection above).

## Step 3: Install App & Collect Bot Token

Tell the user to navigate to **Settings > Install App** in the sidebar, then click **Install to Workspace** and authorize the requested permissions (already pre-configured from the manifest).

After installation, collect the bot token securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "bot_token"`, `label: "Bot User OAuth Token"`, `placeholder: "xoxb-..."`, `description: "Paste the Bot User OAuth Token shown after installing"`

## Step 4: Validate Bot Token & Store Workspace Metadata

```bash
BOT_TOKEN=$(assistant credentials reveal --service slack_channel --field bot_token)
AUTH_RESPONSE=$(curl -sf -X POST "https://slack.com/api/auth.test" \
  -H "Authorization: Bearer $BOT_TOKEN")
echo "$AUTH_RESPONSE" | jq .
```

If `ok` is `false`, the token is invalid — ask the user to re-enter (repeat Step 3).

If `ok` is `true`, parse the response and persist workspace metadata so the Settings UI can display the connected bot and workspace:

```bash
TEAM_ID=$(echo "$AUTH_RESPONSE" | jq -r '.team_id')
TEAM_NAME=$(echo "$AUTH_RESPONSE" | jq -r '.team')
BOT_USER_ID=$(echo "$AUTH_RESPONSE" | jq -r '.user_id')
BOT_USERNAME=$(echo "$AUTH_RESPONSE" | jq -r '.user')
assistant config set slack.teamId "$TEAM_ID"
assistant config set slack.teamName "$TEAM_NAME"
assistant config set slack.botUserId "$BOT_USER_ID"
assistant config set slack.botUsername "$BOT_USERNAME"
```

Report the bot username and workspace from the response.

Socket Mode connects automatically once both credentials are stored — no further action needed.

## Step 5: Guardian Verification (Optional)

Link the user's Slack account as the trusted guardian. Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user declines, skip and continue.

## Step 6: Report Success

Summarize:

- Bot connected: {username} in {workspace}
- Socket Mode: active (gateway auto-connects when credentials are stored)
- Guardian: {verified | skipped}
- Usage: @{botUsername} in any channel, or DM the bot directly

# Clearing Credentials

To disconnect Slack:

```bash
assistant credentials delete --service slack_channel --field bot_token
assistant credentials delete --service slack_channel --field app_token
assistant config set slack.teamId ""
assistant config set slack.teamName ""
assistant config set slack.botUserId ""
assistant config set slack.botUsername ""
```
