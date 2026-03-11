---
name: google-oauth-applescript
description: Set up Google Cloud OAuth credentials for Gmail and Calendar using collaborative AppleScript navigation
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Google OAuth Setup"
    user-invocable: true
    credential-setup-for: "gmail"
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Client Check

Determine which path applies before taking action:

- **macOS desktop app:** Follow **Path A: Collaborative Chrome Setup**.
- **Telegram, SMS, Slack, or any non-interactive channel:** Follow **Path B: Manual Channel Setup**.

---

# Path A: Collaborative Chrome Setup (macOS Desktop App)

You open pages in Chrome via `host_bash` + `osascript`. The user does the clicking and form-filling. You tell them exactly what to click at each step.

If computer use with AX tree access is available, you may handle the clicking/filling yourself using the same AppleScript navigation. Fall back to collaborative mode on failure.

## Path A Rules

1. **Navigation is your job.** Use `host_bash` with `osascript` to open every URL. The user should never have to type a URL.
2. **Never auto-advance.** Wait for user confirmation ("done", "ok", "next", etc.) before proceeding to the next step.
3. **Be specific.** Don't say "configure the consent screen." Say "click **Audience** in the left sidebar, then click **Add users**."
4. **Explain what they should see.** "You should see a table with project names in the first column." Helps the user confirm they're on the right page.
5. **Keep instructions short per step.** One action per message when possible.
6. Never use `computer_use_*` tools, `browser_*` tools, or CDP for navigation. AppleScript only.
7. Use `credential_store prompt` for both Client ID and Client Secret — never ask the user to type credentials in chat.

## AppleScript Navigation Pattern

All URL navigation uses this pattern:

```
host_bash:
  command: |
    osascript -e '
    tell application "Google Chrome"
      activate
      if (count of windows) = 0 then
        make new window
      end if
      set URL of active tab of front window to "TARGET_URL"
    end tell'
```

Replace `TARGET_URL` with the actual URL for each step.

---

## Step 1: Select or Create a Project

**Always check for existing projects first.** Never jump straight to project creation.

### Step 1a: Open the project list

Navigate to: `https://console.cloud.google.com/cloud-resource-manager`

Tell the user:

> I've opened your Google Cloud project list. You should see a table of your existing projects. Each row shows the project **name**, **ID**, and **number**.
>
> Do you already have a project you'd like to use? If you see one called "Vellum Assistant" or similar, that's perfect. Otherwise I can create a new one.
>
> I need the **project ID** (not the name — the ID is in the second column). It looks something like `my-project-123456`. You can also find it by clicking into a project and looking at the URL after `project=`.
>
> Let me know what you'd like to do!

Wait for confirmation.

### Step 1b: Decision logic

- **User picks an existing project:** Record the project ID. Navigate to `https://console.cloud.google.com/home/dashboard?project=PROJECT_ID` to confirm. Tell the user which project you're using, then proceed to Step 2.
- **User wants a new project:** Navigate to `https://console.cloud.google.com/projectcreate`. Tell the user:

  > I've opened the project creation page. Set the project name to **Vellum Assistant** and click **Create**. Let me know when it's done!

- **User is at the project limit:** Explain their options:
  1. Request a quota increase
  2. Delete an unused project
  3. Reuse an existing project

Wait for confirmation. Record the project ID for all subsequent URL substitutions.

---

## Step 2: Enable Gmail API

Navigate to: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`

Tell the user:

> I've opened the Gmail API page. If you see an **Enable** button, click it. If it already says **Manage** or shows it's enabled, you can skip this one.
>
> Let me know when done!

Wait for confirmation.

---

## Step 3: Enable Calendar API

Navigate to: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

Tell the user:

> Same thing here for the Calendar API. Click **Enable** if you see it, skip if it's already on.
>
> Let me know when done!

Wait for confirmation.

---

## Step 4: Configure OAuth Consent Screen

The Google Cloud Console uses a "Google Auth Platform" layout. The consent screen is split across **multiple sidebar sections**, not a single wizard.

### Google Auth Platform Sidebar Reference

| Sidebar Item    | What It Contains                                             | URL Path         |
| --------------- | ------------------------------------------------------------ | ---------------- |
| **Overview**    | Status summary, "Get Started" button if not configured       | `/auth/overview` |
| **Branding**    | App name, user support email, developer contact, logo, links | `/auth/branding` |
| **Audience**    | User type (Internal/External), publishing status, test users | `/auth/audience` |
| **Data Access** | Scopes ("Add or Remove Scopes")                              | `/auth/scopes`   |
| **Clients**     | OAuth client credentials                                     | `/auth/clients`  |

### Step 4a: Initial setup (if not already configured)

Navigate to: `https://console.cloud.google.com/auth/overview?project=PROJECT_ID`

