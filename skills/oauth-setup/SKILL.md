---
name: oauth-setup
description: Connect any OAuth service — walk users through app setup via a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "OAuth Setup"
    user-invocable: true
    includes: ["collaborative-oauth-flow"]
---

You are helping the user connect an OAuth-based service to Vellum. This is a generic setup flow that works for any provider with a well-known OAuth config.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines the generic provider-agnostic steps.

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

## Step 2: Check for a dedicated setup skill

Check the available skills catalog for a dedicated `<service>-oauth-setup` skill matching this service name. If one exists, load that skill instead — it has provider-specific steps that are more reliable than the generic flow. Use `skill_load` with that skill ID and hand off completely.

Well-known services with dedicated setup skills: `gmail` (google-oauth-applescript), `slack`, `notion`, `twitter`, `github`, `linear`, `spotify`, `todoist`, `discord`, `dropbox`, `asana`, `airtable`, `hubspot`, `figma`.

## Step 3: Choose the flow based on setup metadata

### If `setup` metadata is present (guided flow)

Continue to Step 4.

### If `setup` metadata is absent (manual flow)

The provider has OAuth config (endpoints, scopes) but no setup guidance. Guide the user through a manual app creation:

1. Tell the user: "I have the OAuth endpoints and scopes for this service, but I don't have step-by-step guidance for its developer dashboard. You'll need to create an OAuth app manually."
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
4. Once they provide the credentials, skip to **Step 9: Store and Connect**.

---

## Guided Flow (when `setup` is present)

### Step 4: Pre-Flow Setup

> We're going to set up {setup.displayName} OAuth together. I'll open each page in your browser and tell you exactly what to do. You can pause anytime.
>
> Your Mac may ask for permissions along the way — if you see an option to allow for a longer duration (like 10 minutes), that'll save you from approving every single step.

### Step 5: Open the developer dashboard

Open: `{setup.dashboardUrl}`

> I've opened the {setup.displayName} developer dashboard. If it's asking you to sign in, go ahead and do that first.

Wait for user confirmation before proceeding.

---

### Step 6: Create an app

> Look for a button to create a new app or integration — it might say "Create App", "New Application", or "New Integration". Go ahead and click it.

Guide the user through the creation flow:

1. Name it "Vellum Assistant"
2. Follow any guidance from `setup.notes` (e.g., select "Public" for Notion, "From scratch" for Slack)
3. Complete the creation

Wait for confirmation.

---

### Step 7: Configure scopes/permissions (if any)

If scopes are non-empty, guide the user to the OAuth/permissions section:

> Now we need to add the permissions {setup.displayName} needs. Look for an OAuth, Permissions, or Scopes section.

List each scope and what it grants. Guide the user to add them one at a time or paste them.

If scopes are empty (e.g. Notion), skip this step.

---

### Step 8: Set redirect URL

Check the `redirectUri` from the config:

- If it says "automatic" — skip this step entirely (no redirect URI needed for loopback)
- If it mentions `ingress.publicBaseUrl` — the user needs a public gateway URL. Check if one is configured; if not, load the `public-ingress` skill first
- Otherwise, tell the user exactly where to add the redirect URI

> Look for "Redirect URLs" or "OAuth Redirect URIs" in the settings. Add this URL: `{redirectUri}`

---

### Step 9: Store and Connect

#### Collect Client ID

> Copy the Client ID from the app's credentials page and paste it here in the chat.

#### Collect Client Secret (if required)

Always use a secure prompt:

```
credential_store prompt:
  service: "<provider-key>"
  field: "client_secret"
  label: "{setup.displayName} OAuth Client Secret"
  description: "Copy the Client Secret from the credentials page and paste it here."
  placeholder: "..."
```

#### Register and authorize

```
bash:
  command: |
    assistant oauth apps upsert --provider <provider-key> --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "credential/<provider-key>/client_secret"
```

```
bash:
  command: |
    assistant oauth connections connect <provider-key> --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

If the service shows an "unverified app" or consent warning, tell the user how to proceed.

---

### Step 10: Verify Connection

If a ping URL is available, verify:

```
bash:
  command: |
    curl -H "Authorization: Bearer $(assistant oauth connections token <provider-key> --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "<provider-ping-url>"
```

**On success:** "**{setup.displayName} is connected!** You're all set."

Summarize what was accomplished.

---

## Path B: Manual Channel Setup

For non-interactive channels (Telegram, Slack, etc.), provide all URLs and instructions as text messages. Key differences:

- The user navigates on their own — give them the URLs to open
- Use **Web application** credentials if the provider distinguishes (callback goes through public gateway)
- Collect the Client Secret via `credential_store prompt` or split entry if the prefix could trigger channel scanners
- Resolve the redirect URI from `ingress.publicBaseUrl` before sending instructions; if not configured, load the `public-ingress` skill first

## Error Handling

- **User lands on unexpected page:** Offer to screenshot, identify where they are, navigate back
- **User not signed in:** Tell them to sign in, wait, continue
- **Feature already configured:** "Looks like this is already set up — great, let's skip ahead."
- **User is confused or frustrated:** Pause, acknowledge, simplify
- **OAuth flow timeout or failure:** Offer to retry. The app is already created, so only the connect step needs to be re-run.
