---
name: linear-oauth-setup
description: Set up Linear OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Linear OAuth Setup"
    feature-flag: "integration-linear"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Linear OAuth credentials so the Linear integration can connect to their workspace.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Linear-specific steps.

## Provider Details

- **Provider key:** `integration:linear`
- **Auth URL:** `https://linear.app/oauth/authorize`
- **Token URL:** `https://api.linear.app/oauth/token`
- **Ping URL:** `https://api.linear.app/graphql`
- **Callback transport:** Loopback (port 17324)
- **Requires secret:** Yes (token endpoint needs both client ID and secret)
- **Extra params:** `prompt=consent`

## Linear-Specific Flow

The flow has 8 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a Linear account with access to a workspace?

If no account, direct them to sign up at `https://linear.app`. If they have an account but aren't sure about permissions, explain that they'll need workspace access to create OAuth applications under Settings > API.

---

### Step 1: Open Linear API Settings

Open: `https://linear.app/settings/api`

> I've opened the Linear API settings page. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New OAuth Application

> Scroll down to the **OAuth Applications** section. Click **Create new OAuth application**.

After the user clicks:

> Set the **Application name** to **Vellum Assistant**.

> For the **Redirect URL**, enter `http://localhost:17324/oauth/callback`.

> Now click **Create**.

**Known issues:**

- If the user sees an error about duplicate application names, suggest a variant like "Vellum Assistant (Personal)"

**Milestone (2 of 8):** "App created - now let's grab the credentials."

---

### Step 3: Copy the Client ID

> You should now see the application details page. Look for the **Client ID** (sometimes labeled **Application ID**). Copy it and paste it here in the chat.

Wait for the user to provide the Client ID.

**Milestone (3 of 8):** "Got the Client ID - now let's grab the secret."

---

### Step 4: Copy the OAuth Secret

> The app secret is shown **only once** right after creation. If you can still see it on the page, copy it now.

If the user missed it:

> If you navigated away and the secret is no longer visible, you'll need to generate a new one. Look for a **Regenerate** or **New secret** option on the application details page.

Collect the secret via secure prompt:

```
credential_store prompt:
  service: "integration:linear"
  field: "oauth_secret"
  label: "Linear OAuth App Secret"
  description: "Copy the app secret from the Linear OAuth application page and paste it here."
  placeholder: "lin_oauth_..."
```

**Milestone (4 of 8):** "Credentials captured - let's add the scopes next."

---

### Step 5: Configure Scopes

> Now let's make sure the right scopes are requested. The Linear OAuth flow requests scopes at authorization time, so I'll handle that automatically. The scopes we'll request are:
>
> - `read` - read access to your Linear data
> - `write` - write access to update issues, projects, etc.
> - `issues:create` - create new issues
>
> You don't need to configure these in the Linear dashboard - I'll include them in the authorization request.

**Milestone (5 of 8):** "Scopes are set - now let's save everything."

---

### Step 6: Store Credentials

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:linear --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:linear:oauth_secret"
```

**Milestone (6 of 8):** "Credentials saved - just the authorization step left."

---

### Step 7: Authorize

> I'll start the Linear authorization flow now. You should see a Linear consent page asking you to allow **Vellum Assistant** to access your workspace.
>
> Review the permissions and click **Authorize**.

```
bash:
  command: |
    assistant oauth connect integration:linear
```

---

### Step 8: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $(assistant oauth connections token integration:linear --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" -d '{"query":"{ viewer { id name email } }"}' "https://api.linear.app/graphql" | python3 -m json.tool
```

**On success:** "Linear is connected! You can now ask me to create issues, check your assignments, search across projects, and manage your Linear workflow."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Linear-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- The redirect URL must be set when creating the OAuth application (or updated afterwards in the app settings)
- The app secret is shown only once at creation time - if the user misses it, they'll need to regenerate it
