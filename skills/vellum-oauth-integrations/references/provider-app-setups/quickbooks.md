You are helping your user set up QuickBooks OAuth credentials so the QuickBooks integration can access their QuickBooks Online company.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the QuickBooks-specific steps.

## Provider Details

- **Provider key:** `quickbooks`
- **Dashboard:** `https://developer.intuit.com/app/developer/dashboard`
- **Ping URL:** none (every probe needs the company id in its path)
- **Callback transport:** Loopback (port 17342)
- **Requires secret:** Yes (token endpoint authenticates with HTTP Basic client credentials)
- **Managed mode:** Supported

## Check Managed Mode First

QuickBooks supports managed mode, so registering an app is optional:

```bash
assistant oauth mode quickbooks --json | jq -r '.mode'
```

- If the result is `managed`, **stop reading this file** and follow [CONNECTING_ACCOUNTS.md](../CONNECTING_ACCOUNTS.md) instead.
- If the result is `your-own` and the user already has an active QuickBooks connection (`assistant oauth status quickbooks`), respect it and do not switch modes.
- Otherwise offer the managed flow before walking through app registration. It is a single Intuit login, against the steps below.

Only continue here once the user has chosen `your-own`.

## How QuickBooks Requests Work

QuickBooks scopes every Accounting API call to one **company** (Intuit calls it
a realm). The user picks the company on Intuit's consent screen, and the API
path carries its id: `/v3/company/<realmId>/...`.

- **Managed connections** remember the company. `assistant oauth status quickbooks --json`
  lists it under each connection as `providerParams.realm_id`, and the
  account label is the company name. Requests are sent **relative to the company**, because the platform
  fills `https://quickbooks.api.intuit.com/v3/company/<realmId>` in for you:

  ```bash
  assistant oauth request --provider quickbooks "/query?query=select%20*%20from%20Customer"
  ```

  Endpoints that repeat the id in the path take it from `providerParams.realm_id`:

  ```bash
  assistant oauth request --provider quickbooks "/companyinfo/${REALM_ID}"
  ```

- **Your-own-app connections** do not capture the company id, so send the
  absolute URL with the id in it. Find it in QuickBooks Online under
  **Settings > Account and settings > Billing & subscription** (Company ID),
  or in the address bar after signing in:

  ```bash
  assistant oauth request --provider quickbooks \
    "https://quickbooks.api.intuit.com/v3/company/${REALM_ID}/query?query=select%20*%20from%20Customer"
  ```

- Add `-H "Accept: application/json"`; the Accounting API answers in XML
  otherwise (managed connections send it by default).
- Intuit **development keys** only authorize sandbox companies, whose API lives
  on `sandbox-quickbooks.api.intuit.com`. **Production keys** use
  `quickbooks.api.intuit.com`. Both hosts accept the credential; use the one
  that matches the key set the app was registered with.

## QuickBooks-Specific Flow

The flow has 6 steps total, takes about 5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have an Intuit developer account and a QuickBooks Online company you want to connect? You'll need both: the developer account to create the app, and the company to authorize.

If the user doesn't have a developer account, point them to `https://developer.intuit.com/app/developer/qbo/docs/get-started` and wait for them to sign up.

---

### Step 1: Open the Intuit Developer Dashboard

Open: `https://developer.intuit.com/app/developer/dashboard`

> I've opened the Intuit developer dashboard. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Create an App

> Click **Create an app**, choose **QuickBooks Online and Payments**, and give it a name such as **Vellum Assistant**. When asked which scopes the app needs, pick **Accounting** (`com.intuit.quickbooks.accounting`). Then click **Create app**.

**Milestone (2 of 6):** "App created - now let's pick the keys and set the redirect URI."

---

### Step 3: Choose Production Keys and Set the Redirect URI

Intuit gives every app two key pairs. **Development** keys only authorize
sandbox companies; **Production** keys authorize real companies but Intuit
asks a short compliance questionnaire before it reveals them.

> In the left sidebar, open **Keys & credentials** and pick **Production** (use **Development** only if you want to connect a sandbox company). Complete the questionnaire if Intuit asks for one.
>
> Under **Redirect URIs**, add:
>
> `http://localhost:17342/oauth/callback`
>
> Then click **Save**.

**Milestone (3 of 6):** "Redirect URI is set - now let's grab the credentials."

---

### Step 4: Get the Client ID and Client Secret

> On the same **Keys & credentials** page you should see the **Client ID** and **Client Secret** for the key set you chose. These are the credentials we need.

**Milestone (4 of 6):** "Almost there - just need to save these credentials."

---

### Step 5: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, connect, and verify.

> I'll start the QuickBooks authorization flow now. Intuit will ask you to sign in, then to **pick the company** to connect and to allow **Vellum Assistant** to access it.
>
> Choose the company and click **Connect**.

**On success:** "QuickBooks is connected! You can now ask me to look up customers, invoices, bills, and reports for that company."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [quickbooks-path-b.md](quickbooks-path-b.md).

Key QuickBooks-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under **Redirect URIs** on the **Keys & credentials** page
- The client secret doesn't have a known prefix that triggers scanners, but still use `assistant credentials prompt` for security (never inline `assistant credentials set`)
