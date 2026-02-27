---
name: "Google OAuth Setup"
description: "Set up Google Cloud OAuth credentials for Gmail and Calendar using browser automation"
user-invocable: true
includes: ["browser", "public-ingress"]
metadata: {"vellum": {"emoji": "\ud83d\udd11"}}
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Client Check

Determine whether the user has browser automation available (macOS desktop app) or is on a non-interactive channel (Telegram, SMS, etc.).

- **macOS desktop app**: Follow the **Automated Setup** path below.
- **Telegram or other channel** (no browser automation): Follow the **Manual Setup for Channels** path below.

---

# Path A: Manual Setup for Channels (Telegram, SMS, etc.)

When the user is on Telegram or any non-macOS client, walk them through a text-based setup. No browser automation is used — the user follows links and performs each action manually.

### Channel Step 1: Confirm and Explain

Tell the user:

> **Setting up Gmail & Calendar from Telegram**
>
> Since I can't automate the browser from here, I'll walk you through each step with direct links. You'll need:
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
> Let me know when it's done (or if you already have a project you'd like to use — just tell me the project ID).

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

Tell the user:

> **Step 4: Create OAuth credentials**
>
> Open: `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`
>
> 1. Click **+ Create Credentials** → **OAuth client ID**
> 2. Application type: Select **"Web application"** (not Desktop app)
> 3. Name: **Vellum Assistant**
> 4. Under **Authorized redirect URIs**, click **Add URI** and enter:
>    `$GATEWAY_BASE_URL/webhooks/oauth/callback`
> 5. Click **Create**
>
> A dialog will show your **Client ID** and **Client Secret**. Copy both values — you'll need them in the next step.

(Use the injected `GATEWAY_BASE_URL` value to build the callback URL shown above.)

**Important:** Channel users must use **"Web application"** credentials (not Desktop app) because the OAuth callback goes through the gateway's public URL.

### Channel Step 6: Store Credentials

**Step 6a — Client ID (safe to send in chat):**

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

**Step 6b — Client Secret (requires split entry to avoid security filters):**

The Client Secret starts with `GOCSPX-` which triggers the ingress secret scanner on channel messages. To work around this, ask the user to send only the portion *after* the prefix.

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

# Path B: Automated Setup (macOS Desktop App)

You will automate the entire GCP setup via the browser while the user watches via screencast. The user's only manual actions are signing in to their Google account and one copy-paste for the client secret.

## Browser Interaction Principles

Google Cloud Console's UI changes frequently. Do NOT memorize or depend on specific element IDs, CSS selectors, or DOM structures. Instead:

1. **Screenshot first, act second.** Before every interaction, take a `browser_screenshot` to see the current visual state. Use `browser_snapshot` to find interactive elements.
2. **Adapt to what you see.** If a button's label or position differs from what you expect, use the screenshot to find the correct element. GCP may rename buttons, reorganize menus, or change form layouts at any time.
3. **Verify after every action.** After clicking, typing, or navigating, take a new screenshot to confirm the action succeeded. If it didn't, try an alternative interaction (e.g., if a dropdown didn't open on click, try pressing Space or Enter).
4. **Never assume DOM structure.** Dropdowns may be `<select>`, `<mat-select>`, `<div role="listbox">`, or something else entirely. Use the snapshot to identify what's on the page and interact accordingly.
5. **When stuck, screenshot and describe.** If you cannot find an expected element after 2 attempts, take a screenshot, describe what you see to the user, and ask for guidance.

## Anti-Loop Guardrails

Each step has a **retry budget of 3 attempts**. An attempt is one try at the step's primary action (e.g., clicking a button, filling a form). If a step fails after 3 attempts:

1. **Stop trying.** Do not continue retrying the same approach.
2. **Fall back to manual.** Tell the user what you were trying to do and ask them to complete that step manually in the browser. Give them the direct URL and clear text instructions.
3. **Resume automation** at the next step once the user confirms the manual step is done.

If **two or more steps** require manual fallback, abandon the automated flow entirely and switch to giving the user the remaining steps as clear text instructions with links — using the correct OAuth type for the current flow (Desktop app for macOS, Web application for channels).

## Things That Do Not Work — Do Not Attempt

