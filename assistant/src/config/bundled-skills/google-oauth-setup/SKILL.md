---
name: "Google OAuth Setup"
description: "Set up Google Cloud OAuth credentials for Gmail and Calendar using browser automation"
user-invocable: true
includes: ["browser", "public-ingress"]
metadata: {"vellum": {"emoji": "\ud83d\udd11"}}
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect. You will automate the entire GCP setup via the browser while the user watches via screencast.

## Client Check

If the user is on Telegram (or any non-macOS client without browser automation):

> "Gmail setup requires browser automation, which is available on the macOS app. Please open the Vellum app on your Mac and ask me to connect Gmail there — I'll handle the rest automatically."

Stop here. Do not attempt a manual walkthrough.

## Prerequisites

Before starting, check that `ingress.publicBaseUrl` is configured (`INGRESS_PUBLIC_BASE_URL` env var or workspace config). If it is not set, load and execute the **public-ingress** skill first (`skill_load` with `skill: "public-ingress"`) to set up an ngrok tunnel and persist the public URL. The OAuth redirect URI depends on this value.

## Step 1: Single Upfront Confirmation

Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Set up Google Cloud for Gmail & Calendar**
>
> I'll create a Google Cloud project, enable the Gmail and Calendar APIs, configure OAuth, and download credentials — all automatically in the browser. You can watch everything via screencast.
>
> After the automated setup, I'll ask you to securely enter the client ID and client secret from the downloaded credential file (I never see these values).
>
> Ready to get started?

If the user declines, acknowledge and stop. No further confirmations are needed after this point.

## Step 2: Open Google Cloud Console

Use `browser_navigate` to go to `https://console.cloud.google.com/`.

Take a `browser_screenshot` and `browser_snapshot` to check the page state:
- **If a sign-in page appears:** Tell the user "Please sign in to your Google account in the browser window. Let me know when you're done." Wait for their confirmation, then re-check.
- **If a CAPTCHA appears:** Tell the user "There's a CAPTCHA to solve. Please complete it in the browser window and let me know." Wait, then re-check.
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

Tell the user: "Configuring OAuth consent screen..."

Navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

Take a `browser_snapshot`:
- If consent screen is already configured: skip to Step 6.
- If user type selection appears: select "External" and click "Create".

Fill in the consent screen form:
1. **App name:** "Vellum Assistant"
2. **User support email:** Select the user's email from the dropdown
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
1. **Application type:** Select "Web application"
2. **Name:** "Vellum Assistant"
3. **Authorized redirect URIs:** Click "Add URI" and enter `${ingress.publicBaseUrl}/webhooks/oauth/callback`

Click "Create".

## Step 7: Download Credentials JSON

After the credentials dialog appears, click the "Download JSON" button (it may say "DOWNLOAD JSON" or show a download icon).

Use `browser_wait_for_download` to wait for the file to download.

Tell the user: "Credentials downloaded! The file is at: `<path>`"

## Step 8: Secure Credential Entry

Tell the user to open the downloaded JSON file, then prompt for secure entry:

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Open the downloaded JSON file and copy the client_id value"
  placeholder: "123456789.apps.googleusercontent.com"
```

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the client_secret value from the same JSON file"
  placeholder: "GOCSPX-..."
```

## Step 9: OAuth2 Authorization

Tell the user: "Opening Google sign-in so you can authorize Vellum. Just click 'Allow' on the consent page."

Use `credential_store` with:

```
action: "oauth2_connect"
service: "integration:gmail"
```

This auto-reads client_id/client_secret from the secure store and auto-fills auth_url, token_url, scopes, and extra_params from well-known config.

**If the user sees a "This app isn't verified" warning:** Tell them this is normal for apps in testing mode. Click "Advanced" then "Go to Vellum Assistant (unsafe)" to proceed.

## Step 10: Done!

"**Gmail and Calendar are connected!** You can now read, search, and send emails, plus view and manage your calendar. Try asking me to check your inbox or show your upcoming events!"

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain clearly and ask them to resolve it.
- **Consent screen already configured:** Don't overwrite — skip to credential creation.
- **Element not found:** Take a fresh `browser_snapshot` to re-assess. GCP UI may have changed. Tell the user what you're looking for if stuck.
- **OAuth flow timeout or failure:** Offer to retry. The credentials are already stored, so reconnecting only requires re-running the authorization flow.
- **Any unexpected state:** Take a `browser_screenshot` and `browser_snapshot`, describe what you see, and ask the user for guidance.
