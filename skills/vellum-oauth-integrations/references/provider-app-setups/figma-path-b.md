# Path B: Manual Channel Setup (Figma)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17331) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Figma from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Figma account
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

## Path B Step 3: Create a Figma App

Tell the user:

> **Step 1: Create a Figma App**
>
> Open this link:
> `https://www.figma.com/developers/apps`
>
> 1. Click **Create a new app** (or the **+** button)
> 2. Set the app name to **Vellum Assistant**
> 3. Set the website URL to any URL (e.g., `https://vellum.ai`)
> 4. Click **Save** or **Create**
>
> Let me know when the app is created.

## Path B Step 4: Configure Scopes and Callback URL

Figma rejects the **whole** authorization request when the app is not configured
to grant one of the requested scopes, so the app has to enable every scope the
connect flow asks for. Read the exact set first, and follow the CLI if it
returns something different from the list below:

```bash
assistant oauth providers get figma --json | jq -r '.defaultScopes[]'
```

Tell the user:

> **Step 2: Set up scopes and callback URL**
>
> On the app settings page:
>
> 1. Find the **Scopes** section and enable all of these:
>    - `current_user:read`
>    - `file_content:read`
>    - `file_metadata:read`
>    - `file_versions:read`
>    - `file_comments:read`
>    - `file_comments:write`
>    - `file_dev_resources:read`
>    - `file_dev_resources:write`
>    - `folders:read`
>    - `folder_metadata:read`
>    - `library_content:read`
>    - `library_assets:read`
>    - `team_library_content:read`
>    - `selections:read`
> 2. Find the **Callback URL** field and paste this exact URL:
>    `OAUTH_CALLBACK_URL`
> 3. Click **Save**
>
> Let me know when it's saved.

If the user does not want to enable all fourteen, have them enable only the
scopes they are comfortable with and pass that exact set on connect, which
replaces the defaults entirely (keep `current_user:read`, since the ping and
identity checks both call `GET /v1/me`):

```bash
assistant oauth connect figma --scopes current_user:read file_content:read file_comments:write
```

`file_variables:*`, `library_analytics:read`, and the `org:*` scopes need an
Enterprise plan (and org admin for `org:*`). Requesting one the app cannot grant
fails the whole authorization, so leave them out unless the user has them.

## Path B Step 5: Get Credentials

Tell the user:

> **Step 3: Get your app credentials**
>
> On the app settings page, find the **Client ID** and **App Secret**.
>
> Send me your **Client ID** first.

Wait for the Client ID. Then ask for the secret:

> You may need to click **Show** to reveal the **App Secret**. Don't paste it in chat: I'll open a secure prompt for you to enter it.

Then open the secure prompt:

```bash
assistant credentials prompt --service figma --field client_secret \
  --label "OAuth Client Secret" \
  --description "Paste the App Secret from the app settings page."
```

Then follow [Prompt outcomes](../CONFIGURING_APPLICATIONS.md#prompt-outcomes) before registering the app; the secret is only stored on exit 0.

## Path B Step 6: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. Tell them to click **Allow access** on the Figma consent page.

After authorization:

> **Figma is connected!** You can now ask me to browse your design files, inspect components, and post comments.
