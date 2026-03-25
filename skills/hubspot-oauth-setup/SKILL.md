---
name: hubspot-oauth-setup
description: Set up HubSpot OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "HubSpot OAuth Setup"
    feature-flag: "integration-hubspot"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up HubSpot OAuth credentials so the HubSpot CRM integration can connect to their account.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the HubSpot-specific steps.

## Provider Details

- **Provider key:** `integration:hubspot`
- **Dashboard:** `https://app.hubspot.com/developer`
- **Ping URL:** `https://api.hubapi.com/crm/v3/objects/contacts?limit=1`
- **Callback transport:** Loopback (port 17330)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## HubSpot-Specific Flow

The flow has 10 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a HubSpot account? You'll need one to create a developer app.

If no account, direct them to sign up at `https://app.hubspot.com/signup/developers` and come back once they're logged in.

---

### Step 1: Open HubSpot Developer Portal

Open: `https://app.hubspot.com/developer`

> I've opened the HubSpot developer portal. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a Developer Account (if needed)

> If this is your first time here, HubSpot may ask you to create a developer account. Go ahead and follow the prompts to set one up - it's free.

If the user already has a developer account, skip to the next step.

**Milestone (2 of 10):** "Developer account ready - now let's create an app."

---

### Step 3: Create a New App

> Look for the **Create app** button. Go ahead and click it.

**Known issues:**

- If the user doesn't see a Create app button, they may need to navigate to **Apps** in the top navigation first
- Some accounts may show "Create a public app" vs "Create a private app" - choose **public app** (required for OAuth)

**Milestone (3 of 10):** "App created - now let's configure it."

---

### Step 4: Fill In App Details

> Set the app name to **Vellum Assistant**. You can leave the other fields (description, logo, etc.) blank for now. Click **Save**.

---

### Step 5: Go to the Auth Tab

> Now click on the **Auth** tab at the top of the app page. This is where we'll configure OAuth settings.

**Milestone (5 of 10):** "Auth tab open - let's set up the redirect URL and scopes."

---

### Step 6: Add Redirect URL

> On the **Auth** tab, find the **Redirect URLs** section. Click **Add URL**, paste this URL, and click **Save**:
>
> `http://localhost:17330/oauth/callback`

---

### Step 7: Add Scopes

> Still on the **Auth** tab, scroll down to the **Scopes** section. You'll need to add each of these scopes:
>
> - `crm.objects.contacts.read` - read contact records
> - `crm.objects.contacts.write` - create and update contacts
> - `crm.objects.deals.read` - read deal records
> - `crm.objects.deals.write` - create and update deals
> - `crm.objects.companies.read` - read company records
>
> Use the search box to find each scope, then check the box next to it. Click **Save** when all five are added.

Wait for the user to confirm all 5 scopes are added.

**Milestone (7 of 10):** "Scopes configured - now let's grab the credentials."

---

### Step 8: Get Client ID and App Secret

> Still on the **Auth** tab, you should see the **Client ID** and **App Secret** near the top of the page.

**Milestone (8 of 10):** "Almost there - just need to save these credentials."

---

### Step 9: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "integration:hubspot"
  field: "oauth_secret"
  label: "HubSpot OAuth App Secret"
  description: "Copy the App Secret from the Auth tab and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:hubspot --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:hubspot:oauth_secret"
```

Then authorize:

> I'll start the HubSpot authorization flow now. You should see a HubSpot consent page asking you to allow **Vellum Assistant** to access your account.
>
> Select the HubSpot account you want to connect, review the permissions, and click **Grant access**.

```
bash:
  command: |
    assistant oauth connect integration:hubspot
```

**Milestone (9 of 10):** "Credentials saved and authorized - let's verify."

---

### Step 10: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth token integration:hubspot --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "https://api.hubapi.com/crm/v3/objects/contacts?limit=1" | python3 -m json.tool
```

**On success:** "HubSpot is connected! You can now ask me to look up contacts, manage deals, and browse company records in your HubSpot CRM."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key HubSpot-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under **Redirect URLs** on the Auth tab
- App secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
