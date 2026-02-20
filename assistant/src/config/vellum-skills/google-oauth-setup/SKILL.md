---
name: "Google OAuth Setup"
description: "Create Google Cloud OAuth credentials for Gmail integration using browser automation"
user-invocable: true
includes: ["browser", "public-ingress"]
metadata: {"vellum": {"emoji": "\ud83d\udd11"}}
---

You are helping your user create Google Cloud OAuth credentials so the Gmail and Google Calendar integrations can connect. Walk through each step below using `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_click`, `browser_type`, and `browser_extract` tools.

**Tone:** Be friendly and reassuring throughout. Narrate what you're doing in plain language so the user always knows what's happening. After each step, briefly confirm what was accomplished before moving on.

## Prerequisites

Before starting, check that `ingress.publicBaseUrl` is configured (Settings > Public Ingress, or `INGRESS_PUBLIC_BASE_URL` env var). If it is not set, load and execute the **public-ingress** skill first (`skill_load` with `skill: "public-ingress"`) to set up an ngrok tunnel and persist the public URL. The OAuth redirect URI depends on this value.

## Before You Start

Tell the user:
- "I'll walk you through setting up Google Cloud so Vellum can connect to your Gmail and Google Calendar. The whole process takes a few minutes."
- "I'll be automating the Google Cloud Console in the browser — you'll be able to see everything I'm doing."
- "I'll ask for your approval before each major step, so nothing happens without your say-so."
- "No sensitive credentials will be shown in the conversation."

## Step 1: Navigate to Google Cloud Console

Tell the user: "First, let me open Google Cloud Console."

Use `browser_navigate` to go to `https://console.cloud.google.com/`.

Take a `browser_screenshot` to show the user what loaded, then take a `browser_snapshot` to check the page state:
- **If a sign-in page appears:** Tell the user "Please sign in to your Google account in the browser window. Let me know when you're done." Wait for their confirmation, then take another snapshot.
- **If a CAPTCHA appears:** Tell the user "There's a CAPTCHA to solve. Please complete it in the browser window and let me know." Wait, then retry.
- **If the console dashboard loads:** Tell the user "Google Cloud Console is loaded. Let's get started!" and continue to Step 2.

## Step 2: Create or Select a Project

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Create a Google Cloud Project**
>
> I'm about to create a new Google Cloud project called "Vellum Assistant". This is completely free and won't affect any of your existing projects. The project is just a container for the Gmail API credentials.

Wait for the user to approve. If they decline, explain that a project is required for OAuth credentials and offer to try again or cancel the setup.

Once approved, navigate to `https://console.cloud.google.com/projectcreate`.

Take a `browser_snapshot`. Fill in the project name form:
- Use `browser_type` to set the project name to "Vellum Assistant"
- Use `browser_click` to submit the "Create" button

Wait a few seconds, then take a `browser_screenshot` to show the user what happened, and a `browser_snapshot` to confirm the project was created. If the project already exists, that's fine — navigate to its dashboard.

Tell the user: "Project created! Now let's enable the Gmail API."

Note the project ID from the URL or page content for subsequent steps.

## Step 3: Enable the Gmail and Calendar APIs

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Enable the Gmail and Calendar APIs**
>
> I'm about to enable the Gmail API and Google Calendar API in your Google Cloud project. This allows Vellum to access your email and calendar — but only after you explicitly authorize it in a later step. Enabling the APIs alone doesn't grant any access.

Wait for the user to approve. If they decline, explain that the APIs are required for email and calendar integration and offer to try again or cancel.

Once approved, navigate to `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID` (substitute the actual project ID).

Take a `browser_snapshot`:
- **If the API is already enabled:** You'll see "API enabled" or a "Manage" button. Tell the user "Gmail API is already enabled — great!" and continue to enable Calendar API.
- **If not enabled:** Use `browser_click` on the "Enable" button.

Wait a moment, then take a `browser_screenshot` to show the result and a `browser_snapshot` to confirm it shows as enabled.

Now navigate to `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID` to enable the Google Calendar API.

Take a `browser_snapshot`:
- **If the API is already enabled:** Tell the user "Google Calendar API is already enabled — great!" and skip to Step 4.
- **If not enabled:** Use `browser_click` on the "Enable" button.

Wait a moment, then take a `browser_screenshot` to show the result.

Tell the user: "Gmail and Calendar APIs are enabled! Next, we need to set up an OAuth consent screen."

## Step 4: Configure the OAuth Consent Screen

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Configure OAuth Consent Screen**
>
> I'm about to set up an OAuth consent screen for your project. This is the page Google shows when you authorize an app. I'll configure it with your email and the Gmail permissions Vellum needs (read, modify, and send emails). The app will start in "testing" mode — only you will be able to authorize it.

Wait for the user to approve. If they decline, explain that the consent screen is required for the OAuth flow and offer to try again or cancel.

