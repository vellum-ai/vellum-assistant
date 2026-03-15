# Path B: Manual Channel Setup (Asana)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17322) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Asana from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. An Asana account with permission to create developer apps
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

## Path B Step 3: Create an Asana App

Tell the user:

> **Step 1: Create an Asana App**
>
> Open this link:
> `https://app.asana.com/0/my-apps`
>
> 1. Click **Create New App**
> 2. Set the app name to **Vellum Assistant**
> 3. Select a purpose (e.g., "Build an integration")
> 4. Click **Create app**
>
> Let me know when the app is created.

## Path B Step 4: Add Redirect URL

Tell the user:

> **Step 2: Add redirect URL**
>
> In the app settings, go to the **OAuth** section.
>
> 1. Under **Redirect URLs**, click **Add redirect URL**
> 2. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 3. Save the changes
>
> Let me know when it's saved.

## Path B Step 5: Get Credentials

Tell the user:

> **Step 3: Get your app credentials**
>
> In the **OAuth** section of your app settings, you should see the **Client ID** and the app **secret**.
>
> Send me your **Client ID** first.

Wait for the Client ID, then store it:

```
credential_store store:
  service: "integration:asana"
  field: "client_id"
  value: "<the client id the user sent>"
```

Then ask for the secret:

> Now send me the **app secret**. You may need to click **Show** to reveal it. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "integration:asana"
  field: "oauth_secret"
  value: "<the app secret the user sent>"
```

Note: Asana app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 6: Authorize

Tell the user:

> **Step 4: Authorize Asana**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:asana --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:asana:oauth_secret"
```

```
bash:
  command: |
    assistant oauth connections connect integration:asana --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

Send the returned auth URL to the user. Tell them to click **Allow** on the Asana consent page.

## Path B Step 7: Done

After authorization:

> **Asana is connected!** You can now ask me to check your Asana tasks, create projects, manage assignments, and track your work.
