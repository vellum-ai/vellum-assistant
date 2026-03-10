---
name: notion-oauth-setup
description: Create a Notion integration and OAuth credentials for Notion integration using browser automation
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Notion OAuth Setup"
    user-invocable: true
    includes: ["browser", "public-ingress"]
---

You are helping your user create a Notion integration (OAuth app) so Vellum can connect to their Notion workspace. Walk through each step below using `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, and `browser_extract` tools.

**Tone:** Be friendly and reassuring throughout. Narrate what you're doing in plain language so the user always knows what's happening. After each step, briefly confirm what was accomplished before moving on.

## Prerequisites

Before starting, check that `ingress.publicBaseUrl` is configured (Settings > Public Ingress, or `INGRESS_PUBLIC_BASE_URL` env var). If it is not set, load and execute the **public-ingress** skill first (`skill_load` with `skill: "public-ingress"`) to set up an ngrok tunnel and persist the public URL. The OAuth redirect URI depends on this value.

## Before You Start

Tell the user:
- "I'll walk you through creating a Notion integration so Vellum can read and write pages and databases in your workspace. The whole process takes a few minutes."
- "I'll be automating the Notion integrations page in the browser — you'll be able to see everything I'm doing."
- "I'll ask for your approval before each major step, so nothing happens without your say-so."
- "No sensitive credentials will be shown in the conversation."

## Step 1: Navigate to Notion Integrations

Tell the user: "First, let me open the Notion integrations page."

Use `browser_navigate` to go to `https://www.notion.so/my-integrations`.

Take a `browser_screenshot` to show the user what loaded, then take a `browser_snapshot` to check the page state:
- **If a sign-in page appears:** Tell the user "Please sign in to your Notion account in the browser window. Let me know when you're done." Wait for their confirmation, then take another snapshot.
- **If the integrations dashboard loads:** Tell the user "Notion integrations page is loaded. Let's create your integration!" and continue to Step 2.

## Step 2: Create a New Integration

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Create a Notion Integration**
>
> I'm about to create a new Notion integration called "Vellum Assistant". This integration will only have the capabilities you approve — it won't access any pages or databases until you explicitly share them with it or authorize it via OAuth.

Wait for the user to approve. If they decline, explain that the integration is required for OAuth and offer to try again or cancel.

Once approved:
1. Click "New integration" (or the "+" button)
2. Select "Public" as the integration type (required for OAuth)
3. Enter integration name: "Vellum Assistant"
4. Select the user's workspace
5. Click "Submit" or "Create"

Take a `browser_screenshot` to show the result.

Tell the user: "Integration created! Now let's configure the OAuth settings."

## Step 3: Configure OAuth Settings

Navigate to the integration's "Distribution" or "OAuth Domain & URIs" tab.

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Configure OAuth Redirect URI**
>
> I'm about to add the OAuth redirect URI to your Notion integration. This allows Notion to send the authorization code back to Vellum after you approve the connection.

Wait for the user to approve.

Once approved:
1. Find the "Redirect URIs" field
2. Enter `${ingress.publicBaseUrl}/webhooks/oauth/callback` (e.g. `https://abc123.ngrok-free.app/webhooks/oauth/callback`). Read the `ingress.publicBaseUrl` value from the assistant's workspace config (Settings > Public Ingress) or the `INGRESS_PUBLIC_BASE_URL` environment variable.
3. Save the settings

Take a `browser_snapshot` to confirm.

Tell the user: "Redirect URI configured. Now let's get your OAuth credentials."

## Step 4: Extract Client ID and Client Secret

Stay on the integration settings page and navigate to the "Secrets" or "OAuth Clients" section.

Use `browser_extract` to read:
1. **OAuth client_id** — this is the integration's OAuth client ID
2. **OAuth client_secret** — click "Show" or "Reveal" first, then extract the value

**Important:** Notion requires a client secret for the token exchange (sent via HTTP Basic Auth). Both values are needed.

Tell the user: "Credentials extracted! Now let's connect your Notion workspace."

## Step 5: Connect Notion

Tell the user: "Opening Notion authorization so you can grant Vellum access to your workspace. You'll see a Notion consent page — just click 'Allow access'."

Use the `credential_store` tool to connect Notion via OAuth2:

```
action: "oauth2_connect"
service: "integration:notion"
client_id: "<the extracted OAuth client_id>"
client_secret: "<the extracted OAuth client_secret>"
auth_url: "https://api.notion.com/v1/oauth/authorize"
token_url: "https://api.notion.com/v1/oauth/token"
scopes: []
extra_params: {"owner": "user"}
token_endpoint_auth_method: "client_secret_basic"
```

This will open the Notion authorization page in the user's browser. Wait for the flow to complete.

## Step 6: Celebrate!

Once connected, tell the user:

"**Notion is connected!** You're all set. You can now read and write pages and databases in your Notion workspace through Vellum. Try asking me to list your databases or read a specific page!"

Summarize what was accomplished:
- Created a Notion public integration called "Vellum Assistant"
- Configured the OAuth redirect URI
- Connected your Notion workspace with read and write access

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **"Public" integration type not available:** The user may need to enable public integrations in their workspace settings. Guide them to Workspace Settings > Integrations.
- **Element not found for click/type:** Take a fresh `browser_snapshot` to re-assess the page layout. Notion's UI may have changed; adapt your selectors.
- **User declines an approval gate:** Don't push back. Explain briefly why the step matters, offer to try again, or cancel gracefully.
- **OAuth flow timeout or failure:** Tell the user what happened and offer to retry. The integration is already created, so they only need to re-run the connect step.
- **Any unexpected state:** Take a `browser_screenshot` and `browser_snapshot`, describe what you see, and ask the user for guidance.
