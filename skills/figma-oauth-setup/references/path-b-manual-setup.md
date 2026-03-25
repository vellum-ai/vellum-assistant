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

Tell the user:

> **Step 2: Set up scopes and callback URL**
>
> On the app settings page:
>
> 1. Find the **Scopes** section and enable:
>    - `files:read`
>    - `file_comments:write`
> 2. Find the **Callback URL** field and paste this exact URL:
>    `OAUTH_CALLBACK_URL`
> 3. Click **Save**
>
> Let me know when it's saved.

## Path B Step 5: Get Credentials

Tell the user:

> **Step 3: Get your app credentials**
>
> On the app settings page, find the **Client ID** and **App Secret**.
>
> Send me your **Client ID** first.

Wait for the Client ID, then store it:

```
credential_store store:
  service: "figma"
  field: "client_id"
  value: "<the client id the user sent>"
```

Then ask for the secret:

> Now send me the **App Secret**. You may need to click **Show** to reveal it. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "figma"
  field: "oauth_secret"
  value: "<the app secret the user sent>"
```

Note: Figma app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 6: Authorize

Tell the user:

> **Step 4: Authorize Figma**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider figma --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "credential/figma/oauth_secret"
```

```
bash:
  command: |
    assistant oauth connect figma
```

Send the returned auth URL to the user. Tell them to click **Allow access** on the Figma consent page.

## Path B Step 7: Done

After authorization:

> **Figma is connected!** You can now ask me to browse your design files, inspect components, and post comments.
