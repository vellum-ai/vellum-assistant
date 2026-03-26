# Path B: Manual Channel Setup (Todoist)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17325) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Todoist from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Todoist account
> 2. About 3 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Ensure Public Ingress

Before proceeding, resolve the redirect URI:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

## Path B Step 3: Create a Todoist App

Tell the user:

> **Step 1: Create a Todoist App**
>
> Open this link:
> `https://developer.todoist.com/appconsole.html`
>
> 1. Click **Create a new app**
> 2. Set the app name to **Vellum Assistant**
> 3. Click **Create app**
>
> Let me know when the app is created.

## Path B Step 4: Add Redirect URL

Tell the user:

> **Step 2: Add redirect URL**
>
> In the app settings, find the **OAuth redirect URL** field.
>
> 1. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 2. Click **Save settings**
>
> Let me know when it's saved.

## Path B Step 5: Get Credentials

Tell the user:

> **Step 3: Get your app credentials**
>
> On the app settings page, you should see the **Client ID** and **App secret** displayed.
>
> Send me your **Client ID** first.

Wait for the Client ID.

Then ask for the secret:

> Now send me the **app secret**. Send it as a standalone message with no other text.

Note: Todoist app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 6: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. Tell them to click **Agree** on the Todoist consent page.

> **Todoist is connected!** You can now ask me to manage your tasks, create projects, and organize your to-do lists.
