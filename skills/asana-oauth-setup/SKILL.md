---
name: asana-oauth-setup
description: Set up Asana OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Asana OAuth Setup"
    feature-flag: "integration-asana"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Asana OAuth credentials so the Asana integration can connect to their workspace.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Asana-specific steps.

## Provider Details

- **Provider key:** `integration:asana`
- **Dashboard:** `https://app.asana.com/0/my-apps`
- **Ping URL:** `https://app.asana.com/api/1.0/users/me`
- **Callback transport:** Loopback (port 17328)
- **Requires secret:** Yes (token endpoint needs both client ID and secret)
- **Scopes:** `default` (Asana uses a single default scope)

## Asana-Specific Flow

The flow has 7 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have an Asana account? You'll need to be able to create developer apps in your Asana workspace.

If no account, direct them to sign up at `https://asana.com`. If they're unsure about permissions, suggest proceeding - most Asana accounts allow creating personal apps.

---

### Step 1: Open Asana Developer Console

Open: `https://app.asana.com/0/my-apps`

> I've opened the Asana Developer Console (My Apps). If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New App

> Look for the **Create New App** button. Go ahead and click it.

After the user clicks:

> Set the app name to **Vellum Assistant**. You'll also need to select a purpose - pick whichever fits best (e.g., "Build an integration" or "Personal use"). Then click **Create app**.

**Known issues:**

- If the user is part of multiple workspaces, the app will be tied to their default workspace - that's fine for personal use

**Milestone (2 of 7):** "App created - now let's set up the redirect URL."

---

### Step 3: Set Up Redirect URL

> In the app settings, look for the **OAuth** section or tab. Under **Redirect URLs**, click **Add redirect URL**, paste this URL, and save:
>
> `http://localhost:17328/oauth/callback`

**Milestone (3 of 7):** "Redirect URL is configured - now let's grab the credentials."

---

### Step 4: Get Client ID and App Secret

> Now let's grab the credentials. In the app settings, look for the **OAuth** section. You should see the **Client ID** and the app **secret** listed there.

> You may need to click a reveal or show button to see the secret.

**Milestone (4 of 7):** "Almost there - just need to save these credentials."

---

### Step 5: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "integration:asana"
  field: "oauth_secret"
  label: "Asana OAuth App Secret"
  description: "Copy the app secret from the OAuth section of your Asana app settings (you may need to click Show first) and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:asana --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:asana:oauth_secret"
```

**Milestone (5 of 7):** "Credentials saved - just the authorization step left."

---

### Step 6: Authorize

> I'll start the Asana authorization flow now. You should see an Asana consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Allow**.

```
bash:
  command: |
    assistant oauth connect integration:asana
```

---

### Step 7: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    assistant oauth ping integration:asana
```

**On success:** "Asana is connected! You can now ask me to check your Asana tasks, create projects, manage assignments, and track your work."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Asana-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under the **OAuth** section of the app settings
- The app secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
