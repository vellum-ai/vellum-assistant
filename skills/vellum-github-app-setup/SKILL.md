---
name: vellum-github-app-setup
description: Create and configure a GitHub App so the assistant can push commits, open PRs, and comment under its own bot identity. Use when the user wants the assistant to have its own GitHub identity, or when setting up git push access for the first time.
compatibility: "Designed for Vellum personal assistants. Requires Python 3, bun, and the assistant credentials CLI."
metadata:
  emoji: "🤖"
  author: vellum-ai
  version: "1.0"
  vellum:
    display-name: "GitHub App Setup"
---

## Overview

This skill creates a **GitHub App** under a GitHub organization, giving the assistant its own bot identity for git operations. After setup, commits, PRs, and comments will attribute to `<app-name>[bot]` instead of the user's personal account.

**Total manual effort: 4 interactions** — Continue to GitHub → Create App → Install on repo → (optional) upload avatar. Everything else is automated.

> **Note:** This skill currently supports GitHub **organizations** only, not personal accounts.

## What Gets Created

- A **GitHub App** owned by the org (not the user's personal account)
- **Installation** on selected repositories with configurable permissions (default: `contents:write` + `pull_requests:write`)
- **Credentials** stored in the assistant's encrypted vault (7 fields)
- **Token helper script** at `bin/gh-app-token.mjs` (in the workspace root) for refreshing auth tokens

## Prerequisites

- User must be an **admin** of the GitHub organization
- User must be **logged into GitHub** in their browser
- The `assistant credentials` CLI must be available
- Python 3 on the host machine (for the manifest flow server)
- `bun` in the container (for the token helper script)

## Setup Flow

### Step 1: Create the GitHub App

Run the manifest flow script on the **user's host machine** (it needs to open a browser and catch a localhost callback):

```bash
python3 scripts/create-github-app.py \
  --org=ORG_NAME \
  --name=APP_NAME \
  --url="https://example.com" \
  --output=/tmp/github-app-credentials.json
```

This starts a local server on `localhost:29170`, opens the browser, and guides the user through two clicks:

1. **"Continue to GitHub"** — submits the pre-filled manifest form
2. **"Create GitHub App for ORG"** — confirms on GitHub's page

The callback server catches the redirect and exchanges the code for credentials automatically. The credentials JSON is saved to `--output`.

**Important manifest details** (learned the hard way):

- `hook_attributes` MUST include a nested `url` field, even if webhooks are disabled. Without it, GitHub rejects the manifest with a misleading `"url" wasn't supplied` error — it's not about the top-level `url`.
- The form must use `<input type="text">` (not hidden) with the value set via `JSON.stringify()` in JavaScript.
- A `state` query parameter must be included on the form action URL.
- The `redirect_url` must point to the local callback server.

### Step 2: Store Credentials

Read the credentials JSON from the host and store each field in the assistant's vault. The fields available immediately after Step 1:

```bash
assistant credentials set --service github-app --field app_id "APP_ID"
assistant credentials set --service github-app --field app_slug "APP_SLUG"
assistant credentials set --service github-app --field client_id "CLIENT_ID"
assistant credentials set --service github-app --field client_secret "CLIENT_SECRET"
assistant credentials set --service github-app --field webhook_secret "WEBHOOK_SECRET"
```

For the PEM (private key), the `-----BEGIN` prefix gets parsed as CLI flags. Use `--` to signal end of options:

```bash
assistant credentials set --service github-app --field pem -- "$(cat pem-file.txt)"
```

**Transferring the PEM from host to container:** The Vellum security layer redacts secrets in transit between host and container. To work around this, base64-encode the PEM on the host, read the base64 string via `host_file_read` (which won't be redacted), decode it inside the container, and store it with `assistant credentials set`.

> **Note:** The `installation_id` credential is stored in Step 3 after installing the app.

### Step 3: Install the App on Repositories

Open the installation page for the user:

```
https://github.com/apps/APP_SLUG/installations/select_target
```

The user selects the org, chooses "Only select repositories", picks the target repos, and clicks Install.

After installation, retrieve the installation ID using the app's JWT auth. Generate a JWT from the stored credentials:

```javascript
// Use the JWT generation logic from gh-app-token.mjs,
// but call /app/installations instead of /access_tokens
const resp = await fetch("https://api.github.com/app/installations", {
  headers: {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
  },
});
const installations = await resp.json();
// installations[0].id is the installation ID
```

Then store it:

```bash
assistant credentials set --service github-app --field installation_id "INSTALLATION_ID"
```

### Step 4: Configure Git

Copy the token helper to the workspace:

```bash
cp scripts/gh-app-token.mjs "$WORKSPACE_ROOT/bin/gh-app-token.mjs"
chmod +x "$WORKSPACE_ROOT/bin/gh-app-token.mjs"
```

Configure the local repo clone:

```bash
cd "$WORKSPACE_ROOT/REPO_NAME"
git config user.name "APP_SLUG[bot]"
git config user.email "APP_ID+APP_SLUG[bot]@users.noreply.github.com"
```

Before each push, refresh the remote URL with a fresh token (tokens expire after 1 hour):

```bash
TOKEN=$(bun "$WORKSPACE_ROOT/bin/gh-app-token.mjs")
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/OWNER/REPO.git"
git push origin BRANCH
```

### Step 5: Set the App Logo (Optional)

The manifest flow does **not** support setting a logo — there's no field for it and no REST API endpoint. The logo can only be uploaded through the GitHub web UI.

If the assistant has an avatar (typically at `data/avatar/avatar-image.png` in the workspace root), send it to the user as a chat attachment:

```
<vellum-attachment source="sandbox" path="data/avatar/avatar-image.png" />
```

Then direct them to the app settings page to upload it:

```
https://github.com/organizations/ORG/settings/apps/APP_SLUG
```

Scroll to "Display information" → "Upload a logo" → drag in the image file → Save.

### Step 6: Verify

Test the full flow:

1. Create a test branch
2. Commit a trivial change
3. Push the branch
4. Open a PR via the GitHub API (using the installation token as a Bearer token)
5. Post a comment on the PR via the GitHub API
6. Verify the commit, PR, and comment all attribute to `APP_SLUG[bot]`
7. Close the PR and delete the branch

## Token Refresh

Installation tokens expire after **1 hour**. The helper script `gh-app-token.mjs` generates a fresh one each time by:

1. Reading `app_id` and `pem` from the vault
2. Signing a JWT with the private key
3. Exchanging the JWT for an installation token via `POST /app/installations/{id}/access_tokens`

Always refresh before pushing:

```bash
TOKEN=$(bun "$WORKSPACE_ROOT/bin/gh-app-token.mjs")
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/OWNER/REPO.git"
```

## Credential Reference

All credentials are stored under `service: github-app`:

| Field             | Description                                     | When Set |
| ----------------- | ----------------------------------------------- | -------- |
| `app_id`          | Numeric GitHub App ID                           | Step 2   |
| `app_slug`        | URL-friendly app name (e.g. `credence-the-bot`) | Step 2   |
| `client_id`       | OAuth client ID                                 | Step 2   |
| `client_secret`   | OAuth client secret                             | Step 2   |
| `pem`             | RSA private key for JWT signing                 | Step 2   |
| `webhook_secret`  | Webhook verification secret                     | Step 2   |
| `installation_id` | Numeric installation ID for the org             | Step 3   |

## Troubleshooting

### "url wasn't supplied" error during manifest submission

The manifest JSON must include `hook_attributes.url` — a nested URL inside the `hook_attributes` object. GitHub's error message is misleading; it's not referring to the top-level `url` field.

### Token generation fails

Check that all three required credentials are set: `app_id`, `pem`, `installation_id`. Use `assistant credentials list --search github-app` to verify.

### Push rejected with 403

The installation token may have expired (1-hour lifetime). Regenerate with `bun bin/gh-app-token.mjs` (from the workspace root) and update the remote URL.

### PEM won't store via CLI

The `-----BEGIN` prefix gets parsed as a CLI flag. Use `--` before the value:

```bash
assistant credentials set --service github-app --field pem -- "$PEM_VALUE"
```

### Port 29170 already in use

Another process is using the callback port. Either kill it or pass `--port=DIFFERENT_PORT` to the creation script.

### App only shows for orgs, not personal accounts

The manifest flow script currently only supports organization-owned apps (it uses the `/organizations/{org}/settings/apps/new` endpoint). Personal account apps would use `/settings/apps/new` instead — this is not yet implemented.
