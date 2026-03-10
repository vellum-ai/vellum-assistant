---
name: google-oauth-setup
description: Set up Google Cloud OAuth credentials for Gmail and Calendar using the user's real Chrome on macOS or guided manual setup elsewhere
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Google OAuth Setup"
    user-invocable: true
    includes: ["public-ingress"]
    credential-setup-for: "gmail"
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Client Check

Determine which path applies before taking action:

- **macOS desktop app with foreground computer use available:** Follow **Path A: Automated Setup in Real Chrome**.
- **macOS desktop app without computer use** (or the user declines computer control, or Path A needs too many manual handoffs): Follow **Path B: Manual Desktop Setup**.
- **Telegram, SMS, Slack, or any non-interactive channel:** Follow **Path C: Manual Channel Setup**.

If the interface is ambiguous, ask one short clarifying question before proceeding.

---

# Path A: Automated Setup in Real Chrome (macOS Desktop App)

Use the user's actual Google Chrome app. Do **not** use `browser_*` tools, CDP, or any automation-specific Chrome profile for this path. Google sign-in may reject those contexts as insecure.

## Path A Rules

1. Start with a single upfront confirmation.
2. After confirmation, request foreground computer control with `computer_use_request_control`.
3. Inside the computer-use session:
   - Use `computer_use_open_app` to switch to **Google Chrome**.
   - Use `computer_use_run_applescript` only for Chrome app/window/tab/URL operations.
   - Use normal computer-use interactions for the actual Google Cloud web UI.
4. Never try to type the user's Google password, 2FA code, or recovery code. Ask the user to complete those steps in Chrome, then continue.
5. If two or more steps require manual fallback, stop the automated path and switch to **Path B**.

## Path A Step 1: One Confirmation

Use `ui_show` with `surface_type: "confirmation"`. Set `message` to just the title, and `detail` to the body:

- **message:** `Set up Google Cloud for Gmail & Calendar`
- **detail:**
  > Here's what will happen:
  >
  > 1. I'll take control of your Mac briefly
  > 2. I'll use your real Google Chrome window, not a test browser
  > 3. You'll sign in to Google if needed
  > 4. I'll set up the project, APIs, consent screen, and OAuth client
  > 5. I'll ask you for one secure paste of the Client Secret
  > 6. You'll approve the final Google authorization
  >
  > This usually takes a few minutes. Ready?

If the user declines, stop.

## Path A Step 2: Request Control and Open Chrome

Request foreground computer control:

```
computer_use_request_control:
  task: "Set up Google Cloud OAuth credentials for Gmail and Google Calendar in the user's real Google Chrome app."
  reason: "I need to operate your actual Chrome window so Google sign-in works normally."
```

Once control is granted:

1. Bring **Google Chrome** to the foreground with `computer_use_open_app`.
2. Use a short AppleScript to activate Chrome and open the Cloud Console in a front tab.

Example AppleScript:

```applescript
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then
    make new window
  end if
  set URL of active tab of front window to "https://console.cloud.google.com/"
end tell
```

Use AppleScript for tab creation, tab reuse, and direct URL changes only. Do not use AppleScript to drive the page UI if ordinary computer-use interaction is sufficient.

## Path A Step 3: Sign In and Reach Cloud Console

Goal: the user is signed in and `console.cloud.google.com` is loaded in real Chrome.

- If Chrome shows a Google sign-in screen, tell the user to complete sign-in in Chrome. Wait and keep observing until the Cloud Console loads.
- If Chrome shows 2FA, CAPTCHA, or account chooser, let the user handle it and continue afterward.
- If the user is already signed in, continue immediately.
- If Google shows a rejection page saying the browser or app may not be secure, stop the automated path and switch to **Path B**. That page means this is not behaving like a normal user Chrome session.

## Path A Step 4: Create or Select a Project

Goal: a GCP project named **Vellum Assistant** exists and is selected.

Navigate Chrome to:

`https://console.cloud.google.com/projectcreate`

Then:

1. If project creation is available, create a project named **Vellum Assistant**.
2. If Google reports the name already exists or an existing project is more appropriate, select the existing project instead.
3. Record the project ID from the URL or visible project picker state.

If the user hits organization restrictions, billing requirements, or quota errors, explain the issue clearly and ask them to resolve it.

## Path A Step 5: Enable Gmail and Calendar APIs

Goal: both APIs are enabled for the selected project.

Visit:

1. `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
2. `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

For each page:

- If you see **Enable**, click it.
- If you see **Manage** or an enabled state, leave it as-is.

## Path A Step 6: Configure the OAuth Consent Screen

Goal: an external OAuth consent screen exists with the required scopes and the user's email as a test user.

Navigate to:

`https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`

Adapt to the current Cloud Console UI. The required end state is:

