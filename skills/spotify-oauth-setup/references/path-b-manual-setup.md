# Path B: Manual Channel Setup (Spotify)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17333) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up Spotify from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A Spotify account (free or premium)
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

## Path B Step 3: Create a Spotify App

Tell the user:

> **Step 1: Create a Spotify App**
>
> Open this link:
> `https://developer.spotify.com/dashboard`
>
> 1. Click **Create App**
> 2. Set the app name to **Vellum Assistant**
> 3. Set the description to **Personal assistant integration**
> 4. Set the redirect URI to `OAUTH_CALLBACK_URL`
> 5. Under **Which API/SDKs are you planning to use?**, check **Web API**
> 6. Check the terms of service box
> 7. Click **Save**
>
> Let me know when the app is created.

## Path B Step 4: Get Credentials

Tell the user:

> **Step 2: Get your app credentials**
>
> On the app overview page, click **Settings** in the top-right area.
>
> You should see your **Client ID** and a hidden **app secret**.
>
> Send me your **Client ID** first.

Wait for the Client ID, then store it:

```
credential_store store:
  service: "spotify"
  field: "client_id"
  value: "<the client id the user sent>"
```

Then ask for the secret:

> Now click **View app secret** to reveal it, then send it to me. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "spotify"
  field: "oauth_secret"
  value: "<the app secret the user sent>"
```

Note: Spotify app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 5: Authorize

Tell the user:

> **Step 3: Authorize Spotify**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider spotify --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "credential/spotify/oauth_secret"
```

```
bash:
  command: |
    assistant oauth connect spotify
```

Send the returned auth URL to the user. Tell them to click **Agree** on the Spotify consent page.

## Path B Step 6: Done

After authorization:

> **Spotify is connected!** You can now ask me to control playback, manage your playlists, check what's playing, and browse your library.
