---
fixture: desktop-app
status: critical
---

# Workspace Files Load on Startup

## Goal

Verify that the assistant correctly loads workspace files (IDENTITY, USER, SOUL) on startup and reflects their contents in behavior.

## Steps

1. Pre-condition: Ensure workspace files exist at ~/.vellum/workspace/ with known content (e.g. a specific assistant name, user name, and personality defined)
2. Launch the app
3. Send a message that would surface identity info (e.g. "What's your name?")
4. Verify the assistant responds with the name defined in IDENTITY.md
5. Send a message that would surface user info (e.g. "What do you know about me?")
6. Verify the assistant references details from USER.md (e.g. user's name, location)
7. Observe the assistant's tone and behavior for consistency with SOUL.md personality settings

## Expected

- The assistant's name matches what is defined in IDENTITY.md
- The assistant references user details from USER.md correctly
- The assistant's tone and behavior reflects the personality defined in SOUL.md
- No errors or fallback behavior indicating files failed to load
- Startup completes without crashes related to missing or malformed workspace files