Once approved, navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

Take a `browser_snapshot` to check the current state:
- **If consent screen is already configured:** Tell the user "Consent screen is already set up — skipping ahead!" and go to Step 5.
- **If a user type selection appears:** Select "External" and click "Create".

Fill in the required fields on the consent screen form:
1. **App name:** "Vellum Assistant"
2. **User support email:** Select the user's email from the dropdown
3. **Developer contact email:** Type the user's email address
4. Leave other fields as defaults

Use `browser_click` to proceed through each page of the wizard:
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

Take a `browser_screenshot` after completing the wizard.

Tell the user: "Consent screen is configured! Almost there — just need to create the credentials."

## Step 5: Create OAuth Credentials

**Ask for approval before proceeding.** Use `ui_show` with `surface_type: "confirmation"` and this message:

> **Create OAuth Credentials**
>
> I'm about to create OAuth Web Application credentials for Vellum Assistant. This generates a client ID that Vellum uses to initiate the authorization flow. The redirect URI will point to the gateway's OAuth callback endpoint.

Wait for the user to approve. If they decline, explain that credentials are the final step needed and offer to try again or cancel.

Once approved, navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Use `browser_click` on "+ Create Credentials" at the top, then select "OAuth client ID" from the dropdown.

Take a `browser_snapshot` and fill in:
1. **Application type:** Select "Web application" from the dropdown
2. **Name:** "Vellum Assistant"
3. **Authorized redirect URIs:** Click "Add URI" and enter `${ingress.publicBaseUrl}/webhooks/oauth/callback` (e.g. `https://abc123.ngrok-free.app/webhooks/oauth/callback`). Read the `ingress.publicBaseUrl` value from the assistant's workspace config (Settings > Public Ingress) or the `INGRESS_PUBLIC_BASE_URL` environment variable.

Use `browser_click` on the "Create" button.

## Step 6: Extract and Store the Client ID

After creation, a dialog should appear showing the client ID and client secret.

Use `browser_snapshot` or `browser_extract` to read the **Client ID** value from the dialog. The client ID looks like `NUMBERS-CHARS.apps.googleusercontent.com`.

**Important:** You only need the Client ID, not the client secret (PKCE flow is used).

Tell the user: "Credentials created! Now let's connect your Gmail account using the client ID."

## Step 7: Connect Gmail

Tell the user: "Opening Google sign-in so you can authorize Vellum to access your Gmail. You'll see a Google consent page — just click 'Allow'."

Use the `credential_store` tool to connect Gmail via OAuth2:

```
action: "oauth2_connect"
service: "integration:gmail"
client_id: "<the extracted client ID>"
auth_url: "https://accounts.google.com/o/oauth2/v2/auth"
token_url: "https://oauth2.googleapis.com/token"
scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/userinfo.email"]
userinfo_url: "https://www.googleapis.com/oauth2/v2/userinfo"
extra_params: {"access_type": "offline", "prompt": "consent"}
```

This will open the Google authorization page in the user's browser. Wait for the flow to complete.

**If the user sees a "This app isn't verified" warning:** Tell them this is normal for apps in testing mode. They should click "Advanced" → "Go to Vellum Assistant (unsafe)" to proceed. This warning appears because the app hasn't gone through Google's verification process, which is only needed for apps used by many people.

## Step 8: Celebrate!

Once connected, tell the user:

"**Gmail and Calendar are connected!** You're all set. You can now read, search, and send emails, plus view and manage your calendar through Vellum. Try asking me to check your inbox or show your upcoming events!"

Summarize what was accomplished:
- Created a Google Cloud project (or used an existing one)
- Enabled the Gmail API and Google Calendar API
- Configured the OAuth consent screen with appropriate scopes (including calendar)
- Created OAuth Web Application credentials with gateway callback redirect URI
- Connected your Gmail and Google Calendar accounts

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain what's needed clearly and ask them to resolve it.
- **Consent screen already configured with different settings:** Don't overwrite; skip to credential creation and tell the user you're using their existing configuration.
- **Element not found for click/type:** Take a fresh `browser_snapshot` to re-assess the page layout. GCP UI may have changed; adapt your selectors. Tell the user what you're looking for if you get stuck.
- **User declines an approval gate:** Don't push back aggressively. Explain briefly why the step matters, offer to try again, or offer to cancel the whole setup gracefully. Never proceed without approval.
- **OAuth flow timeout or failure:** Tell the user what happened and offer to retry the connect step. The client ID is already stored, so they can also connect later from Settings.
- **"This app isn't verified" warning:** Guide the user through clicking "Advanced" → "Go to Vellum Assistant (unsafe)". Reassure them this is expected for personal-use OAuth apps.
- **Any unexpected state:** Take a `browser_screenshot` and `browser_snapshot`, describe what you see, and ask the user for guidance rather than guessing.
