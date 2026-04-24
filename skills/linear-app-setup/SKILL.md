---
name: linear-app-setup
description: Create and configure a Linear agent app so the assistant can manage issues, projects, and workflows under its own identity
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔷"
  vellum:
    display-name: "Linear App Setup"
    user-invocable: true
---

## Overview

Set up a **Linear agent app** so the assistant operates under its own identity in a Linear workspace — creating issues, commenting, updating status, etc. as itself.

Linear agent apps act as their own entity in the workspace. They're free (don't count as billable users), can be @mentioned, and can be delegated issues.

**Total manual effort: ~3 interactions** — create the app, grab the API key, (optionally) upload an avatar.

## Prerequisites

- User must be a **workspace admin** in Linear
- User must be logged into Linear in their browser

## Setup Flow

### Step 1: Create the Application

Direct the user to create a new application:

> Open **https://linear.app/settings/api/applications/new** to create a new application.

Guide them through the form:

| Field                | Value                                                                        |
| -------------------- | ---------------------------------------------------------------------------- |
| **Application name** | The assistant's name. This is how the agent appears in mentions and filters. |
| **Developer name**   | The user's name or org name                                                  |
| **Developer URL**    | Any valid URL                                                                |

> Click **Create** when done.

### Step 2: Generate an API Key for the App

After creating the app, the user should generate a **personal API key** scoped to this app identity. This is how the assistant authenticates — simpler and more reliable than the full OAuth token refresh flow.

Direct the user:

> On the app's settings page, look for the option to create an API key for this application. Copy the key.

Prompt for the API key via secure UI:

```
credential_store:
  action: "prompt"
  service: linear
  field: api_key
  label: "Linear App API Key"
  placeholder: "lin_api_xxxxxxxxxx"
  description: "API key for your Linear app (used to authenticate API requests)"
  allowed_domains: ["api.linear.app"]
  injection_templates:
    - hostPattern: "api.linear.app"
      injectionType: header
      headerName: Authorization
      valuePrefix: "Bearer "
```

### Step 3: Verify

After storing the key, verify the connection:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}'
```

Run with `network_mode: "proxied"` and the linear credential. A successful response returns the app's identity:

```json
{
  "data": {
    "viewer": {
      "id": "...",
      "name": "MyAssistant",
      "email": "...@oauthapp.linear.app"
    }
  }
}
```

The `@oauthapp.linear.app` email confirms it's an app actor, not a user.

### Step 4: Set the App Avatar (Optional)

Linear doesn't support setting the avatar via API — it must be uploaded through the web UI.

If the assistant has an avatar, send it to the user:

```
<vellum-attachment source="sandbox" path="data/avatar/avatar-image.png" />
```

Then direct them to the app settings page:

> Go to **https://linear.app/settings/api**, find your app, and upload the avatar image under the app icon.

## App Identity

The app appears as a distinct entity in Linear:

- Issues it creates show the app as creator
- Comments it posts show the app's name and avatar
- It appears in mention menus if `app:mentionable` scope is enabled
- Issues can be delegated to it if `app:assignable` scope is enabled — delegation sets the app as `delegate`, not `assignee`, so humans keep ownership

### Acting on Behalf of a User

When the agent performs an action that originated from a specific user in a third-party system, use `createAsUser` and `displayIconUrl` to attribute it:

```graphql
mutation {
  issueCreate(
    input: {
      title: "Bug report"
      teamId: "TEAM_UUID"
      createAsUser: "Jane"
      displayIconUrl: "https://example.com/jane-avatar.png"
    }
  ) {
    success
    issue {
      identifier
      url
    }
  }
}
```

This renders as "Jane (via AppName)" in Linear.

## Team Access

After installation, workspace admins can modify the app's team access at any time through the app's details page in Linear settings.

## Important Notes

- The app's name and icon are how it appears everywhere in Linear — pick something short, recognizable, and unique.
- Agent apps are free — they don't count toward the workspace's billable user seats.
- The app gets a unique user ID per workspace.
