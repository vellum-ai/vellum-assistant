---
name: "Google OAuth Setup"
description: "Set up Google Cloud OAuth credentials for Gmail and Calendar using browser automation"
user-invocable: true
includes: ["browser"]
metadata: {"vellum": {"emoji": "\ud83d\udd11"}}
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect. You will automate the entire GCP setup via the browser while the user watches via screencast. The user's only manual action is signing in to their Google account — everything else is fully automated.

## Client Check

Determine whether the user has browser automation available (macOS desktop app) or is on a non-interactive channel (Telegram, SMS, etc.).

- **macOS desktop app**: Follow the **Automated Setup** path below (Steps 1-9).
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
>    `GATEWAY_OAUTH_CALLBACK_URL`
> 5. Click **Create**
>
> A dialog will show your **Client ID** and **Client Secret**. Copy both values — you'll need them in the next step.

(Substitute the actual gateway OAuth callback URL. This is obtained from `getOAuthCallbackUrl(loadConfig())` — the skill should compute and insert this URL.)

**Important:** Channel users must use **"Web application"** credentials (not Desktop app) because the OAuth callback goes through the gateway's public URL, not localhost.

### Channel Step 6: Store Credentials

Tell the user to send the Client ID first:

> **Step 5: Store your credentials**
>
> Please send me the **Client ID** from the dialog (it looks like `123456789-xxxxx.apps.googleusercontent.com`).

When the user provides the Client ID, store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the value the user sent>"
```

Then ask for the Client Secret:

> Now send me the **Client Secret** (it starts with `GOCSPX-...`).

When the user provides it, store it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_secret"
  value: "<the value the user sent>"
```

**Note:** These values are stored securely in the vault and are not logged or exposed after storage. However, since the user sent them in chat, advise them that the credentials were visible in the conversation and they can revoke/regenerate them in GCP if concerned.

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

## Step 1: Single Upfront Confirmation

Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Set up Google Cloud for Gmail & Calendar**
>
> Here's what will happen:
> 1. **A browser opens** — you sign in to your Google account
> 2. **I automate everything** — project creation, APIs, OAuth config, credentials
> 3. **One quick copy-paste** — you'll click a button to generate a secret and paste it (secure prompt — I never see it)
> 4. **You authorize Vellum** with one click
>
> The whole thing takes 2-3 minutes. Ready?

If the user declines, acknowledge and stop. No further confirmations are needed after this point.

## Step 2: Open Google Cloud Console

Use `browser_navigate` to go to `https://console.cloud.google.com/`.

Take a `browser_screenshot` and `browser_snapshot` to check the page state:
- **If a sign-in page appears:** Tell the user: "Please sign in to your Google account in the browser preview panel (or the Chrome window that just opened)." Then **auto-detect sign-in completion** by polling `browser_snapshot` every 5-10 seconds. Check if the current URL has moved away from `accounts.google.com` to `console.cloud.google.com`. Do NOT ask the user to "let me know when you're done" — detect it automatically. Once sign-in is detected, tell the user: "Signed in! Starting the automated setup now..."
- **If already signed in** (URL is already `console.cloud.google.com`): Tell the user: "Already signed in — starting setup now..." and continue immediately.
- **If a CAPTCHA appears:** The browser automation's built-in handoff will handle this. If it persists, tell the user: "There's a CAPTCHA in the browser — please complete it and I'll continue automatically."
- **If the console dashboard loads:** Continue to Step 3.

## Step 3: Create or Select a Project

Tell the user: "Creating Google Cloud project 'Vellum Assistant'..."

Navigate to `https://console.cloud.google.com/projectcreate`.

Take a `browser_snapshot`. Fill in the project name:
- Use `browser_type` to set the project name to "Vellum Assistant"
- Use `browser_click` to submit the "Create" button

Wait a few seconds, take a `browser_screenshot` and `browser_snapshot` to confirm. If the project already exists, navigate to its dashboard. Note the project ID for subsequent steps.

Tell the user: "Project created!"

## Step 4: Enable Gmail and Calendar APIs

Tell the user: "Enabling Gmail and Calendar APIs..."

Navigate to `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID` (substitute actual project ID).

Take a `browser_snapshot`:
- If already enabled (shows "API enabled" or "Manage" button): skip.
- If not: click the "Enable" button and wait.

Then navigate to `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`.

Same check — enable if needed.

Take a `browser_screenshot` to show result. Tell the user: "APIs enabled!"

## Step 5: Configure OAuth Consent Screen

Tell the user: "Configuring OAuth consent screen — this is the longest step, but it's fully automated..."

Navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

Take a `browser_snapshot`:
- If consent screen is already configured: skip to Step 6.
- If user type selection appears: select "External" and click "Create".

