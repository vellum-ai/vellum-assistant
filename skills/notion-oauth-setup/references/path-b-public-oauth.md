# Public Integration (OAuth) Setup

Use this path only when the user explicitly needs multi-workspace OAuth distribution. For single-workspace use, the Internal integration flow in the main SKILL.md is simpler and preferred.

## Overview

Public integrations use OAuth 2.0 and require:

- Converting the integration from Internal to Public (via Notion's integration settings)
- A redirect URI for the OAuth callback
- OAuth Client ID and Client Secret (different from the Internal secret)

## Important: Notion UI for Public Integrations

As of early 2026, Notion does **not** offer a "Type" selector during integration creation - all integrations start as Internal. To convert to Public:

1. Create the integration as Internal (per the main flow)
2. Look for a way to convert to Public in the integration settings - Notion docs reference this option but the exact UI location may vary
3. Once converted, a **Distribution** tab should appear with OAuth settings

## Provider Details (Public)

- **Token endpoint auth:** `client_secret_basic` (client secret always required)
- **Scopes:** None (Notion does not use explicit OAuth scopes)
- **Extra params:** `owner=user`
- **Callback transport:** Loopback (port 17323) for interactive channels; public ingress for remote channels
- **Redirect URI (interactive):** `http://localhost:17323/oauth/callback`
- **Redirect URI (remote/Path B):** `<ingress.publicBaseUrl>/webhooks/oauth/callback` - resolve from the configured public gateway URL

## Public Integration Steps

### Step 1: Convert to Public

Guide the user to find the conversion option in their integration settings. Once converted:

- A **Distribution** tab should appear
- OAuth Client ID and Client Secret become available in the **Secrets** section

### Step 2: Configure OAuth Redirect URI

Determine the correct redirect URI based on the channel:

- **Interactive (macOS app, local):** Use `http://localhost:17323/oauth/callback`
- **Remote channel (Telegram, Slack, etc.):** Read the configured public gateway URL from `ingress.publicBaseUrl`. If missing, load and run the `public-ingress` skill first. Build the URI as `<publicBaseUrl>/webhooks/oauth/callback`.

Copy the resolved redirect URI to clipboard:

```
host_bash:
  command: |
    echo -n "<resolved redirect URI>" | pbcopy
```

Guide the user to the **Distribution** tab to paste the redirect URI and save.

### Step 3: Copy Client ID and Client Secret

> In the **Secrets** section, copy the **OAuth Client ID** and paste it here.

After receiving the Client ID, collect the secret securely:

```
credential_store prompt:
  service: "integration:notion"
  field: "client_secret"
  label: "Notion OAuth Client Secret"
  description: "Copy the Client Secret from the Notion integration page and paste it here."
  placeholder: "secret_..."
```

### Step 4: Store Credentials and Authorize

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:notion --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "credential/integration:notion/client_secret"
```

```
bash:
  command: |
    assistant oauth connect integration:notion
```

### Step 5: Verify Connection

```
bash:
  command: |
    assistant oauth ping integration:notion
```
