# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17322) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Slack from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Slack workspace where you can install apps
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

## Path B Step 3: Create a Slack App

Tell the user:

> **Step 1: Create a Slack App**
>
> Open this link:
> `https://api.slack.com/apps`
>
> 1. Click **Create New App**
> 2. Choose **From scratch**
> 3. Set the app name to **Vellum Assistant**
> 4. Select your workspace from the dropdown
> 5. Click **Create App**
>
> Let me know when the app is created.

## Path B Step 4: Add User Token Scopes

Tell the user:

> **Step 2: Add permissions**
>
> In the left sidebar, click **OAuth & Permissions**. Scroll down to **User Token Scopes** and add each of these scopes using the **Add an OAuth Scope** button:
>
> `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `users:read`, `chat:write`, `search:read`, `reactions:write`
>
> That's 13 scopes total. You can type the name to filter the dropdown.
>
> Let me know when they're all added.

## Path B Step 5: Add Redirect URL

Tell the user:

> **Step 3: Add redirect URL**
>
> Still on the **OAuth & Permissions** page, scroll up to the **Redirect URLs** section.
>
> 1. Click **Add New Redirect URL**
> 2. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 3. Click **Add**
> 4. Click **Save URLs**
>
> Let me know when it's saved.

## Path B Step 6: Get Credentials

Tell the user:

> **Step 4: Get your app credentials**
>
> In the left sidebar, click **Basic Information**. Scroll down to the **App Credentials** section.
>
> Send me your **Client ID** first.

Wait for the Client ID, then store it:

```
credential_store store:
  service: "integration:slack"
  field: "client_id"
  value: "<the client id the user sent>"
```

Then ask for the secret:

> Now send me the **Client Secret**. You may need to click **Show** to reveal it. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "integration:slack"
  field: "client_secret"
  value: "<the client secret the user sent>"
```

Note: Slack client secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 7: Authorize

Tell the user:

> **Step 5: Authorize Slack**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:slack --client-id <client-id> --client-secret-credential-path "credential/integration:slack/client_secret"
```

```
bash:
  command: |
    assistant oauth connections connect integration:slack --client-id <client-id>
```

Send the returned auth URL to the user. Tell them to click **Allow** on the Slack consent page.

## Path B Step 8: Done

After authorization:

> **Slack is connected!** You can now ask me to check your Slack messages, search conversations, send messages, and react to posts.
