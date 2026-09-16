# Path B: Manual Channel Setup (QuickBooks)

When the user is on a non-interactive channel, walk them through a text-based setup. The channel path requires **public ingress** because the loopback callback (port 17342) is not reachable from a remote channel.

## Path B Step 1: Confirm and Explain

Tell the user:

> **Setting up QuickBooks from chat**
>
> Since I can't open pages in your browser from here, I'll walk you through each step with direct links. You'll need:
>
> 1. An Intuit developer account
> 2. A QuickBooks Online company to connect
> 3. About 5 minutes
>
> Ready to start?

If the user declines, stop.

## Path B Step 2: Ensure Public Ingress

Before proceeding, resolve the redirect URI:

- Read the configured public gateway URL from `ingress.publicBaseUrl`.
- If it is missing, load and run the `public-ingress` skill first: call `skill_load` with `skill: "public-ingress"`, then follow its instructions.
- Build `oauthCallbackUrl` as `<public gateway URL>/webhooks/oauth/callback`.
- Replace `OAUTH_CALLBACK_URL` below with that concrete value. Never send the placeholder literally.

## Path B Step 3: Create an Intuit App

Tell the user:

> **Step 1: Create an app**
>
> Open this link:
> `https://developer.intuit.com/app/developer/dashboard`
>
> 1. Click **Create an app**
> 2. Choose **QuickBooks Online and Payments**
> 3. Name it **Vellum Assistant**
> 4. When asked for scopes, pick **Accounting**
> 5. Click **Create app**
>
> Let me know when the app is created.

## Path B Step 4: Choose Keys and Set the Redirect URI

Tell the user:

> **Step 2: Pick the key set and add the redirect URI**
>
> In the left sidebar, open **Keys & credentials**.
>
> 1. Pick **Production** (real companies) or **Development** (sandbox companies only). Intuit asks a short questionnaire before showing production keys.
> 2. Under **Redirect URIs**, add this exact URL:
>    `OAUTH_CALLBACK_URL`
> 3. Click **Save**
>
> Let me know when it's saved.

## Path B Step 5: Get Credentials

Tell the user:

> **Step 3: Get your app credentials**
>
> On the **Keys & credentials** page, find the **Client ID** and **Client Secret** for the key set you chose.
>
> Send me your **Client ID** first.

Wait for the Client ID. Then ask for the secret:

> Don't paste the **Client Secret** in chat: I'll open a secure prompt for you to enter it.

Then open the secure prompt:

```bash
assistant credentials prompt --service quickbooks --field client_secret \
  --label "OAuth Client Secret" \
  --description "Paste the Client Secret from the Keys & credentials page."
```

Then follow [Prompt outcomes](../CONFIGURING_APPLICATIONS.md#prompt-outcomes) before registering the app; the secret is only stored on exit 0.

## Path B Step 6: Authorize and Verify

Follow the `vellum-oauth-integrations` workflow to register the OAuth app, connect, and verify.

Send the returned auth URL to the user. Tell them to sign in, **pick the company** to connect, and click **Connect** on the Intuit consent page.

After authorization:

> **QuickBooks is connected!** You can now ask me to look up customers, invoices, bills, and reports for that company.
