---
fixture: desktop-app
---

# Hello World: Open Desktop App and Enter API Key

## Goal

Launch the desktop application, select the "Own API Key" option, and enter an Anthropic API key.

## Steps

1. Verify the built macOS app exists at `{{APP_DIR}}/{{APP_DISPLAY_NAME}}.app`
2. Clear any previous onboarding state by running `defaults delete com.vellum.vellum-assistant` (it's okay if this fails because the domain doesn't exist yet)
3. Launch the app by running `open -a "{{APP_DIR}}/{{APP_DISPLAY_NAME}}.app"`
4. Wait 8 seconds for the app to finish launching
5. Take a screenshot to see the current state
6. Dump the accessibility tree of the app's first window for debugging by running an AppleScript that asks System Events for the `entire contents of window 1` of the process "{{APP_DISPLAY_NAME}}"
7. Click the first button in the main group of the window (this is the "Own API Key" Start button). Use AppleScript to tell System Events to click `button 1 of group 1 of window 1` of the process "{{APP_DISPLAY_NAME}}"
8. Wait 3 seconds
9. Take a screenshot to see the API key entry step
10. Dump the accessibility tree again to see the current state
11. Type the API key `{{ANTHROPIC_API_KEY}}` using AppleScript keystroke into the process "{{APP_DISPLAY_NAME}}"
12. Wait 3 seconds
13. Take a screenshot to confirm the key was entered

## Expected

- The app should still be running with at least one window open. Verify by using AppleScript to count the windows of process "{{APP_DISPLAY_NAME}}" — the count should be greater than 0.
