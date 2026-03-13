# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The OAuth callback goes through the public gateway URL.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Notion integration from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Notion account with a workspace you want to connect
> 2. About 3 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Create a Public Integration

Tell the user:

> **Step 1: Create a Notion integration**
>
> Open this link to go to your Notion integrations page:
> `https://www.notion.so/profile/integrations`
>
> If you need to sign in, do that first.
>
> Then:
>
> 1. Click **"New integration"** (or the **"+"** button)
> 2. Set the name to **Vellum Assistant**
> 3. Select your workspace from the **Associated workspace** dropdown
> 4. For the **Type**, select **Public** (this is required for OAuth)
> 5. Click **Submit**
>
> Let me know when the integration is created.

## Path B Step 3: Configure OAuth Redirect URI

Before sending the next step, resolve the concrete callback URL:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

Tell the user:

> **Step 2: Configure the redirect URI**
>
> In your integration settings, find the **Distribution** tab in the left sidebar (or a section called **OAuth Domain & URIs**).
>
> In the **Redirect URIs** field, paste this exact URL:
> `OAUTH_CALLBACK_URL`
>
> Scroll down and click **Save changes**.
>
> Let me know when it's saved.

## Path B Step 4: Copy Credentials

Tell the user:

> **Step 3: Copy your credentials**
>
> In your integration settings, find the **Secrets** section. You should see:
>
> - **OAuth client ID**
> - **OAuth client secret** (you may need to click **Show** to reveal it)
>
> Send me the **Client ID** first. It looks like a UUID or alphanumeric string.

Wait for the user to send the Client ID.

## Path B Step 5: Store Credentials

### Path B Step 5a: Client ID

After the user sends the Client ID:

```
credential_store store:
  service: "integration:notion"
  field: "client_id"
  value: "<the client id the user sent>"
```

### Path B Step 5b: Client Secret

Tell the user:

> **Step 4: Send your Client Secret**
>
> Now send me the **Client Secret** from the Secrets section. It starts with `secret_`.
>
> Send it as a standalone message with no other text.

After the user sends it:

```
credential_store store:
  service: "integration:notion"
  field: "client_secret"
  value: "<the client secret the user sent>"
```

## Path B Step 6: Authorize

Tell the user:

> **Step 5: Authorize Notion**
>
> I'll generate an authorization link for you now.

```
credential_store:
  action: "oauth2_connect"
  service: "integration:notion"
  client_id: "<the client id the user sent>"
```

Send the returned auth URL to the user:

> Open this link to authorize Vellum Assistant:
> `<auth URL>`
>
> You'll see a Notion consent page. Select the pages and databases you'd like to share, then click **Allow access**.

## Path B Step 7: Done

After authorization:

> **Notion is connected!** You can now ask me to read and write pages and databases in your Notion workspace.
