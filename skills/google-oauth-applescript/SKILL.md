---
name: google-oauth-applescript
description: Set up Google Cloud OAuth credentials for Gmail and Calendar using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Google OAuth Setup"
    includes: ["collaborative-oauth-flow"]
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

This skill follows the **Collaborative Guided Flow** pattern from the included `collaborative-oauth-flow` skill. That reference covers the navigation helper setup, step rhythm, rules, tone, error handling, and guardrails. This file defines only the Google-specific steps.

## Provider Details

- **Provider key:** `integration:google`
- **Provider search keys:** `gmail`, `google`
- **Credential type (Path A):** Desktop app
- **Credential type (Path B):** Web application (callback through public gateway)

## Google-Specific Flow

The flow has 9 steps total, takes about 3–5 minutes.

### Step 0: Prerequisite Check

> Before we start — do you have a Google account you'd like to use for this?

If no Google account → guide them to create one or defer.

---

### Step 1: Open Google Cloud Console

Open: `https://console.cloud.google.com`

> I've opened the Google Cloud Console. If it's asking you to sign in, go ahead and do that first.

---

### Step 2: Select or Create a Project

Open: `https://console.cloud.google.com/cloud-resource-manager`

> I've opened your project list. If you see an existing project you'd like to use, let me know its name. Otherwise I'll walk you through creating a new one.

**New project:** Open `https://console.cloud.google.com/projectcreate` → name it `vellum-assistant` → click Create → get the project ID.

**Known issues:**

- Workspace accounts may show an Organization/Location dropdown — leave as-is
- Project quota limit → suggest requesting increase, deleting unused, or reusing existing

Record the **project ID** for all subsequent URLs.

---

### Step 3: Enable Gmail API

Open: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`

> You should see the Gmail API page. Look for a blue **Enable** button and click it.

If already enabled ("Manage" shown), skip ahead.

---

### Step 4: Enable Google Calendar API

Open: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

> Same thing — click **Enable** for the Google Calendar API.

**Milestone (4 of 9):** "APIs are enabled — now we'll set up the OAuth consent screen."

---

### Step 5: Configure OAuth Consent Screen

Google has two different flows depending on whether the consent screen has been configured before.

#### Sidebar Reference (previously configured projects)

| Sidebar Item    | URL Path         |
| --------------- | ---------------- |
| **Overview**    | `/auth/overview` |
| **Branding**    | `/auth/branding` |
| **Audience**    | `/auth/audience` |
| **Data Access** | `/auth/scopes`   |
| **Clients**     | `/auth/clients`  |

#### Step 5a: Open the consent screen

Open: `https://console.cloud.google.com/auth/branding?project=PROJECT_ID`

**Case 1 — Wizard flow** (new/unconfigured projects, URL shows `/auth/overview/create`):

> It looks like Google is showing the setup wizard. Let's walk through it:
>
> **Step 1 — App Information:** App name: `Vellum Assistant`, leave the rest
> **Step 2 — Audience:** Select **External**
> **Step 3 — Contact Information:** Enter your email
>
> Then click **Create**.

After the wizard, skip Step 5b. Open `https://console.cloud.google.com/auth/audience?project=PROJECT_ID` to add test users (scroll to **Test users** → **+ Add users** → enter email → Save), then go to Step 5c.

**Case 2 — Branding page** (already configured projects):

If needs setup: fill in App name (`Vellum Assistant`), User support email, Developer contact email → Save. If already filled, skip to Step 5b.

#### Step 5b: Audience and test users (skip if wizard was used)

Open: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`

1. Set user type to **External** if not already
2. Scroll to **Test users** → **+ Add users** → enter email → Save

#### Step 5c: Add scopes

Copy scopes to clipboard, then open Data Access:

```
host_bash:
  command: |
    echo -n "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/contacts.readonly" | pbcopy && /tmp/vellum-nav.sh "https://console.cloud.google.com/auth/scopes?project=PROJECT_ID"
```

> I've opened **Data Access** and copied the scopes to your clipboard.
>
> 1. Click **Add or Remove Scopes** → scroll to **"Manually add scopes"** → **paste** (Cmd+V) → click **Update**
> 2. Back on the main page, scroll down and click **Save**
>
> You should see:
>
> - **Non-sensitive:** `userinfo.email`, `contacts.readonly`
> - **Sensitive:** `calendar.readonly`, `calendar.events`, `gmail.send`
> - **Restricted:** `gmail.modify`, `gmail.readonly`

**Milestone (5 of 9):** "Over halfway — the fiddliest part is behind us."

---

### Step 6: Create OAuth Client Credentials

Open: `https://console.cloud.google.com/auth/clients/create?project=PROJECT_ID`

> Select **Desktop app** as the application type. You can name it "Vellum Assistant" or leave the default. Click **Create**.

A modal should appear with the **Client ID** and **Client Secret**. Tell the user to keep it open.

> **Heads up:** Google sometimes has a slight delay, so the modal may only show your Client ID without the Client Secret. If that happens, don't worry — click the **Download JSON** button (downward arrow icon) on the modal. Open the downloaded file and you'll find your `client_secret` in there. It's a little annoying, but it works every time.

---

### Step 7: Store Credentials

Collect Client ID conversationally, Client Secret via `credential_store prompt`. Register via `assistant oauth apps upsert`. See the collaborative guided flow reference for the exact commands.

**Milestone (7 of 9):** "Credentials saved — just two steps left."

---

### Step 8: Authorize

> I'll start the Google authorization flow now.
>
> If you see **"This app isn't verified"**, click **Advanced** then **Go to Vellum Assistant (unsafe)**. This is normal for apps in testing mode.
>
> Review the permissions and click **Allow**.

---

### Step 9: Verify Connection

Use the ping URL from the provider registration to verify the connection.

**On success:** "Gmail and Calendar are connected! You can now ask me to check your inbox, manage emails, or look at your calendar."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

Key Google-specific differences for Path B:

- Use **Web application** credentials (not Desktop app)
- Add redirect URI under **Authorized redirect URIs**
- Client Secret prefix is `GOCSPX-` — use split entry to avoid channel scanners
