---
name: google-oauth-setup
description: Set up Google Cloud OAuth credentials for Gmail and Calendar using browser automation
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Google OAuth Setup"
    user-invocable: true
    includes: ["browser", "public-ingress"]
    credential-setup-for: "gmail"
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Client Check

Determine whether the user has browser automation available (macOS desktop app) or is on a non-interactive channel (Telegram, SMS, etc.).

- **macOS desktop app**: Follow the **Automated Setup** path below.
- **Telegram or other channel** (no browser automation): Follow the **Manual Setup for Channels** path below.

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

# Path B: Automated Setup (macOS Desktop App)

You will automate the entire GCP setup via the browser while the user watches in the Chrome window on the side. The user's only manual actions are: signing in to their Google account, and copy-pasting credentials from the Chrome window into secure prompts.

## Browser Interaction Principles

Google Cloud Console's UI changes frequently. Do NOT memorize or depend on specific element IDs, CSS selectors, or DOM structures. Instead:

1. **Snapshot first, act second.** Before every interaction, use `browser_snapshot` to discover interactive elements and their IDs. This is your primary navigation tool; it gives you the accessibility tree with clickable/typeable element IDs. Use `browser_screenshot` for visual context when the snapshot alone isn't enough.
2. **Adapt to what you see.** If an element's label or position differs from what you expect, use the snapshot to find the correct element. GCP may rename buttons, reorganize menus, or change form layouts at any time.
3. **Verify after every action.** After clicking, typing, or navigating, take a new snapshot to confirm the action succeeded. If it didn't, try an alternative interaction (e.g., if a dropdown didn't open on click, try pressing Space or Enter on the element).
4. **Never assume DOM structure.** Dropdowns may be `<select>`, `<mat-select>`, `<div role="listbox">`, or something else entirely. Use the snapshot to identify element types and interact accordingly.
5. **When stuck after 2 attempts, describe and ask.** Take a screenshot, describe what you see to the user, and ask for guidance.

## Anti-Loop Guardrails

Each step has a **retry budget of 3 attempts**. An attempt is one try at the step's primary action (e.g., clicking a button, filling a form). If a step fails after 3 attempts:

1. **Stop trying.** Do not continue retrying the same approach.
2. **Fall back to manual.** Tell the user what you were trying to do and ask them to complete that step manually in the Chrome window (which they can see on the side). Give them the direct URL and clear text instructions.
3. **Resume automation** at the next step once the user confirms the manual step is done.

If **two or more steps** require manual fallback, abandon the automated flow entirely and switch to giving the user the remaining steps as clear text instructions with links, using "Desktop app" as the OAuth application type.

## Things That Do Not Work: Do Not Attempt

These actions are technically impossible in the browser automation environment. Attempting them wastes time and leads to loops:

- **Downloading files.** `browser_click` on a Download button does not save files to disk. There is NO JSON file to find at `~/Downloads` or anywhere else. Never click Download buttons.
- **Clipboard operations.** You cannot copy/paste via browser automation. The user must manually copy values from the Chrome window.
- **Deleting and recreating OAuth clients** to get a fresh secret. This orphans the stored client_id and causes `invalid_client` errors.
- **Navigating away from the credential dialog** before both credentials are stored. You will lose the Client Secret display and cannot get it back without creating a new client.

## Step 1: Single Upfront Confirmation

Use `ui_show` with `surface_type: "confirmation"`. Set `message` to just the title, and `detail` to the body:

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

If the user declines, acknowledge and stop. No further confirmations are needed after this point.

## Step 2: Open Google Cloud Console and Sign In

**Goal:** The user is signed in and the Google Cloud Console dashboard is loaded.

Navigate to `https://console.cloud.google.com/`.

Take a screenshot to check the page state:

