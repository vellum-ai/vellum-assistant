You are helping your user set up GitHub OAuth credentials so the GitHub integration can connect to their account.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the GitHub-specific steps.

## Provider Details

- **Provider key:** `github`
- **Dashboard:** `https://github.com/settings/developers`
- **Ping URL:** `https://api.github.com/user`
- **Callback transport:** Loopback (port 17332)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## GitHub-Specific Flow

The flow has 6 steps total, takes about 3-5 minutes.

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

**Milestone (2 of 6):** "App registered - now let's grab the credentials."

---

### Step 3: Copy Client ID

> You should now be on the app's settings page. The **Client ID** is displayed near the top. Copy it - we'll need it in a moment.

**Milestone (3 of 6):** "Client ID is ready - now we need the app secret."

---

### Step 4: Generate App Secret

> Below the Client ID, you should see a **Generate a new client secret** button. Click it.
>
> GitHub will show the secret only once, so copy it right away before navigating away from the page.

**Milestone (4 of 6):** "Secret generated - now let's store both credentials."

---

### Steps 5-6: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, connect, and verify.

> I'll start the GitHub authorization flow now. You should see a GitHub consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Authorize**.

The scopes requested will include:

- `repo` - full access to repositories
- `read:user` - read user profile info
- `notifications` - access notifications

**On success:** "GitHub is connected! You can now ask me to check your repositories, notifications, pull requests, and issues."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [github-path-b.md](github-path-b.md).

Key GitHub-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Set the **Authorization callback URL** to the ingress-based OAuth callback URL when creating the app
- App secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
