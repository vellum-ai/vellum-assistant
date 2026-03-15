---
name: spotify-oauth-setup
description: Set up Spotify OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Spotify OAuth Setup"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Spotify OAuth credentials so the Spotify integration can control playback, manage playlists, and access their library.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Spotify-specific steps.

## Provider Details

- **Provider key:** `integration:spotify`
- **Dashboard:** `https://developer.spotify.com/dashboard`
- **Ping URL:** `https://api.spotify.com/v1/me`
- **Callback transport:** Loopback
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## Spotify-Specific Flow

The flow has 7 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start — do you have a Spotify account? Any Spotify account (free or premium) can create developer apps.

If the user doesn't have a Spotify account, direct them to sign up at `https://www.spotify.com/signup` first.

---

### Step 1: Open Spotify Developer Dashboard

Open: `https://developer.spotify.com/dashboard`

> I've opened the Spotify Developer Dashboard. If it's asking you to sign in, go ahead and do that first — then let me know.

---

### Step 2: Create a New App

> Look for the **Create App** button. Go ahead and click it.

After the user clicks:

> Fill in the following:
>
> - **App name:** Vellum Assistant
> - **App description:** Personal assistant integration
> - **Redirect URI:** (I'll get the right URL for you in a moment)

Before providing the redirect URI, resolve it:

```
bash:
  command: assistant oauth providers get integration:spotify --json
```

- If the `redirectUri` is a concrete URL (e.g. `http://localhost:…/oauth/callback`), tell the user to enter that exact URL as the redirect URI.
- If it is `null`, stop and help the user configure public ingress first.

Then:

> For **Which API/SDKs are you planning to use?**, check **Web API**.
>
> Check the terms of service box, then click **Save**.

**Known issues:**

- If the dashboard shows a "You need to verify your email" banner, the user must verify their Spotify email first
- Free and premium accounts both have access to the developer dashboard

**Milestone (2 of 7):** "App created — now let's grab the credentials."

---

### Step 3: Get Client ID and App Secret

> You should now be on the app's overview page. The **Client ID** is shown right there.
>
> To find the app secret, click **Settings** in the top-right area of the app page.

Open: the app's **Settings** page.

> On the Settings page, you should see the **Client ID** and a hidden **app secret**. Click **View app secret** to reveal it.

**Milestone (3 of 7):** "Credentials are visible — let's save them."

---

### Step 4: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect the app secret via secure prompt:

```
credential_store prompt:
  service: "integration:spotify"
  field: "oauth_secret"
  label: "Spotify OAuth App Secret"
  description: "Copy the app secret from the Settings page (click View app secret to reveal it) and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:spotify --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:spotify:oauth_secret"
```

**Milestone (4 of 7):** "Credentials saved — just the authorization step left."

---

### Step 5: Authorize

> I'll start the Spotify authorization flow now. You should see a Spotify consent page asking you to allow **Vellum Assistant** to access your account.
>
> Review the permissions and click **Agree**.

```
bash:
  command: |
    assistant oauth connections connect integration:spotify --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

The scopes requested will include:

- `user-read-playback-state` — see what's playing
- `user-modify-playback-state` — play, pause, skip tracks
- `user-read-currently-playing` — see the current track
- `user-read-recently-played` — see listening history
- `playlist-read-private` — view private playlists
- `playlist-modify-public` — create and edit public playlists
- `playlist-modify-private` — create and edit private playlists
- `user-library-read` — view saved tracks and albums
- `user-library-modify` — save and remove tracks and albums

---

### Step 6: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:spotify --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "https://api.spotify.com/v1/me" | python3 -m json.tool
```

**On success:** "Spotify is connected! You can now ask me to control playback, manage your playlists, check what's playing, and browse your library."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Spotify-specific differences for Path B:

- Loopback callback won't work from a remote channel — need public ingress configured
- Add the ingress-based redirect URI in the app's Settings page under **Redirect URIs**
- The app secret doesn't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