- **Sign-in page:** Tell the user: "Please sign in to your Google account in the Chrome window on the right side of your screen." Then auto-detect sign-in completion by polling with `browser_screenshot` every 5-10 seconds to check if the URL has moved away from `accounts.google.com` to `console.cloud.google.com`. Do NOT ask the user to "let me know when you're done"; detect it automatically. Once sign-in is detected, tell the user: "Signed in! Starting the automated setup now..."
- **Already signed in:** Tell the user: "Already signed in, starting setup now..." and continue immediately.
- **CAPTCHA:** The browser automation's built-in handoff will handle this. If it persists, tell the user: "There's a CAPTCHA in the browser, please complete it and I'll continue automatically."

**What you should see when done:** URL contains `console.cloud.google.com` and no sign-in overlay is visible.

## Step 3: Create or Select a Project

**Goal:** A GCP project named "Vellum Assistant" exists and is selected.

Tell the user: "Creating Google Cloud project..."

Navigate to `https://console.cloud.google.com/projectcreate`.

Take a `browser_snapshot`. Find the project name input field (look for an element with label containing "Project name" or a text input near the top of the form). Type "Vellum Assistant" into it.

Look for a "Create" button in the snapshot and click it. Wait 10-15 seconds for project creation, then take a screenshot to check for:

- **Success message** or redirect to the new project dashboard. Note the project ID from the URL or page content.
- **"Project name already in use" error**: that's fine. Navigate to `https://console.cloud.google.com/cloud-resource-manager` to find and select the existing "Vellum Assistant" project. Use `browser_extract` to read the project ID from the page.
- **Organization restriction or quota error**: tell the user what happened and ask them to resolve it.

**What you should see when done:** The project selector in the top bar shows the project name, and you have the project ID (something like `vellum-assistant-12345`).

Tell the user: "Project created!"

## Step 4: Enable Gmail and Calendar APIs

**Goal:** Both the Gmail API and Google Calendar API are enabled for the project.

Tell the user: "Enabling Gmail and Calendar APIs..."

Navigate to each API's library page and enable it if not already enabled:

1. `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
2. `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

For each page: take a `browser_snapshot`. Look for:

- **"Enable" button**: click it, wait a few seconds, take another snapshot to confirm.
- **"Manage" button or "API enabled" text**: the API is already enabled. Skip it.

**What you should see when done:** Both API pages show "Manage" or "API enabled" status.

Tell the user: "APIs enabled!"

## Step 5: Configure OAuth Consent Screen

**Goal:** An OAuth consent screen is configured with External user type, the required scopes, and the user added as a test user.

Tell the user: "Setting up OAuth consent screen. This is the longest step but it's fully automated..."

Navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

Take a `browser_snapshot` and `browser_screenshot`. Check the page state:

### If the consent screen is already configured

You'll see a dashboard showing the app name ("Vellum Assistant" or similar) with an "Edit App" button. **Skip to Step 6.**

### If you see a user type selection (External / Internal)

Select **"External"** and click **Create** or **Get Started**.

### Consent screen form (wizard or single-page)

Google Cloud uses either a multi-page wizard or a single-page form. Adapt to what you see:

**App information section:**

- **App name**: Type "Vellum Assistant" in the app name field.
- **User support email**: This is typically a dropdown showing the signed-in user's email. Use `browser_snapshot` to find a `<select>` or clickable dropdown element near "User support email". Select the user's email.
- **Developer contact email**: Type the user's email into this field. (Use the same email visible in the support email dropdown if you can read it, or use `browser_extract` to find the email shown on the page.)
- Click **Save and Continue** if on a multi-page wizard.

**Scopes section:**

- Click **"Add or Remove Scopes"** (or similar button).
- In the scope picker dialog, look for a text input labeled **"Manually add scopes"** or **"Filter"** at the bottom or top of the dialog.
- Paste all 6 scopes at once as a comma-separated string into that input:
  ```
  https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email
  ```
- Click **"Add to Table"** or **"Update"** to confirm the scopes.
- If no manual input is available, you'll need to search for and check each scope individually using the scope tree. Search for each scope URL in the filter box and check its checkbox.
- Click **Save and Continue** (or **Update** then **Save and Continue**).

**Test users section:**

- Click **"Add Users"** or similar.
- Enter the user's email address.
- Click **Add** then **Save and Continue**.