- User type: **External**
- App name: **Vellum Assistant**
- User support email: the signed-in user's email
- Developer contact email: the signed-in user's email
- Scopes:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.modify`
  - `https://www.googleapis.com/auth/gmail.send`
  - `https://www.googleapis.com/auth/calendar.readonly`
  - `https://www.googleapis.com/auth/calendar.events`
  - `https://www.googleapis.com/auth/userinfo.email`
- Test user: the signed-in user's email

If the consent screen is already configured, verify the important pieces and move on.

## Path A Step 7: Create Desktop OAuth Credentials and Store Them

Goal: a **Desktop app** OAuth client exists and both values are stored securely.

Navigate to:

`https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`

Then:

1. Create **OAuth client ID** credentials.
2. Choose **Desktop app** as the application type.
3. Name the client **Vellum Assistant**.
4. Click **Create**.

When the credential dialog appears:

- Keep the dialog open until both values are safely stored.
- If the **Client ID** is clearly visible in the observed UI text, you may store it directly:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<client id from the dialog>"
```

- If the Client ID is not reliably readable, prompt the user for it securely:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Copy the Client ID from the Google Cloud dialog and paste it here."
  placeholder: "123456789-xxxxx.apps.googleusercontent.com"
```

- For the **Client Secret**, always use a secure prompt rather than trusting OCR or memory:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud dialog in Chrome and paste it here."
  placeholder: "GOCSPX-..."
```

Do not navigate away from the credential dialog before the prompts are complete.

## Path A Step 8: Authorize Gmail and Calendar

Tell the user:

> I'll start the Google authorization flow now. Review the permissions and click **Allow** when prompted.

Run:

```
credential_store:
  action: "oauth2_connect"
  service: "integration:gmail"
```

If the user sees **This app isn't verified**, tell them this is normal for an app in testing mode. They should click **Advanced** and then continue to **Vellum Assistant**.

## Path A Step 9: Finish

Confirm success once authorization completes:

> **Gmail and Calendar are connected.** You can now ask me to check your inbox or show your calendar.

---

# Path B: Manual Desktop Setup (macOS Desktop App Without Computer Use)

Use this when the user is in the macOS desktop app but you are not using computer control. In this path, the user performs the browser steps manually in their own Chrome window and you use secure prompts for the credentials.

## Path B Step 1: Confirm

Tell the user:

> **Set up Gmail & Calendar in Google Cloud**
>
> I'll guide you step by step in your own Chrome window, then I'll securely collect the OAuth credentials here in the app.
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Create or Select a Project

Tell the user:

> **Step 1: Create or choose a Google Cloud project**
>
> Open:
> `https://console.cloud.google.com/projectcreate`
>
> Create a project named **Vellum Assistant**, or select an existing project you want to use.
>
> Tell me when it's ready. If you already know the project ID, send that too.

Wait for confirmation. Record the project ID if the user provides it.

## Path B Step 3: Enable Gmail and Calendar APIs

Tell the user:

> **Step 2: Enable Gmail and Calendar APIs**
>
> Open each link below and click **Enable** if needed:
>
> 1. `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
> 2. `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`
>
> Tell me when both are enabled.

## Path B Step 4: Configure the OAuth Consent Screen

Tell the user:

> **Step 3: Configure the OAuth consent screen**
>
> Open:
> `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`
>
> Set these values:
>
> - User type: **External**
> - App name: **Vellum Assistant**
> - User support email: **your email**
> - Developer contact email: **your email**
>
> Add these scopes:
>
> - `https://www.googleapis.com/auth/gmail.readonly`
> - `https://www.googleapis.com/auth/gmail.modify`
> - `https://www.googleapis.com/auth/gmail.send`
> - `https://www.googleapis.com/auth/calendar.readonly`
> - `https://www.googleapis.com/auth/calendar.events`
> - `https://www.googleapis.com/auth/userinfo.email`
>
> Add **your email** as a test user, then return to the dashboard.
>
> Tell me when that's done.

## Path B Step 5: Create Desktop OAuth Credentials

Tell the user:

> **Step 4: Create OAuth credentials**
>
> Open:
> `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`
>
> 1. Click **+ Create Credentials** -> **OAuth client ID**
> 2. Application type: **Desktop app**
> 3. Name: **Vellum Assistant**
> 4. Click **Create**
>
> Keep the dialog open when it shows the Client ID and Client Secret. I'll prompt you for both values securely in the app.

## Path B Step 6: Store Credentials Securely

Prompt for the Client ID:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Copy the Client ID from the Google Cloud dialog and paste it here."
  placeholder: "123456789-xxxxx.apps.googleusercontent.com"
```

Then prompt for the Client Secret:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud dialog and paste it here."
  placeholder: "GOCSPX-..."
```

## Path B Step 7: Authorize

Tell the user:

> **Step 5: Authorize Gmail and Calendar**
>
> I'll start the Google authorization flow now. Approve the requested permissions when the Google page appears.

Run:

```
credential_store:
  action: "oauth2_connect"
  service: "integration:gmail"
```

If the result returns an auth URL instead of completing automatically, send the URL to the user and tell them to open it in their browser.