Tell the user:

> I've opened the Google Auth Platform page. If you see a **Get Started** button, click it and fill in:
>
> 1. **App name:** `Vellum Assistant`
> 2. **User support email:** select your email from the dropdown
> 3. Click **Next**
> 4. **Audience / User type:** select **External**
> 5. Click **Next**
> 6. **Contact information:** enter your email
> 7. Click **Next**
> 8. Check the **Agree to Google API Services User Data Policy** checkbox
> 9. Click **Continue**, then **Create**
>
> If you see a dashboard instead of "Get Started", the auth platform is already set up — just let me know and we'll move on!
>
> Let me know when you're through!

Wait for confirmation.

### Step 4b: Add test users

Navigate to: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`

Tell the user:

> Now I've opened the **Audience** page (it's in the left sidebar). Scroll down to the **Test users** section, click **+ Add users**, enter your email address, and click **Save**.
>
> Let me know when done!

Wait for confirmation.

### Step 4c: Add scopes

Navigate to: `https://console.cloud.google.com/auth/scopes?project=PROJECT_ID`

Tell the user:

> Now I've opened the **Data Access** page (left sidebar). Click **Add or Remove Scopes**.
>
> In the scopes panel, look for the **"Manually add scopes"** text box at the bottom. Paste these scopes in, one at a time or comma-separated:
>
> ```
> https://www.googleapis.com/auth/gmail.readonly
> https://www.googleapis.com/auth/gmail.modify
> https://www.googleapis.com/auth/gmail.send
> https://www.googleapis.com/auth/calendar.readonly
> https://www.googleapis.com/auth/calendar.events
> https://www.googleapis.com/auth/userinfo.email
> ```
>
> After adding them, click **Add to Table** (or **Update**), then click **Save**.
>
> When done, you should see them listed on the page:
>
> - **Non-sensitive scopes:** `userinfo.email`
> - **Sensitive scopes:** `calendar.readonly`, `calendar.events`, `gmail.send`
> - **Restricted scopes (Gmail):** `gmail.modify`, `gmail.readonly`
>
> Let me know when done!

Wait for confirmation.

---

## Step 5: Create OAuth Credentials

Navigate to: `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`

Tell the user:

> I've opened the Credentials page. Now:
>
> 1. Click **+ Create Credentials** at the top
> 2. Choose **OAuth client ID**
> 3. Application type: **Desktop app**
> 4. Name: **Vellum Assistant**
> 5. Click **Create**
>
> **Keep the dialog open** when it shows the Client ID and Client Secret. I'll prompt you to paste them securely in the app.
>
> Let me know when the dialog is showing!

Wait for the user to confirm the dialog is showing.

---

## Step 6: Store Credentials Securely

### 6a: Client ID

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Copy the Client ID from the Google Cloud dialog and paste it here."
  placeholder: "123456789-xxxxx.apps.googleusercontent.com"
```

If computer use is active and the Client ID is readable from the AX tree, store it directly with `credential_store store` instead.

### 6b: Client Secret

**Always use a secure prompt.** Never read secrets from screen.

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud dialog in Chrome and paste it here."
  placeholder: "GOCSPX-..."
```

Do not navigate away from the credential dialog until both values are stored. After both are stored, tell the user they can close the dialog.

---

## Step 7: Authorize Gmail and Calendar

Tell the user:

> I'll start the Google authorization flow now. A browser window will open asking you to approve access.
>
> If you see **"This app isn't verified"**, click **Advanced** then **Go to Vellum Assistant (unsafe)**. This is normal for apps in testing mode.
>
> Review the permissions and click **Allow**.

```
credential_store:
  action: "oauth2_connect"
  service: "gmail"
```

If the tool returns an auth URL instead of auto-completing, send the URL to the user.

---

## Step 8: Verify Connection

```
messaging_auth_test:
  platform: "gmail"
```

**On success:**

