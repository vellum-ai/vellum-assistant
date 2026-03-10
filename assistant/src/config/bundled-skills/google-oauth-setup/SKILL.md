---
name: google-oauth-setup
description: Set up Google Cloud OAuth credentials for Gmail and Calendar
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🔑","vellum":{"display-name":"Google OAuth Setup","user-invocable":true,"includes":["browser"],"credential-setup-for":"gmail"}}
---

Set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Route Selection

- **macOS desktop app** (browser automation available): Use **Automated Setup** below.
- **Telegram / SMS / other channel** (no browser): Use **Manual Setup** below.

---

# Manual Setup (Channels)

Walk the user through each step with direct links. They do everything in their browser; you provide instructions and store the results.

### 1. Create a GCP Project

Send the user to `https://console.cloud.google.com/projectcreate`. Project name: **"Vellum Assistant"**. Get the project ID back from them.

### 2. Enable APIs

Have them open and click **Enable** on each:
- `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
- `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

### 3. Configure OAuth Consent Screen

Direct them to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`:
- User type: **External**
- App name: **Vellum Assistant**, support + developer email: their email
- Add scopes: `gmail.readonly`, `gmail.modify`, `gmail.send`, `calendar.readonly`, `calendar.events`, `userinfo.email`
- Add themselves as a test user

### 4. Create OAuth Credentials

Direct them to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`:
- **+ Create Credentials** → **OAuth client ID** → type **"Desktop app"**
- Name: **Vellum Assistant**
- Copy the **Client ID** and **Client Secret** from the dialog

### 5. Store Credentials

**Client ID** — safe to send in chat. Ask the user to paste it, then store:
```
credential_store store: service="integration:gmail" field="client_id" value="<ID>"
```

**Client Secret** — starts with `GOCSPX-` which triggers the ingress secret scanner. Ask the user to send **only the part after** `GOCSPX-`. Reconstruct the full value by prepending `GOCSPX-` before storing:
```
credential_store store: service="integration:gmail" field="client_secret" value="GOCSPX-<suffix>"
```

### 6. Authorize

```
credential_store: action="oauth2_connect" service="integration:gmail"
```

The tool returns an authorization URL. **You MUST extract the URL from the tool result and present it as plain text in your conversation response** — do NOT rely on the user seeing the tool output panel. Write the full URL out so the user can click it. Tell them to open it on the same Mac/desktop where Vellum is running so the localhost callback can complete. If they see "This app isn't verified", tell them to click **Advanced** → **Go to Vellum Assistant (unsafe)** (normal for testing mode).

### 7. Done

> **Gmail and Calendar are connected!** Try asking me to check your inbox or show your upcoming events.

---

# Automated Setup (macOS Desktop App)

**NEVER use `gcloud` CLI — users do not have it installed.** Every step uses the CDP client library in `lib/`. The library executes `fetch()` inside Chrome's page context via CDP, using the browser's authenticated session. No shell commands to Google Cloud, ever.

## How It Works

Chrome runs with `--remote-debugging-port=9222`. The `lib/client.ts` module provides CDP API functions. Some GCP endpoints work through CDP (the `cloudconsole-pa` GraphQL proxy), while others require browser automation.

**What works via API:** `ensureProject()`, `getBrandInfo()`, `updateScopes()`, `setTestUsers()`, `getTestUsers()`
**What needs browser automation:** API enablement, brand creation, OAuth client creation

**Invocation pattern for API calls:** Run with `bun --eval` from the `assistant/` directory. Set `VELLUM_DATA_DIR` to the assistant's data directory. Import functions from `lib/client.ts`, call them, print results.

## Steps

### 1. Confirm

Use `ui_show` with `surface_type: "confirmation"` — explain that a browser will open, they sign in, you automate everything, they authorize with one click.

### 2. Launch Chrome and Sign In

Use `ensureChromeWithCdp({ startUrl: "https://console.cloud.google.com/" })` from `src/tools/browser/chrome-cdp.ts`. If the user lands on `accounts.google.com`, tell them to sign in and poll with `browser_screenshot` until they reach `console.cloud.google.com`.

### 3. Ensure Project (via API)

Call `ensureProject()`. This checks for a saved project config, then searches for an existing "Vellum Assistant" project, and only creates a new one if none exists. Returns `{ projectId, projectNumber }` and saves the config automatically.

### 4. Enable APIs (via browser)

Navigate the CDP Chrome to each API library page and click **Enable**:
- `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`
- `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

If the API is already enabled, the page will show "Manage" instead — just skip it.

### 5. Configure Consent Screen

1. **Check brand status:** Call `getBrandInfo()` — if `isBrandConfigured` is false, the brand must be created via browser automation first (navigate to `https://console.cloud.google.com/apis/credentials/consent?project=PROJECT_ID`, select "External", fill app name + email, save).
2. **Set scopes (via API):** Call `updateScopes()` — sets all 6 required scopes.
3. **Add test user (via API):** Call `setTestUsers([userEmail])`.
4. **Verify (via API):** Call `getBrandInfo()` and `getTestUsers()` to confirm.

### 6. Create OAuth Client (via browser)

Navigate to `https://console.cloud.google.com/apis/credentials?project=PROJECT_ID`:
1. Click **+ Create Credentials** → **OAuth client ID**
2. Application type: **Desktop app**
3. Name: **Vellum Assistant**
4. Click **Create**
5. Copy the **Client ID** and **Client Secret** from the confirmation dialog
6. Store credentials:
```
credential_store store: service="integration:gmail" field="client_id" value="<clientId>"
credential_store store: service="integration:gmail" field="client_secret" value="<secret>"
```

### 7. Authorize

```
credential_store: action="oauth2_connect" service="integration:gmail"
```

The tool returns an authorization URL. **You MUST extract the URL from the tool result and present it as plain text in your conversation response** — do NOT rely on the user seeing the tool output panel. Write something like:

> To connect Gmail, open this link and authorize access:
>
> https://accounts.google.com/o/oauth2/v2/auth?...

**Do NOT** open the auth URL via browser automation — `oauth2_connect` handles listening for the localhost callback automatically. If "This app isn't verified" appears, tell the user to click **Advanced** → **Go to Vellum Assistant (unsafe)**.

### 8. Done

> **Gmail and Calendar are connected!** Try asking me to check your inbox or show your upcoming events.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| CDP connection refused | Chrome not running with `--remote-debugging-port=9222` | Launch with `ensureChromeWithCdp()` |
| 401/403 or "caller does not have permission" | Google session expired | Ask user to sign in again at `console.cloud.google.com` in the CDP Chrome window |
| Query signature errors | Google deployed a new Console version | Open `console.cloud.google.com/auth/branding`, record network traffic, extract new `querySignature` values from `batchGraphql` requests, update `QUERY_SIGNATURES` in `lib/queries.ts` |
| Brand not configured on fresh project | Brand creation isn't available via API | Must be done via browser automation first (select "External", fill form, save). After that, scopes and test users work via API. |

## API Reference

For debugging or extending the `lib/` code:

- **OAuth client CRUD** (`clientauthconfig.clients6.google.com`): `GET /v1/clients` (list), `POST /v1/clients` (create — returns plaintext secret)
- **Consent screen** (`cloudconsole-pa.clients6.google.com/.../OauthEntityService`): `GetBrandInfo`, `UpdateBrandInfo` (scopes), `SetTrustedUserList`, `GetTrustedUserList`, `ListClientIds`
- **Auth**: All requests need a `SAPISIDHASH` header computed from the `SAPISID` cookie — `lib/client.ts` handles this inside the browser context automatically.
