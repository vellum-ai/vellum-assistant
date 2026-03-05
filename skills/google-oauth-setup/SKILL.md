---
name: "google-oauth-setup"
description: "Set up Google Cloud OAuth credentials for Gmail and Calendar using CLI tools or guided manual steps"
compatibility: "Desktop: requires gcloud and gws CLI tools. Channels: requires public ingress for OAuth callback"
metadata:
  emoji: "🔑"
  vellum:
    user-invocable: true
    credential-setup-for: "gmail"
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Client Check

Determine which setup path to use based on the user's client:

- **macOS desktop app**: Follow **Path B: CLI Setup** below.
- **Telegram or other channel** (no browser automation): Follow **Path A: Manual Setup for Channels** below.

---

# Path A: Manual Setup for Channels (Telegram, SMS, etc.)

When the user is on Telegram or any non-macOS client, walk them through a text-based setup. No browser automation is used; the user follows links and performs each action manually.

### Channel Step 1: Confirm and Explain

Tell the user:

> **Setting up Gmail & Calendar from Telegram**
>
> Since I can't automate the browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Google account with access to Google Cloud Console
> 2. About 5 minutes
>
> Ready to start?

If the user declines, acknowledge and stop.

### Channel Step 2: Create a Google Cloud Project

Tell the user:

> **Step 1: Create a Google Cloud project**
>
> Open this link to create a new project:
> https://console.cloud.google.com/projectcreate
>
> Set the project name to **"Vellum Assistant"** and click **Create**.
>
> Let me know when it's done (or if you already have a project you'd like to use, just tell me the project ID).

Wait for confirmation. Note the project ID for subsequent steps.

### Channel Step 3: Enable APIs

Tell the user:

> **Step 2: Enable Gmail and Calendar APIs**
>
> Open each link below and click **Enable**:
>
> 1. Gmail API: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
> 2. Calendar API: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`
>
> Let me know when both are enabled.

(Substitute the actual project ID into the URLs.)

### Channel Step 4: Configure OAuth Consent Screen

Tell the user:

> **Step 3: Configure the OAuth consent screen**
>
> Open: `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`
>
> 1. Select **"External"** user type, click **Create**
> 2. Fill in:
>    - App name: **Vellum Assistant**
>    - User support email: **your email**
>    - Developer contact email: **your email**
> 3. Click **Save and Continue**
> 4. On the Scopes page, click **Add or Remove Scopes** and add these:
>    - `https://www.googleapis.com/auth/gmail.readonly`
>    - `https://www.googleapis.com/auth/gmail.modify`
>    - `https://www.googleapis.com/auth/gmail.send`
>    - `https://www.googleapis.com/auth/calendar.readonly`
>    - `https://www.googleapis.com/auth/calendar.events`
>    - `https://www.googleapis.com/auth/userinfo.email`
>    - Click **Update**, then **Save and Continue**
> 5. On the Test users page, add **your email**, click **Save and Continue**
> 6. On the Summary page, click **Back to Dashboard**
>
> Let me know when the consent screen is configured.

### Channel Step 5: Create OAuth Credentials (Web Application)

Before sending Step 4 to the user, resolve the concrete callback URL:

- Read the configured public gateway URL (`ingress.publicBaseUrl`). If it is missing, run the `public-ingress` skill first.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- When you send the instructions below, replace `OAUTH_CALLBACK_URL` with that concrete value. Never send placeholders literally.

Tell the user:

> **Step 4: Create OAuth credentials**
>
> Open: `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`
>
> Use this exact redirect URI:
> `OAUTH_CALLBACK_URL`
>
> 1. Click **+ Create Credentials** → **OAuth client ID**
> 2. Application type: Select **"Web application"** (not Desktop app)
> 3. Name: **Vellum Assistant**
> 4. Under **Authorized redirect URIs**, click **Add URI** and paste the redirect URI shown above
> 5. Click **Create**
>
> A dialog will show your **Client ID** and **Client Secret**. Copy both values, you'll need them in the next step.

**Important:** Channel users must use **"Web application"** credentials (not Desktop app) because the OAuth callback goes through the gateway URL.

### Channel Step 6: Store Credentials

**Step 6a: Client ID (safe to send in chat)**

Tell the user:

> **Step 5a: Send your Client ID**
>
> Please send me the **Client ID** from the dialog. It looks like `123456789-xxxxx.apps.googleusercontent.com`.

