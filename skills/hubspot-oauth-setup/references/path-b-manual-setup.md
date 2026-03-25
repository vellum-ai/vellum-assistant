# Path B: Manual Channel Setup (HubSpot)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17330) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up HubSpot from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. A HubSpot account (free tier works)
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

## Path B Step 3: Create a Developer Account and App

Tell the user:

> **Step 1: Create a HubSpot App**
>
> Open this link:
> `https://app.hubspot.com/developer`
>
> 1. Sign in or create a free developer account if needed
> 2. Click **Create app** (choose public app if prompted)
> 3. Set the app name to **Vellum Assistant**
> 4. Click **Save**
>
> Let me know when the app is created.

## Path B Step 4: Add Scopes

Tell the user:

> **Step 2: Add permissions**
>
> Click on the **Auth** tab at the top of the app page. Scroll down to the **Scopes** section and add each of these scopes:
>
> `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.companies.read`
>
> That's 5 scopes total. Use the search box to find each one and check the box next to it. Click **Save** when done.
>
> Let me know when they're all added.

## Path B Step 5: Add Redirect URL

Tell the user:

> **Step 3: Add redirect URL**
>
> Still on the **Auth** tab, scroll to the **Redirect URLs** section.
>
> 1. Click **Add URL**
> 2. Paste this exact URL: `OAUTH_CALLBACK_URL`
> 3. Click **Save**
>
> Let me know when it's saved.

## Path B Step 6: Get Credentials

Tell the user:

> **Step 4: Get your app credentials**
>
> Still on the **Auth** tab, look near the top for the **Client ID** and **App Secret**.
>
> Send me your **Client ID** first.

Wait for the Client ID, then store it:

```
credential_store store:
  service: "integration:hubspot"
  field: "client_id"
  value: "<the client id the user sent>"
```

Then ask for the secret:

> Now send me the **App Secret**. Send it as a standalone message with no other text.

Store the secret:

```
credential_store store:
  service: "integration:hubspot"
  field: "oauth_secret"
  value: "<the app secret the user sent>"
```

Note: HubSpot app secrets don't have a known prefix that triggers channel scanners, so direct entry is acceptable. Still, keep the secret in its own message to avoid accidental logging with surrounding context.

## Path B Step 7: Authorize

Tell the user:

> **Step 5: Authorize HubSpot**
>
> I'll generate an authorization link for you now.

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:hubspot --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:hubspot:oauth_secret"
```

```
bash:
  command: |
    assistant oauth connect integration:hubspot --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

Send the returned auth URL to the user. Tell them to select their HubSpot account and click **Grant access** on the consent page.

## Path B Step 8: Done

After authorization:

> **HubSpot is connected!** You can now ask me to look up contacts, manage deals, and browse company records in your HubSpot CRM.
