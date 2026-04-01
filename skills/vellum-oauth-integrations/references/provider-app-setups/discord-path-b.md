# Path B: Manual Channel Setup (Discord)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17326) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Discord from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Discord account
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

## Path B Step 3: Create a Discord Application

Tell the user:

> **Step 1: Create a Discord Application**
>
> Open this link:
> `https://discord.com/developers/applications`
>
> 1. Click **New Application**
> 2. Set the name to **Vellum Assistant**
> 3. Accept the Developer Terms of Service and Developer Policy
> 4. Click **Create**
>
> Let me know when the application is created.

## Path B Step 4: Navigate to OAuth2

Tell the user:

> **Step 2: Open OAuth2 settings**
>
> In the left sidebar, click **OAuth2**.
>
> Let me know when you're on that page.

## Path B Step 5: Add Redirect URL

Tell the user:

> **Step 3: Add redirect URL**
>
> On the **OAuth2** page, scroll down to the **Redirects** section.
>
> 1. Click **Add Redirect**
> 2. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 3. Click **Save Changes** at the bottom of the page
>
> Let me know when it's saved.

## Path B Step 6: Get Credentials

Tell the user:

> **Step 4: Get your app credentials**
>
> On the **OAuth2** page, you should see the **Client ID** near the top.
>
> Send me your **Client ID** first.

Wait for the Client ID. Then ask for the secret:

> Now click **Reset Secret** on the OAuth2 page. Confirm the reset when prompted. Copy the revealed secret and send it here as a standalone message with no other text.

Note: Discord app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 7: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Scopes to request: `identify guilds guilds.members.read messages.read`

Send the returned auth URL to the user. Tell them to click **Authorize** on the Discord consent page.

After authorization:

> **Discord is connected!** You can now ask me to check your Discord servers, read messages, and look up server members.