> **Gmail and Calendar are connected!** You can now ask me to check your inbox, manage emails, or look at your calendar.

**On failure:**

> Something went wrong. Let me re-check the credentials and try the authorization again.

---

# Path B: Manual Channel Setup (Telegram, SMS, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path uses **Web application** credentials because the OAuth callback goes through the public gateway URL.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Gmail & Calendar from chat**
>
> Since I can't open Chrome for you from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Google account with access to Google Cloud Console
> 2. About 5 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Create or Select a Project

Tell the user:

> **Step 1: Select or create a Google Cloud project**
>
> Open this link to see your existing projects:
> `https://console.cloud.google.com/cloud-resource-manager`
>
> If you have a project you'd like to use, send me the **project ID** (second column in the table, looks like `my-project-123456`).
>
> If you want to create a new one, open:
> `https://console.cloud.google.com/projectcreate`
>
> Set the name to **Vellum Assistant** and click **Create**. Then send me the project ID.

Wait for confirmation. Record the project ID for subsequent steps.

## Path B Step 3: Enable APIs

Tell the user:

> **Step 2: Enable Gmail and Calendar APIs**
>
> Open each link below and click **Enable**:
>
> 1. Gmail API: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
> 2. Calendar API: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`
>
> Let me know when both are enabled.

## Path B Step 4: Configure OAuth Consent Screen

Tell the user:

> **Step 3: Configure the OAuth consent screen**
>
> Open: `https://console.cloud.google.com/auth/overview?project=PROJECT_ID`
>
> If you see **Get Started**, click it and set:
>
> - App name: **Vellum Assistant**
> - User support email: **your email**
> - User type: **External**
> - Contact email: **your email**
> - Agree to the policy, click **Continue** then **Create**
>
> Then go to **Audience** in the left sidebar and add **your email** as a test user.
>
> Then go to **Data Access** in the left sidebar and add these scopes:
>
> - `https://www.googleapis.com/auth/gmail.readonly`
> - `https://www.googleapis.com/auth/gmail.modify`
> - `https://www.googleapis.com/auth/gmail.send`
> - `https://www.googleapis.com/auth/calendar.readonly`
> - `https://www.googleapis.com/auth/calendar.events`
> - `https://www.googleapis.com/auth/userinfo.email`
>
> Let me know when that's all done.

## Path B Step 5: Create Web Application Credentials

Before sending the next step, resolve the concrete callback URL:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

Tell the user:

> **Step 4: Create OAuth credentials**
>
> Open: `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`
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

## Path B Step 6: Store Credentials

### Path B Step 6a: Client ID

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

### Path B Step 6b: Client Secret Split Entry

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

## Path B Step 7: Authorize

Tell the user:

> **Step 6: Authorize Gmail and Calendar**
>
> I'll generate an authorization link for you now.

```
credential_store:
  action: "oauth2_connect"
  service: "gmail"
```

Send the returned auth URL to the user. If they see **This app isn't verified**, tell them to click **Advanced** and continue to **Vellum Assistant**.

## Path B Step 8: Done

After authorization:

> **Gmail and Calendar are connected!**

---

## Error Handling

| Scenario                                     | Action                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| User not signed in to Google                 | Tell them to sign in, wait, continue                           |
| Project already exists                       | Reuse it                                                       |
| API already enabled                          | Skip (page shows "Manage")                                     |
| Project quota limit reached                  | Offer: request increase, delete unused, or reuse existing      |
| Org policy / billing blockers                | Explain plainly, wait for user                                 |
| "This app isn't verified" warning            | Normal for testing. Click Advanced > Continue                  |
| Auth URL returned instead of auto-completing | Send URL to user to open manually                              |
| Consent screen already configured            | Verify key settings via Branding/Audience/Data Access, move on |
| Chrome not installed or osascript fails      | Fall back to Path B (give URLs manually)                       |

## Guardrails

- **No browser automation tools.** Path A uses `host_bash` + `osascript` only for navigation. No `browser_*`, no CDP, no `computer_use_*` for navigation.
- **Use AppleScript narrowly.** Only for: activate Chrome, open a URL in the active tab. Do not click buttons or fill forms via AppleScript.
- **Do not delete and recreate OAuth clients.** That orphans stored credentials.
- **Do not leave the credential dialog early.** The Client Secret is shown only once.
- **Google Cloud UI drift is normal.** Adapt instructions while preserving the same end state.
