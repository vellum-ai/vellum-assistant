---
name: google-oauth-setup
description: Set up Google Cloud OAuth credentials for Gmail and Calendar using browser automation
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🔑","vellum":{"display-name":"Google OAuth Setup","user-invocable":true,"includes":["browser"],"credential-setup-for":"gmail"}}
---

Set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Route Selection

- **macOS desktop app** (browser automation available): Use **Automated Setup** below.
- **Telegram / SMS / other channel** (no browser): Use **Manual Setup** below.

---

# Manual Setup (Channels)

Walk the user through each step with direct links. They do everything in their browser; you provide instructions and store the results.

### 1. Create a GCP Project

Send the user to `https://console.cloud.google.com/projectcreate`. Project name: **"Vellum Assistant"**. Get the project ID back from them.

### 2. Enable APIs

Have them open and click **Enable** on each:
- `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
- `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

### 3. Configure OAuth Consent Screen

Direct them to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`:
- User type: **External**
- App name: **Vellum Assistant**, support + developer email: their email
- Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `calendar.readonly`, `calendar.events`, `userinfo.email`
- Add themselves as a test user

### 4. Create OAuth Credentials

Direct them to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`:
- **+ Create Credentials** → **OAuth client ID** → type **"Desktop app"**
- Name: **Vellum Assistant**
- Copy the **Client ID** and **Client Secret** from the dialog

### 5. Store Credentials

**Client ID** — safe to send in chat. Ask the user to paste it, then store:
```
credential_store store: service="integration:gmail" field="client_id" value="<ID>"
```

**Client Secret** — starts with `GOCSPX-` which triggers the ingress secret scanner. Ask the user to send **only the part after** `GOCSPX-`. Reconstruct the full value by prepending `GOCSPX-` before storing:
```
credential_store store: service="integration:gmail" field="client_secret" value="GOCSPX-<suffix>"
```

### 6. Authorize

```
credential_store: action="oauth2_connect" service="integration:gmail"
```

The tool returns an authorization URL. **You MUST extract the URL from the tool result and present it as plain text in your conversation response** — do NOT rely on the user seeing the tool output panel. Write the full URL out so the user can click it. Tell them to open it on the same Mac/desktop where Vellum is running so the localhost callback can complete. If they see "This app isn't verified", tell them to click **Advanced** → **Go to Vellum Assistant (unsafe)** (normal for testing mode).

### 7. Done

> **Gmail and Calendar are connected!** Try asking me to check your inbox or show your upcoming events.

---

# Automated Setup (macOS Desktop App)

You will automate the entire GCP setup via the browser while the user watches in the Chrome window on the side. The user's only manual actions are: signing in to their Google account, and copy-pasting credentials from the Chrome window into secure prompts.

## Browser Interaction Principles

Google Cloud Console's UI changes frequently. Do NOT memorize or depend on specific element IDs, CSS selectors, or DOM structures. Instead:

1. **Snapshot first, act second.** Before every interaction, use `browser_snapshot` to discover interactive elements and their IDs. Use `browser_screenshot` for visual context when the snapshot alone isn't enough.
2. **Adapt to what you see.** If an element's label or position differs from what you expect, use the snapshot to find the correct element.
3. **Verify after every action.** After clicking, typing, or navigating, take a new snapshot to confirm the action succeeded.
4. **Never assume DOM structure.** Dropdowns may be `<select>`, `<mat-select>`, `<div role="listbox">`, or something else entirely.
5. **When stuck after 2 attempts, describe and ask.** Take a screenshot, describe what you see to the user, and ask for guidance.

## Anti-Loop Guardrails

Each step has a **retry budget of 3 attempts**. If a step fails after 3 attempts:

1. **Stop trying.** Do not continue retrying the same approach.
2. **Fall back to manual.** Tell the user what you were trying to do and ask them to complete that step manually in the Chrome window. Give them the direct URL and clear text instructions.
3. **Resume automation** at the next step once the user confirms the manual step is done.

If **two or more steps** require manual fallback, abandon the automated flow entirely and switch to giving the user the remaining steps as clear text instructions with links.

## Things That Do Not Work: Do Not Attempt

- **Downloading files.** `browser_click` on a Download button does not save files to disk. Never click Download buttons.
- **Clipboard operations.** You cannot copy/paste via browser automation. The user must manually copy values from the Chrome window.
- **Deleting and recreating OAuth clients** to get a fresh secret. This orphans the stored client_id and causes `invalid_client` errors.
- **Navigating away from the credential dialog** before both credentials are stored. You will lose the Client Secret display and cannot get it back without creating a new client.

## Step 1: Single Upfront Confirmation

Use `ui_show` with `surface_type: "confirmation"`:

