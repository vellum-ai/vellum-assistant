# Path B: Manual Channel Setup (Dropbox)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17327) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Dropbox from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Dropbox account (free is fine)
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

## Path B Step 3: Create a Dropbox App

Tell the user:

> **Step 1: Create a Dropbox App**
>
> Open this link:
> `https://www.dropbox.com/developers/apps`
>
> 1. Click **Create app**
> 2. Choose **Scoped access**
> 3. Choose **Full Dropbox** access type
> 4. Name it **Vellum Assistant**
> 5. Click **Create app**
>
> Let me know when the app is created.

## Path B Step 4: Set Permissions

Tell the user:

> **Step 2: Set permissions**
>
> Click the **Permissions** tab at the top of the app page. Check the boxes for each of these scopes:
>
> `files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.read`
>
> That's 4 scopes total. After checking all four, click **Submit** to save.
>
> Let me know when they're saved.

## Path B Step 5: Add Redirect URL

Tell the user:

> **Step 3: Add redirect URL**
>
> Click the **Settings** tab. Scroll down to the **OAuth 2** section and find **Redirect URIs**.
>
> 1. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 2. Click **Add**
>
> Let me know when it's saved.

## Path B Step 6: Get Credentials

Tell the user:

> **Step 4: Get your app credentials**
>
> Still on the **Settings** tab, find the **App key** and **App secret** in the OAuth 2 section.
>
> Send me your **App key** first.

Wait for the App key, then store it:

```
credential_store store:
  service: "integration:dropbox"
  field: "client_id"
  value: "<the app key the user sent>"
```

Then ask for the secret:

> Now send me the **App secret**. You may need to click **Show** to reveal it. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "integration:dropbox"
  field: "oauth_secret"
  value: "<the app secret the user sent>"
```

Note: Dropbox app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 7: Authorize

Tell the user:

> **Step 5: Authorize Dropbox**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:dropbox --client-id $(cat <<'EOF'
    <app-key>
    EOF
    ) --client-secret-credential-path "integration:dropbox:oauth_secret"
```

```
bash:
  command: |
    assistant oauth connect integration:dropbox
```

Send the returned auth URL to the user. Tell them to click **Allow** on the Dropbox consent page.

## Path B Step 8: Done

After authorization:

> **Dropbox is connected!** You can now ask me to read files, upload documents, and browse your Dropbox.
