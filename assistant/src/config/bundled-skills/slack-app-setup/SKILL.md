---
name: "Slack App Setup"
description: "Connect a Slack app to the Vellum Assistant via Socket Mode with guided app creation and guardian verification"
user-invocable: true
includes: ["guardian-verify-setup"]
metadata: { "vellum": { "emoji": "💬" } }
---

You are helping your user connect a Slack bot to the Vellum Assistant gateway via Socket Mode. The gateway manages the Socket Mode connection — it never hits the assistant runtime directly. When this skill is invoked, walk through each step below using only existing tools.

## Prerequisites — Check Before Starting

Before beginning setup, verify these conditions are met:

1. **Gateway API base URL is set and reachable:** Use the injected `INTERNAL_GATEWAY_BASE_URL`, then run `curl -sf "$INTERNAL_GATEWAY_BASE_URL/healthz"` — it should return gateway health JSON (for example `{"status":"ok"}`). If it fails, tell the user to start the assistant with `vellum wake` and wait for it to become healthy before continuing.
2. **Use gateway control-plane routes only.** Slack setup/config actions in this skill must call gateway endpoints under `/v1/integrations/slack/channel/*` — never call the assistant runtime port directly.

## Setup Steps

### Step 1: Generate Manifest & Create Slack App

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

The manifest pre-configures everything needed: Socket Mode, 9 minimal bot scopes, 4 event subscriptions, bot user, App Home, and interactivity. No manual scope or event configuration is needed.

Wait for the user to confirm they've created the app before proceeding.

### Step 2: Generate App Token & Collect It

Tell the user to navigate to **Settings > Basic Information > App-Level Tokens** in their newly created Slack app, then:

1. Click **Generate Token and Scopes**
2. Token name: "Socket Mode" (or any name they prefer)
3. Add scope: `connections:write`
4. Click **Generate**

**Immediately** collect the app token securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "app_token"`, `label: "App-Level Token"`, `placeholder: "xapp-..."`, `description: "Paste the App-Level Token you just generated"`

**IMPORTANT — Secure credential collection only:** Never accept tokens pasted in plaintext chat. If the user pastes a token in the conversation, inform them that for security reasons you cannot use tokens shared in chat and must collect it through the secure prompt instead.

### Step 3: Install App & Collect Bot Token

Tell the user to navigate to **Settings > Install App** in the sidebar, then click **Install to Workspace** and authorize the requested permissions (already pre-configured from the manifest).

After installation, collect the bot token securely:

- Call `credential_store` with `action: "prompt"`, `service: "slack_channel"`, `field: "bot_token"`, `label: "Bot User OAuth Token"`, `placeholder: "xoxb-..."`, `description: "Paste the Bot User OAuth Token shown after installing"`

**IMPORTANT — Secure credential collection only:** Never accept tokens pasted in plaintext chat. Always collect through the secure prompt.

### Step 4: Validate & Connect

After both tokens are collected, submit them to the gateway for validation and storage:

```bash
curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/slack/channel/config" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"botToken": "<bot_token>", "appToken": "<app_token>"}'
```

The endpoint validates the bot token via Slack's `auth.test` API and stores both tokens in the secure key store.

**On success** (`success: true`, `connected: true`):

- Report the bot username and workspace name to the user
- Proceed to Step 5

**On failure:**

| Error                    | Action                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `invalid_auth`           | Bot token is invalid — re-prompt for the correct token (repeat Step 3 collection)    |
| Missing scopes           | Tell the user which scopes to add in the Slack app configuration                     |
| Socket Mode not enabled  | Instruct the user to enable Socket Mode in the app settings                          |
| App token format invalid | Must start with `xapp-` — re-prompt for the correct token (repeat Step 2 collection) |

### Step 5: Guardian Verification

Tell the user: "Now let's verify your identity as the trusted guardian for Slack."

Load the **guardian-verify-setup** skill to handle the verification flow:

- Call `skill_load` with `skill: "guardian-verify-setup"` to load the dependency skill.

The guardian-verify-setup skill manages the full outbound verification flow for Slack, including:

- Collecting the user's Slack user ID as the destination
- Starting the outbound verification session via the gateway endpoint `POST /v1/integrations/guardian/sessions` with `channel: "slack"` and the user's destination
- Sending a verification code via Slack DM
- Auto-polling for completion (the guardian-verify-setup skill handles this)
- Checking guardian status to confirm the binding was created

Tell the user: _"I've loaded the guardian verification guide. It will walk you through linking your Slack account as the trusted guardian."_

After the guardian-verify-setup skill completes (or the user skips), continue to Step 6.

**Note:** Guardian verification is optional but recommended. If the user declines or wants to skip, proceed to Step 6 without blocking.

### Step 6: Verify Connection & Report Success

Check the final connection status:

```bash
curl -s "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/slack/channel/config" \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN"
```

Check guardian binding status:

```bash
assistant integrations guardian status --channel slack --json
```

The Settings > Channels > Slack card auto-refreshes on view appear via `fetchSlackChannelConfig()`, so the user will see the "Connected" status badge when they open or re-open that page.

Summarize what was done:

- Bot connected: {username} in {workspace}
- Socket Mode: active
- Guardian: {verified | not configured}
- Usage: "@{botUsername} in any channel, or DM the bot directly"

Tell the user: "Your Slack bot is now connected! Open **Settings > Channels** to see it reflected there."

## Automated vs Manual Steps

| Step                    | Status                       | Details                                                       |
| ----------------------- | ---------------------------- | ------------------------------------------------------------- |
| App manifest generation | Automated                    | Skill generates manifest JSON with all scopes/events/settings |
| App creation            | Manual (one-click)           | User clicks manifest URL, selects workspace, creates          |
| App token generation    | Manual                       | User generates in Slack settings (can't be automated)         |
| App installation        | Manual                       | User clicks "Install to Workspace"                            |
| Token collection        | Manual (secure prompt)       | Via `credential_store` — never plaintext                      |
| Token validation        | Automated                    | `auth.test` validates bot token on submission                 |
| Socket Mode connection  | Automated                    | Gateway connects when tokens are stored                       |
| Routing                 | Automated (single-assistant) | CLI sets defaults                                             |
| Guardian verification   | Semi-automated               | Via `guardian-verify-setup` skill                             |
