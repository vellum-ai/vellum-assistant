---
name: twitter-oauth-setup
description: Set up Twitter/X OAuth credentials for Twitter integration using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Twitter / X OAuth Setup"
    user-invocable: true
    credential-setup-for: "twitter"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Twitter/X OAuth credentials so the Twitter integration can post tweets, read timelines, and access user data.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Twitter-specific steps.

## Provider Details

- **Provider key:** `integration:twitter`
- **Auth URL:** `https://twitter.com/i/oauth2/authorize`
- **Token URL:** `https://api.x.com/2/oauth2/token`
- **Ping URL:** `https://api.x.com/2/users/me`
- **Base URL:** `https://api.x.com`
- **Default scopes:** `tweet.read`, `tweet.write`, `users.read`, `offline.access`
- **Token endpoint auth method:** `client_secret_basic`
- **Callback transport:** Gateway (requires public ingress)
- **Requires secret:** Yes (token endpoint uses `client_secret_basic`, so both Client ID and Client Secret are needed)

## Twitter-Specific Flow

The flow has 8 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start — do you have a Twitter/X account you'd like to use for this? You'll also need access to the Twitter Developer Portal.

If no account -> guide them to create one or defer.
If no developer account -> they'll be prompted to sign up during Step 1. Free tier is sufficient.

---

### Step 1: Open Twitter Developer Portal

Open: `https://developer.x.com/en/portal/dashboard`

> I've opened the Twitter Developer Portal. If it's asking you to sign in, go ahead and do that first.

**Known issues:**

- First-time developers will see a sign-up flow — they need to agree to the developer agreement and describe their use case. "Personal project" or "Building a tool" works fine for the description.
- Free tier is sufficient for OAuth 2.0 with PKCE.

---

### Step 2: Create a Project

> Look for **Projects & Apps** in the left sidebar. If you already have a project you'd like to use, let me know. Otherwise, click **+ Add Project**.

Guide through project creation:

> 1. **Project name:** `Vellum Assistant` (or whatever you prefer)
> 2. **Use case:** Select **Making a bot** or **Exploring the API** — either works
> 3. **Project description:** Something brief like "Personal assistant integration"
> 4. Click **Next** through each step

**Known issues:**

- Free tier allows only one project — if the user already has one, reuse it
- If they see "You've reached your project limit", use the existing project

**Milestone (2 of 8):** "Project created — now let's set up an app inside it."

---

### Step 3: Create an App (or select existing)

If the project creation wizard prompts to create an app immediately, follow along. Otherwise:

> Inside your project, look for an **+ Add App** button or a prompt to create a new app.
>
> Set the app name to **Vellum Assistant** and click **Next** or **Create**.

After creation, the portal may show API keys (API Key and Secret, Bearer Token). These are for OAuth 1.0a — we don't need them for OAuth 2.0, but it doesn't hurt to save them somewhere safe.

> You may see API Key, API Secret, and Bearer Token on this screen. You can save these somewhere safe if you like, but we won't need them — we're using OAuth 2.0. Go ahead and click **App Settings** or navigate to your app's settings page.

---

### Step 4: Configure OAuth 2.0 Settings

Navigate to the app's settings. If not already there:

> In the left sidebar under your project, click on your app name, then look for **Settings** or **Edit** under the **User authentication settings** section.

Open the User Authentication Settings:

> Scroll down to **User authentication settings** and click **Set up** or **Edit**.

Guide through the OAuth 2.0 configuration:

> You should see an authentication setup page. Here's what to fill in:
>
> 1. **App permissions:** Select **Read and write** (this covers tweet.read, tweet.write, and users.read)
> 2. **Type of App:** Select **Web App, Automated App or Bot**
> 3. **App info:**
>    - **Callback URI / Redirect URL:** I'll give you the URL in a moment
>    - **Website URL:** You can use `https://vellum.ai` or any URL you own

Before providing the redirect URI, resolve it:

```
bash:
  command: assistant oauth providers list --provider-key "integration:twitter" --json
```

Check the redirect URI situation. Since callbackTransport is `gateway`, public ingress must be configured:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.

> For the **Callback URI / Redirect URL**, paste this exact URL:
> `OAUTH_CALLBACK_URL`
>
> For the **Website URL**, you can enter `https://vellum.ai` or any website you own.
>
> Then click **Save**.

**Milestone (4 of 8):** "OAuth settings configured — now let's grab the credentials."

---

### Step 5: Get Client ID and Client Secret

> After saving, you should be back on the app settings page. Look for the **Keys and tokens** tab at the top of the page, then scroll down to **OAuth 2.0 Client ID and Client Secret**.
>
> If you don't see a Client Secret, click **Regenerate** next to it. You may need to confirm by typing "Yes" in a dialog.

Note: The token endpoint auth method (`basic`) requires both a Client ID and a secret, so the skill collects both.

**Milestone (5 of 8):** "Almost there — just need to save these credentials."

---

### Step 6: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** (it's a long string, sometimes called "OAuth 2.0 Client ID") and paste it here in the chat.

Collect Client Secret via secure prompt:

```
credential_store prompt:
  service: "integration:twitter"
  field: "client_secret"
  label: "Twitter OAuth 2.0 Client Secret"
  description: "Copy the Client Secret from the Keys and tokens page and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:twitter --client-id <client-id> --client-secret-credential-path "credential/integration:twitter/client_secret"
```

**Milestone (6 of 8):** "Credentials saved — just the authorization step left."

---

### Step 7: Authorize

> I'll start the Twitter authorization flow now. You should see a Twitter consent page asking you to authorize **Vellum Assistant** to access your account.
>
> Review the permissions — it will ask for permission to read your tweets, post tweets, and read your profile info. Click **Authorize app**.

```
bash:
  command: |
    assistant oauth connections connect integration:twitter --client-id <client-id>
```

---

### Step 8: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:twitter --client-id <client-id>)" "https://api.x.com/2/users/me" | python3 -m json.tool
```

**On success:** "Twitter is connected! You can now ask me to read your timeline, post tweets, and check your profile."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Twitter-specific differences for Path B:

- Gateway callback requires public ingress — must be configured before starting
- OAuth 2.0 Client Secret doesn't have a known prefix that triggers channel scanners, but still use `credential_store store` for security
- App type must be **Web App, Automated App or Bot** (same as Path A, since gateway transport is used in both paths)
