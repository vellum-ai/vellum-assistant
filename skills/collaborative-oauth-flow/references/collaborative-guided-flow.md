# Collaborative Guided Flow — AppleScript Browser Navigation

This reference defines a reusable pattern for walking users through OAuth app setup on third-party developer dashboards. The assistant opens pages in the user's browser and coaches them through each action. The user keeps control.

Use this pattern when browser automation tools (`browser_*`) are not available or when the service-specific skill specifies `collaborative` mode.

---

## Design Philosophy

"I'll be there every step of the way — with guidance, and always ready to get you unstuck."

The assistant opens the right pages and coaches. The user does the clicking and form-filling. Failures become conversations, not silent breakage.

---

## Client Check

Determine which delivery path applies before taking action:

- **macOS desktop app** → **Path A: Collaborative Browser Setup** (this document)
- **Telegram, Slack, or any non-interactive channel** → **Path B: Manual Channel Setup** — provide URLs and instructions as text messages; the user navigates on their own

---

## Path A: Collaborative Browser Setup

### Opening URLs

#### Setup: create the navigation helper (once per flow)

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

#### Navigating to a URL

```
host_bash:
  command: /tmp/vellum-nav.sh "TARGET_URL"
```

The helper detects the default browser and navigates in the existing tab. Falls back to opening a new tab when no window exists.

### Rules

1. **Navigation is your job.** Open every URL for the user — they should never have to type a URL.
2. **Screenshot after navigating.** After opening a page, take a screenshot to see what's actually on screen. Use what you see to give specific, contextual instructions rather than generic guidance. Developer consoles change frequently — never assume you know the exact layout.
3. **Never auto-advance.** Wait for user confirmation ("done", "ok", "next") before proceeding.
4. **Use landmarks, not coordinates.** Say "Look for **APIs & Services**" not "click the third item in the left sidebar."
5. **Confirm after, not before.** Describe what they _should see after_ they act, not what the page _should_ look like beforehand.
6. **Keep instructions short.** One action per message when possible.
7. **Don't assume any browser.** Focus on page content, not browser-specific UI.
8. Never use `computer_use_*` tools, `browser_*` tools, or CDP for navigation.
9. Use `credential_store prompt` for secrets — never ask the user to type secrets in chat. Non-secret values (like Client IDs) can be collected conversationally.

### Step Rhythm

Every step follows this pattern:

1. **Open the URL** using the navigation helper
2. **Screenshot** to see the current state of the page
3. **Give a specific instruction** based on what you actually see on screen — reference exact button labels, section names, and layout
4. **User acts** and confirms
5. **If the user reports a mismatch or seems stuck** — screenshot again to see what changed, then adapt
6. **Move on** once confirmed

---

## Pre-Flow: Internal OAuth Provider Setup

Before beginning the user-facing flow, look up or register the OAuth provider:

```
bash:
  command: assistant oauth providers list --provider-key "<provider-key>" --json
```

If one doesn't exist, register a new one:

```
bash:
  command: assistant oauth providers register --help
```

Take note of the **provider key**, **base URL**, and (if available) the **ping URL** for later.

## Pre-Flow: User Guidance

Before beginning, tell the user:

> We're going to set up [SERVICE] OAuth together — about N steps, roughly M minutes. I'll open each page in your browser and tell you exactly what to do. You can pause anytime and pick up where you left off.
>
> Your Mac may ask for permissions along the way — if you see an option to allow for a longer duration (like 10 minutes), that'll save you from approving every single step.

---

## Credential Collection

### Client ID

Non-secret — collect conversationally:

> Copy the Client ID from the dialog and paste it here in the chat.

### Client Secret

Always use a secure prompt:

```
credential_store prompt:
  service: "<provider-key>"
  field: "client_secret"
  label: "<Service> OAuth Client Secret"
  description: "Copy the Client Secret from the dialog and paste it here."
  placeholder: "..."
```

### Register OAuth App

```
bash:
  command: |
    assistant oauth apps upsert --provider <provider-key> --client-id <client-id> --client-secret-credential-path "credential/<provider-key>/client_secret"
```

---

## Authorization

```
bash:
  command: |
    assistant oauth connections connect <provider-key> --client-id <client-id>
```

The command prints an authorization URL. Send it to the user. Wait for completion.

If the service shows an "unverified app" warning, tell the user how to proceed (e.g., click Advanced → Continue).

---

## Verification

If a ping URL is available:

```
bash:
  command: |
    curl -H "Authorization: Bearer $(assistant oauth connections token <provider-key> --client-id <client-id>)" "<provider-ping-url>"
```

---

## Path B: Manual Channel Setup

For non-interactive channels, provide all URLs and instructions as text messages. Key differences from Path A:

- The user navigates on their own — give them the URLs to open
- For providers with `callbackTransport: "gateway"`, use **Web application** credentials and resolve the redirect URI from `ingress.publicBaseUrl`; if not configured, load the `public-ingress` skill first
- For providers with `callbackTransport: "loopback"`, the redirect URI is handled automatically in Path A; in Path B (remote channel), public ingress is still required since the loopback port is not reachable
- Collect the Client Secret via split entry if the secret prefix could trigger channel scanners (e.g., Slack's `xoxp-`, Google's `GOCSPX-`)

---

## Error Handling

### When Things Don't Match

1. **Don't panic or apologize excessively** — "Okay, that looks a bit different than expected. Let me take a look..."
2. **Screenshot first, then reorient** — take a screenshot to see the actual state, then describe what you see: "It looks like you're on the project selector page. Let's pick the project we just created..."
3. **Never blame the user** — the UI is the variable, not them.

### Recovery Patterns

| Situation                              | Response                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| User lands on unexpected page          | Offer to screenshot, identify where they are, navigate back    |
| User not signed in                     | Tell them to sign in, wait, continue                           |
| Feature already configured             | "Looks like this is already set up — great, let's skip ahead." |
| Quota / billing issue                  | Explain clearly, help resolve or use a different project       |
| Secret not shown after creation        | Guide to credential detail page as fallback                    |
| Auth URL returned instead of auto-open | Send URL to user to open manually                              |
| User is confused or frustrated         | Pause, acknowledge, simplify: "Let's take a step back..."      |
| `open` command fails                   | Fall back to Path B (give URLs manually)                       |

## Tone & Voice

- **Confident but not bossy** — "Go ahead and click Enable" not "You must click Enable"
- **Specific but not rigid** — "Look for a blue button that says Enable" not "Click the button at coordinates 450, 320"
- **Progress-aware** — use milestone markers to keep the user oriented
- **Calm when things go sideways** — "That doesn't look quite right, but no worries — let me see what we're working with"

## Guardrails

- **No browser automation tools.** Path A uses `host_bash` + `/tmp/vellum-nav.sh` for navigation only.
- **Browser-aware tab reuse.** The nav helper detects the browser each time. Falls back to `open` for unknown browsers.
- **Do not delete and recreate OAuth clients.** That orphans stored credentials.
- **Do not leave the credential dialog early.** The Client Secret may be shown only once.
- **Provider UI drift is normal.** Adapt instructions while preserving the same end state.
