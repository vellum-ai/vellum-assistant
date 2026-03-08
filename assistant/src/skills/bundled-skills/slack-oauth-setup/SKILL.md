---
name: slack-oauth-setup
description: Create Slack App and OAuth credentials for Slack integration using browser automation
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🔑","vellum":{"display-name":"Slack OAuth Setup","user-invocable":true,"includes":["browser"]}}
---

You are helping your user create a Slack App and OAuth credentials so the Messaging integration can connect to their Slack workspace. Walk through each step below using `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, and `browser_extract` tools.

**Tone:** Be friendly and reassuring throughout. Narrate what you're doing in plain language so the user always knows what's happening. After each step, briefly confirm what was accomplished before moving on.

## Before You Start

Tell the user:
- "I'll walk you through creating a Slack App so Vellum can connect to your workspace. The whole process takes a few minutes."
- "I'll be automating the Slack API website in the browser — you'll be able to see everything I'm doing."
- "I'll ask for your approval before each major step, so nothing happens without your say-so."
- "No sensitive credentials will be shown in the conversation."

## Step 1: Navigate to Slack API

Tell the user: "First, let me open the Slack API dashboard."

Use `browser_navigate` to go to `https://api.slack.com/apps`.

Take a `browser_screenshot` to show the user what loaded, then take a `browser_snapshot` to check the page state:
- **If a sign-in page appears:** Tell the user "Please sign in to your Slack account in the browser window. Let me know when you're done." Wait for their confirmation, then take another snapshot.
- **If the apps dashboard loads:** Tell the user "Slack API dashboard is loaded. Let's create your app!" and continue to Step 2.

## Step 2: Create a Slack App

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Create a Slack App**
>
> I'm about to create a new Slack App called "Vellum Assistant" in your workspace. This app will only have the permissions you approve in the next step. It won't post anything or access any data until you explicitly authorize it.

Wait for the user to approve. If they decline, explain that the app is required for OAuth and offer to try again or cancel.

Once approved:
1. Click "Create New App"
2. Select "From scratch"
3. Enter app name: "Vellum Assistant"
4. Select the user's workspace from the dropdown
5. Click "Create App"

Take a `browser_screenshot` to show the result.

Tell the user: "App created! Now let's configure the permissions it needs."

## Step 3: Configure OAuth Scopes

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Configure Slack Permissions**
>
> I'm about to add the following User Token Scopes to your Slack App. These let Vellum read your messages and channels, send messages on your behalf, search your message history, and add emoji reactions:
>
> - `channels:read` — View basic channel info
> - `channels:history` — Read message history in public channels
> - `groups:read` — View private channel info
> - `groups:history` — Read message history in private channels
> - `im:read` — View direct message info
> - `im:history` — Read direct message history
> - `im:write` — Open and send direct messages
> - `mpim:read` — View group DM info
> - `mpim:history` — Read group DM history
> - `users:read` — View user profiles
> - `chat:write` — Send messages
> - `search:read` — Search messages
> - `reactions:write` — Add emoji reactions

Wait for the user to approve.

Once approved:
1. Navigate to "OAuth & Permissions" in the left sidebar (or go to the app's OAuth page directly)
2. Scroll to "User Token Scopes"
3. Add each scope listed above using the "Add an OAuth Scope" button

Take a `browser_screenshot` after adding all scopes.

Tell the user: "Permissions configured! Now let's set up the redirect URL and get the credentials."

## Step 4: Add Redirect URL

Navigate to the "OAuth & Permissions" page if not already there.

Before entering the redirect URL, resolve the exact value from the well-known OAuth config:

```
credential_store describe:
  service: "integration:slack"
```

Read the `redirectUri` field from that response and use it exactly as shown.

In the "Redirect URLs" section:
1. If `redirectUri` says "automatic", skip adding a redirect URL for this provider.
2. If `redirectUri` mentions "not currently configured" / `GATEWAY_BASE_URL` / `INGRESS_PUBLIC_BASE_URL`, stop and ask the user to configure public ingress first.
3. Otherwise, click "Add New Redirect URL" and enter the `redirectUri` value exactly as returned.
4. Click "Add" then "Save URLs"

Take a `browser_snapshot` to confirm.

Tell the user: "Redirect URL configured using the redirect URI from Vellum's Slack OAuth profile."

## Step 5: Extract Client ID and Client Secret

Navigate to "Basic Information" in the left sidebar.

Use `browser_extract` to read:
1. **Client ID** from the "App Credentials" section
2. **Client Secret** — click "Show" first, then extract the value

**Important:** Slack requires a client secret for the token exchange (unlike Google which uses PKCE). Both values are needed.

Tell the user: "Credentials extracted! Now let's connect your Slack workspace."

## Step 6: Connect Slack

Tell the user: "Opening Slack authorization so you can grant Vellum access to your workspace. You'll see a Slack consent page — just click 'Allow'."

Use the `credential_store` tool to connect Slack via OAuth2:

```
action: "oauth2_connect"
service: "integration:slack"
client_id: "<the extracted Client ID>"
client_secret: "<the extracted Client Secret>"
auth_url: "https://slack.com/oauth/v2/authorize"
token_url: "https://slack.com/api/oauth.v2.access"
scopes: ["channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history", "im:write", "mpim:read", "mpim:history", "users:read", "chat:write", "search:read", "reactions:write"]
extra_params: {"user_scope": "channels:read,channels:history,groups:read,groups:history,im:read,im:history,im:write,mpim:read,mpim:history,users:read,chat:write,search:read,reactions:write"}
```

This will open the Slack authorization page in the user's browser. Wait for the flow to complete.

## Step 7: Celebrate!

Once connected, tell the user:

"**Slack is connected!** You're all set. You can now read channels, search messages, send messages, and manage your Slack workspace through Vellum. Try asking me to check your unread Slack messages!"

Summarize what was accomplished:
- Created a Slack App called "Vellum Assistant"
- Configured User Token Scopes for reading, writing, and searching
- Set up the OAuth redirect URL from the Slack OAuth profile
- Connected your Slack workspace

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Workspace selection issues:** The user may need admin permissions to install apps. Explain this clearly.
- **Element not found for click/type:** Take a fresh `browser_snapshot` to re-assess the page layout. Slack's UI may have changed; adapt your selectors.
- **User declines an approval gate:** Don't push back. Explain briefly why the step matters, offer to try again, or cancel gracefully.
- **OAuth flow timeout or failure:** Tell the user what happened and offer to retry. The app is already created, so they only need to re-run the connect step.
- **Any unexpected state:** Take a `browser_screenshot` and `browser_snapshot`, describe what you see, and ask the user for guidance.
