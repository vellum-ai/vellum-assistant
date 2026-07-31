# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path uses **Web application** credentials because the OAuth callback goes through the public gateway URL.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Gmail, Calendar & Drive from chat**
>
> Fair warning - this involves Google's developer console, which can feel pretty technical. Don't worry about that - you don't need to understand any of it. I'll give you a direct link for every step and tell you exactly what to do. If anything looks confusing, just let me know and I'll help you through it.
>
> One thing worth knowing upfront: even after setup, I'll only ever create email drafts — I won't send anything without your explicit say-so.
>
> Since I can't open pages in your browser from here, you'll need:
>
> 1. A Google account with access to Google Cloud Console
> 2. About 3-5 minutes
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

## Path B Step 3: Enable APIs + Configure Consent Screen + Add Scopes

After receiving the project ID, present API enabling, consent screen configuration, and scope setup together in one message. Substitute the user's `PROJECT_ID` into all URLs.

Tell the user:

> **Step 2: Enable APIs, configure consent screen, and add scopes**
>
> Now that I have your project ID, here are the next steps — work through them in order:
>
> **Part A: Enable Gmail, Calendar, and Drive APIs**
>
> Open each link below and click **Enable**:
>
> 1. Gmail API: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
> 2. Calendar API: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`
> 3. Drive API: `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=PROJECT_ID`
>
> **Part B: Configure the OAuth consent screen**
>
> Open: `https://console.cloud.google.com/auth/branding?project=PROJECT_ID`
>
> **If you see a setup wizard** (numbered steps: App Information -> Audience -> Contact Information -> Finish):
>
> 1. **App Information:** Set app name to **Vellum Assistant**
> 2. **Audience:** Select **External**
> 3. **Contact Information:** Enter your email
> 4. Click **Create**
>
> After the wizard completes, open `https://console.cloud.google.com/auth/audience?project=PROJECT_ID` and scroll to **Test users** -> click **+ Add users** -> add your email -> **Save**.
>
> **If you see a Branding page** (with fields for App name, support email, etc.):
>
> - **Branding** - Fill in:
>   - App name: **Vellum Assistant**
>   - User support email: **your email**
>   - Developer contact email: **your email**
>   - Click **Save**
> - **Audience** - Open: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`
>   - Set user type to **External** if not already set
>   - Scroll to **Test users**, click **+ Add users**, add **your email**, click **Save**
>
> **Part C: Add scopes (regardless of which flow you saw above)**
>
> Open: `https://console.cloud.google.com/auth/scopes?project=PROJECT_ID`
>
> - Click **Add or Remove Scopes** - a panel will open
> - Scroll down to the **"Manually add scopes"** text box and paste these (comma-separated):
>   `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.settings.basic,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/contacts.readonly`
> - Click **Update** at the bottom of the panel
> - Back on the main page, scroll down and click **Save**
>
> **Quick note on email safety:** The `gmail.modify` and `gmail.send` scopes let me create drafts and, when you explicitly ask, send them. By default I only create drafts — nothing leaves your outbox without your approval. If you'd rather I only have read access to your email for now, you can remove those two from the list before pasting - everything else will still work fine, and you can always add them later.
>
> Let me know when you've finished all parts.

## Path B Step 4: Create Credentials + Collect Client ID & Secret

Before sending this step, resolve the concrete callback URL:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

In this step, present credential creation instructions AND collect both the Client ID and Client Secret in the same turn. Output the chat text first (including the Client ID request), then run `assistant credentials prompt` (via the bash tool) for the Client Secret in the same turn.

Tell the user:

> **Step 3: Create OAuth credentials**
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
> After you click **Create** and the dialog appears — paste your **Client ID** here in chat, and paste the full **Client Secret** into the secure form I've just opened.

Then, in the same turn, run:

```bash
assistant credentials prompt --service google --field client_secret \
  --label "OAuth Client Secret" \
  --placeholder "GOCSPX-..." \
  --description "Copy the full Client Secret (including the GOCSPX- prefix) from the dialog and paste it here."
```

The `assistant credentials prompt` command is a secure input (not visible in chat), so there is no risk of channel scanners triggering on the `GOCSPX-` prefix. Collect the entire Client Secret value directly — do not ask the user to split or strip any prefix.

## Path B Step 5: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. If they see **This app isn't verified**, tell them to click **Advanced** and continue to **Vellum Assistant**.

**On success:** "Gmail, Calendar, and Drive are connected!"
