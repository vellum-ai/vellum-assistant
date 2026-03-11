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
- **Telegram, SMS, Slack, or any non-interactive channel:** Follow **Path B: Manual Channel Setup**.

---

# Path A: Collaborative Browser Setup (macOS Desktop App)

You open pages via the `open` command (launches in the user's default browser — no Chrome dependency). The user does the clicking and form-filling. You tell them exactly what to look for and click at each step.

## Path A Rules

1. **Navigation is your job.** Use `host_bash` with `open "URL"` to open every URL. The user should never have to type a URL.
2. **Screenshots are a tool, not a routine.** Don't screenshot after every step. Give clear landmark-based instructions and let the user tell you how it's going. If the user reports something doesn't match or they're stuck, offer to take a screenshot: "Want me to take a look? I can screenshot your screen to see what you're seeing." Then adapt based on what you see.
3. **Never auto-advance.** Wait for user confirmation ("done", "ok", "next", etc.) before proceeding to the next step.
4. **Use landmarks, not coordinates.** Don't say "click the third item in the left sidebar." Say "Look for **APIs & Services** — it might be in the left sidebar, or you might need to click the hamburger menu first."
5. **Confirm after, not before.** Don't show what the page _should_ look like before the user acts. Confirm what they _should see after_ they act — this catches divergence without overloading them.
6. **Keep instructions short per step.** One action per message when possible.
7. **Don't assume any browser.** Screenshots work at the screen level. Focus on the GCP page content, not browser-specific UI (bookmark bars, tab layouts, etc.).
8. Never use `computer_use_*` tools, `browser_*` tools, or CDP for navigation.
9. Use `credential_store prompt` for both Client ID and Client Secret — never ask the user to type credentials in chat.

## Opening URLs

All URL navigation uses this pattern:

```
host_bash:
  command: open "TARGET_URL"
```

Replace `TARGET_URL` with the actual URL for each step. The `open` command launches the URL in whatever the user's default browser is.

## Step Pattern

Every step follows this rhythm:

1. **Open the URL** via `open "https://..."`
2. **Give a landmark-based instruction** — tell the user what to look for, not pixel-precise coordinates
3. **User acts** and confirms
4. **If the user reports a mismatch or is stuck** — offer to screenshot to see what they're seeing, then adapt
5. **Move on** once confirmed

---

## Pre-Flow

Before beginning, tell the user:

> I'm going to open a few pages in your browser and walk you through Google Cloud setup. Your Mac may ask for permissions along the way — if you see an option to allow for a longer duration (like 10 minutes), that'll save you from approving every single step.

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

**Milestone acknowledgment:**

> APIs are enabled — nice. Now the fun part.

Wait for confirmation.

---

## Step 5: Configure OAuth Consent Screen

This is the most variable step. Google has been actively redesigning this flow. Look for landmarks rather than assuming exact layout.

### Google Auth Platform Sidebar Reference

| Sidebar Item    | What It Contains                                             | URL Path         |
| --------------- | ------------------------------------------------------------ | ---------------- |
| **Overview**    | Status summary, "Get Started" button if not configured       | `/auth/overview` |
| **Branding**    | App name, user support email, developer contact, logo, links | `/auth/branding` |
| **Audience**    | User type (Internal/External), publishing status, test users | `/auth/audience` |
| **Data Access** | Scopes ("Add or Remove Scopes")                              | `/auth/scopes`   |
| **Clients**     | OAuth client credentials                                     | `/auth/clients`  |

### Step 5a: Branding / Initial setup

Open: `https://console.cloud.google.com/auth/branding?project=PROJECT_ID`.

The Branding page has App name, User support email, Developer contact email, and optionally logo/links. It does **not** have a User Type selector — that's on the Audience page (Step 5b).

If the consent screen is already configured (app name and emails already filled in), recognize this and skip ahead.

If it needs setup:

> This is the Branding page. Fill in:
>
> 1. **App name:** `Vellum Assistant`
> 2. **User support email:** select your email from the dropdown
> 3. **Developer contact email:** enter your email
> 4. Click **Save**

Wait for confirmation. If already configured, skip directly to Step 5b.

### Step 5b: Audience and test users

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
    echo -n "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/contacts.readonly" | pbcopy && open "https://console.cloud.google.com/auth/scopes?project=PROJECT_ID"
```

> Now I've opened the **Data Access** page and copied the required scopes to your clipboard. Click **Add or Remove Scopes**, find the **"Manually add scopes"** text box at the bottom, **paste** (Cmd+V), then click **Add to Table** (or **Update**), and **Save**.
>
> When done, you should see them listed on the page:
>
> - **Non-sensitive scopes:** `userinfo.email`, `contacts.readonly`
> - **Sensitive scopes:** `calendar.readonly`, `calendar.events`, `gmail.send`
> - **Restricted scopes (Gmail):** `gmail.modify`, `gmail.readonly`

> I know this is a lot of setup — we're about halfway through and the hardest part is behind us.

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

## Step 7: Store Credentials Securely

### 7a: Client ID

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_id"
  label: "Google OAuth Client ID"
  description: "Copy the Client ID from the Google Cloud dialog and paste it here."
  placeholder: "123456789-xxxxx.apps.googleusercontent.com"
```

### 7b: Client Secret

**Always use a secure prompt.** Never read secrets from screen.

```
credential_store prompt:
  service: "integration:gmail"
  field: "client_secret"
  label: "Google OAuth Client Secret"
  description: "Copy the Client Secret from the Google Cloud dialog and paste it here."
  placeholder: "GOCSPX-..."
```

Do not navigate away from the credential dialog until both values are stored. After both are stored, tell the user they can close the dialog.

---

## Step 8: Authorize Gmail and Calendar

Tell the user:

> I'll start the Google authorization flow now. A browser window will open asking you to approve access.
>
> If you see **"This app isn't verified"**, click **Advanced** then **Go to Vellum Assistant (unsafe)**. This is normal for apps in testing mode.
>
> Review the permissions and click **Allow**.

```
credential_store:
  action: "oauth2_connect"
  service: "integration:gmail"
```

If the tool returns an auth URL instead of auto-completing, send the URL to the user.

---

## Step 9: Verify Connection

```
messaging_auth_test:
  platform: "gmail"
```

**On success:**

> **Gmail and Calendar are connected!** You can now ask me to check your inbox, manage emails, or look at your calendar.

**On failure:**

> Something went wrong. Let me re-check the credentials and try the authorization again.

---

# Path B: Manual Channel Setup (Telegram, SMS, Slack, etc.)

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
- **Acknowledging the tedium** — "I know this is a lot of setup — we're about halfway through and the hardest part is behind us"
- **Celebratory at milestones** — "APIs are enabled — nice. Now the fun part."
- **Calm when things go sideways** — "That doesn't look quite right, but no worries — let me see what we're working with"

## Guardrails

- **No browser automation tools.** Path A uses `host_bash` + `open` for navigation. No `browser_*`, no CDP, no `computer_use_*` for navigation.
- **Browser-agnostic.** Use `open` to launch URLs in the default browser. Do not use AppleScript to target any specific browser. Use `pbcopy` for clipboard operations.
- **Do not delete and recreate OAuth clients.** That orphans stored credentials.
- **Do not leave the credential dialog early.** The Client Secret is shown only once.
- **Google Cloud UI drift is normal.** Adapt instructions while preserving the same end state.
