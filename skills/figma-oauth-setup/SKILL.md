---
name: figma-oauth-setup
description: Set up Figma OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Figma OAuth Setup"
    feature-flag: "integration-figma"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Figma OAuth credentials so the Figma integration can access their design files and comments.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Figma-specific steps.

## Provider Details

- **Provider key:** `integration:figma`
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

### Step 6: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "integration:figma"
  field: "oauth_secret"
  label: "Figma OAuth App Secret"
  description: "Copy the app secret from the Figma app settings page and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:figma --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:figma:oauth_secret"
```

**Milestone (6 of 7):** "Credentials saved - just the authorization step left."

---

### Step 7: Authorize and Verify

> I'll start the Figma authorization flow now. You should see a Figma consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Allow access**.

```
bash:
  command: |
    assistant oauth connect integration:figma
```

After authorization completes, verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth token integration:figma)" "https://api.figma.com/v1/me" | python3 -m json.tool
```

**On success:** "Figma is connected! You can now ask me to browse your design files, inspect components, and post comments."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Figma-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI in the **Callback URL** field on the app settings page
- The app secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
