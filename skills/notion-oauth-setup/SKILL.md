---
name: notion-oauth-setup
description: Set up Notion OAuth credentials for Notion integration using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Notion OAuth Setup"
    user-invocable: true
    credential-setup-for: "notion"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Notion OAuth credentials so the Notion integration can connect to their workspace.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Notion-specific steps.

## Provider Details

- **Provider key:** `integration:notion`
- **Credential type:** Public integration (OAuth)
- **Token endpoint auth:** `client_secret_basic` (client secret always required)
- **Scopes:** None (Notion does not use explicit OAuth scopes)
- **Extra params:** `owner=user`

## Prerequisites

Before beginning the user-facing flow, ensure **public ingress** is configured. Notion OAuth requires a publicly reachable redirect URI — there is no loopback/desktop-app alternative.

Read the configured public gateway URL from `ingress.publicBaseUrl`. If it is missing, load and run the `public-ingress` skill first (`skill_load` with `skill: "public-ingress"`). Build the redirect URI as `<publicBaseUrl>/webhooks/oauth/callback`.

## Notion-Specific Flow

The flow has 6 steps total, takes about 2-3 minutes.

### Step 0: Prerequisite Check

> Before we start — do you have a Notion account and workspace you'd like to connect?

If no Notion account, guide them to create one at `https://www.notion.so/signup` or defer.

---

### Step 1: Open Notion Integrations

Open: `https://www.notion.so/profile/integrations`

> I've opened the Notion integrations page. If it's asking you to sign in, go ahead and do that first. Once you're in, you should see your list of integrations (it might be empty).

---

### Step 2: Create a New Public Integration

> Look for the **"New integration"** button (or a **"+"** button) and click it.
>
> On the creation form:
>
> 1. Set the name to **Vellum Assistant**
> 2. Select your workspace from the **Associated workspace** dropdown
> 3. For the **Type**, select **Public** — this is required for OAuth
> 4. Click **Submit**

**Known issues:**

- If "Public" is not available as a type, the user may need to check their workspace settings or plan level
- If they already have an integration named "Vellum Assistant", ask if they'd like to reuse it — skip ahead to Step 3

**Milestone (2 of 6):** "Integration created — now we'll configure the OAuth redirect."

---

### Step 3: Configure OAuth Redirect URI

The integration settings page should load after creation. Guide the user to the **Distribution** tab or section.

> Now look for the **Distribution** tab in the left sidebar (or a section called **OAuth Domain & URIs**). Click into it.
>
> You should see a field for **Redirect URIs**. Paste this exact URL:
> `OAUTH_CALLBACK_URL`
>
> Then scroll down and click **Save changes**.

Replace `OAUTH_CALLBACK_URL` with the concrete redirect URI built from `ingress.publicBaseUrl`. Never send the placeholder literally.

Copy the redirect URI to the clipboard before navigating so the user can paste it:

```
host_bash:
  command: |
    echo -n "OAUTH_CALLBACK_URL" | pbcopy && /tmp/vellum-nav.sh "https://www.notion.so/profile/integrations"
```

**Known issues:**

- Notion may require a "Website" or "Redirect URI" domain to be filled in as well — if so, use the base domain from `ingress.publicBaseUrl`
- If the page shows "Internal integration" with no Distribution tab, the integration was created as Internal — they'll need to recreate it as Public

---

### Step 4: Copy Client ID and Client Secret

> Now look for the **Secrets** section on the integration page. You should see:
>
> - **OAuth client ID**
> - **OAuth client secret** (you may need to click **Show** to reveal it)
>
> Copy the **Client ID** and paste it here in the chat.

After receiving the Client ID, collect the secret securely:

```
credential_store prompt:
  service: "integration:notion"
  field: "client_secret"
  label: "Notion OAuth Client Secret"
  description: "Copy the Client Secret from the Notion integration page and paste it here."
  placeholder: "secret_..."
```

**Milestone (4 of 6):** "Credentials collected — almost done."

---

### Step 5: Store Credentials and Authorize

Register the OAuth app and start the authorization flow. See the collaborative guided flow reference for the exact commands (`assistant oauth apps upsert` and `assistant oauth connections connect`).

> I'll save your credentials and start the Notion authorization flow now.
>
> You should see a Notion consent page asking you to **select which pages** to share with Vellum Assistant. Pick the pages or databases you'd like to connect, then click **Allow access**.

**Known issues:**

- If the consent page shows an error about the redirect URI, double-check that the URI in Step 3 matches exactly
- The user can always re-authorize later to share additional pages

---

### Step 6: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:notion --client-id <client-id>)" "https://api.notion.com/v1/users/me" -H "Notion-Version: 2022-06-28"
```

**On success:** "Notion is connected! You can now ask me to read and write pages and databases in your Notion workspace."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Notion-specific differences for Path B:

- Still requires public ingress for the redirect URI (no loopback alternative)
- Client Secret prefix is `secret_` — use `credential_store prompt` to collect it securely; split entry is not needed since this prefix doesn't trigger channel scanners
