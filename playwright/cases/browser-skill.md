---
fixture: desktop-app-hatched
status: experimental
---

# Browser Skill Usage

## Goal

Verify that the assistant is able to load the browser skill and use browser tools to navigate to a website, interact with page elements, and extract information from a web page.

## Steps

1. Launch the App
2. Open a chat thread
3. Send the message "Go to https://example.com and tell me what the main heading says on the page"
4. Wait for the assistant to respond. The assistant should automatically load the browser skill and use browser tools (e.g. `browser_navigate`, `browser_snapshot` or `browser_extract`) to visit the page
5. Verify that the assistant's response includes the text "Example Domain", which is the main heading on example.com
6. Send a follow-up message: "Now click the 'More information...' link on the page and tell me what domain you ended up on"
7. Wait for the assistant to respond. The assistant should use browser tools to click the link and report the resulting URL or page content
8. Verify that the assistant's response references "iana.org" (the destination of the "More information..." link on example.com)

## Expected

- The assistant should load the browser skill without being explicitly asked to do so
- The assistant should successfully navigate to https://example.com and report that the main heading is "Example Domain"
- The assistant should be able to click the "More information..." link and navigate to the IANA website
- The assistant should report information about the destination page, referencing "iana.org"
- The chat should remain functional throughout the browsing session
