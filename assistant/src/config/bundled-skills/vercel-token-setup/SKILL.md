---
name: vercel-token-setup
description: Set up a Vercel API token for publishing apps using browser automation
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"▲","vellum":{"display-name":"Vercel Token Setup","includes":["browser"],"credential-setup-for":"vercel:api_token"}}
---

You are helping your user set up a Vercel API token so they can publish apps to the web.

## Client Check

Determine whether the user has browser automation available (macOS desktop app) or is on a non-interactive channel (Telegram, SMS, etc.).

- **macOS desktop app**: Follow the **Automated Setup** path below.
- **Telegram or other channel** (no browser automation): Follow the **Manual Setup for Channels** path below.

---

# Path A: Manual Setup for Channels (Telegram, SMS, etc.)

When the user is on Telegram or any non-macOS client, walk them through a text-based setup. No browser automation is used — the user follows links and performs each action manually.

### Channel Step 1: Confirm and Explain

Tell the user:

> **Setting up Vercel API Token**
>
> Since I can't automate the browser from here, I'll walk you through each step with direct links. You'll need:
> 1. A Vercel account (free tier works)
> 2. About 2 minutes
>
> Ready to start?

If the user declines, acknowledge and stop.

### Channel Step 2: Create the Token

Tell the user:

> **Step 1: Create an API token**
>
> Open this link to go to your Vercel tokens page:
> https://vercel.com/account/tokens
>
> 1. Click **"Create"** (or **"Create Token"**)
> 2. Set the token name to **"Vellum Assistant"**
> 3. Select scope: **"Full Account"**
> 4. Set expiration to the longest option available (or **"No Expiration"** if offered)
> 5. Click **"Create Token"**
>
> A token value will appear — **copy it now**, as it's only shown once.

### Channel Step 3: Store the Token

Tell the user:

> **Step 2: Send me the token**
>
> Please paste the token value into the secure prompt below.

Present the secure prompt:

```
credential_store prompt:
  service: "vercel"
  field: "api_token"
  label: "Vercel API Token"
  description: "Paste the API token you just created on vercel.com"
  placeholder: "Enter your Vercel API token"
```

Wait for the user to complete the prompt. Once received, store it:

```
credential_store store:
  service: "vercel"
  field: "api_token"
  value: "<the token the user provided>"
  allowedTools: ["publish_page", "unpublish_page"]
  allowedDomains: ["api.vercel.com"]
```

### Channel Step 4: Done!

> **Vercel is connected!** You can now publish apps to the web. Try clicking Publish on any app you've built.

---

# Path B: Automated Setup (macOS Desktop App)

You will automate Vercel token creation via the browser while the user watches. The user's only manual action is signing in to Vercel (if needed) and one copy-paste for the token value.

## Browser Interaction Principles

Vercel's UI may change over time. Do NOT memorize or depend on specific element IDs, CSS selectors, or DOM structures. Instead:

1. **Screenshot first, act second.** Before every interaction, take a `browser_screenshot` to see the current visual state. Use `browser_snapshot` to find interactive elements.
2. **Adapt to what you see.** If a button's label or position differs from what you expect, use the screenshot to find the correct element.
3. **Verify after every action.** After clicking, typing, or navigating, take a new screenshot to confirm the action succeeded.
4. **Never assume DOM structure.** Use the snapshot to identify what's on the page and interact accordingly.
5. **When stuck, screenshot and describe.** If you cannot find an expected element after 2 attempts, take a screenshot, describe what you see to the user, and ask for guidance.

## Anti-Loop Guardrails

Each step has a **retry budget of 3 attempts**. An attempt is one try at the step's primary action (e.g., clicking a button, filling a form). If a step fails after 3 attempts:

1. **Stop trying.** Do not continue retrying the same approach.
2. **Fall back to manual.** Tell the user what you were trying to do and ask them to complete that step manually in the browser. Give them the direct URL and clear text instructions.
3. **Resume automation** at the next step once the user confirms the manual step is done.

If **two or more steps** require manual fallback, abandon the automated flow entirely and switch to giving the user the remaining steps as clear text instructions with links.

## Things That Do Not Work — Do Not Attempt

