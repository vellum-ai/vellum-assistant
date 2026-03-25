---
name: dropbox-oauth-setup
description: Set up Dropbox OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Dropbox OAuth Setup"
    feature-flag: "integration-dropbox"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Dropbox OAuth credentials so the Dropbox integration can connect to their account.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Dropbox-specific steps.

## Provider Details

- **Provider key:** `dropbox`
- **Dashboard:** `https://www.dropbox.com/developers/apps`
- **Ping URL:** `https://api.dropboxapi.com/2/users/get_current_account` (POST, no body)
- **Callback transport:** Loopback (port 17327)
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)
- **Extra params:** `token_access_type=offline`

## Dropbox-Specific Flow

The flow has 11 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a Dropbox account? A free account works fine.

If no account, direct them to `https://www.dropbox.com` to create one first.

---

### Step 1: Open Dropbox App Console

Open: `https://www.dropbox.com/developers/apps`

> I've opened the Dropbox App Console. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create a New App

> Look for the **Create app** button. Go ahead and click it.

After the user clicks:

> You should see a setup form. Choose these options:
>
> 1. **Choose an API:** Select **Scoped access**
> 2. **Choose the type of access:** Select **Full Dropbox**
> 3. **Name your app:** Enter **Vellum Assistant**

Then:

> Click **Create app** to finish.

**Known issues:**

- App names must be globally unique on Dropbox - if "Vellum Assistant" is taken, suggest adding a suffix like "Vellum Assistant - Personal"
- If the user sees "You have reached the limit for the number of apps," they'll need to delete an unused app first

**Milestone (2 of 11):** "App created - now let's set the permissions."

---

### Step 3: Set Permissions

> Click the **Permissions** tab at the top of the app page.
>
> You'll need to check the boxes for each of these scopes:
>
> - `files.metadata.read` - view file and folder metadata
> - `files.content.read` - read file content
> - `files.content.write` - create and update files
> - `sharing.read` - view shared files and folders
>
> Make sure each one is checked.

Wait for the user to confirm all 4 scopes are enabled.

---

### Step 4: Save Permissions

> Now click the **Submit** button at the bottom to save the permissions.

**Important:** Permissions must be saved before the authorization step, otherwise the token will not include the requested scopes.

**Milestone (4 of 11):** "Permissions saved - now let's set up the redirect URL."

---

### Step 5: Set Up Redirect URI

> Click the **Settings** tab. Scroll down to the **OAuth 2** section and find the **Redirect URIs** field.
>
> Paste this URI and click **Add**:
>
> `http://localhost:17327/oauth/callback`

---

### Step 6: Get App Key and App Secret

> Stay on the **Settings** tab. Scroll up to the **App key** and **App secret** fields in the same OAuth 2 section.
>
> The App key is shown in plain text. The App secret is hidden - click **Show** to reveal it.

**Milestone (6 of 11):** "Found the credentials - now let's save them."

---

### Step 7: Store App Key (Client ID)

Collect the App key conversationally:

> Copy the **App key** and paste it here in the chat.

---

### Step 8: Store App Secret

Collect the App secret via secure prompt:

```
credential_store prompt:
  service: "dropbox"
  field: "oauth_secret"
  label: "Dropbox App Secret"
  description: "Copy the App secret from the Settings page (click Show to reveal it) and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider dropbox --client-id $(cat <<'EOF'
    <app-key>
    EOF
    ) --client-secret-credential-path "credential/dropbox/oauth_secret"
```

**Milestone (8 of 11):** "Credentials saved - just the authorization step left."

---

### Step 9: Authorize

> I'll start the Dropbox authorization flow now. You should see a Dropbox consent page asking you to allow **Vellum Assistant** to access your Dropbox.
>
> Review the permissions and click **Allow**.

```
bash:
  command: |
    assistant oauth connect dropbox
```

---

### Step 10: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    assistant oauth ping dropbox
```

**On success:** "Dropbox is connected! You can now ask me to read files, upload documents, and browse your Dropbox."

---

### Step 11: Done

Summarize what was set up and remind the user:

> Your Dropbox integration is ready. The token will refresh automatically, so you shouldn't need to repeat this process.

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Dropbox-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under **Redirect URIs** on the Settings tab
- App secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
