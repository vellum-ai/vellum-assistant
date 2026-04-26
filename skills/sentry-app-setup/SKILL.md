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

**Total manual effort: ~3 interactions** — create the integration, grab the auth token, (optionally) upload a logo.

## Prerequisites

- User must be an **organization owner or manager** in Sentry
- User must be logged into Sentry in their browser

## Setup Flow

### Step 0: Check Existing Configuration

Before starting, check whether Sentry is already configured:

- Call `credential_store` with `action: "list"`.

Scan the result for entries matching `service: "sentry"` with `field: "auth_token"`.

- If `auth_token` is present — Sentry is already configured. Offer to show status, verify the connection, or reconfigure.
- If not present — continue to Step 1.

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

Then collect it securely:

```
credential_store:
  action: "prompt"
  service: sentry
  field: auth_token
  label: "Sentry Auth Token"
  placeholder: "sntrys_..."
  description: "Auth token from your Sentry internal integration (found on the integration's details page under Tokens)"
  allowed_domains: ["sentry.io"]
  injection_templates:
    - hostPattern: "sentry.io"
      injectionType: header
      headerName: Authorization
      valuePrefix: "Bearer "
```

### Step 3: Collect the Organization Slug

The org slug is needed for API calls. Ask the user for it conversationally (it's not secret — visible in their Sentry URL as `sentry.io/organizations/{slug}/`).

Store it using `remember` for future API calls.

### Step 4: Verify

After storing the token, verify the connection:

```bash
curl -s https://sentry.io/api/0/organizations/{org_slug}/ \
  -H "Content-Type: application/json"
```

Run with `network_mode: "proxied"` and the sentry credential. A successful response returns the organization's details:

```json
{
  "id": "...",
  "slug": "my-org",
  "name": "My Organization",
  ...
}
```

If the response returns a 401, the token is invalid or revoked. If 403, the integration doesn't have `org:read` permission.

### Step 5: Set the Integration Logo (Optional)

Sentry supports uploading a logo for internal integrations through the web UI (not via API).

If the assistant has an avatar, send it to the user:

```
<vellum-attachment source="sandbox" path="data/avatar/avatar-image.png" />
```

Then direct them:

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

## Useful API Endpoints

Once connected, here are common operations the assistant can perform:

| Operation         | Method | Endpoint                                                  |
| ----------------- | ------ | --------------------------------------------------------- |
| List projects     | GET    | `/api/0/organizations/{org}/projects/`                    |
| List issues       | GET    | `/api/0/projects/{org}/{project}/issues/`                 |
| Get issue details | GET    | `/api/0/issues/{issue_id}/`                               |
| Resolve an issue  | PUT    | `/api/0/issues/{issue_id}/` with `{"status": "resolved"}` |
| List issue events | GET    | `/api/0/issues/{issue_id}/events/`                        |
| List releases     | GET    | `/api/0/organizations/{org}/releases/`                    |
| Create a release  | POST   | `/api/0/organizations/{org}/releases/`                    |

All requests use `Authorization: Bearer {token}` and target `https://sentry.io`.

## Managing Tokens

Internal integrations can have up to 20 tokens. To generate additional tokens or revoke existing ones:

> Go to **Settings > Developer Settings > {Your Integration}** and manage tokens in the Tokens section.

## Troubleshooting

### 401 Unauthorized

The auth token may have been revoked. Go to **Settings > Developer Settings > {Your Integration}**, generate a new token, and re-enter it via the credential prompt.

### 403 Forbidden

The integration doesn't have the required permission scope for the endpoint. Go to **Settings > Developer Settings > {Your Integration}**, update the permissions, and click **Save Changes**. Note: expanding permissions may require re-confirmation.

### Rate limiting (429)

Sentry API has rate limits. Respect `Retry-After` headers. For bulk operations, add delays between requests.

### Can't find Developer Settings

Make sure the user is an organization **owner or manager**. Regular members don't have access to Developer Settings.

## Implementation Rules

- All credential collection goes through `credential_store` prompts. Do NOT ask the user to paste tokens in chat.
- The org slug is not secret and can be collected conversationally.
- Always verify the connection after storing credentials — don't assume the token works.