These actions are technically impossible in the browser automation environment:

- **Downloading files.** `browser_click` on a Download button does not save files to disk.
- **Reading the token value from a screenshot.** The token IS visible in the creation dialog, but you MUST NOT attempt to read it from a screenshot — it is too easy to misread characters, and the value must be exact. Always use the `credential_store prompt` approach to let the user copy-paste it accurately.
- **Clipboard operations.** You cannot copy/paste via browser automation.

## Step 1: Single Upfront Confirmation

Tell the user:

> **Setting up your Vercel API token so we can publish your app...**
>
> Here's what will happen:
> 1. **A browser opens** to your Vercel account settings
> 2. **You sign in** (if not already signed in)
> 3. **I create the token** — you just watch
> 4. **One quick copy-paste** — I'll ask you to copy the token value into a secure prompt
>
> Takes about a minute. Ready?

If the user declines, acknowledge and stop. No further confirmations are needed after this point.

## Step 2: Open Vercel and Sign In

**Goal:** The user is signed in and the Vercel tokens page is loaded.

Navigate to `https://vercel.com/account/tokens`.

Take a screenshot and snapshot to check the page state:
- **Sign-in page:** Tell the user: "Please sign in to your Vercel account in the browser." Then auto-detect sign-in completion by polling screenshots every 5-10 seconds. Check if the current URL has moved away from the login/sign-in page to the tokens page. Do NOT ask the user to "let me know when you're done" — detect it automatically. Once sign-in is detected, tell the user: "Signed in! Creating your API token now..."
- **Already signed in:** Tell the user: "Already signed in — creating your API token now..." and continue immediately.

**Verify:** URL contains `vercel.com/account/tokens` and no sign-in overlay is visible.

## Step 3: Create Token

**Goal:** A new API token named "Vellum Assistant" is created.

Take a screenshot and snapshot. Find and click the button to create a new token (typically labeled "Create" or "Create Token").

On the creation form:
- Token name: **"Vellum Assistant"**
- Scope: Select **"Full Account"** (or the broadest scope available)
- Expiration: Select the longest option available, or **"No Expiration"** if offered
- Click create/submit

**Verify:** Take a screenshot. A dialog or section should now display the newly created token value.

## Step 4: Capture Token via Secure Prompt

**Goal:** The token value is securely captured and stored.

### CRITICAL — Token Capture Protocol

After token creation, Vercel shows the token value **once**. You MUST follow this exact sequence — **no improvisation**:

1. Tell the user: "Your token has been created! Please copy the token value shown on screen and paste it into the secure prompt below."
2. **IMMEDIATELY** present a `credential_store prompt` for the token. This is your ONLY next action.
3. Wait for the user to paste the token.

**Absolute prohibitions during this step:**
- Do NOT try to read the token value from the screenshot. It must come from the user via secure prompt to ensure accuracy.
- Do NOT navigate away from the page until the user has pasted the token.
- Do NOT click any download or copy buttons.

Present the secure prompt:

```
credential_store prompt:
  service: "vercel"
  field: "api_token"
  label: "Vercel API Token"
  description: "Copy the token value shown on the Vercel page and paste it here."
  placeholder: "Enter your Vercel API token"
```

Wait for the user to complete the prompt. Once received, store it:

```
credential_store store:
  service: "vercel"
  field: "api_token"
  value: "<the token the user provided>"
  allowedTools: ["publish_page", "unpublish_page"]
  allowedDomains: ["api.vercel.com"]
```

**Verify:** `credential_store list` shows `api_token` for `vercel`.

## Step 5: Done!

"**Vercel is connected!** Your API token is set up and ready to go. You can now publish apps to the web."

## Error Handling

- **Page load failures:** Retry navigation once. If it still fails, tell the user and ask them to check their internet connection.
- **Element not found:** Take a fresh screenshot to re-assess. The Vercel UI may have changed. Describe what you see and try alternative approaches. If stuck after 2 attempts, ask the user for guidance.
- **Token already exists with same name:** This is fine — Vercel allows multiple tokens with the same name. Proceed with creation.
- **Any unexpected state:** Take a `browser_screenshot`, describe what you see, and ask the user for guidance.
