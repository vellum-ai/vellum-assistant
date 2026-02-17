---
name: "Google OAuth Setup"
description: "Create Google Cloud OAuth credentials for Gmail integration using browser automation"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udd11"}}
---

You are helping your user create Google Cloud OAuth credentials so the Gmail integration can connect. Walk through each step below using `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_extract` tools.

## Before You Start

Tell the user:
- You will open Google Cloud Console in the browser and automate the setup
- They may need to sign in to their Google account if not already authenticated
- The process creates a project, enables the Gmail API, and generates OAuth credentials
- No sensitive credentials will be shown in the conversation; the client ID is stored directly

## Step 1: Navigate to Google Cloud Console

Use `browser_navigate` to go to `https://console.cloud.google.com/`.

Take a `browser_snapshot` to check the page state:
- **If a sign-in page appears:** Tell the user "Please sign in to your Google account in the browser window. Let me know when you're done." Wait for their confirmation, then take another snapshot.
- **If a CAPTCHA appears:** Tell the user "There's a CAPTCHA to solve. Please complete it in the browser window and let me know." Wait, then retry.
- **If the console dashboard loads:** Continue to Step 2.

## Step 2: Create or Select a Project

Navigate to `https://console.cloud.google.com/projectcreate`.

Take a `browser_snapshot`. Fill in the project name form:
- Use `browser_type` to set the project name to "Vellum Assistant" (or similar)
- Use `browser_click` to submit the "Create" button

Wait a few seconds, then take a `browser_snapshot` to confirm the project was created. If the project already exists, that's fine; navigate to its dashboard.

Note the project ID from the URL or page content for subsequent steps.

## Step 3: Enable the Gmail API

Navigate to `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID` (substitute the actual project ID).

Take a `browser_snapshot`:
- **If the API is already enabled:** You'll see "API enabled" or a "Manage" button. Skip to Step 4.
- **If not enabled:** Use `browser_click` on the "Enable" button.

Wait a moment, then take a `browser_snapshot` to confirm it shows as enabled.

## Step 4: Configure the OAuth Consent Screen

Navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`.

Take a `browser_snapshot` to check the current state:
- **If consent screen is already configured:** Skip to Step 5.
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
  - `https://www.googleapis.com/auth/userinfo.email`
  - Click "Update" then "Save and Continue"
- Test users page: Add the user's email as a test user, click "Save and Continue"
- Summary page: Click "Back to Dashboard"

## Step 5: Create OAuth Credentials

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`.

Use `browser_click` on "+ Create Credentials" at the top, then select "OAuth client ID" from the dropdown.

Take a `browser_snapshot` and fill in:
1. **Application type:** Select "Desktop app" from the dropdown
2. **Name:** "Vellum Assistant Desktop"

Use `browser_click` on the "Create" button.

## Step 6: Extract the Client ID

After creation, a dialog should appear showing the client ID and client secret.

Use `browser_snapshot` or `browser_extract` to read the **Client ID** value from the dialog. The client ID looks like `NUMBERS-CHARS.apps.googleusercontent.com`.

**Important:** You only need the Client ID, not the client secret (PKCE flow is used).

## Step 7: Store the Client ID

Use the `integration_manage` tool to save the client ID:

```
action: "set_client_id"
integration_id: "gmail"
client_id: "<the extracted client ID>"
```

## Step 8: Report Success

Summarize what was done:
- Google Cloud project created (or existing project used)
- Gmail API enabled
- OAuth consent screen configured with appropriate scopes
- OAuth Desktop credentials created
- Client ID stored in Vellum configuration

Tell the user: **"Setup is complete! Go to Settings and click 'Connect Gmail' to authorize access to your email."**

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Permission errors in GCP:** The user may need billing enabled or organization-level permissions. Explain what's needed and ask them to resolve it.
- **Consent screen already configured with different settings:** Don't overwrite; skip to credential creation.
- **Element not found for click/type:** Take a fresh `browser_snapshot` to re-assess the page layout. GCP UI may have changed; adapt your selectors.
- **Any unexpected state:** Take a `browser_snapshot`, describe what you see, and ask the user for guidance rather than guessing.