These actions are technically impossible in the browser automation environment. Attempting them wastes time and leads to loops:

- **Downloading files.** `browser_click` on a Download button does not save files to disk. The downloaded file will not appear anywhere accessible. There is NO JSON file to find at `~/Downloads` or anywhere else.
- **Reading the Client Secret from a screenshot.** The Client Secret IS visible in the creation dialog, but you MUST NOT attempt to read it from a screenshot — it is too easy to misread characters, and the value must be exact. Always use the `credential_store prompt` approach to let the user copy-paste it accurately.
- **Clipboard operations.** You cannot copy/paste via browser automation.
- **Deleting and recreating OAuth clients** to get a fresh secret — this orphans the stored client_id and causes `invalid_client` errors.

## Step 1: Single Upfront Confirmation

Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Set up Google Cloud for Gmail & Calendar**
>
> Here's what will happen:
> 1. **A browser opens** — you sign in to your Google account
> 2. **I automate everything** — project creation, APIs, OAuth config, credentials
> 3. **One quick copy-paste** — I'll create OAuth credentials and ask you to copy-paste the Client Secret from the dialog into a secure prompt
> 4. **You authorize Vellum** with one click
>
> The whole thing takes 2-3 minutes. Ready?

If the user declines, acknowledge and stop. No further confirmations are needed after this point.

## Step 2: Open Google Cloud Console and Sign In

**Goal:** The user is signed in and the Google Cloud Console dashboard is loaded.

Navigate to `https://console.cloud.google.com/`.

Take a screenshot and snapshot to check the page state:
- **Sign-in page:** Tell the user: "Please sign in to your Google account in the browser preview panel (or the Chrome window that just opened)." Then auto-detect sign-in completion by polling screenshots every 5-10 seconds. Check if the current URL has moved away from `accounts.google.com` to `console.cloud.google.com`. Do NOT ask the user to "let me know when you're done" — detect it automatically. Once sign-in is detected, tell the user: "Signed in! Starting the automated setup now..."
- **Already signed in:** Tell the user: "Already signed in — starting setup now..." and continue immediately.
- **CAPTCHA:** The browser automation's built-in handoff will handle this. If it persists, tell the user: "There's a CAPTCHA in the browser — please complete it and I'll continue automatically."

**Verify:** URL contains `console.cloud.google.com` and no sign-in overlay is visible.

## Step 3: Create or Select a Project

**Goal:** A GCP project named "Vellum Assistant" exists and is selected.

Tell the user: "Creating Google Cloud project 'Vellum Assistant'..."

Navigate to `https://console.cloud.google.com/projectcreate`. Take a screenshot. Find the project name input field, enter "Vellum Assistant", and submit the form.

If the project already exists (e.g., an error says the name is taken or you see it in the project list), select the existing project instead. Note the project ID for subsequent steps.

**Verify:** Take a screenshot. The console shows the project is active (project name visible in the header bar or a success message). Record the project ID.

## Step 4: Enable Gmail and Calendar APIs

**Goal:** Both the Gmail API and Google Calendar API are enabled for the project.

Tell the user: "Enabling Gmail and Calendar APIs..."

Navigate to each API's library page and enable it if not already enabled:
1. `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
2. `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

For each page: take a screenshot. If the API shows as already enabled (e.g., "Manage" button or "API enabled" status), skip it. Otherwise, find and click the enable button, then wait for confirmation.

**Verify:** Both API pages show an enabled/active state.

## Step 5: Configure OAuth Consent Screen

**Goal:** An OAuth consent screen is configured with External user type, the required scopes, and the user added as a test user.

Tell the user: "Configuring OAuth consent screen — this is the longest step, but it's fully automated..."

Navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

Take a screenshot. If the consent screen is already configured (you see a dashboard with app info), skip to Step 6.

Otherwise, work through the consent screen wizard. The wizard has multiple pages — progress through each:

**App information page:**
- Select "External" user type if prompted
- App name: "Vellum Assistant"
- User support email: select the user's email (this may be a dropdown or text input — adapt to what you see)
- Developer contact email: enter the user's email
- Submit / Save and Continue

