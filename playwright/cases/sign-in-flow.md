---
fixture: desktop-app
status: experimental
required_env: E2E_GMAIL_TEST_USER_PASSWORD
---

# Sign In Flow

## Goal

Verify that clicking "Sign in" on the welcome screen initiates the managed sign-in flow, completes authentication via the platform, and results in a responsive assistant.

## Credentials

- **Email:** `testing@vellum.ai`
- **Password:** Use the `E2E_GMAIL_TEST_USER_PASSWORD` environment variable (type it with `type_env_var`)

## Steps

1. Launch the App
2. On the welcome screen, click the "Sign in" button
3. Wait for the sign-in flow to begin — the app should open a browser window or in-app web view pointing to the platform authentication page (https://dev-platform.vellum.ai)
4. On the authentication page, enter the email `testing@vellum.ai` into the email field
5. Enter the password by using `type_env_var` with `E2E_GMAIL_TEST_USER_PASSWORD` into the password field
6. Submit the sign-in form
7. After authentication completes, verify that the app proceeds past the welcome screen
8. Wait for the assistant to finish setting up and become ready
9. Send a message like "hello" in the chat
10. Verify that the assistant responds to the message

## Expected

- Clicking "Sign in" should initiate the managed authentication flow
- A browser or in-app web view should open to the platform authentication page at https://dev-platform.vellum.ai
- The email `testing@vellum.ai` should be accepted and the password from `E2E_GMAIL_TEST_USER_PASSWORD` should authenticate successfully
- After signing in, the app should proceed through onboarding and the assistant should become ready
- The assistant should respond to a chat message, confirming it is fully functional
