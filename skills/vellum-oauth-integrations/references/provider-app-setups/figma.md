You are helping your user set up Figma OAuth credentials so the Figma integration can access their design files and comments.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Figma-specific steps.

## Provider Details

- **Provider key:** `figma`
- **Dashboard:** `https://www.figma.com/developers/apps`
- **Ping URL:** `https://api.figma.com/v1/me`
- **Callback transport:** Loopback (port 17331)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)
- **Managed mode:** Supported

## Check Managed Mode First

Figma supports managed mode, so registering an app is optional:

```bash
assistant oauth mode figma --json | jq -r '.mode'
```

- If the result is `managed`, **stop reading this file** and follow [CONNECTING_ACCOUNTS.md](../CONNECTING_ACCOUNTS.md) instead.
- If the result is `your-own` and the user already has an active Figma connection (`assistant oauth status figma`), respect it and do not switch modes.
- Otherwise offer the managed flow before walking through app registration. It is a single Figma login, against the seven steps below.

Only continue here once the user has chosen `your-own`.

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

Figma rejects the **whole** authorization request when the app is not configured
to grant one of the requested scopes, so the app has to enable every scope the
connect flow asks for. Read the exact set first:

```bash
assistant oauth providers get figma --json | jq -r '.defaultScopes[]'
```

That is the list below. Keep the two in sync: if the CLI returns something
different, follow the CLI.

> Now let's make sure the right scopes are enabled. On the app settings page, look for a **Scopes** or **Permissions** section.
>
> Enable all of these:
>
> - `current_user:read` - your name, email, and profile image
> - `file_content:read` - contents of files, such as nodes and the editor type
> - `file_metadata:read` - metadata of files
> - `file_versions:read` - version history for files you can access
> - `file_comments:read` - comments on files
> - `file_comments:write` - post and delete comments and comment reactions
> - `file_dev_resources:read` - dev resources in files
> - `file_dev_resources:write` - write dev resources to files
> - `folders:read` - list folders and the files inside them
> - `folder_metadata:read` - metadata of folders
> - `library_content:read` - published components and styles of files
> - `library_assets:read` - data of individual published components and styles
> - `team_library_content:read` - published components and styles of teams
> - `selections:read` - most recent selection in files you can access
>
> Save your changes if there's a save button.

Wait for the user to confirm scopes are set.

**Narrower grants.** If the user does not want to enable all fourteen, have them
enable only the ones they are comfortable with and pass that exact set on
connect, which replaces the defaults entirely:

```bash
assistant oauth connect figma --scopes current_user:read file_content:read file_comments:write
```

`current_user:read` is the one scope to keep in any narrowed set: the ping and
identity checks both call `GET /v1/me`.

**Do not add** `file_variables:read`, `file_variables:write`,
`library_analytics:read`, or any `org:*` scope unless the user is on a Figma
plan that offers them (Enterprise, plus org admin for `org:*`). Requesting one
the app cannot grant fails the whole authorization.

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
- The app secret doesn't have a known prefix that triggers scanners, but still use `assistant credentials prompt` for security (never inline `assistant credentials set`)
