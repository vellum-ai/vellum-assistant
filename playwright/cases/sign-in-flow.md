---
fixture: desktop-app
status: experimental
---

# Sign In Flow

## Goal

Verify that clicking "Sign in" on the welcome screen initiates the managed sign-in flow, completes authentication via the platform, and results in a responsive assistant.

## Steps

1. Launch the App
2. On the welcome screen, click the "Sign in" button
3. Wait for the sign-in flow to begin — the app should open a browser window or in-app web view pointing to the platform authentication page (https://dev-platform.vellum.ai)
4. Complete the sign-in process on the authentication page
5. After authentication completes, verify that the app proceeds past the welcome screen
6. Wait for the assistant to finish setting up and become ready
7. Send a message like "hello" in the chat
8. Verify that the assistant responds to the message

## Expected

- Clicking "Sign in" should initiate the managed authentication flow
- A browser or in-app web view should open to the platform authentication page at https://dev-platform.vellum.ai
- After signing in, the app should proceed through onboarding and the assistant should become ready
- The assistant should respond to a chat message, confirming it is fully functional
