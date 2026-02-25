---
name: "Google OAuth Setup"
description: "Set up Google Cloud OAuth credentials for Gmail and Calendar using browser automation"
user-invocable: true
includes: ["browser"]
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
>    `GATEWAY_OAUTH_CALLBACK_URL`
> 5. Click **Create**
>
> A dialog will show your **Client ID** and **Client Secret**. Copy both values — you'll need them in the next step.

(Substitute the actual gateway OAuth callback URL. This is obtained from `getOAuthCallbackUrl(loadConfig())` — the skill should compute and insert this URL.)

**Important:** Channel users must use **"Web application"** credentials (not Desktop app) because the OAuth callback goes through the gateway's public URL, not localhost.

### Channel Step 6: Store Credentials

**IMPORTANT — Secure credential collection only:** Never ask the user to paste credentials in chat. Always collect credentials through the secure credential prompt flow using `credential_store` with `action: "prompt"`. If the user has already pasted a credential in the conversation, inform them that for security reasons you cannot use credentials shared in chat and must collect them through the secure prompt instead.

Tell the user:

> **Step 5: Store your credentials**
>
> I'll now open secure input fields for your Client ID and Client Secret. These values are never visible in our conversation.

First, collect the Client ID via secure prompt:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Paste the Client ID from the dialog (looks like 123456789-xxxxx.apps.googleusercontent.com)"
  placeholder: "123456789-xxxxx.apps.googleusercontent.com"
```

Then collect the Client Secret via secure prompt:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Paste the Client Secret from the dialog (starts with GOCSPX-...)"
  placeholder: "GOCSPX-..."
```

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

## Step 6: Create OAuth Credentials

**Goal:** A "Desktop app" OAuth client exists for the project, and its Client ID is stored in the vault.

Tell the user: "Creating OAuth credentials..."

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Find the option to create new credentials (typically a button labeled "Create Credentials" or similar), then select "OAuth client ID" from the menu.

On the creation form:
- Application type: **Desktop app** (not Web application — Desktop app uses localhost redirects)
- Name: "Vellum Assistant"
- Do NOT add any redirect URIs

Submit the form.

After creation, a dialog or page will display the new Client ID. It looks like `123456789-xxxxx.apps.googleusercontent.com`. Read this value from the screen.

Store it immediately:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the Client ID you read from the screen>"
```

Close/dismiss any creation dialog.

**Verify:** `credential_store list` shows the `integration:gmail` `client_id` entry.

## Step 7: Capture the Client Secret

**Goal:** The user generates a client secret on the credential detail page and pastes it into a secure prompt.

### Hard constraints — do NOT violate these under any circumstances:
- Do NOT try to read or extract the client secret from the page via browser automation. Google masks secrets immediately — they appear as `****xxxx` and cannot be revealed.
- Do NOT try to download the credentials JSON file. This does not work in headless/automated browsers.
- Do NOT delete and recreate the OAuth client.
- Do NOT navigate to legacy or old-style credential pages.
- The secret MUST come from the user via `credential_store prompt`. No other method is acceptable.

### Procedure:

Navigate to the credential detail page for the client you just created. From the credentials list, find the OAuth client whose Client ID matches the one stored in Step 6 and click it to open its detail page.

Tell the user:

> "Almost done! I need the client secret to complete the connection. On the page in the browser, find the **Client secrets** section and click the button to add or generate a new secret. Google will show the new secret value **once** — copy it immediately, then paste it into the secure prompt below."

Then immediately present the secure prompt so it's ready when the user has the value:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Generate a new secret on the page, copy the value Google shows you, and paste it here"
  placeholder: "GOCSPX-..."
```

Wait for the user to complete the prompt.

If the user has trouble finding the button, take a `browser_screenshot` and help them locate it based on what's actually visible on the page.

**Verify:** `credential_store list` shows both `client_id` and `client_secret` for `integration:gmail`.

## Step 8: OAuth2 Authorization

**Goal:** The user authorizes Vellum to access their Gmail and Calendar via OAuth.

Tell the user: "Opening Google sign-in so you can authorize Vellum. Just click 'Allow' on the consent page."

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This auto-reads client_id and client_secret from the secure store and auto-fills auth_url, token_url, scopes, and extra_params from well-known config. The OAuth flow uses a localhost callback — no public URL or tunnel is needed.

**If the user sees a "This app isn't verified" warning:** Tell them this is normal for apps in testing mode. Click "Advanced" then "Go to Vellum Assistant (unsafe)" to proceed.

**Verify:** The `oauth2_connect` call returns a success message with the connected account email.

## Step 9: Done!

"**Gmail and Calendar are connected!** You can now read, search, and send emails, plus view and manage your calendar. Try asking me to check your inbox or show your upcoming events!"

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain clearly and ask them to resolve it.
- **Consent screen already configured:** Don't overwrite — skip to credential creation.
- **Element not found:** Take a fresh screenshot to re-assess. The GCP UI may have changed. Describe what you see and try alternative approaches. If stuck after 2 attempts, ask the user for guidance.
- **OAuth flow timeout or failure:** Offer to retry. The credentials are already stored, so reconnecting only requires re-running the authorization flow.
- **Any unexpected state:** Take a `browser_screenshot`, describe what you see, and ask the user for guidance.
