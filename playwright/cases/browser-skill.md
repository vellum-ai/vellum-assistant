---
fixture: desktop-app-hatched
status: experimental
---

# Browser Skill Usage

## Goal

Verify that the assistant is able to load the browser skill and use browser tools to navigate to a website and capture a screenshot of the page.

## Steps

1. Launch the App
2. Open a chat thread
3. Send the message "Go to https://vellum.ai and take a screenshot of the page for me"
4. Wait for the assistant to respond. The assistant should automatically load the browser skill and use browser tools (e.g. `browser_navigate`, `browser_screenshot`) to visit the page and capture a screenshot
5. Verify that the assistant's response includes a screenshot attachment or image showing the vellum.ai homepage
6. Verify that the assistant confirms it navigated to vellum.ai and provides the screenshot

## Expected

- The assistant should load the browser skill without being explicitly asked to do so
- The assistant should successfully navigate to https://vellum.ai using `browser_navigate`
- The assistant should take a screenshot of the page using `browser_screenshot` and share it in the conversation
- The chat should remain functional after the browsing session
