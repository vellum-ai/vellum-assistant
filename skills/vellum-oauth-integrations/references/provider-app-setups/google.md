You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

The included `vellum-oauth-integrations` skill handles the generic parts of the flow (credential collection, app registration, connection, and verification). This file defines only the Google-specific steps.

## Provider Details

- **Provider key:** `google`
- **Provider search keys:** `google`
- **Credential type (Path A):** Desktop app
- **Credential type (Path B):** Web application (callback through public gateway)

## Path A: macOS Desktop App

On the macOS desktop app, this is a collaborative Google Chrome flow. For every `Open:` URL in this file:

- Use `host_bash` plus `osascript` to activate Google Chrome and navigate the user's existing browser window to that URL
- Wait for the user to confirm they are done before moving to the next step
- Never use `browser_*`, CDP, the browser skill, or `computer_use_*` for Google Cloud Console or Google OAuth pages
- If Chrome is unavailable or AppleScript navigation fails, tell the user the URL and continue manually; do not switch to browser automation

Use this exact pattern:

```
host_bash:
  command: |
    osascript -e '
    tell application "Google Chrome"
      activate
      if (count of windows) = 0 then
        make new window
      end if
      set URL of active tab of front window to "TARGET_URL"
    end tell'
```

Replace `TARGET_URL` with the actual URL for that step. The point of Path A is to keep the flow in the user's real Chrome profile and avoid automated-browser rejections.

## Google-Specific Flow

The flow has 9 steps total, takes about 3-5 minutes.

### Step 0: Prerequisite Check

> Before we start - fair warning: this setup involves Google's developer console, which can feel pretty technical. Don't worry about that - you don't need to understand any of it. I'll open every page for you and tell you exactly what to click. If anything looks confusing or different from what I describe, just tell me and I'll figure it out.
>
> One thing worth knowing upfront: even after setup, I'll only ever create email drafts — I won't send anything without your explicit say-so.
>
> Do you have a Google account you'd like to use for this?

If no Google account -> guide them to create one or defer.

---

### Step 1: Open Google Cloud Console

Open: `https://console.cloud.google.com`

> I've opened the Google Cloud Console. If it's asking you to sign in, go ahead and do that first.

---

### Step 2: Select or Create a Project

Open: `https://console.cloud.google.com/cloud-resource-manager`

> I've opened your project list. If you see an existing project you'd like to use, let me know its name. Otherwise I'll walk you through creating a new one.

**New project:** Open `https://console.cloud.google.com/projectcreate` -> name it `vellum-assistant` -> click Create -> get the project ID.

**Known issues:**

- Workspace accounts may show an Organization/Location dropdown - leave as-is
- Project quota limit -> suggest requesting increase, deleting unused, or reusing existing

Record the **project ID** for all subsequent URLs.

---

### Step 3: Enable Gmail API

Open: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`

> You should see the Gmail API page. Look for a blue **Enable** button and click it.

If already enabled ("Manage" shown), skip ahead.

---

### Step 4: Enable Google Calendar API

Open: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`

> Same thing - click **Enable** for the Google Calendar API.

**Milestone (4 of 9):** "APIs are enabled - now we'll set up the OAuth consent screen."

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

**Case 1 - Wizard flow** (new/unconfigured projects, URL shows `/auth/overview/create`):

> It looks like Google is showing the setup wizard. Let's walk through it:
>
> **Step 1 - App Information:** App name: `Vellum Assistant`, leave the rest
> **Step 2 - Audience:** Select **External**
> **Step 3 - Contact Information:** Enter your email
>
> Then click **Create**.

After the wizard, skip Step 5b. Open `https://console.cloud.google.com/auth/audience?project=PROJECT_ID` to add test users (scroll to **Test users** -> **+ Add users** -> enter email -> Save), then go to Step 5c.

**Case 2 - Branding page** (already configured projects):

If needs setup: fill in App name (`Vellum Assistant`), User support email, Developer contact email -> Save. If already filled, skip to Step 5b.

#### Step 5b: Audience and test users (skip if wizard was used)

Open: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`

1. Set user type to **External** if not already
2. Scroll to **Test users** -> **+ Add users** -> enter email -> Save

#### Step 5c: Add scopes

Open: `https://console.cloud.google.com/auth/scopes?project=PROJECT_ID`

On macOS desktop, before proceeding, copy the comma-separated scope string below to the user's clipboard using `pbcopy`.

> I've opened **Data Access**.
>
> 1. Click **Add or Remove Scopes** -> scroll to **"Manually add scopes"** -> paste the comma-separated scopes below -> click **Update**
> 2. Back on the main page, scroll down and click **Save**

The scopes to paste:

```
https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/contacts.readonly
```

> You should see all 7 scopes listed across the three categories (Non-sensitive, Sensitive, Restricted):
>
> - `userinfo.email`
> - `contacts.readonly`
> - `calendar.readonly`
> - `calendar.events`
> - `gmail.send`
> - `gmail.modify`
> - `gmail.readonly`
>
> **Note:** GCP may categorize these scopes differently than you'd expect — that's fine, as long as all 7 are present.
>
> **Quick note on email safety:** The `gmail.modify` and `gmail.send` scopes let me create drafts and, when you explicitly ask, send them. By default I only create drafts — nothing leaves your outbox without your approval. If you'd rather I only have read access to your email for now, you can uncheck those two - everything else will still work fine, and you can always come back and add them later.

**Milestone (5 of 9):** "Over halfway - the fiddliest part is behind us."

---

### Step 6: Create OAuth Client Credentials

Open: `https://console.cloud.google.com/auth/clients/create?project=PROJECT_ID`

> Select **Desktop app** as the application type. You can name it "Vellum Assistant" or leave the default. Click **Create**.

A modal should appear with the **Client ID** and **Client Secret**. Tell the user to keep it open.

> **Heads up:** Google sometimes has a slight delay, so the modal may only show your Client ID without the Client Secret. If that happens, don't worry - close the modal and navigate to `https://console.cloud.google.com/auth/clients?project=PROJECT_ID`. Click on the client you just created (look for the name you used, e.g. "Vellum Assistant"). Under **Client secrets**, find the row with a copy button, click it, and paste the secret into the secure credential input when prompted.

---

### Steps 7-9: Store Credentials, Authorize, and Verify

Follow the `vellum-oauth-integrations` workflow to collect credentials, register the OAuth app, and verify the connection.

Google-specific override for macOS desktop app:

1. Before app registration, check the provider mode and set it to `your-own` if needed with `assistant oauth mode google --set your-own`.
2. Register the OAuth app normally via `assistant oauth apps upsert`.
3. For authorization, do **not** use the default browser behavior.
4. Instead, run `assistant oauth connect google --no-browser` so the command returns the authorization URL.
5. Open that returned authorization URL in Google Chrome using the same `host_bash` + `osascript` pattern as every other `Open:` step in this skill.
6. Never use browser automation or computer-use for the Google consent screen.

> I'll start the Google authorization flow now.
>
> If you see **"This app isn't verified"**, click **Advanced** then **Go to Vellum Assistant (unsafe)**. This is normal for apps in testing mode.
>
> Review the permissions and click **Allow**.

**On success:** "Gmail and Calendar are connected! You can now ask me to check your inbox, manage emails, or look at your calendar."

---

## Path B: Manual Channel Setup

For non-interactive channels, see [google-path-b.md](google-path-b.md).

Key Google-specific differences for Path B:

- Use **Web application** credentials (not Desktop app)
- Add redirect URI under **Authorized redirect URIs**
- Client Secret prefix is `GOCSPX-` - use split entry to avoid channel scanners
