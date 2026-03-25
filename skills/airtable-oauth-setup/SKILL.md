---
name: airtable-oauth-setup
description: Set up Airtable OAuth credentials using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Airtable OAuth Setup"
    feature-flag: "integration-airtable"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Airtable OAuth credentials so the Airtable integration can connect to their bases.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Airtable-specific steps.

## Provider Details

- **Provider key:** `integration:airtable`
- **Dashboard:** `https://airtable.com/create/oauth`
- **Ping URL:** `https://api.airtable.com/v0/meta/whoami`
- **Callback transport:** Loopback (port 17329)
- **Token endpoint auth method:** secret via POST body
- **Requires secret:** Yes (token endpoint needs both client ID and app secret)

## Airtable-Specific Flow

The flow has 8 steps total, takes about 3-5 minutes.

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

**Milestone (2 of 8):** "Integration registered - now let's configure the redirect URL."

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

**Milestone (4 of 8):** "Scopes configured - now let's grab the credentials."

---

### Step 5: Get Client ID and OAuth Secret

> Now let's grab the credentials. You should see the **Client ID** on this page.

> Also look for the **OAuth secret** - you may need to click a button to reveal or generate it.

**Milestone (5 of 8):** "Almost there - just need to save these credentials."

---

### Step 6: Store Credentials

Collect Client ID conversationally:

> Copy the **Client ID** and paste it here in the chat.

Collect the OAuth secret via secure prompt:

```
credential_store prompt:
  service: "integration:airtable"
  field: "oauth_secret"
  label: "Airtable OAuth Secret"
  description: "Copy the OAuth secret from the integration page (you may need to click Show or Generate first) and paste it here."
  placeholder: "..."
```

Register the OAuth app:

```
bash:
  command: |
    assistant oauth apps upsert --provider integration:airtable --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ) --client-secret-credential-path "integration:airtable:oauth_secret"
```

**Milestone (6 of 8):** "Credentials saved - just the authorization step left."

---

### Step 7: Authorize

> I'll start the Airtable authorization flow now. You should see a consent page asking you to allow **Vellum Assistant** to access your Airtable data.
>
> Review the permissions and click **Grant access**.

```
bash:
  command: |
    assistant oauth connect integration:airtable --client-id $(cat <<'EOF'
    <client-id>
    EOF
    )
```

---

### Step 8: Verify Connection

Use the ping URL to verify the connection:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant oauth connections token integration:airtable --client-id $(cat <<'EOF'
    <client-id>
    EOF
    ))" "https://api.airtable.com/v0/meta/whoami" | python3 -m json.tool
```

**On success:** "Airtable is connected! You can now ask me to read and update records in your Airtable bases."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Airtable-specific differences for Path B:

- Loopback callback won't work from a remote channel - need public ingress configured
- Add the ingress-based redirect URI under the OAuth redirect URL field on the integration page
- Airtable OAuth secrets don't have a known prefix that triggers scanners, but still use `credential_store prompt` or `credential_store store` for security
