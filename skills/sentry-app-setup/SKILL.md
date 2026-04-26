---
name: sentry-app-setup
description: Create and configure a Sentry internal integration so the assistant can manage issues, alerts, and releases under its own identity
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔺"
  vellum:
    display-name: "Sentry App Setup"
    user-invocable: true
---

## Overview

Set up a **Sentry internal integration** so the assistant can interact with a Sentry organization — querying issues, resolving events, managing releases, and monitoring alerts as its own entity.

Internal integrations are scoped to a single organization. They don't require an OAuth flow — you get an auth token immediately after creation. Tokens don't expire automatically (but can be revoked manually).

**Total manual effort: ~2 interactions** — create the integration and grab the auth token.

## Prerequisites

- User must be an **organization owner or manager** in Sentry
- User must be logged into Sentry in their browser

## Setup Flow

### Step 0: Check Existing Configuration

Before starting, check whether Sentry is already configured by running the check script:

```bash
bun skills/sentry-app-setup/scripts/check-config.ts
```

The script outputs JSON: `{ "configured": boolean, "details": string }`.

- If `configured` is `true` — Sentry is already set up. Offer to verify the connection or reconfigure.
- If `configured` is `false` — continue to Step 1.

### Step 1: Create the Internal Integration

Direct the user to create a new internal integration:

> Open **https://sentry.io/settings/developer-settings/new-internal/** to create a new internal integration.

Guide them through the form:

| Field           | Value                                                                |
| --------------- | -------------------------------------------------------------------- |
| **Name**        | The assistant's name. This is how the integration appears in Sentry. |
| **Webhook URL** | Leave blank (not needed for API-only usage)                          |

**Permissions** — set these based on what the assistant needs. A good default for full issue and project management:

| Resource          | Access Level |
| ----------------- | ------------ |
| **Issue & Event** | Read & Write |
| **Project**       | Read & Write |
| **Release**       | Admin        |
| **Organization**  | Read         |
| **Team**          | Read         |
| **Member**        | Read         |

Adjust permissions up or down based on the user's needs. The principle of least privilege applies — only request what you'll actually use.

> Click **Save Changes** when done. The integration is automatically installed on the organization.

### Step 2: Collect the Auth Token

After saving, Sentry displays the integration's details page. An auth token is automatically generated.

Tell the user: on the integration details page, find the **Tokens** section and copy the auth token.

Then run the store script to securely collect and store the token:

```bash
bun skills/sentry-app-setup/scripts/store-token.ts
```

The script opens a secure credential prompt in the user's app, stores the token in the encrypted vault with the correct injection templates, and exits. No further action needed — if it exits 0, the token is stored.

### Step 3: Collect the Organization Slug

The org slug is needed for API calls. Ask the user for it — it's visible in their Sentry URL as `sentry.io/organizations/{slug}/`.

Remember the org slug for future API calls.

### Step 4: Verify

After storing the token, verify the connection:

```bash
curl -s https://sentry.io/api/0/organizations/{org_slug}/ \
  -H "Content-Type: application/json"
```

Run with `network_mode: "proxied"` and the sentry credential. A successful response returns the organization's details.

If the response returns a 401, the token is invalid or revoked. If 403, the integration doesn't have `org:read` permission.

### Step 5: Set the Integration Logo (Optional)

Sentry supports uploading a logo for internal integrations through the web UI (not via API).

Direct the user:

> Go to **Settings > Developer Settings**, find your integration, and upload a logo. Requirements: PNG, 256×256 to 1024×1024, transparent background (unless the logo fills the entire space).

### Step 6: Report Success

Summarize with the completed checklist:

"Setup complete!
✅ Internal integration created
✅ Auth token configured
✅ Connection verified
{logo_line}

Connected: {integration_name} in {org_slug}
Permissions: {list the configured permission levels}
Token: does not expire (can be revoked in Settings > Developer Settings)"

For `{logo_line}`:

- If logo was uploaded: `✅ Logo uploaded`
- If skipped: `⬜ Logo — upload anytime in Settings > Developer Settings`
