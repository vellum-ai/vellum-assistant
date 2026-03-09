---
fixture: desktop-app
status: experimental
---

# Sign In Flow

## Goal

Verify that clicking "Sign in" on the welcome screen initiates the managed sign-in flow and opens the platform authentication page.

## Steps

1. Launch the App
2. On the welcome screen, click the "Sign in" button
3. Wait for the sign-in flow to begin — the app should open a browser window or in-app web view pointing to the platform authentication page (https://dev-platform.vellum.ai)
4. Verify that the authentication page has loaded and is requesting the user to sign in

## Expected

- Clicking "Sign in" should initiate the managed authentication flow
- A browser or in-app web view should open to the platform authentication page at https://dev-platform.vellum.ai
- The authentication page should be visible and ready for user input