## Path B Step 8: Done

After success:

> **Gmail and Calendar are connected.**

---

# Path C: Manual Channel Setup (Telegram, SMS, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path must use **Web application** credentials because the OAuth callback goes through the public gateway URL.

## Path C Step 1: Confirm and Explain

Tell the user:

> **Setting up Gmail & Calendar from chat**
>
> Since I can't control your browser from here, I'll walk you through the steps with direct links. You'll need:
>
> 1. A Google account with access to Google Cloud Console
> 2. About 5 minutes
>
> Ready to start?

If the user declines, stop.

## Path C Step 2: Create a Google Cloud Project

Tell the user:

> **Step 1: Create a Google Cloud project**
>
> Open this link:
> `https://console.cloud.google.com/projectcreate`
>
> Create a project named **Vellum Assistant**. If you already have a project you'd rather use, that's fine too.
>
> Let me know when it's done, or send the project ID if you already know it.

Wait for confirmation. Record the project ID for the next steps.

## Path C Step 3: Enable APIs

Tell the user:

> **Step 2: Enable Gmail and Calendar APIs**
>
> Open each link below and click **Enable**:
>
> 1. Gmail API: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
> 2. Calendar API: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`
>
> Let me know when both are enabled.

## Path C Step 4: Configure OAuth Consent Screen

Tell the user:

> **Step 3: Configure the OAuth consent screen**
>
> Open:
> `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`
>
> 1. Choose **External**
> 2. Set app name to **Vellum Assistant**
> 3. Set both support email and developer contact email to **your email**
> 4. Add these scopes:
>    - `https://www.googleapis.com/auth/gmail.readonly`
>    - `https://www.googleapis.com/auth/gmail.modify`
>    - `https://www.googleapis.com/auth/gmail.send`
>    - `https://www.googleapis.com/auth/calendar.readonly`
>    - `https://www.googleapis.com/auth/calendar.events`
>    - `https://www.googleapis.com/auth/userinfo.email`
> 5. Add **your email** as a test user
> 6. Return to the dashboard
>
> Let me know when that's done.

## Path C Step 5: Create Web Application Credentials

Before sending the next step, resolve the concrete callback URL:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, run the `public-ingress` skill first.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

Tell the user:

> **Step 4: Create OAuth credentials**
>
> Open:
> `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`
>
> Use this exact redirect URI:
> `OAUTH_CALLBACK_URL`
>
> 1. Click **+ Create Credentials** -> **OAuth client ID**
> 2. Application type: **Web application**
> 3. Name: **Vellum Assistant**
> 4. Add the redirect URI shown above under **Authorized redirect URIs**
> 5. Click **Create**
>
> When the dialog appears, copy the Client ID and Client Secret. You'll send them to me next.

## Path C Step 6: Store Credentials

### Path C Step 6a: Client ID

Tell the user:

> **Step 5a: Send your Client ID**
>
> Send me the **Client ID** from the dialog. It looks like `123456789-xxxxx.apps.googleusercontent.com`.

After the user sends it:

```
credential_store store:
  service: "integration:gmail"
  field: "client_id"
  value: "<the client id the user sent>"
```

### Path C Step 6b: Client Secret Split Entry

The Google client secret starts with `GOCSPX-`, which can trigger channel secret scanners. Ask for only the suffix.

Tell the user:

> **Step 5b: Send your Client Secret**
>
> Your Client Secret starts with `GOCSPX-`. Please send me only the part **after** `GOCSPX-` as a standalone message with no other text.

After the user sends the suffix, reconstruct and store the full secret:

```
credential_store store:
  service: "integration:gmail"
  field: "client_secret"
  value: "GOCSPX-<the suffix the user sent>"
```

## Path C Step 7: Authorize

Tell the user:

> **Step 6: Authorize Gmail and Calendar**
>
> I'll generate an authorization link for you now.

Run:

```
credential_store:
  action: "oauth2_connect"
  service: "integration:gmail"
```

Send the returned auth URL to the user and tell them to open it. If they see **This app isn't verified**, tell them to click **Advanced** and continue to **Vellum Assistant**.

## Path C Step 8: Done

After authorization:

> **Gmail and Calendar are connected.**

---

## Guardrails and Error Handling

- **No CDP or browser automation on Path A.** Use the user's real Chrome app plus computer use.
- **Use AppleScript narrowly.** Good uses: activate Chrome, open a tab, set a URL, or inspect high-level Chrome state. Do not use `do shell script`.
- **Do not delete and recreate OAuth clients** just to get another secret. That risks orphaning stored credentials.
- **Do not leave the credential dialog early.** The Client Secret is shown only once.
- **Google Cloud UI drift is normal.** Adapt to renamed buttons or reorganized layouts while preserving the same end state.
- **If the user hits org policy, billing, or quota blockers, explain the blocker plainly and wait.**
- **If Path A needs repeated manual rescue, switch to Path B.** Do not loop indefinitely.