Fill in the consent screen form:
1. **App name:** "Vellum Assistant"
2. **User support email:** This is an Angular Material dropdown. Use this approach:
   - Take a `browser_snapshot` to find the dropdown element (look for a `mat-select` or element with "User support email" label)
   - Click the dropdown element_id to open it
   - Wait briefly (`browser_wait_for` with duration 1000ms) for the overlay to render
   - Take a **new** `browser_snapshot` — the dropdown options now appear as `[role="option"]` elements with the email addresses as text
   - Click the element_id of the desired email option (the user's own email, e.g. the first option)
   - If the dropdown didn't open on click, try: focus the element with `browser_click`, then press `Space` to open it, then take another snapshot and click the option
3. **Developer contact email:** Type the user's email address
4. Leave other fields as defaults

Navigate through the wizard pages:
- App information page: Fill fields, click "Save and Continue"
- Scopes page: Click "Add or Remove Scopes", search for and select:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.modify`
  - `https://www.googleapis.com/auth/gmail.send`
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/calendar.events`
  - `https://www.googleapis.com/auth/userinfo.email`
  - Click "Update" then "Save and Continue"
- Test users page: Add the user's email as a test user, click "Save and Continue"
- Summary page: Click "Back to Dashboard"

Tell the user: "Consent screen configured!"

## Step 6: Create OAuth Credentials

Tell the user: "Creating OAuth credentials..."

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Click "+ Create Credentials" then select "OAuth client ID".

Take a `browser_snapshot` and fill in:
1. **Application type:** Select **"Desktop app"** from the dropdown
2. **Name:** "Vellum Assistant"

**Do NOT add any redirect URIs** — Desktop app credentials handle localhost redirects automatically.

Click "Create".

### Capture the Client ID from the creation dialog

After clicking "Create", a dialog appears showing the Client ID. **Read the Client ID from this dialog** using `browser_snapshot` or `browser_extract` — it looks like `123456789-xxxxx.apps.googleusercontent.com`.

Store it immediately:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the Client ID you read from the dialog>"
```

Close the creation dialog. Do NOT try to read the client secret from this dialog — **Google masks client secrets after creation** (they appear as `****xxxx` and cannot be revealed or downloaded).

## Step 7: Generate and Capture the Client Secret

**Important context:** Google's Cloud Console no longer displays client secret values after initial creation, and "Download JSON" does not work in headless/automated browsers. The reliable approach is to generate a new secret, which Google shows exactly once.

Navigate to the credential detail page. From the credentials list (`https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`), find the OAuth client whose **Client ID** matches the one you captured and stored in Step 6 (e.g., `123456789-xxxxx.apps.googleusercontent.com`). Click on that client to open its detail page. Do not rely on the display name alone — there may be multiple clients named "Vellum Assistant".

Tell the user:

> "Almost done! I need the client secret to complete the connection. On the page that just opened, click the **"+ Add secret"** button under the Client secrets section. Google will show the new secret value **once** — copy it immediately, then paste it into the secure prompt below."

Then immediately present the secure prompt so it's ready when the user has the value:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Click '+ Add secret' on the page, copy the value Google shows you, and paste it here"
  placeholder: "GOCSPX-..."
```

Wait for the user to complete the prompt. Do NOT attempt to:
- Download the credentials JSON file (does not work in headless browsers)
- Read the secret from the page (Google masks it immediately)
- Delete and recreate the OAuth client to try again
- Navigate to old-style credential pages

If the user has trouble finding the button, take a `browser_screenshot` and point them to the right location.

## Step 8: OAuth2 Authorization

Tell the user: "Opening Google sign-in so you can authorize Vellum. Just click 'Allow' on the consent page."

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This auto-reads client_id and client_secret from the secure store and auto-fills auth_url, token_url, scopes, and extra_params from well-known config. The OAuth flow uses a localhost callback — no public URL or tunnel is needed.

**Important:** The `client_secret` is required for Desktop app credentials — Google does not support PKCE-only for this credential type. If the token exchange fails, verify that both `client_id` and `client_secret` are stored (use `credential_store list`).

**If the user sees a "This app isn't verified" warning:** Tell them this is normal for apps in testing mode. Click "Advanced" then "Go to Vellum Assistant (unsafe)" to proceed.

## Step 9: Done!

"**Gmail and Calendar are connected!** You can now read, search, and send emails, plus view and manage your calendar. Try asking me to check your inbox or show your upcoming events!"

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain clearly and ask them to resolve it.
- **Consent screen already configured:** Don't overwrite — skip to credential creation.
- **Element not found:** Take a fresh `browser_snapshot` to re-assess. GCP UI may have changed. Tell the user what you're looking for if stuck.
- **OAuth flow timeout or failure:** Offer to retry. The credentials are already stored, so reconnecting only requires re-running the authorization flow.
- **Any unexpected state:** Take a `browser_screenshot` and `browser_snapshot`, describe what you see, and ask the user for guidance.
