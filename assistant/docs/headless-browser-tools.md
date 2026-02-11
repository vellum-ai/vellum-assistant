# Headless Browser Tools

Vellum Assistant includes a set of headless browser tools powered by Playwright (Chromium). These tools allow the assistant to navigate web pages, inspect DOM elements, interact with forms, and extract content.

## Prerequisites

Playwright and Chromium must be installed:

```bash
bun add playwright
bunx playwright install --with-deps chromium
```

On cloud instances, the startup script handles this automatically.

Use `vellum doctor` to verify browser runtime readiness.

## Architecture

- **Browser manager** (`browser-manager.ts`): Singleton that manages a persistent Chromium browser context with a profile directory at `~/.vellum/browser-profile`. Pages are allocated per session and share the same browser context.
- **Session isolation**: Each conversation session gets its own browser page. Pages are reused across tool calls within the same session.
- **Snapshot map**: `browser_snapshot` assigns deterministic element IDs (`e1`, `e2`, ...) to interactive elements and stores a mapping from element ID to CSS selector. Other tools (`browser_click`, `browser_type`, `browser_press_key`) use this mapping to resolve `element_id` parameters.

## Security Defaults

- **Private/local network blocking**: `browser_navigate` blocks navigation to localhost, private IP ranges, and hostnames that resolve to private addresses by default. Set `allow_private_network: true` to override.
- **DNS resolution check**: Hostnames are resolved before navigation to prevent SSRF via DNS rebinding.
- **Headless only**: The browser always runs in headless mode.
- **Chromium only**: Only Chromium is supported (no Firefox or WebKit).

## Tools

### `browser_navigate`

Navigate to a URL and return the page title and HTTP status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | yes | The URL to navigate to. If scheme is missing, `https://` is assumed. |
| `allow_private_network` | boolean | no | Allow navigation to localhost/private-network hosts. Default: `false`. |

**Risk level**: Low (Medium when `allow_private_network` is true).

### `browser_snapshot`

List interactive elements on the current page. Returns elements with unique IDs that can be used with `browser_click`, `browser_type`, and `browser_press_key`.

No parameters.

**Risk level**: Low.

**Output format**:
```
URL: https://example.com/
Title: Example

[e1] <a href="/about"> About
[e2] <input type="text" name="q" placeholder="Search">
[e3] <button> Submit

3 interactive elements found.
```

Interactive elements detected: `a[href]`, `button`, `input`, `select`, `textarea`, and elements with ARIA roles (`button`, `link`, `checkbox`, `radio`, `tab`, `menuitem`), plus `[contenteditable="true"]`. Only visible elements (non-zero bounding rect) are included, capped at 500.

### `browser_close`

Close the browser page for the current session, or all pages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `close_all_pages` | boolean | no | If true, close all pages and the browser context. Default: `false`. |

**Risk level**: Medium.

### `browser_click`

Click an element on the page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_id` | string | no | Element ID from a previous `browser_snapshot` (e.g. `"e1"`). |
| `selector` | string | no | CSS selector fallback when `element_id` is not available. |

At least one of `element_id` or `selector` is required. When both are provided, `element_id` takes precedence.

**Risk level**: Medium.

### `browser_type`

Type text into an input element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element_id` | string | no | Element ID from `browser_snapshot`. |
| `selector` | string | no | CSS selector fallback. |
| `text` | string | yes | The text to type. |
| `clear_first` | boolean | no | Clear existing content before typing. Default: `true`. |
| `press_enter` | boolean | no | Press Enter after typing. Default: `false`. |

**Risk level**: Medium.

### `browser_press_key`

Press a keyboard key, optionally targeting a specific element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | The key to press (e.g. `"Enter"`, `"Escape"`, `"Tab"`, `"ArrowDown"`). |
| `element_id` | string | no | Optional element ID to target. |
| `selector` | string | no | Optional CSS selector to target. |

When no target is specified, the key is pressed on the currently focused element.

**Risk level**: Medium.

### `browser_wait_for`

Wait for a condition on the page. Exactly one mode must be specified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | no | Wait for an element matching this CSS selector to appear. |
| `text` | string | no | Wait for this text to appear on the page. |
| `duration` | number | no | Wait for this many milliseconds. |
| `timeout` | number | no | Maximum wait time in milliseconds. Default and max: 30000. |

**Risk level**: Low.

### `browser_extract`

Extract the text content of the current page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_links` | boolean | no | Include a list of links found on the page (up to 200). Default: `false`. |

Text content is capped at 50,000 characters to prevent excessive token usage.

**Risk level**: Low.

## Permission and Trust Rules

Browser tools follow the standard permission system:

- **Low risk** tools (`browser_navigate`, `browser_snapshot`, `browser_wait_for`, `browser_extract`) are auto-allowed.
- **Medium risk** tools (`browser_close`, `browser_click`, `browser_type`, `browser_press_key`) check trust rules and prompt if no match.
- `browser_navigate` uses URL-scoped trust rules (same format as `web_fetch`), allowing patterns like `browser_navigate:https://example.com/*`.

## Cloud Provisioning

On cloud compute instances, the startup script installs Chromium automatically via `bunx playwright install --with-deps chromium` after `bun install`. This path is currently prepared for when cloud compute routes are re-enabled.

## Typical Workflow

1. `browser_navigate` to load a page.
2. `browser_snapshot` to see interactive elements.
3. `browser_click` / `browser_type` / `browser_press_key` to interact.
4. `browser_wait_for` to wait for page updates.
5. `browser_extract` to read page content.
6. `browser_close` when done.
