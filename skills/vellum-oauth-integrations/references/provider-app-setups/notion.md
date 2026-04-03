You are helping your user set up Notion credentials so the Notion integration can connect to their workspace.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Notion-specific steps.

## Provider Details

- **Provider key:** `notion`
- **Default credential type:** Internal integration (API token)
- **No OAuth flow required** for the default path - just copy the integration secret and grant page access

## Prerequisites

No OAuth, redirect URIs, or public ingress needed for Internal integrations. The user just needs a Notion account and workspace.

## Choosing the Flow

- **Internal integration (default):** Single-workspace, simple setup. Follow the steps below.
- **Public integration (OAuth):** Multi-workspace distribution. Only guide to this path if the user explicitly needs OAuth for multi-workspace access. See [notion-path-b-public.md](notion-path-b-public.md) for that flow.

## Internal Integration Flow

The flow has 4 steps total, takes about 1-2 minutes.

### Step 0: Prerequisite Check

> Before we start - do you have a Notion account and workspace you'd like to connect?

If no Notion account, guide them to create one at `https://www.notion.so/signup` or defer.

---

### Step 1: Open Notion Integrations

Open: `https://www.notion.so/profile/integrations`

This is the first navigation - wait a few seconds for the page to load, then take a screenshot to see the actual layout. Use what you see to give the user specific guidance. If the page is asking them to sign in, tell them to do that first.

---

### Step 2: Create a New Integration

> Look for the **"New integration"** button (or a **"+"** button) and click it.
>
> On the creation form:
>
> 1. Set the name to **Vellum Assistant**
> 2. Select your workspace from the **Associated workspace** dropdown
> 3. Click **Create**

There is no Type selector on the creation form - integrations are created as **Internal by default**, which is what we want.

**Known issues:**

- If they already have an integration named "Vellum Assistant", ask if they'd like to reuse it - skip ahead to Step 3
- **Missing admin permissions:** Only workspace **admins** can create integrations. If the user can't find the "New integration" button, sees a disabled/grayed-out option, gets a permissions error, or tells you they aren't an admin — see [notion-non-admin.md](notion-non-admin.md).

**Milestone (2 of 4):** "Integration created - now let's grab the secret and grant page access."

---

### Step 3: Copy Internal Integration Secret and Grant Page Access

After creation, the user lands on the integration's Configuration page.

#### 3a: Copy the secret

> You should now see the **Configuration** tab with an **"Internal integration secret"** field. Click **Show** to reveal it, then **Copy** to copy the secret.

Collect the secret securely:

```
credential_store prompt:
  service: "notion"
  field: "internal_secret"
  label: "Notion Internal Integration Secret"
  description: "Paste the Internal Integration Secret you just copied."
  placeholder: "ntn_..."
```

#### 3b: Grant page access

> Now you need to grant the integration access to the Notion pages you want to use.
>
> 1. Go to any Notion page you want to connect
> 2. Click the **"..."** menu (top-right) or the **Share** button
> 3. Click **"Add connections"** (or **"Connect to"**)
> 4. Search for **Vellum Assistant** and select it
> 5. Repeat for any other pages or databases you want accessible
>
> You can always add more pages later by repeating this step.

**Milestone (3 of 4):** "Secret stored and pages connected - let's verify."

---

### Step 4: Verify Connection

Verify the connection works by calling the Notion API with the stored secret:

```
bash:
  command: |
    curl -s -H "Authorization: Bearer $(assistant credentials reveal --service notion --field internal_secret)" \
      -H "Notion-Version: 2022-06-28" \
      "https://api.notion.com/v1/users/me"
```

**On success:** "Notion is connected! You can now ask me to read and write pages and databases in your Notion workspace."

**On failure (401):** The secret may have been copied incorrectly. Offer to redo Step 3a.

**On failure (other):** Check the error message and guide accordingly.

---

## Path B: Manual Channel Setup

For non-interactive channels, see [notion-path-b.md](notion-path-b.md).

Key Notion-specific differences for Path B:

- No OAuth flow or redirect URIs needed for Internal integrations
- The user copies their Internal Integration Secret and sends it via chat
- The secret prefix is `ntn_` - use `credential_store prompt` to collect it securely
