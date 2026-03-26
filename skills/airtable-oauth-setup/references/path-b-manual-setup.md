# Path B: Manual Channel Setup (Telegram, Slack, etc.)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17329) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Airtable from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. An Airtable account
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

## Path B Step 3: Register an OAuth Integration

Tell the user:

> **Step 1: Register an OAuth integration**
>
> Open this link:
> `https://airtable.com/create/oauth`
>
> 1. Click **Register new OAuth integration**
> 2. Set the name to **Vellum Assistant**
> 3. Click **Register integration**
>
> Let me know when the integration is created.

## Path B Step 4: Add Scopes

Tell the user:

> **Step 2: Add permissions**
>
> In the integration settings, find the **Scopes** section and add each of these scopes:
>
> `data.records:read`, `data.records:write`, `schema.bases:read`
>
> That's 3 scopes total.
>
> Let me know when they're all added.

## Path B Step 5: Add Redirect URL

Tell the user:

> **Step 3: Add redirect URL**
>
> In the integration settings, find the **OAuth redirect URL** field.
>
> 1. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 2. Save the settings
>
> Let me know when it's saved.

## Path B Step 6: Get Credentials

Tell the user:

> **Step 4: Get your integration credentials**
>
> On the integration settings page, find the **Client ID** and the **OAuth secret**.
>
> Send me your **Client ID** first.

Wait for the Client ID. Then ask for the secret:

> Now send me the **OAuth secret**. You may need to click **Show** or **Generate** to reveal it. Send it as a standalone message with no other text.

Note: Airtable OAuth secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 7: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. Tell them to click **Grant access** on the Airtable consent page.

After authorization:

> **Airtable is connected!** You can now ask me to read and update records in your Airtable bases.
