You are helping your user set up Figma OAuth credentials so the Figma integration can access their design files and comments.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Figma-specific steps.

## Provider Details

- **Provider key:** `figma`
- **Dashboard:** `https://www.figma.com/developers/apps`
- **Ping URL:** `https://api.figma.com/v1/me`
- **Callback transport:** Loopback (port 17331)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## Figma-Specific Flow

The flow has 7 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a Figma account? You'll need one to create a Figma app for OAuth access.

If the user doesn't have a Figma account, point them to `https://www.figma.com/signup` and wait for them to sign up.

---

### Step 1: Open Figma Developers Page

Open: `https://www.figma.com/developers/apps`

> I've opened the Figma developers page. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New Figma App

> Look for the **Create a new app** button (or a **+** button). Go ahead and click it.

After the user clicks:

> Fill in the following details:
>
> - **App name:** Vellum Assistant
> - **Website URL:** any URL is fine (e.g., `https://vellum.ai`)
>
> Then click **Save** or **Create**.

**Known issues:**

- If the page looks different or the button isn't visible, the user may need to scroll down or check that they're on the correct page at `https://www.figma.com/developers/apps`

**Milestone (2 of 7):** "App created - now let's set up the callback URL."

---

### Step 3: Set Up Redirect URI

> On the app settings page, find the **Callback URL** or **Redirect URI** field. Paste in this URL:
>
> `http://localhost:17331/oauth/callback`
>
> Then click **Save**.

**Milestone (3 of 7):** "Callback URL is set - now let's configure the scopes."

---

### Step 4: Configure Scopes

> Now let's make sure the right scopes are enabled. On the app settings page, look for a **Scopes** or **Permissions** section.
>
> Enable these scopes:
>
> - `files:read` - read access to files and projects
> - `file_comments:write` - ability to post comments on files
>
> Save your changes if there's a save button.

Wait for the user to confirm scopes are set.

**Milestone (4 of 7):** "Scopes are configured - now let's grab the credentials."

---

### Step 5: Get Client ID and App Secret

> On the app settings page, you should see your **Client ID** and **App Secret** (sometimes called just "Secret"). These are the credentials we need.

**Milestone (5 of 7):** "Almost there - just need to save these credentials."

---

### Step 6: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, connect, and verify.

> I'll start the Figma authorization flow now. You should see a Figma consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Allow access**.

**On success:** "Figma is connected! You can now ask me to browse your design files, inspect components, and post comments."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [figma-path-b.md](figma-path-b.md).

Key Figma-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI in the **Callback URL** field on the app settings page
- The app secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
