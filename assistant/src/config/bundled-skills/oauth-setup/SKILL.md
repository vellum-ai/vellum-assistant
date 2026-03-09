---
name: oauth-setup
description: Connect any OAuth service — create app credentials and authorize via browser automation
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🔑","vellum":{"display-name":"OAuth Setup","user-invocable":true,"includes":["browser"]}}
---

You are helping the user connect an OAuth-based service to Vellum. This is a generic setup flow that works for any provider with a well-known OAuth config.

**Tone:** Be friendly and reassuring throughout. Narrate what you're doing in plain language so the user always knows what's happening. After each step, briefly confirm what was accomplished before moving on.

## Input

You will be given a `service` name (e.g., "discord", "linear", "spotify"). If not provided, ask the user which service they want to connect.

## Step 1: Read the service config

Use `credential_store` with `action: "describe"` and `service: "<name>"` to get the well-known OAuth config. This returns:
- `scopes` — permissions to request
- `redirectUri` — the callback URL to register
- `callbackTransport` — loopback or gateway
- `requiresClientSecret` — whether a client secret is needed
- `authUrl` / `tokenUrl` — OAuth endpoints

It may also include a `setup` object with rich metadata:
- `setup.displayName` — the provider's name
- `setup.dashboardUrl` — where to create the app
- `setup.appType` — what kind of app to create
- `setup.requiresClientSecret` — whether a client secret is needed
- `setup.notes` — provider-specific guidance

If no config is found, tell the user this service doesn't have a pre-configured setup and offer to help them configure it manually via `oauth2_connect`.

## Step 2: Choose the flow based on setup metadata

### If `setup` metadata is present (rich flow)

Continue to Step 3 (Rich Flow).

### If `setup` metadata is absent (manual flow)

The provider has OAuth config (endpoints, scopes) but no setup automation metadata. Guide the user through a manual app creation:

1. Tell the user: "I have the OAuth endpoints and scopes for this service, but I don't have developer dashboard automation for it. You'll need to create an OAuth app manually."
2. Provide the details they need:
   - **Scopes to request:** list the `scopes` from the config
   - **Redirect URI:** show the `redirectUri` value
   - **Whether a client secret is required:** use the top-level `requiresClientSecret` field
3. Ask the user to:
   - Go to the provider's developer dashboard
   - Create an OAuth app (name it "Vellum Assistant")
   - Set the redirect URI
   - Configure the required scopes
   - Copy the Client ID (and Client Secret if required)
4. Once they provide the credentials, skip to **Step 8: Connect**.

---

## Rich Flow (when `setup` is present)

### Step 3: Tell the user what's happening

Tell the user:
- "I'll walk you through creating a {setup.appType} so Vellum can connect to {setup.displayName}. The whole process takes a few minutes."
- "I'll be automating the {setup.displayName} developer dashboard in the browser — you'll be able to see everything I'm doing."
- "I'll ask for your approval before each major step, so nothing happens without your say-so."

### Step 4: Navigate to the developer dashboard

Use `browser_navigate` to go to `setup.dashboardUrl`.

Take a `browser_screenshot` and `browser_snapshot`:
- **If a sign-in page appears:** Tell the user to sign in and wait for confirmation.
- **If the dashboard loads:** Continue to Step 5.

### Step 5: Create an app

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` explaining what you're about to create.

Once approved:
1. Find and click the "Create App" / "New Application" / "New Integration" button (adapt to the provider's UI)
2. Name it "Vellum Assistant"
3. Follow any guidance from `setup.notes`
4. Complete the creation flow

Take a `browser_screenshot` to confirm.

### Step 6: Configure scopes/permissions

**Ask for approval before proceeding.** List the `scopes` from the config and explain what each grants.

Once approved, navigate to the OAuth/permissions section and add each scope. Follow `setup.notes` for any provider-specific guidance (e.g., "User Token Scopes" vs "Bot Token Scopes").

Take a `browser_screenshot` after adding all scopes.

### Step 7: Set redirect URL

Check the `redirectUri` from the config:
- If it mentions "not currently configured", `GATEWAY_BASE_URL`, or `INGRESS_PUBLIC_BASE_URL` — the user needs a public gateway URL configured. Check if one is set; if not, load the `public-ingress` skill first.
- If it says "automatic" — skip this step entirely (no redirect URI needed).
- Otherwise, enter the `redirectUri` exactly as provided.

Take a `browser_snapshot` to confirm.

### Step 7b: Extract credentials

Navigate to the app's credentials/settings section.

Use `browser_extract` to read:
1. **Client ID** (or equivalent)
2. **Client Secret** (if `requiresClientSecret` is true) — click "Show"/"Reveal" first if needed

---

## Step 8: Connect

Tell the user you're opening the authorization page.

Use `credential_store` with:
```
action: "oauth2_connect"
service: "<service name>"
client_id: "<extracted client ID>"
client_secret: "<extracted client secret>"  (if required)
```

Everything else (endpoints, scopes, params) is auto-filled from the well-known config. Wait for the flow to complete.

## Step 9: Celebrate!

Once connected, tell the user:
- If `setup` is present: "**{setup.displayName} is connected!** You're all set."
- If `setup` is absent: "**{service} is connected!** You're all set."

Summarize what was accomplished.

## Error Handling

- **Page load failures:** Retry once. If it still fails, ask the user to check their connection.
- **Element not found:** Take a fresh `browser_snapshot`. The provider's UI may have changed — adapt dynamically.
- **User declines an approval gate:** Don't push back. Explain why it matters, offer to retry or cancel.
- **OAuth flow timeout or failure:** Offer to retry. The app is already created, so only the connect step needs to be re-run.
- **Any unexpected state:** Take a `browser_screenshot` and `browser_snapshot`, describe what you see, and ask for guidance.
