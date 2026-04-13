---
name: browser
description: Navigate and interact with web pages using a headless browser
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🌐"
  vellum:
    display-name: "Browser"
    feature-flag: "browser"
    activation-hints:
      - "Load first if you need browser_* tools (navigating, clicking, extracting web content)"
---

Use this skill to browse the web. After loading this skill, the following browser tools become available:

- `browser_attach` - Attach the Chrome debugger to the active tab
- `browser_navigate` - Navigate to a URL
- `browser_snapshot` - List interactive elements on the current page
- `browser_screenshot` - Take a visual screenshot
- `browser_close` - Close the browser page
- `browser_detach` - Detach the Chrome debugger from the active tab
- `browser_click` - Click an element
- `browser_type` - Type text into an input
- `browser_press_key` - Press a keyboard key
- `browser_scroll` - Scroll the page or a specific element
- `browser_select_option` - Select an option from a native `<select>` element
- `browser_hover` - Hover over an element to reveal menus/tooltips
- `browser_wait_for` - Wait for a condition
- `browser_extract` - Extract page text content
- `browser_wait_for_download` - Wait for a file download to complete
- `browser_fill_credential` - Fill a stored credential into a form field

## Capabilities

This browser runs **full Chromium with JavaScript enabled**. It can handle SPAs, React/Vue/Angular apps, dynamic content, date pickers, booking systems, reservation flows, and any JavaScript-heavy interactive site. Never tell the user you "can't handle interactive JavaScript" - you can.

## Browser Mode

Every browser tool accepts an optional `browser_mode` parameter that controls which backend executes the command:

| Value | Backend | Description |
|---|---|---|
| `auto` | Automatic | Default. The assistant picks the best available backend based on context (extension > cdp-inspect > local). |
| `extension` | Chrome extension | Routes through the user's Chrome browser via the extension debugger. |
| `cdp-inspect` | CDP inspect | Connects to an already-running Chrome instance via the DevTools protocol. Alias: `cdp-debugger`. |
| `local` | Playwright | Drives a dedicated Playwright-managed Chromium instance. Alias: `playwright`. |

**When to use `auto`**: Prefer `auto` (or omit `browser_mode` entirely) unless you have a specific reason to pin. The automatic backend selection handles extension availability, fallback, and session reuse.

**When to pin a mode**: Pin explicitly when:
- The user requests interaction with their own browser (use `extension` or `cdp-inspect`).
- A tool only works on a specific backend (e.g. `browser_wait_for_download` requires `local`).
- You want to avoid fallback behavior for diagnostic clarity.

**Unsupported mode errors**: Some tools restrict which modes they support. For example, `browser_wait_for_download` only supports `auto` and `local` because file downloads require the Playwright backend. Passing an unsupported mode returns a clear error with the accepted alternatives.

## Typical Workflow

1. `browser_attach` to establish the debugger session (extension path; optional on other backends)
2. `browser_navigate` to load a page
3. `browser_snapshot` to discover interactive elements
4. Use `browser_click`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_select_option`, or `browser_hover` to interact
5. `browser_extract` or `browser_screenshot` to capture results
6. `browser_detach` to end the debugger session, or `browser_close` to close the page entirely

## Interaction Strategies

**Date pickers / calendars:** Click the date input to open the picker, re-snapshot to see calendar controls, click month navigation arrows to reach the target month, then click the target date. For `<input type="date">`, use `browser_type` with `YYYY-MM-DD` format.

**Native `<select>` elements:** Use `browser_select_option` with `value`, `label`, or `index`. Do not try to click individual `<option>` elements.

**ARIA / custom dropdowns:** Click to open, take a new `browser_snapshot`, then click the desired option by `element_id`.

**Autocomplete inputs:** Type the search text, wait 500–1000ms (`browser_wait_for` with duration), re-snapshot for suggestions, then click the suggestion or use ArrowDown + Enter.

**Multi-step forms:** Complete each step, wait for the next section to load, re-snapshot to discover new elements, then proceed.

**Dynamic content:** After interactions that change the page, use `browser_wait_for` (selector or text) or re-snapshot to see updated elements before continuing.

**Scrolling:** Use `browser_scroll` to reveal below-the-fold content before snapshotting. Long pages may require multiple scrolls.

**Hover menus / tooltips:** Use `browser_hover` to reveal hidden menus or tooltips, then re-snapshot to see newly revealed elements.

## Verification

Use `browser_screenshot` after critical actions (form submission, booking confirmation, checkout) to visually verify results before reporting success to the user.