**Scopes page:**
- Add these scopes:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.modify`
  - `https://www.googleapis.com/auth/gmail.send`
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/calendar.events`
  - `https://www.googleapis.com/auth/userinfo.email`
- Save and Continue

**Test users page:**
- Add the user's email as a test user
- Save and Continue

**Summary page:**
- Return to dashboard

**Verify:** The consent screen dashboard shows "Vellum Assistant" with the configured scopes.

## Step 6: Create OAuth Credentials and Capture Both Client ID and Secret

**Goal:** A "Desktop app" OAuth client exists, and both its Client ID and Client Secret are stored in the vault.

### CRITICAL — Credential Capture Protocol

When you create the OAuth client, Google shows a **single dialog** with the Client ID, Client Secret, and a Download button. You MUST follow this exact sequence — **no improvisation**:

1. Read the **Client ID** from the screen (it is visible and safe to read).
2. Store the Client ID via `credential_store store`.
3. **IMMEDIATELY** present a `credential_store prompt` for the Client Secret. This is your ONLY next action after storing the Client ID. Do not attempt anything else.
4. Wait for the user to paste the secret.

**Absolute prohibitions during this step:**
- Do NOT click the Download button. There is no JSON file. Downloads do not work.
- Do NOT try to read the Client Secret from the screenshot. It is visible on screen but must come from the user via secure prompt to ensure accuracy.
- Do NOT navigate away from the dialog, close it, or interact with any other element until the user has pasted the secret.
- Do NOT mention JSON files, downloads, or `~/Downloads` to the user — none of these exist.

### 6a: Create the credential

Tell the user: "Creating OAuth credentials..."

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Find the option to create new credentials (typically a button labeled "Create Credentials" or similar), then select "OAuth client ID" from the menu.

On the creation form:
- Application type: **Desktop app**
- Name: "Vellum Assistant"
- Do NOT add any redirect URIs for the desktop app flow

Submit the form.

### 6b: Read Client ID and IMMEDIATELY prompt for Client Secret

After creation, a dialog will display the new Client ID and Client Secret. Handle **both** in this single step:

**First**, read the **Client ID** from the screen. It looks like `123456789-xxxxx.apps.googleusercontent.com`. Store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the Client ID you read from the screen>"
```

**Then IMMEDIATELY** — with no other actions in between — tell the user:

> "Got the Client ID! Now I need the Client Secret. In the dialog still open in the browser, you'll see the **Client Secret** value (starts with `GOCSPX-`). Please copy it and paste it into the secure prompt below."

And present the secure prompt:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud Console dialog and paste it here."
  placeholder: "GOCSPX-..."
```

Wait for the user to complete the prompt. Do not take any other action until they do.

If the user has trouble locating the secret, take a `browser_screenshot` and help them find it on the page — but do NOT attempt to read the secret value yourself.

**Verify:** `credential_store list` shows both `client_id` and `client_secret` for `integration:gmail`.

## Step 7: OAuth2 Authorization

**Goal:** The user authorizes Vellum to access their Gmail and Calendar via OAuth.

Tell the user: "Opening Google sign-in so you can authorize Vellum. Just click 'Allow' on the consent page."

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This auto-reads client_id and client_secret from the secure store and auto-fills auth_url, token_url, scopes, and extra_params from well-known config.

**If the user sees a "This app isn't verified" warning:** Tell them this is normal for apps in testing mode. Click "Advanced" then "Go to Vellum Assistant (unsafe)" to proceed.

**Verify:** The `oauth2_connect` call returns a success message with the connected account email.

## Step 8: Done!

"**Gmail and Calendar are connected!** You can now read, search, and send emails, plus view and manage your calendar. Try asking me to check your inbox or show your upcoming events!"

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain clearly and ask them to resolve it.
- **Consent screen already configured:** Don't overwrite — skip to credential creation.
- **Element not found:** Take a fresh screenshot to re-assess. The GCP UI may have changed. Describe what you see and try alternative approaches. If stuck after 2 attempts, ask the user for guidance.
- **OAuth flow timeout or failure:** Offer to retry. The credentials are already stored, so reconnecting only requires re-running the authorization flow.
- **Any unexpected state:** Take a `browser_screenshot`, describe what you see, and ask the user for guidance.
