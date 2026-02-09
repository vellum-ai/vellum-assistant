# Recipe: GitHub App Setup

> A computer-use recipe for an orchestration agent to register, configure, and install
> a GitHub App on behalf of the user's assistant — fully hands-free.

## When This Recipe Fires

This recipe is invoked as a **just-in-time skill** during onboarding when:

1. The user answers **"GitHub"** to _"Where do you spend most of your time?"_
2. The orchestration agent presents: _"Let me get {assistant-name} set up on GitHub. Can I take it from here?"_
3. The user selects **"Yes (I'll use your mouse and keyboard)"**

## Prerequisites

- User is signed into github.com in their default browser
- User has admin access to the target GitHub organization or personal account
- macOS Accessibility + Screen Recording permissions are granted (handled by prior onboarding steps)

---

## Recipe Steps

### Phase 1: Navigate to GitHub App Creation

```
STEP 1: Open GitHub Developer Settings
  ACTION: open_app("default browser")
  ACTION: key("cmd+l")  // focus address bar
  ACTION: type_text("github.com/settings/apps/new")
  ACTION: key("return")
  WAIT: page loads — look for "Register new GitHub App" heading
  VERIFY: AX tree contains "Register new GitHub App" or "New GitHub App"
```

### Phase 2: Fill Out App Registration Form

```
STEP 2: Set App Name
  LOCATE: text field labeled "GitHub App name"
  ACTION: click([field_id])
  ACTION: type_text("{assistant-name}-github-app")
  NOTE: Must be globally unique on GitHub. If taken, append random 4-digit suffix.

STEP 3: Set Homepage URL
  LOCATE: text field labeled "Homepage URL"
  ACTION: click([field_id])
  ACTION: type_text("{assistant-homepage-url}")
  NOTE: Can be any valid URL. Use the assistant's web page or a placeholder.

STEP 4: Skip Webhook Configuration (for now)
  LOCATE: checkbox "Active" under Webhooks section
  ACTION: click([checkbox_id]) to UNCHECK it
  NOTE: Webhooks can be configured later. Not necessary to get started.
```

### Phase 3: Set Permissions

```
STEP 5: Configure Repository Permissions
  LOCATE: "Repository permissions" section (may need to scroll)
  ACTION: scroll(down) until "Repository permissions" is visible

  STEP 5a: Contents → Read and write
    LOCATE: "Contents" dropdown
    ACTION: click([dropdown_id])
    ACTION: click option "Read and write"

  STEP 5b: Issues → Read and write
    LOCATE: "Issues" dropdown
    ACTION: click([dropdown_id])
    ACTION: click option "Read and write"

  STEP 5c: Pull requests → Read and write
    LOCATE: "Pull requests" dropdown
    ACTION: click([dropdown_id])
    ACTION: click option "Read and write"

  STEP 5d: (Optional) Metadata → Read-only
    NOTE: Usually auto-granted. Verify it shows "Read-only".
```

### Phase 4: Set Visibility & Create

```
STEP 6: Make the App Public (if org install needed)
  LOCATE: radio button or section "Where can this GitHub App be installed?"
  ACTION: select "Any account" (public)
  NOTE: Making it public allows the Vellum organization to install it.
        If private, only the owning account can install.

STEP 7: Create the GitHub App
  LOCATE: "Create GitHub App" button (green, bottom of form)
  ACTION: click([button_id])
  WAIT: page navigates to the new app's settings page
  VERIFY: page title or heading contains the app name
  CAPTURE: App ID from the "App ID" field on the About page
```

### Phase 5: Generate Private Key

```
STEP 8: Navigate to Private Key Section
  ACTION: scroll(down) to "Private keys" section
  LOCATE: "Generate a private key" button (green)

STEP 9: Generate and Download Key
  ACTION: click([generate_button_id])
  WAIT: .pem file downloads (browser download notification or file appears)
  VERIFY: download completes — look for .pem in ~/Downloads/
  CAPTURE: path to downloaded .pem file
  NOTE: The key is a multi-line PEM string starting with
        "-----BEGIN RSA PRIVATE KEY-----" and ending with
        "-----END RSA PRIVATE KEY-----"
```

### Phase 6: Install the App

```
STEP 10: Click "Install App" in Sidebar
  LOCATE: "Install App" link in left sidebar navigation
  ACTION: click([install_link_id])
  WAIT: installation page loads

STEP 11: Select Target Account/Org
  LOCATE: the target organization or personal account
  ACTION: click "Install" button next to it
  NOTE: If org requires admin approval, this may show "Request" instead.

STEP 12: Choose Repository Access
  LOCATE: "Only select repositories" radio button
  ACTION: click([radio_id])
  LOCATE: repository dropdown/selector
  ACTION: click([dropdown_id])
  ACTION: type_text("{target-repo-name}")
  ACTION: click the matching repo option
  NOTE: Scoping to specific repos follows principle of least privilege.

STEP 13: Confirm Installation
  LOCATE: "Install" button (green)
  ACTION: click([install_button_id])
  WAIT: redirects to installation confirmation or app settings
  VERIFY: page shows "Installed" status or installation ID
```

### Phase 7: Capture Credentials

```
STEP 14: Record App ID and Installation Details
  CAPTURE: App ID (from app settings page, numeric)
  CAPTURE: Private key file path (from Step 9)
  STORE: Both values in assistant's secure credential store
  NOTE: These two pieces — App ID + Private Key — are all the assistant
        needs to authenticate as the GitHub App via JWT.

STEP 15: Report Success
  DONE: "I've set up {assistant-name} as a GitHub App and installed it
         on {target-repo}. I can now open PRs, review code, and respond
         to issues on your behalf."
```

---

## Error Recovery

| Scenario | Recovery |
|----------|----------|
| App name taken | Append `-{random-4-digits}` and retry Step 2 |
| Not signed into GitHub | Navigate to github.com/login, pause, ask user to sign in |
| No admin access to org | Fall back to personal account installation |
| Download blocked by browser | Check ~/Downloads for .pem, or look for browser download bar |
| Permissions dropdown not visible | Scroll down, expand collapsed sections |
| Page layout changed | Fall back to screenshot-only mode, use visual matching |

## Credentials Output

```json
{
  "github_app_id": "123456",
  "github_app_name": "{assistant-name}-github-app",
  "private_key_path": "~/Downloads/{app-name}.{date}.private-key.pem",
  "installed_on": "{org}/{repo}",
  "installation_id": "78901234"
}
```

---

## Architecture Notes

### How This Fits Into Onboarding

This recipe is one of several **integration recipes** that fire during onboarding
based on user selections. The pattern:

```
Onboarding Step: "Where do you spend most of your time?"
├── GitHub  → github-app-setup.md (this recipe)
├── Gmail   → gmail-oauth-setup.md
├── Slack   → slack-app-setup.md
├── Linear  → linear-oauth-setup.md
├── Notion  → notion-integration-setup.md
└── ...
```

Each recipe follows the same structure:
1. **Prerequisites** — what must be true before starting
2. **Steps** — atomic, verifiable computer-use actions
3. **Captures** — credentials/config the assistant stores
4. **Error recovery** — fallback strategies
5. **Completion message** — what to tell the user

### Recipe Execution Model

Recipes are executed by the `ComputerUseSession` with a structured task prompt
derived from the recipe steps. The orchestration agent:

1. Reads the recipe markdown
2. Converts steps into a task description for the session
3. Monitors step execution via `SessionState`
4. Captures output credentials
5. Stores them in the assistant's secure config
6. Reports completion to the onboarding flow
