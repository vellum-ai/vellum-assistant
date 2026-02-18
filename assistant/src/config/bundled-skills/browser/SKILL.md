---
name: "Browser"
description: "Navigate and interact with web pages using a headless browser"
user-invocable: false
disable-model-invocation: true
metadata: {"vellum": {"emoji": "🌐"}}
---

Use this skill to browse the web. After loading this skill, the following browser tools become available:

- `browser_navigate` — Navigate to a URL
- `browser_snapshot` — List interactive elements on the current page
- `browser_screenshot` — Take a visual screenshot
- `browser_close` — Close the browser page
- `browser_click` — Click an element
- `browser_type` — Type text into an input
- `browser_press_key` — Press a keyboard key
- `browser_wait_for` — Wait for a condition
- `browser_extract` — Extract page text content
- `browser_fill_credential` — Fill a stored credential into a form field

## Typical Workflow

1. `browser_navigate` to load a page
2. `browser_snapshot` to discover interactive elements
3. Use `browser_click`, `browser_type`, or `browser_press_key` to interact
4. `browser_extract` or `browser_screenshot` to capture results
5. `browser_close` when done
