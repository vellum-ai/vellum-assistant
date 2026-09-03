# Path B: Manual Channel Setup (GitHub)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17332) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up GitHub from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A GitHub account
> 2. About 3-5 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Ensure Public Ingress

Before proceeding, resolve the redirect URI:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

## Path B Step 3: Create a GitHub OAuth App

Tell the user:

> **Step 1: Create an OAuth App**
>
> Open this link:
> `https://github.com/settings/developers`
>
> 1. Click the **OAuth Apps** tab if not already selected
> 2. Click **New OAuth App**
> 3. Fill in:
>    - **Application name:** `Vellum Assistant`
>    - **Homepage URL:** `https://vellum.ai`
>    - **Authorization callback URL:** `OAUTH_CALLBACK_URL`
> 4. Click **Register application**
>
> Let me know when the app is created.

## Path B Step 4: Get Credentials

Tell the user:

> **Step 2: Get your app credentials**
>
> You should be on the app's settings page now. The **Client ID** is shown near the top.
>
> Send me your **Client ID** first.

Wait for the Client ID. Then ask for the secret:

> Click **Generate a new client secret**. GitHub shows it only once, so copy it immediately. Don't paste it in chat: I'll open a secure prompt for you to enter it.

Then open the secure prompt:

```bash
assistant credentials prompt --service github --field client_secret \
  --label "OAuth Client Secret" \
  --description "Paste the client secret from the app settings page."
```

Then follow [Prompt outcomes](../CONFIGURING_APPLICATIONS.md#prompt-outcomes) before registering the app; the secret is only stored on exit 0.

## Path B Step 5: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. Tell them to click **Authorize** on the GitHub consent page.

After authorization:

> **GitHub is connected!** You can now ask me to check your repositories, notifications, pull requests, and issues.
