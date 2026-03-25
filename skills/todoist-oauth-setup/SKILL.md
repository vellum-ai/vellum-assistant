---
name: todoist-oauth-setup
description: Set up Todoist OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Todoist OAuth Setup"
    feature-flag: "integration-todoist"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Todoist OAuth credentials so the Todoist integration can connect to their account.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Todoist-specific steps.

## Provider Details

- **Provider key:** `integration:todoist`
- **Dashboard:** `https://developer.todoist.com/appconsole.html`
- **Scopes:** `data:read_write`
- **Callback transport:** Loopback (port 17325)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)
- **Ping URL:** `https://api.todoist.com/rest/v2/projects`

## Todoist-Specific Flow

The flow has 7 steps total, takes about 2-3 minutes.

### Step 1: Open Todoist App Console

Open: `https://developer.todoist.com/appconsole.html`

> I've opened the Todoist App Console. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New App

> Look for the **Create a new app** button and click it.

Then:

> Set the app name to **Vellum Assistant** and click **Create app**.

**Milestone (2 of 7):** "App created - now let's set up the redirect URL."

---

### Step 3: Set Up OAuth Redirect URL

> In the app settings, find the **OAuth redirect URL** field and paste in this URL:
>
> `http://localhost:17325/oauth/callback`
>
> Then click **Save settings**.

**Milestone (3 of 7):** "Redirect URL is set - now let's grab the credentials."

---

### Step 4: Copy Client ID and App Secret

> You should see the **Client ID** and **App secret** displayed in the app settings page.

**Milestone (4 of 7):** "Credentials are visible - let's save them."

---

### Step 5: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "integration:todoist"
  field: "app_secret"
  label: "Todoist OAuth App Secret"
  description: "Copy the app secret from the Todoist app settings page and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:todoist --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:todoist:app_secret"
```

**Milestone (5 of 7):** "Credentials saved - just the authorization step left."

---

### Step 6: Authorize

> I'll start the Todoist authorization flow now. You should see a Todoist consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Agree**.

```
bash:
  command: |
    assistant oauth connect integration:todoist --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

---

### Step 7: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:todoist --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "https://api.todoist.com/rest/v2/projects" | python3 -m json.tool
```

**On success:** "Todoist is connected! You can now ask me to manage your tasks, create projects, and organize your to-do lists."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Todoist-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under **OAuth redirect URL** in the app settings
- The app secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
