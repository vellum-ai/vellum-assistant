You are helping your user set up Discord OAuth credentials so the Discord integration can connect to their account and servers.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Discord-specific steps.

## Provider Details

- **Provider key:** `discord`
- **Dashboard:** `https://discord.com/developers/applications`
- **Ping URL:** `https://discord.com/api/v10/users/@me`
- **Callback transport:** Loopback (port 17326)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## Discord-Specific Flow

The flow has 8 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a Discord account? You don't need any special permissions; any Discord user can create applications in the Developer Portal.

If no account, direct them to `https://discord.com/register` first.

---

### Step 1: Open Discord Developer Portal

Open: `https://discord.com/developers/applications`

> I've opened the Discord Developer Portal. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New Application

> Look for the **New Application** button (top-right area). Go ahead and click it.

After the user clicks:

> Set the application name to **Vellum Assistant**, accept the Developer Terms of Service and Developer Policy, then click **Create**.

**Known issues:**

- If the user already has an application named "Vellum Assistant", they can either reuse it or pick a different name
- Discord may show a CAPTCHA during creation

**Milestone (2 of 8):** "Application created - now let's head to the OAuth2 settings."

---

### Step 3: Navigate to OAuth2

> In the left sidebar, click **OAuth2**. This is where we'll configure the credentials and scopes.

Open: the application's **OAuth2** page via the left sidebar.

**Milestone (3 of 8):** "OAuth2 page open - let's grab the Client ID."

---

### Step 4: Copy Client ID

> You should see the **Client ID** near the top of the OAuth2 page. Copy it and paste it here in the chat.

Wait for the user to provide the Client ID.

---

### Step 5: Reset and Copy the App Secret

> Now we need the app secret. Click the **Reset Secret** button. Discord will ask you to confirm - go ahead and confirm it.

> **Important:** Once the secret is shown, you'll only be able to see it this once. I'll prompt you to paste it securely in a moment.

**Known issues:**

- If the user has 2FA enabled, Discord will ask for a 2FA code before revealing the secret
- The old secret (if any) will stop working immediately after reset

**Milestone (5 of 8):** "Credentials in hand - now let's set up the redirect URL."

---

### Step 6: Add Redirect URL

> Still on the **OAuth2** page, scroll down to the **Redirects** section. Click **Add Redirect**, paste this URL:
>
> `http://localhost:17326/oauth/callback`
>
> Then click **Save Changes** at the bottom.

**Milestone (6 of 8):** "Redirect URL is set - time to save the credentials."

---

### Step 7: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, connect, and verify.

Scopes to request: `identify guilds guilds.members.read messages.read`

> I'll start the Discord authorization flow now. You should see a Discord consent page asking you to authorize **Vellum Assistant** to access your account.
>
> Review the permissions and click **Authorize**.

**On success:** "Discord is connected! You can now ask me to check your Discord servers, read messages, and look up server members."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [discord-path-b.md](discord-path-b.md).

Key Discord-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under **Redirects** on the OAuth2 page
- Discord app secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