Wait for the user to send the Client ID. Once received, store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the Client ID the user sent>"
```

**Step 6b: Client Secret (requires split entry to avoid security filters)**

The Client Secret starts with `GOCSPX-` which triggers the ingress secret scanner on channel messages. To work around this, ask the user to send only the portion _after_ the prefix.

Tell the user:

> **Step 5b: Send your Client Secret (split entry)**
>
> Your Client Secret starts with `GOCSPX-` followed by a series of characters. For security reasons, I can't receive the full value directly in chat.
>
> Please send me **only the part after** `GOCSPX-` (the characters that come after the dash) as a standalone message with no other text. For example, if your secret is `GOCSPX-AbCdEfGhIjKlMnOpQrStUvWxYz12`, send just:
>
> `AbCdEfGhIjKlMnOpQrStUvWxYz12`

Wait for the user to send the suffix. Once received, reconstruct the full secret by prepending `GOCSPX-` and store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_secret"
  value: "GOCSPX-<the suffix the user sent>"
```

**Important:** Always prepend `GOCSPX-` to the value the user provides. The user sends only the suffix; you reconstruct the full secret before storing.

### Channel Step 7: Authorize

Tell the user:

> **Step 6: Authorize access**
>
> I'll now generate an authorization link for you.

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This will return an auth URL (since the session is non-interactive). Send the URL to the user:

> Open this link to authorize Vellum to access your Gmail and Calendar. After you click **Allow**, the connection will be set up automatically.

**If the user sees a "This app isn't verified" warning:** Tell them this is normal for apps in testing mode. Click "Advanced" then "Go to Vellum Assistant (unsafe)" to proceed.

### Channel Step 8: Done!