- **message:** `Set up Google Cloud for Gmail & Calendar`
- **detail:**
  > Here's what will happen:
  >
  > 1. **A browser opens on the side** so you can watch everything I do
  > 2. **You sign in** to your Google account in the browser
  > 3. **I automate everything** including project creation, APIs, OAuth config, and credentials
  > 4. **One copy-paste** where I'll ask you to copy the Client Secret from the browser into a secure prompt
  > 5. **You authorize Vellum** with one click
  >
  > The whole thing takes 2-3 minutes. Ready?

If the user declines, acknowledge and stop.

## Step 2: Open Google Cloud Console and Sign In

**Goal:** The user is signed in and the Google Cloud Console dashboard is loaded.

Navigate to `https://console.cloud.google.com/`.

Take a screenshot to check the page state:

- **Sign-in page:** Tell the user: "Please sign in to your Google account in the Chrome window on the right side of your screen." Auto-detect sign-in completion by polling with `browser_screenshot` every 5-10 seconds until the URL moves to `console.cloud.google.com`. Do NOT ask the user to "let me know when you're done"; detect it automatically.
- **Already signed in:** Continue immediately.
- **CAPTCHA:** The browser automation's built-in handoff will handle this.

## Step 3: Create or Select a Project

**Goal:** A GCP project named "Vellum Assistant" exists and is selected.

Tell the user: "Creating Google Cloud project..."

Navigate to `https://console.cloud.google.com/projectcreate`. Take a `browser_snapshot`, find the project name input, type "Vellum Assistant", click **Create**. Wait 10-15 seconds.

- **Success** or redirect: Note the project ID.
- **"Project name already in use"**: Navigate to `https://console.cloud.google.com/cloud-resource-manager` to find and select the existing project.
- **Organization/quota error**: Tell the user and ask them to resolve it.

## Step 4: Enable Gmail and Calendar APIs

Tell the user: "Enabling Gmail and Calendar APIs..."

Navigate to each API's library page and enable if not already:

1. `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
2. `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

For each: take a `browser_snapshot`. Look for **"Enable"** button (click it) or **"Manage"** (already enabled, skip).

## Step 5: Configure OAuth Consent Screen

Tell the user: "Setting up OAuth consent screen..."

Navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

### If already configured
You'll see a dashboard with the app name and "Edit App". **Skip to Step 6.**

### If you see user type selection
Select **"External"** and click **Create** or **Get Started**.

### Consent screen form
- **App name**: "Vellum Assistant"
- **User support email**: Select the user's email from the dropdown
- **Developer contact email**: Type the user's email
- Click **Save and Continue**

**Scopes:** Click **"Add or Remove Scopes"**, paste all 6 at once:
```
https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email
```
Click **"Add to Table"** / **"Update"**, then **Save and Continue**.

**Test users:** Click **"Add Users"**, enter the user's email, click **Add** then **Save and Continue**.

**Summary:** Click **"Back to Dashboard"**.

## Step 6: Create OAuth Credentials and Capture Them

Tell the user: "Creating OAuth credentials..."

### 6a: Create the credential

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Click **"Create Credentials"** → **"OAuth client ID"**.

On the form:
- **Application type**: Select **"Desktop app"**
- **Name**: "Vellum Assistant"
- Do NOT add redirect URIs
- Click **"Create"**

### 6b: Capture credentials from the dialog

After creation, a dialog displays the **Client ID** and **Client Secret**. This is critical.

**Client ID:** Try to auto-read using `browser_extract`. The Client ID matches `*.apps.googleusercontent.com`. If found, store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<extracted Client ID>"
```

If auto-read fails, use `credential_store prompt` to ask the user to copy it.

**Client Secret:** The secret starts with `GOCSPX-` which triggers the secret scanner. You **cannot** read it from tool output — it will be redacted. Instead, use a secure prompt so the user pastes it directly into the vault:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud Console dialog and paste it here."
  placeholder: "GOCSPX-..."
```

**Do not take any other browser actions until the user has pasted the secret.** The dialog must stay open.

## Step 7: OAuth2 Authorization

Tell the user: "Starting the authorization flow — a Google sign-in page will open in a few seconds. Just click 'Allow' when it appears."

```
credential_store:
  action: "oauth2_connect"
  service: "integration:gmail"
```

If the tool returns an authorization URL instead of completing directly, **you MUST copy the full URL into your response text** so the user can see and click it. Do not just say "click the link above" — the tool output panel is not reliably visible.

If the user sees "This app isn't verified": tell them to click **Advanced** → **Go to Vellum Assistant (unsafe)** (normal for testing mode).

## Step 8: Done!

> **Gmail and Calendar are connected!** Try asking me to check your inbox or show your upcoming events.
