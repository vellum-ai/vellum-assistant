You are helping your user set up Todoist OAuth credentials so the Todoist integration can connect to their account.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Todoist-specific steps.

## Provider Details

- **Provider key:** `todoist`
- **Dashboard:** `https://developer.todoist.com/appconsole.html`
- **Scopes:** `data:read_write`
- **Callback transport:** Loopback (port 17325)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)
- **Ping URL:** `https://api.todoist.com/rest/v2/projects`

## Todoist-Specific Flow

The flow has 6 steps total, takes about 2-3 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a Todoist account? You'll need one to create a developer app.

If no account, direct them to `https://todoist.com/users/showregister` to sign up first.

---

### Step 1: Open Todoist App Console

Open: `https://developer.todoist.com/appconsole.html`

> I've opened the Todoist App Console. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New App

> Look for the **Create a new app** button and click it.

Then:

> Set the app name to **Vellum Assistant** and click **Create app**.

**Milestone (2 of 6):** "App created - now let's set up the redirect URL."

---

### Step 3: Set Up OAuth Redirect URL

> In the app settings, find the **OAuth redirect URL** field and paste in this URL:
>
> `http://localhost:17325/oauth/callback`
>
> Then click **Save settings**.

**Milestone (3 of 6):** "Redirect URL is set - now let's grab the credentials."

---

### Step 4: Copy Client ID and App Secret

> You should see the **Client ID** and **App secret** displayed in the app settings page.

**Milestone (4 of 6):** "Credentials are visible - let's save them."

---

### Step 5: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, connect, and verify.

> I'll start the Todoist authorization flow now. You should see a Todoist consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Agree**.

**On success:** "Todoist is connected! You can now ask me to manage your tasks, create projects, and organize your to-do lists."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [todoist-path-b.md](todoist-path-b.md).

Key Todoist-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under **OAuth redirect URL** in the app settings
- The app secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
