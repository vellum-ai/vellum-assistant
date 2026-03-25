---
name: github-oauth-setup
description: Set up GitHub OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "GitHub OAuth Setup"
    feature-flag: "integration-github"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up GitHub OAuth credentials so the GitHub integration can connect to their account.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the GitHub-specific steps.

## Provider Details

- **Provider key:** `github`
- **Dashboard:** `https://github.com/settings/developers`
- **Ping URL:** `https://api.github.com/user`
- **Callback transport:** Loopback
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## GitHub-Specific Flow

The flow has 8 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a GitHub account? You'll need one to create an OAuth App.

If no account, direct them to `https://github.com/signup` and wait for them to finish before continuing.

---

### Step 1: Open GitHub Developer Settings

Open: `https://github.com/settings/developers`

> I've opened the GitHub Developer Settings page. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New OAuth App

> Look for the **New OAuth App** button (top-right area of the OAuth Apps tab). Go ahead and click it.

After the user clicks:

> Fill in the following fields:
>
> - **Application name:** `Vellum Assistant`
> - **Homepage URL:** `https://vellum.ai` (or any URL you prefer)
> - **Authorization callback URL:** We need to look this up first - hold on.

Resolve the callback URL:

```
bash:
  command: assistant oauth providers get github --json
```

Use the `redirectUri` from the JSON response:

- If it is a concrete URL (e.g. `http://localhost:…/oauth/callback`), tell the user to enter that exact URL as the **Authorization callback URL**.
- If it is `null`, stop and help the user configure public ingress first.

Then:

> Once all three fields are filled in, click **Register application**.

**Milestone (2 of 8):** "App registered - now let's grab the credentials."

---

### Step 3: Copy Client ID

> You should now be on the app's settings page. The **Client ID** is displayed near the top. Copy it - we'll need it in a moment.

**Milestone (3 of 8):** "Client ID is ready - now we need the app secret."

---

### Step 4: Generate App Secret

> Below the Client ID, you should see a **Generate a new client secret** button. Click it.
>
> GitHub will show the secret only once, so copy it right away before navigating away from the page.

**Milestone (4 of 8):** "Secret generated - now let's store both credentials."

---

### Step 5: Store Credentials

Collect Client ID conversationally:

> Paste the **Client ID** here in the chat.

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "github"
  field: <secret-field>
  label: "GitHub OAuth App Secret"
  description: "Paste the app secret you just generated from the GitHub OAuth App page."
  placeholder: "..."
```

<!-- Note: <secret-field> maps to the provider's secret credential field name for the OAuth token exchange. -->

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider github --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "github:<secret-field>"
```

**Milestone (5 of 8):** "Credentials saved - just the authorization step left."

---

### Step 6: Add Scopes

The GitHub integration requires these scopes:

- `repo` - full access to repositories
- `read:user` - read user profile info
- `notifications` - access notifications

These scopes are passed during the authorization step below.

---

### Step 7: Authorize

> I'll start the GitHub authorization flow now. You should see a GitHub consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Authorize**.

```
bash:
  command: |
    assistant oauth connect github --scopes repo read:user notifications
```

**Milestone (7 of 8):** "Authorization complete - let's verify it works."

---

### Step 8: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    assistant oauth ping github
```

**On success:** "GitHub is connected! You can now ask me to check your repositories, notifications, pull requests, and issues."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key GitHub-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Set the **Authorization callback URL** to the ingress-based OAuth callback URL when creating the app
- App secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
