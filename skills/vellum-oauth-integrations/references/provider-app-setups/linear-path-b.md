# Path B: Manual Channel Setup (Linear)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17324) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Linear from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Linear account with workspace access
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

## Path B Step 3: Create a Linear OAuth Application

Tell the user:

> **Step 1: Create a Linear OAuth application**
>
> Open this link:
> `https://linear.app/settings/api`
>
> 1. Scroll down to the **OAuth Applications** section
> 2. Click **Create new OAuth application**
> 3. Set the application name to **Vellum Assistant**
> 4. Set the **Redirect URL** to `OAUTH_CALLBACK_URL`
> 5. Click **Create**
>
> Let me know when the app is created.

## Path B Step 4: Get Credentials

Tell the user:

> **Step 2: Get your app credentials**
>
> You should now see the application details. Send me the **Client ID** (also called **Application ID**) first.

Wait for the Client ID.

Then ask for the secret:

> Copy the **app secret**. It is shown only once right after creation; if you navigated away, regenerate it from the application settings page. Don't paste it in chat: I'll open a secure prompt for you to enter it.

Then open the secure prompt:

```bash
assistant credentials prompt --service linear --field client_secret \
  --label "OAuth Client Secret" \
  --description "Paste the app secret from the app settings page."
```

Then follow [Prompt outcomes](../CONFIGURING_APPLICATIONS.md#prompt-outcomes) before registering the app; the secret is only stored on exit 0.

## Path B Step 5: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. Tell them to click **Authorize** on the Linear consent page.

> **Linear is connected!** You can now ask me to create issues, check your assignments, search across projects, and manage your Linear workflow.
