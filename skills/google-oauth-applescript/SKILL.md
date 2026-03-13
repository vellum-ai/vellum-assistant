---
name: google-oauth-applescript
description: Set up Google Cloud OAuth credentials for Gmail and Calendar using a collaborative guided flow
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Google OAuth Setup"
    user-invocable: true
    credential-setup-for: "gmail"
---

You are helping your user set up Google Cloud OAuth credentials so Gmail and Google Calendar integrations can connect.

## Design Philosophy

"I'll be there every step of the way — with guidance, and always ready to get you unstuck."

This is a **collaborative guided flow**: you open the right pages in the user's default browser and coach them through each action. The user keeps control — no anxiety about what the assistant is doing behind the scenes. Failures become conversations, not silent breakage.

## Client Check

Determine which path applies before taking action:

- **macOS desktop app:** Follow **Path A: Collaborative Browser Setup**.
- **Telegram, Slack, or any non-interactive channel:** Follow **Path B: Manual Channel Setup**.

---

# Path A: Collaborative Browser Setup (macOS Desktop App)

You open pages in the user's default browser using the `/tmp/vellum-nav.sh` helper (see "Opening URLs" below). The user does the clicking and form-filling. You tell them exactly what to look for and click at each step.

## Path A Rules

1. **Navigation is your job.** Open every URL for the user — they should never have to type a URL. Use the browser-aware navigation pattern described in **Opening URLs** below.
2. **Screenshots are a tool, not a routine.** Don't screenshot after every step. Give clear landmark-based instructions and let the user tell you how it's going. If the user reports something doesn't match or they're stuck, offer to take a screenshot: "Want me to take a look? I can screenshot your screen to see what you're seeing." Then adapt based on what you see.
3. **Never auto-advance.** Wait for user confirmation ("done", "ok", "next", etc.) before proceeding to the next step.
4. **Use landmarks, not coordinates.** Don't say "click the third item in the left sidebar." Say "Look for **APIs & Services** — it might be in the left sidebar, or you might need to click the hamburger menu first."
5. **Confirm after, not before.** Don't show what the page _should_ look like before the user acts. Confirm what they _should see after_ they act — this catches divergence without overloading them.
6. **Keep instructions short per step.** One action per message when possible.
7. **Don't assume any browser.** Screenshots work at the screen level. Focus on the GCP page content, not browser-specific UI (bookmark bars, tab layouts, etc.).
8. Never use `computer_use_*` tools, `browser_*` tools, or CDP for navigation.
9. Use `credential_store prompt` for the Client Secret — never ask the user to type secrets in chat. The Client ID is not secret and can be collected conversationally.

## Opening URLs

### Setup: create the navigation helper (do this once at the start of the flow)

Before opening any URLs, create the helper script:

```
host_bash:
  command: |
    cat > /tmp/vellum-nav.sh << 'NAVSCRIPT'
    #!/bin/bash
    URL="$1"
    BROWSER=$(plutil -convert json -o - ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist 2>/dev/null | python3 -c "import json,sys;[print(h.get('LSHandlerRoleAll','')) for h in json.load(sys.stdin).get('LSHandlers',[]) if h.get('LSHandlerURLScheme')=='https']" 2>/dev/null)
    case "$BROWSER" in
      com.google.chrome)
        osascript -e "tell application \"Google Chrome\" to set URL of active tab of front window to \"$URL\"" 2>/dev/null || open "$URL" ;;
      com.apple.safari)
        osascript -e "tell application \"Safari\" to set URL of current tab of front window to \"$URL\"" 2>/dev/null || open "$URL" ;;
      company.thebrowser.Browser)
        osascript -e "tell application \"Arc\" to set URL of active tab of front window to \"$URL\"" 2>/dev/null || open "$URL" ;;
      com.brave.Browser)
        osascript -e "tell application \"Brave Browser\" to set URL of active tab of front window to \"$URL\"" 2>/dev/null || open "$URL" ;;
      *)
        open "$URL" ;;
    esac
    NAVSCRIPT
    chmod +x /tmp/vellum-nav.sh
    echo "Navigation helper ready."
```

### Navigating to a URL

For every URL in the flow, use:

```
host_bash:
  command: /tmp/vellum-nav.sh "TARGET_URL"
```

Replace `TARGET_URL` with the actual URL. The helper detects the default browser and navigates in the existing tab. On the first call (no browser window yet), it falls back to opening a new tab.

## Step Pattern

Every step follows this rhythm:

1. **Open the URL** using the browser-aware pattern above
2. **Give a landmark-based instruction** — tell the user what to look for, not pixel-precise coordinates
3. **User acts** and confirms
4. **If the user reports a mismatch or is stuck** — offer to screenshot to see what they're seeing, then adapt
5. **Move on** once confirmed

---

## Pre-Flow

### Internal OAuth Provider Setup

Before beginning, look up information about the google oauth app, which we'll need later.

Find the gmail or google oauth provider

```
bash:
  command: assistant oauth providers list --provider-key "gmail, google" --json
```

If one doesn't yet exist, then register a new one with a provider key of "integration:google"

```
bash:
  command: assistant oauth providers register --help
```

In either case, take mental note of the **provider key**, **base url**, and, if available, the **ping url** for later.

### User Guidance

Before beginning, tell the user:

> We're going to set up Google OAuth together — 9 steps, about 3–5 minutes. I'll open each page in your browser and tell you exactly what to do. You can pause anytime and pick up where you left off.
>
> Your Mac may ask for permissions along the way — if you see an option to allow for a longer duration (like 10 minutes), that'll save you from approving every single step.

## Step 0: Prerequisite Check

Ask the user:

> Before we start — do you have a Google account you'd like to use for this?

If no Google account → guide them to create one (or defer).

---

## Step 1: Open Google Cloud Console

Open: `https://console.cloud.google.com`.

Tell the user:

> I've opened the Google Cloud Console in your browser. You should see a dashboard — if it's asking you to sign in, go ahead and do that first.

Wait for confirmation.

---

## Step 2: Select or Create a Project

**Goal:** Use an existing GCP project or create a new one.

Open: `https://console.cloud.google.com/cloud-resource-manager`.

Tell the user:

> I've opened your project list. If you see an existing project you'd like to use, let me know its name. Otherwise I'll walk you through creating a new one.

### Branch A — Existing projects found

> It looks like you already have some projects in your Google Cloud account. We can either reuse one of these or create a fresh one. Which would you prefer?

If the user picks an existing project, confirm its name and skip to Step 3. Record the project ID for all subsequent URL substitutions.

### Branch B — No existing projects (or user wants new)

Open: `https://console.cloud.google.com/projectcreate`.

> I've opened the Create Project page. You should see a field for **Project name**. Type something like `vellum-assistant` (the exact name doesn't matter). Then click **Create**.

After the user clicks Create, ask them to confirm the project was created and send you the **project ID** (shown in the URL or project settings, looks like `my-project-123456`).

**Known issue:** Some Google Workspace accounts require org selection. If the user mentions an "Organization" or "Location" dropdown, tell them to leave it as-is or select their org.

### Project limit reached

If the user hits the project quota limit, explain their options:

1. Request a quota increase
2. Delete an unused project
3. Reuse an existing project

Wait for confirmation. Record the project ID for all subsequent URL substitutions.

---

## Step 3: Enable Gmail API

Open: `https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID`.

> You should see the Gmail API page. Look for a blue **Enable** button and click it.

**Checkpoint:** The button should change to "Manage" or the page should redirect to the API overview.

**Adapt:** If the page says "API not found" or the project context is wrong, guide the user to select the correct project from the top dropdown. If it already says "Manage" — "Looks like this one's already enabled — great, let's skip ahead."

Wait for confirmation.

---

## Step 4: Enable Google Calendar API

Open: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=PROJECT_ID`.

> Same thing here — click **Enable** for the Google Calendar API.

**Checkpoint:** Ask the user to confirm it says "Manage" (meaning it's enabled).

**Milestone acknowledgment (4 of 9):**

> APIs are enabled — that's steps 3 and 4 done. Now we'll set up the OAuth consent screen.

Wait for confirmation.

---

## Step 5: Configure OAuth Consent Screen

This is the most variable step. Google has two different flows depending on whether the consent screen has been configured before:

- **New projects** → Google redirects to a **wizard** at `/auth/overview/create` with steps: App Information → Audience → Contact Information → Finish
- **Previously configured projects** → Google shows separate pages: Branding, Audience, Data Access, etc.

### Google Auth Platform Sidebar Reference (for previously configured projects)

| Sidebar Item    | What It Contains                                             | URL Path         |
| --------------- | ------------------------------------------------------------ | ---------------- |
| **Overview**    | Status summary, "Get Started" button if not configured       | `/auth/overview` |
| **Branding**    | App name, user support email, developer contact, logo, links | `/auth/branding` |
| **Audience**    | User type (Internal/External), publishing status, test users | `/auth/audience` |
| **Data Access** | Scopes ("Add or Remove Scopes")                              | `/auth/scopes`   |
| **Clients**     | OAuth client credentials                                     | `/auth/clients`  |

### Step 5a: Open the consent screen

Open: `https://console.cloud.google.com/auth/branding?project=PROJECT_ID`.

