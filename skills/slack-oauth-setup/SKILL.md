---
name: slack-oauth-setup
description: Set up Slack OAuth credentials for Slack integration using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Slack OAuth Setup"
    user-invocable: true
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Slack OAuth credentials so the Slack messaging integration can connect to their workspace.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Slack-specific steps.

## Provider Details

- **Provider key:** `integration:slack`
- **Auth URL:** `https://slack.com/oauth/v2/authorize`
- **Token URL:** `https://slack.com/api/oauth.v2.access`
- **Ping URL:** `https://slack.com/api/auth.test`
- **Callback transport:** Loopback (port 17322)
- **Requires secret:** Yes (token endpoint needs both client ID and secret)

## Slack-Specific Flow

The flow has 8 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start — do you have a Slack workspace where you have permission to install apps?

If no workspace or no admin access, explain that workspace admin approval may be needed and offer to proceed anyway (some workspaces allow member-installed apps).

---

### Step 1: Open Slack API Dashboard

Open: `https://api.slack.com/apps`

> I've opened the Slack API dashboard. If it's asking you to sign in, go ahead and do that first — then let me know.

---

### Step 2: Create a New Slack App

> Look for the **Create New App** button (usually green, top-right area). Go ahead and click it.

After the user clicks:

> You should see two options — **From scratch** and **From an app manifest**. Pick **From scratch**.

Then:

> Set the app name to **Vellum Assistant** and select your workspace from the dropdown. Then click **Create App**.

**Known issues:**

- If the workspace dropdown is empty, the user may need to sign in to a different workspace
- Some workspaces require admin approval for new apps — if blocked, explain that they'll need an admin to approve the app

**Milestone (2 of 8):** "App created — now let's add the permissions it needs."

---

### Step 3: Add User Token Scopes

Open: the app's **OAuth & Permissions** page. Look for it in the left sidebar, or navigate directly if you have the app URL.

> In the left sidebar, click **OAuth & Permissions**. Scroll down until you see **User Token Scopes**.
>
> You'll need to click **Add an OAuth Scope** and add each of these scopes one at a time:
>
> - `channels:read` — view basic channel info
> - `channels:history` — read public channel messages
> - `groups:read` — view private channel info
> - `groups:history` — read private channel messages
> - `im:read` — view direct message info
> - `im:history` — read direct messages
> - `im:write` — start and send direct messages
> - `mpim:read` — view group DM info
> - `mpim:history` — read group DM messages
> - `users:read` — view user profiles
> - `chat:write` — send messages
> - `search:read` — search messages
> - `reactions:write` — add emoji reactions
>
> You can start typing the scope name to filter the dropdown — it goes pretty fast once you get the rhythm.

Wait for the user to confirm all 13 scopes are added.

**Milestone (3 of 8):** "Permissions are set — now let's handle the redirect URL."

---

### Step 4: Set Up Redirect URL

Before this step, resolve the redirect URI:

```
bash:
  command: assistant oauth providers list --provider-key "integration:slack" --json
```

Check the `redirectUri` from `credential_store describe`:

```
credential_store describe:
  service: "integration:slack"
```

- If `redirectUri` mentions `ingress.publicBaseUrl` or says "not currently configured", stop and help the user configure public ingress first.
- Otherwise (including loopback URIs like `http://localhost:17322/callback`), tell the user to scroll up to the **Redirect URLs** section on the same OAuth & Permissions page, click **Add New Redirect URL**, paste the URI, click **Add**, then **Save URLs**.

> Slack requires the redirect URL to be registered even for local loopback callbacks. Without it, the authorization step will fail with a redirect mismatch error.

---

### Step 5: Get Client ID and Client Secret

> Now let's grab the credentials. In the left sidebar, click **Basic Information**.

Open: the app's **Basic Information** page via the sidebar.

> Scroll down to the **App Credentials** section. You should see **Client ID** and **Client Secret** listed there.

**Milestone (5 of 8):** "Almost there — just need to save these credentials."

---

### Step 6: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect Client Secret via secure prompt:

```
credential_store prompt:
  service: "integration:slack"
  field: "client_secret"
  label: "Slack OAuth Client Secret"
  description: "Copy the Client Secret from the Basic Information page (you may need to click Show first) and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:slack --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "credential/integration:slack/client_secret"
```

**Milestone (6 of 8):** "Credentials saved — just the authorization step left."

---

### Step 7: Authorize

> I'll start the Slack authorization flow now. You should see a Slack consent page asking you to allow **Vellum Assistant** to access your workspace.
>
> Review the permissions and click **Allow**.

```
bash:
  command: |
    assistant oauth connections connect integration:slack --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

---

### Step 8: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:slack --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "https://slack.com/api/auth.test" | python3 -m json.tool
```

**On success:** "Slack is connected! You can now ask me to check your Slack messages, search conversations, send messages, and react to posts."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Slack-specific differences for Path B:

- Loopback callback won't work from a remote channel — need public ingress configured
- Add the ingress-based redirect URI under **Redirect URLs** on the OAuth & Permissions page
- Client Secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