After the user authorizes (they'll come back and say so, or you can suggest they verify):

> **Gmail and Calendar are connected!** Try asking me to check your inbox or show your upcoming events to verify everything is working.

---

# Path B: CLI Setup (macOS Desktop App)

You will set up Google Cloud OAuth credentials using the `gcloud` and `gws` command-line tools plus browser automation. The user signs in once via the browser, the CLI handles project setup, and the browser automates credential creation — the user only needs to copy-paste the Client Secret.

## Browser Interaction Principles

Google Cloud Console's UI may change over time. Do NOT memorize or depend on specific element IDs, CSS selectors, or DOM structures. Instead:

1. **Screenshot first, act second.** Before every interaction, take a `browser_screenshot` to see the current visual state. Use `browser_snapshot` to find interactive elements.
2. **Adapt to what you see.** If a button's label or position differs from what you expect, use the screenshot to find the correct element.
3. **Verify after every action.** After clicking, typing, or navigating, take a new screenshot to confirm the action succeeded.
4. **Never assume DOM structure.** Use the snapshot to identify what's on the page and interact accordingly.
5. **When stuck, screenshot and describe.** If you cannot find an expected element after 2 attempts, take a screenshot, describe what you see to the user, and ask for guidance.

## Anti-Loop Guardrails

Each step has a **retry budget of 3 attempts**. An attempt is one try at the step's primary action (e.g., clicking a button, filling a form). If a step fails after 3 attempts:

1. **Stop trying.** Do not continue retrying the same approach.
2. **Fall back to manual.** Tell the user what you were trying to do and ask them to complete that step manually in the browser. Give them the direct URL and clear text instructions.
3. **Resume automation** at the next step once the user confirms the manual step is done.

If **two or more steps** require manual fallback, abandon the automated flow entirely and switch to giving the user the remaining steps as clear text instructions with links.

## Things That Do Not Work — Do Not Attempt

These actions are technically impossible in the browser automation environment:

- **Downloading files.** `browser_click` on a Download button does not save files to disk. Do NOT click "Download JSON" in the OAuth client creation dialog.
- **Reading the Client Secret from a screenshot.** The secret IS visible in the creation dialog, but you MUST NOT attempt to read it from a screenshot — it is too easy to misread characters, and the value must be exact. Always use the `credential_store prompt` approach to let the user copy-paste it accurately.
- **Clipboard operations.** You cannot copy/paste via browser automation.

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Element not found:** Take a fresh screenshot to re-assess. The GCP Console UI may have changed. Describe what you see and try alternative approaches. If stuck after 2 attempts, ask the user for guidance.
- **OAuth client already exists with same name:** This is fine — GCP allows multiple clients with the same name. Proceed with creation.
- **Any unexpected state:** Take a `browser_screenshot`, describe what you see, and ask the user for guidance.

## CLI Step 1: Confirm

Use `ui_show` with `surface_type: "confirmation"`:

- **message:** `Set up Google Cloud for Gmail & Calendar`
- **detail:**
  > Here's what will happen:
  >
  > 1. **Install CLI tools** (`gcloud` and `gws`) if not already installed
  > 2. **You sign in** to your Google account once via the browser
  > 3. **CLI automates everything** — project creation, APIs, and consent screen
  > 4. **I create OAuth credentials** in the browser — you just watch
  > 5. **One quick copy-paste** — you copy the Client Secret into a secure prompt
  > 6. **You authorize** with one click
  >
  > Takes about a minute after first-time setup. Ready?

If the user declines, acknowledge and stop.

## CLI Step 2: Install Prerequisites

Check for and install each prerequisite. If any installation fails (e.g., Homebrew not available, corporate restrictions), tell the user what went wrong and provide manual installation instructions.

### gcloud

```bash
which gcloud
```

If missing:

```bash
brew install google-cloud-sdk
```

After installation, verify it works:

```bash
gcloud --version
```

### gws

```bash
which gws
```

If missing:

```bash
npm install -g @googleworkspace/cli
```

After installation, verify it works:

```bash
gws --version
```

## CLI Step 3: Sign In to Google

Tell the user: "Opening your browser so you can sign in to Google..."

```bash
gcloud auth login
```

This opens the browser for Google sign-in. Wait for the command to complete — it prints the authenticated account email on success.

If the user is already authenticated (`gcloud auth list` shows an active account), skip this step and tell the user: "Already signed in, continuing setup..."

## CLI Step 4: GCP Project Setup

Tell the user: "Setting up your Google Cloud project, APIs, and credentials..."

```bash
gws auth setup
```

This command automates:

- GCP project creation (or selection of an existing one)
- OAuth consent screen configuration
- OAuth credential creation

Wait for the command to complete. It may have interactive prompts — let them run in the terminal and the user can respond if needed.

Note the **project ID** from the output — you'll need it for the next step.

## CLI Step 5: Enable Additional APIs

`gws auth setup` enables the APIs it needs, but Vellum also requires the Calendar and People APIs. Enable them explicitly using the project ID from step 4:

```bash
gcloud services enable calendar-json.googleapis.com --project=PROJECT_ID
gcloud services enable people.googleapis.com --project=PROJECT_ID
```

If either command reports the API is already enabled, that's fine — continue.

## CLI Step 6: Create OAuth Credentials via Browser

**Goal:** Create a Desktop OAuth client in GCP Console and capture both credentials.

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID` (substitute the actual project ID from step 4).

Take a screenshot and snapshot to check the page state:
- **Sign-in page:** Tell the user: "Please sign in to your Google account in the browser." Then auto-detect sign-in completion by polling screenshots every 5-10 seconds. Once signed in, continue.
- **Already signed in / Credentials page loaded:** Continue immediately.

### Step 6a: Create the OAuth Client

1. Take a screenshot and snapshot. Find and click **+ Create Credentials**, then select **OAuth client ID**.
2. On the creation form:
   - Application type: Select **"Desktop app"**
   - Name: **"Vellum Assistant"**
   - Click **Create**
3. **Verify:** Take a screenshot. A dialog should appear showing both the **Client ID** and **Client Secret**.

### Step 6b: Extract Client ID

Use `browser_extract` to read the Client ID from the creation dialog. It looks like `123456789-xxxxx.apps.googleusercontent.com`.

Store it immediately:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the extracted Client ID>"
```

### Step 6c: Capture Client Secret via Secure Prompt

The Client Secret is visible in the same dialog. Do NOT attempt to read it from the screenshot — use a secure prompt so the user copies it accurately.

Tell the user: "Your OAuth credentials have been created! Please copy the **Client Secret** shown in the dialog and paste it into the secure prompt below."

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the dialog on screen. It starts with GOCSPX-"
  placeholder: "GOCSPX-..."
```

**CRITICAL — do NOT dismiss the creation dialog before the user has copied the secret.** Wait for the secure prompt to be completed before clicking OK or navigating away.

After the secret is stored, you may close the dialog.

## CLI Step 7: Authorize

Tell the user: "Starting the authorization flow — a Google sign-in page will open. Just click 'Allow' when it appears."

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This auto-reads client_id and client_secret from the secure store and auto-fills auth_url, token_url, scopes, and extra_params from well-known config.

**If the user sees a "This app isn't verified" warning:** Tell them: "You'll see an 'app isn't verified' warning. This is normal for personal apps in testing mode. Click **Advanced**, then **Go to Vellum Assistant (unsafe)** to proceed."

**Verify:** The `oauth2_connect` call returns a success message with the connected account email.

## CLI Step 8: Done!

Tell the user: "**Gmail and Calendar are connected!** You can now read, search, and send emails, plus view and manage your calendar. Try asking me to check your inbox or show your upcoming events!"