This may land on one of two pages:

#### Case 1: Wizard flow (new/unconfigured projects)

If the user lands on a page with numbered steps (App Information → Audience → Contact Information → Finish), or the URL shows `/auth/overview/create`, guide them through the wizard:

> It looks like Google is showing the setup wizard. Let's walk through it:
>
> **Step 1 — App Information:**
>
> - **App name:** `Vellum Assistant`
> - Leave everything else as-is
>
> **Step 2 — Audience:**
>
> - Select **External** — this lets any Google account authorize (it starts in testing mode, so only test users you add can access it)
>
> **Step 3 — Contact Information:**
>
> - Enter your email address
>
> Then click **Create** at the bottom.

Wait for confirmation. After the wizard completes, the user will be on the separate-page layout. **Skip Step 5b** (the wizard already set user type), and go directly to adding test users and scopes.

Open the Audience page to add test users:

Open: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`.

> Great, the consent screen is configured! One more thing — scroll down to the **Test users** section, click **+ Add users**, enter your email address, and click **Save**.

Wait for confirmation, then proceed to Step 5c.

#### Case 2: Branding page (already configured projects)

If the user sees a Branding page with fields for App name, User support email, Developer contact email — they've been here before or the consent screen is already set up.

If already configured (app name and emails already filled in), skip ahead to Step 5b.

If it needs setup:

> This is the Branding page. Fill in:
>
> 1. **App name:** `Vellum Assistant`
> 2. **User support email:** select your email from the dropdown
> 3. **Developer contact email:** enter your email
> 4. Click **Save**

Wait for confirmation, then continue to Step 5b.

### Step 5b: Audience and test users (skip if wizard was used)

Open: `https://console.cloud.google.com/auth/audience?project=PROJECT_ID`.

> I've opened the **Audience** page. Two things to check here:
>
> 1. **User type:** If it doesn't already show **External**, select **External** and save.
> 2. **Test users:** Scroll down to the **Test users** section, click **+ Add users**, enter your email address, and click **Save**.

Wait for confirmation.

### Step 5c: Add scopes

Copy the required scopes to the clipboard, then open the Data Access page:

```
host_bash:
  command: |
    echo -n "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/contacts.readonly" | pbcopy && /tmp/vellum-nav.sh "https://console.cloud.google.com/auth/scopes?project=PROJECT_ID"
```

> Now I've opened the **Data Access** page and copied the required scopes to your clipboard. There are two stages here:
>
> 1. Click **Add or Remove Scopes** — a panel will open. Scroll down to the **"Manually add scopes"** text box, **paste** (Cmd+V), then click **Update** at the bottom of the panel.
> 2. Back on the main page, scroll down and click **Save**.
>
> When done, you should see them listed on the page:
>
> - **Non-sensitive scopes:** `userinfo.email`, `contacts.readonly`
> - **Sensitive scopes:** `calendar.readonly`, `calendar.events`, `gmail.send`
> - **Restricted scopes (Gmail):** `gmail.modify`, `gmail.readonly`

> That's step 5 of 9 — over halfway, and the fiddliest part is behind us.

Wait for confirmation.

---

## Step 6: Create OAuth Client Credentials

Open: `https://console.cloud.google.com/auth/clients/create?project=PROJECT_ID`.

> On this page, you should see a dropdown for **Application type**. Select **Desktop app**. You can leave the name as-is or change it to "Vellum Assistant". Then click **Create**.

**Checkpoint — CRITICAL:** After clicking Create, a modal should appear showing the **Client ID** and **Client Secret**.

**If the secret doesn't appear:** Sometimes the modal doesn't show the secret on the first attempt. Guide the user:

> Hmm, it looks like the secret didn't show up. Let's try clicking on the credential you just created — you should see it listed on the Credentials page. Click its name, and the Client ID and Secret should be on the detail page.

Tell the user:

> You should see a **Client ID** and a **Client Secret**. **Keep this dialog open** — I'll prompt you to paste them securely in the app.

Wait for the user to confirm the dialog is showing.

---

## Step 7: Store Client ID and Client Secret

### 7a: Client ID

This value is not secret and can safely be provided conversationally.

> Copy the Client ID from the Google Cloud dialog and paste it here in the chat. This is not a secret value and can be safely provided here.

