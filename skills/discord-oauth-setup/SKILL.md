---
name: discord-oauth-setup
description: Set up Discord OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Discord OAuth Setup"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Discord OAuth credentials so the Discord integration can connect to their account and servers.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Discord-specific steps.

## Provider Details

- **Provider key:** `integration:discord`
- **Dashboard:** `https://discord.com/developers/applications`
- **Ping URL:** `https://discord.com/api/v10/users/@me`
- **Callback transport:** Loopback (port 17326)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## Discord-Specific Flow

The flow has 9 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start — do you have a Discord account? You don't need any special permissions; any Discord user can create applications in the Developer Portal.

If no account, direct them to `https://discord.com/register` first.

---

### Step 1: Open Discord Developer Portal

Open: `https://discord.com/developers/applications`

> I've opened the Discord Developer Portal. If it's asking you to sign in, go ahead and do that first — then let me know.

---

### Step 2: Create a New Application

> Look for the **New Application** button (top-right area). Go ahead and click it.

After the user clicks:

> Set the application name to **Vellum Assistant**, accept the Developer Terms of Service and Developer Policy, then click **Create**.

**Known issues:**

- If the user already has an application named "Vellum Assistant", they can either reuse it or pick a different name
- Discord may show a CAPTCHA during creation

**Milestone (2 of 9):** "Application created — now let's head to the OAuth2 settings."

---

### Step 3: Navigate to OAuth2

> In the left sidebar, click **OAuth2**. This is where we'll configure the credentials and scopes.

Open: the application's **OAuth2** page via the left sidebar.

**Milestone (3 of 9):** "OAuth2 page open — let's grab the Client ID."

---

### Step 4: Copy Client ID

> You should see the **Client ID** near the top of the OAuth2 page. Copy it and paste it here in the chat.

Wait for the user to provide the Client ID.

---

### Step 5: Reset and Copy the App Secret

> Now we need the app secret. Click the **Reset Secret** button. Discord will ask you to confirm — go ahead and confirm it.

> **Important:** Once the secret is shown, you'll only be able to see it this once. I'll prompt you to paste it securely in a moment.

**Known issues:**

- If the user has 2FA enabled, Discord will ask for a 2FA code before revealing the secret
- The old secret (if any) will stop working immediately after reset

**Milestone (5 of 9):** "Credentials in hand — now let's set up the redirect URL."

---

### Step 6: Add Redirect URL

> Still on the **OAuth2** page, scroll down to the **Redirects** section. Click **Add Redirect**, paste this URL:
>
> `http://localhost:17326/oauth/callback`
>
> Then click **Save Changes** at the bottom.

**Milestone (6 of 9):** "Redirect URL is set — time to save the credentials."

---

### Step 7: Store Credentials

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "integration:discord"
  field: "oauth_secret"
  label: "Discord OAuth App Secret"
  description: "Paste the app secret you just copied from the OAuth2 page."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:discord --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:discord:oauth_secret"
```

**Milestone (7 of 9):** "Credentials saved — just the authorization step left."

---

### Step 8: Authorize

> I'll start the Discord authorization flow now. You should see a Discord consent page asking you to authorize **Vellum Assistant** to access your account.
>
> Review the permissions and click **Authorize**.

```
bash:
  command: |
    assistant oauth connections connect integration:discord --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --scopes identify guilds guilds.members.read messages.read
```

---

### Step 9: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:discord --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "https://discord.com/api/v10/users/@me" | python3 -m json.tool
```

**On success:** "Discord is connected! You can now ask me to check your Discord servers, read messages, and look up server members."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Discord-specific differences for Path B:

- Loopback callback won't work from a remote channel — need public ingress configured
- Add the ingress-based redirect URI under **Redirects** on the OAuth2 page
- Discord app secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
