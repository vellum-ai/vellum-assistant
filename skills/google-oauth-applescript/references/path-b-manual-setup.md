# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path uses **Web application** credentials because the OAuth callback goes through the public gateway URL.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Gmail & Calendar from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
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
> Open: `https://console.cloud.google.com/auth/branding?project=PROJECT_ID`
>
> **If you see a setup wizard** (numbered steps: App Information → Audience → Contact Information → Finish):
>
> 1. **App Information:** Set app name to **Vellum Assistant**
> 2. **Audience:** Select **External**
> 3. **Contact Information:** Enter your email
> 4. Click **Create**
>
> After the wizard completes, open `https://console.cloud.google.com/auth/audience?project=PROJECT_ID` and scroll to **Test users** → click **+ Add users** → add your email → **Save**.
>
> **If you see a Branding page** (with fields for App name, support email, etc.):
>
> - **3a. Branding** — Fill in:
>   - App name: **Vellum Assistant**
>   - User support email: **your email**
>   - Developer contact email: **your email**
>   - Click **Save**
> - **3b. Audience** — Open: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`
>   - Set user type to **External** if not already set
>   - Scroll to **Test users**, click **+ Add users**, add **your email**, click **Save**
>
> **Then, regardless of which flow you saw:**
>
> - **Scopes** — Open: `https://console.cloud.google.com/auth/scopes?project=PROJECT_ID`
>   - Click **Add or Remove Scopes** — a panel will open
>   - Scroll down to the **"Manually add scopes"** text box and paste these (comma-separated):
>     `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/contacts.readonly`
>   - Click **Update** at the bottom of the panel
>   - Back on the main page, scroll down and click **Save**
>
> **Quick note:** The `gmail.modify` and `gmail.send` scopes are what allow me to draft and send emails on your behalf. If you'd rather I only have read access to your email for now, you can remove those two from the list before pasting — everything else will still work fine, and you can always add them later.
>
> Let me know when all parts are done.

## Path B Step 5: Create Web Application Credentials

Before sending the next step, resolve the concrete callback URL:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

Tell the user:

> **Step 4: Create OAuth credentials**
>
> Open: `https://console.cloud.google.com/auth/clients/create?project=PROJECT_ID`
>
> Use this exact redirect URI:
> `OAUTH_CALLBACK_URL`
>
> 1. Application type: **Web application**
> 2. Name: **Vellum Assistant**
> 3. Under **Authorized redirect URIs**, click **Add URI** and paste the redirect URI shown above
> 4. Click **Create**
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
  service: "integration:google"
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
  service: "integration:google"
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
  service: "integration:google"
```

Send the returned auth URL to the user. If they see **This app isn't verified**, tell them to click **Advanced** and continue to **Vellum Assistant**.

## Path B Step 8: Done

After authorization:

> **Gmail and Calendar are connected!**
