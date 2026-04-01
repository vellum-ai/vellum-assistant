You are helping your user set up Airtable OAuth credentials so the Airtable integration can connect to their bases.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Airtable-specific steps.

## Provider Details

- **Provider key:** `airtable`
- **Dashboard:** `https://airtable.com/create/oauth`
- **Ping URL:** `https://api.airtable.com/v0/meta/whoami`
- **Callback transport:** Loopback (port 17329)
- **Token endpoint auth method:** secret via POST body
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## Airtable-Specific Flow

The flow has 7 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have an Airtable account? You'll need one to create an OAuth integration.

If no account, direct them to `https://airtable.com/signup` to create one first.

---

### Step 1: Open Airtable OAuth Page

Open: `https://airtable.com/create/oauth`

> I've opened the Airtable OAuth page. If it's asking you to sign in, go ahead and do that first - then let me know.

---

### Step 2: Register a New OAuth Integration

> Look for the **Register new OAuth integration** button and click it.

Then:

> Set the name to **Vellum Assistant**. Then click **Register integration**.

**Known issues:**

- If you don't see the registration option, make sure you're on a plan that supports OAuth integrations (most plans do)

**Milestone (2 of 7):** "Integration registered - now let's configure the redirect URL."

---

### Step 3: Set Up Redirect URL

> Find the **OAuth redirect URL** field, paste this URL, and save:
>
> `http://localhost:17329/oauth/callback`

---

### Step 4: Add Scopes

> Now let's add the permissions this integration needs. Look for the **Scopes** section.
>
> You'll need to add each of these scopes:
>
> - `data.records:read` - read records from bases
> - `data.records:write` - create and update records
> - `schema.bases:read` - view base structure and field info
>
> Select each scope from the list and make sure all three are added.

Wait for the user to confirm all 3 scopes are added.

**Milestone (4 of 7):** "Scopes configured - now let's grab the credentials."

---

### Step 5: Get Client ID and OAuth Secret

> Now let's grab the credentials. You should see the **Client ID** on this page.

> Also look for the **OAuth secret** - you may need to click a button to reveal or generate it.

**Milestone (5 of 7):** "Almost there - just need to save these credentials."

---

### Step 6: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, connect, and verify.

> I'll start the Airtable authorization flow now. You should see a consent page asking you to allow **Vellum Assistant** to access your Airtable data.
>
> Review the permissions and click **Grant access**.

**On success:** "Airtable is connected! You can now ask me to read and update records in your Airtable bases."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [airtable-path-b.md](airtable-path-b.md).

Key Airtable-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under the OAuth redirect URL field on the integration page
- Airtable OAuth secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