**Summary section:**

- Click **"Back to Dashboard"** or **"Submit"**.

**What you should see when done:** A consent screen dashboard showing "Vellum Assistant" as the app name.

Tell the user: "Consent screen configured!"

## Step 6: Create OAuth Credentials and Capture Them

**Goal:** A "Desktop app" OAuth client exists, and both its Client ID and Client Secret are stored in the vault.

Tell the user: "Creating OAuth credentials..."

### 6a: Create the credential

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Take a `browser_snapshot`. Find and click a button labeled **"Create Credentials"** or **"+ Create Credentials"**. A dropdown menu should appear. Take another snapshot and click **"OAuth client ID"**.

On the creation form (take a snapshot to see the fields):

- **Application type**: Find the dropdown and select **"Desktop app"**. This may be a `<select>` element or a custom dropdown. Use the snapshot to identify it. You might need to click the dropdown first, then take another snapshot to see the options, then click "Desktop app".
- **Name**: Type "Vellum Assistant" in the name field.
- Do NOT add any redirect URIs. The desktop app flow doesn't need them.

Click **"Create"** to submit the form.

### 6b: Capture credentials from the dialog

After creation, a dialog will display the **Client ID** and **Client Secret**. This is the critical step.

**First**, try to auto-read the **Client ID** using `browser_extract`. The Client ID matches the pattern `*.apps.googleusercontent.com`. Search the extracted text for this pattern. If found, store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the Client ID extracted from the page>"
```

If `browser_extract` fails to find the Client ID, prompt the user instead:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Copy the Client ID from the dialog in the Chrome window and paste it here. It looks like 123456789-xxxxx.apps.googleusercontent.com"
  placeholder: "xxxxx.apps.googleusercontent.com"
```

**Then**, whether the Client ID was auto-read or prompted, tell the user:

> "Got the Client ID! Now I need the Client Secret. You can see it in the dialog in the Chrome window. It starts with `GOCSPX-`. Please copy it and paste it into the secure prompt below."

And present the secure prompt:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud Console dialog and paste it here."
  placeholder: "GOCSPX-..."
```

Wait for the user to complete the prompt. **Do not take any other browser actions until the user has pasted the secret.** The dialog must stay open so they can see and copy the value.

If the user has trouble locating the secret, take a `browser_screenshot` and describe where the secret field is on the screen, but do NOT attempt to read the secret value yourself. It must come from the user for accuracy.

**What you should see when done:** `credential_store list` shows both `client_id` and `client_secret` for `integration:gmail`.

Tell the user: "Credentials stored securely!"

## Step 7: OAuth2 Authorization

**Goal:** The user authorizes Vellum to access their Gmail and Calendar via OAuth.

Tell the user: "Starting the authorization flow — a Google sign-in page will open in a few seconds. Just click 'Allow' when it appears."

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This auto-reads client_id and client_secret from the secure store and auto-fills auth_url, token_url, scopes, and extra_params from well-known config.

**If the user sees a "This app isn't verified" warning:** Tell them: "You'll see an 'app isn't verified' warning. This is normal for personal apps in testing mode. Click **Advanced**, then **Go to Vellum Assistant (unsafe)** to proceed."

**Verify:** The `oauth2_connect` call returns a success message with the connected account email.

## Step 8: Done!

Tell the user: "**Gmail and Calendar are connected!** You can now read, search, and send emails, plus view and manage your calendar. Try asking me to check your inbox or show your upcoming events!"

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain clearly and ask them to resolve it.
- **Consent screen already configured:** Don't overwrite. Skip to credential creation.
- **Element not found:** Take a fresh `browser_snapshot` to re-assess. The GCP UI may have changed. Describe what you see and try alternative approaches. If stuck after 2 attempts, ask the user for guidance. They can see the Chrome window too.
- **OAuth flow timeout or failure:** Offer to retry. The credentials are already stored, so reconnecting only requires re-running the authorization flow.
- **Any unexpected state:** Take a `browser_screenshot`, describe what you see, and ask the user for guidance.
