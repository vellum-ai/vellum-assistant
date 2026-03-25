# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the gateway callback is not reachable without it.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Twitter / X from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Twitter/X account with access to the Developer Portal
> 2. About 5 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Ensure Public Ingress

Before proceeding, resolve the redirect URI:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

## Path B Step 3: Create a Project and App

Tell the user:

> **Step 1: Create a Project and App**
>
> Open this link to the Twitter Developer Portal:
> `https://developer.x.com/en/portal/dashboard`
>
> 1. In the left sidebar, find **Projects & Apps**
> 2. Click **+ Add Project** (if you already have a project, you can reuse it)
> 3. Set the project name to **Vellum Assistant**
> 4. For the use case, pick **Making a bot** or **Exploring the API**
> 5. Add a brief description and click through each step
> 6. When prompted, create a new app named **Vellum Assistant**
>
> You may see API Key, API Secret, and Bearer Token - save them if you like, but we won't use them. Navigate to your app's settings page.
>
> Let me know when the app is created.

## Path B Step 4: Configure OAuth 2.0

Tell the user:

> **Step 2: Configure OAuth 2.0 settings**
>
> On your app's settings page, scroll down to **User authentication settings** and click **Set up** (or **Edit** if already configured).
>
> Fill in:
>
> 1. **App permissions:** Select **Read and write**
> 2. **Type of App:** Select **Web App, Automated App or Bot**
> 3. **Callback URI / Redirect URL:** `OAUTH_CALLBACK_URL`
> 4. **Website URL:** `https://vellum.ai` (or any website you own)
>
> Click **Save**.
>
> Let me know when it's saved.

## Path B Step 5: Get Credentials

Tell the user:

> **Step 3: Get your app credentials**
>
> Go to the **Keys and tokens** tab at the top of your app page. Scroll down to the **OAuth 2.0 Client ID and Client Secret** section.
>
> If you don't see a Client Secret, click **Regenerate** next to it and confirm.
>
> Send me your **Client ID** first.

Wait for the Client ID, then store it:

```
credential_store store:
  service: "integration:twitter"
  field: "client_id"
  value: "<the client id the user sent>"
```

Then ask for the secret:

> Now send me the **Client Secret**. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "integration:twitter"
  field: "client_secret"
  value: "<the client secret the user sent>"
```

Note: Twitter OAuth 2.0 Client Secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 6: Authorize

Tell the user:

> **Step 4: Authorize Twitter**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:twitter --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "credential/integration:twitter/client_secret"
```

```
bash:
  command: |
    assistant oauth connect integration:twitter --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

Send the returned auth URL to the user. Tell them to review the permissions and click **Authorize app**.

## Path B Step 7: Done

After authorization:

> **Twitter is connected!** You can now ask me to read your timeline, post tweets, and check your profile.
