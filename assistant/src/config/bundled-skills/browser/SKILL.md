---
name: browser
description: Browse the web using `assistant browser` CLI commands
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🌐"
  vellum:
    display-name: "Browser"
    feature-flag: "browser"
    activation-hints:
      - "Load first if you need to browse the web (navigating, clicking, extracting web content) via `assistant browser` commands"
---

Use this skill to browse the web. All browser operations are executed through the `assistant browser` CLI, invoked via `bash` or `host_bash`. Each operation is a subcommand:

| Command | Description |
|---|---|
| `assistant browser navigate` | Navigate to a URL |
| `assistant browser snapshot` | List interactive elements on the current page |
| `assistant browser screenshot` | Take a visual screenshot |
| `assistant browser click` | Click an element |
| `assistant browser type` | Type text into an input |
| `assistant browser press-key` | Press a keyboard key |
| `assistant browser scroll` | Scroll the page or a specific element |
| `assistant browser select-option` | Select an option from a native `<select>` element |
| `assistant browser hover` | Hover over an element to reveal menus/tooltips |
| `assistant browser wait-for` | Wait for a condition |
| `assistant browser extract` | Extract page text content |
| `assistant browser wait-for-download` | Wait for a file download to complete |
| `assistant browser fill-credential` | Fill a stored credential into a form field |
| `assistant browser attach` | Attach the Chrome debugger to the active tab |
| `assistant browser detach` | Detach the Chrome debugger from the active tab |
| `assistant browser close` | Close the browser page |
| `assistant browser status` | Diagnose browser backend readiness and setup steps |

## Capabilities

This browser runs **full Chromium with JavaScript enabled**. It can handle SPAs, React/Vue/Angular apps, dynamic content, date pickers, booking systems, reservation flows, and any JavaScript-heavy interactive site. Never tell the user you "can't handle interactive JavaScript" - you can.

## Session Management

Use `--session <id>` on the `assistant browser` parent command to group sequential operations so they share browser state (same page, cookies, etc.). Different session IDs create independent browser contexts.

```bash
assistant browser --session myflow navigate --url https://example.com
assistant browser --session myflow snapshot
assistant browser --session myflow click --element-id e3
```

Omitting `--session` uses the `default` session.

## Machine-Readable Output

Use `--json` on the `assistant browser` parent command to get structured JSON output suitable for parsing in scripts:

```bash
assistant browser --json navigate --url https://example.com
# {"ok":true,"content":"Page title: Example Domain"}

assistant browser --json snapshot
# {"ok":true,"content":"...element list..."}

assistant browser --json screenshot
# {"ok":true,"content":"...","screenshots":[{"mediaType":"image/jpeg","data":"<base64>"}]}
```

Error responses use `{"ok":false,"error":"..."}`.

## Screenshots

To save a screenshot to disk, use `--output <path>`:

```bash
assistant browser screenshot --output page.jpg
assistant browser screenshot --full-page --output full.jpg
```

To receive base64 screenshot data in JSON output:

```bash
assistant browser --json screenshot
```

The response includes a `screenshots` array with `mediaType` and `data` (base64) fields.

## Browser Mode

Use `--browser-mode <mode>` on the `assistant browser` parent command to pin the browser backend:

| Value | Backend | Description |
|---|---|---|
| `auto` | Automatic | Default. Picks the best available backend based on context. |
| `extension` | Chrome extension | Routes through the user's Chrome browser via the extension debugger. |
| `cdp-inspect` | CDP inspect | Connects to an already-running Chrome instance via DevTools Protocol. |
| `local` | Playwright | Drives a dedicated Playwright-managed Chromium instance. |

```bash
assistant browser --browser-mode local navigate --url http://localhost:3000
```

**When to use `auto`**: Prefer `auto` (or omit `--browser-mode` entirely) unless you have a specific reason to pin. The automatic backend selection handles extension availability, fallback, and session reuse.

**When to pin a mode**: Pin explicitly when:
- The user requests interaction with their own browser (use `extension` or `cdp-inspect`).
- A command only works on a specific backend (e.g. `wait-for-download` requires `local`).
- You want to avoid fallback behavior for diagnostic clarity.

## Typical Workflow

1. (Optional) `assistant browser status` to diagnose backend availability
2. (Optional) `assistant browser attach` to establish the debugger session (extension path)
3. `assistant browser navigate --url <url>` to load a page
4. `assistant browser snapshot` to discover interactive elements
5. Use `click`, `type`, `press-key`, `scroll`, `select-option`, or `hover` to interact
6. `assistant browser extract` or `assistant browser screenshot --output <path>` to capture results
7. `assistant browser detach` to end the session, or `assistant browser close` to close the page

## Interaction Strategies

**Date pickers / calendars:** Click the date input to open the picker, re-snapshot to see calendar controls, click month navigation arrows to reach the target month, then click the target date. For `<input type="date">`, use `type` with `YYYY-MM-DD` format.

**Native `<select>` elements:** Use `select-option` with `--value`, `--label`, or `--index`. Do not try to click individual `<option>` elements.

**ARIA / custom dropdowns:** Click to open, take a new `snapshot`, then click the desired option by `--element-id`.

**Autocomplete inputs:** Type the search text, wait 500-1000ms (`wait-for --duration`), re-snapshot for suggestions, then click the suggestion or use `press-key --key ArrowDown` + `press-key --key Enter`.

**Multi-step forms:** Complete each step, wait for the next section to load, re-snapshot to discover new elements, then proceed.

**Dynamic content:** After interactions that change the page, use `wait-for` (with `--selector` or `--text`) or re-snapshot to see updated elements before continuing.

**Scrolling:** Use `scroll --direction down` to reveal below-the-fold content before snapshotting. Long pages may require multiple scrolls.

**Hover menus / tooltips:** Use `hover` to reveal hidden menus or tooltips, then re-snapshot to see newly revealed elements.

## Verification

After critical actions (form submission, booking confirmation, checkout), take a screenshot and read the saved image to visually verify results before reporting success to the user:

```bash
assistant browser screenshot --output /tmp/verify.jpg
# then read the image to see its contents
read_file /tmp/verify.jpg
```