### 7b: Client Secret

**Always use a secure prompt.** Never read secrets from screen.

Use the provider key from the "Internal OAuth Provider Setup" step above as the service name.

```
credential_store prompt:
  service: "<provider-key>"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud dialog and paste it here."
  placeholder: "GOCSPX-..."
```

### 7c: Register OAuth App

Now register the OAuth app with the collected Client ID and Client Secret.

```
bash:
  command: |
    assistant oauth apps upsert --provider <provider-key> --client-id <client-id> --client-secret-credential-path "<provider-key>:client_secret"
```

Do not navigate away from the credential dialog until both values are provided. After both are stored and the app is registered, tell the user they can close the dialog.

**Milestone acknowledgment (7 of 9):**

> Credentials saved — just two steps left: authorize and verify.

---

## Step 8: Authorize Gmail and Calendar

Tell the user:

> I'll start the Google authorization flow now. A browser window will open asking you to approve access.
>
> If you see **"This app isn't verified"**, click **Advanced** then **Go to Vellum Assistant (unsafe)**. This is normal for apps in testing mode.
>
> Review the permissions and click **Allow**.

```
bash:
  command: |
    assistant oauth connections connect <provider-key> --client-id <client-id>
```

The command prints an authorization URL. Send it to the user and encourage them to open it. Wait for the user to complete authorization in the browser. The token exchange completes in the background.

---

## Step 9: Verify Connection

If there is a ping url available, make a request to it.

```
bash:
  command: |
    curl -H "Authorization: Bearer $(assistant oauth connections token <provider-key> --client-id <client-id>)" "<provider-ping-url>"
```

**On success:**

> **Gmail and Calendar are connected!** You can now ask me to check your inbox, manage emails, or look at your calendar.

**On failure:**

> Something went wrong. Let me re-check the credentials and try the authorization again.

---

# Path B: Manual Channel Setup (Telegram, Slack, etc.)

For non-interactive channels, see [references/path-b-manual-setup.md](references/path-b-manual-setup.md).

---

## Error Handling

### When Things Don't Match

When the user reports something doesn't look right, offer to take a screenshot to see what they're seeing. When something doesn't match:

1. **Don't panic or apologize excessively** — "Okay, this looks a bit different than expected. Let me take a look..."
2. **Describe what you see and reorient** — "It looks like you're on the project selector page. Let's pick the project we just created..."
3. **Never blame the user** — the UI is the variable, not them.

### Recovery Patterns

| Situation                                    | Response                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| User lands on unexpected page                | Offer to screenshot, identify where they are, navigate back               |
| User not signed in to Google                 | Tell them to sign in, wait, continue                                      |
| API already enabled                          | "Looks like this one's already enabled — great, let's skip ahead."        |
| OAuth consent screen already configured      | "You've already set this up — let's go straight to creating credentials." |
| Project quota / billing issue                | Explain clearly, help them resolve or use a different project             |
| Secret not shown after credential creation   | Guide to credential detail page as fallback                               |
| Org policy / billing blockers                | Explain plainly, wait for user                                            |
| "This app isn't verified" warning            | Normal for testing. Click Advanced > Continue                             |
| Auth URL returned instead of auto-completing | Send URL to user to open manually                                         |
| User is confused or frustrated               | Pause, acknowledge, simplify: "Let's take a step back..."                 |
| `open` command fails                         | Fall back to Path B (give URLs manually)                                  |

## Tone & Voice

- **Confident but not bossy** — "Go ahead and click Enable" not "You must click Enable"
- **Specific but not rigid** — "Look for a blue button that says Enable" not "Click the button at coordinates 450, 320"
- **Progress-aware** — use the milestone markers to keep the user oriented on where they are and how much is left
- **Calm when things go sideways** — "That doesn't look quite right, but no worries — let me see what we're working with"

## Guardrails

- **No browser automation tools.** Path A uses `host_bash` + `/tmp/vellum-nav.sh` for navigation. No `browser_*`, no CDP, no `computer_use_*` for navigation.
- **Browser-aware tab reuse.** Every URL navigation uses the self-contained detect-and-navigate snippet from the "Opening URLs" section. The assistant does not need to remember the browser — the snippet detects it each time. Falls back to `open` for unknown browsers or when no window exists. Use `pbcopy` for clipboard operations.
- **Do not delete and recreate OAuth clients.** That orphans stored credentials.
- **Do not leave the credential dialog early.** The Client Secret is shown only once.
- **Google Cloud UI drift is normal.** Adapt instructions while preserving the same end state.
