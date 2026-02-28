---
fixture: desktop-app
required_env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
---

# Twilio Voice Setup: Configure Phone Calling via Settings

## Goal

Launch the desktop application, navigate to Settings > Channels, and configure the Phone Calling channel with Twilio credentials and a phone number.

## Steps

1. Launch the app and wait until it reaches a usable UI state (past any onboarding screens).
2. Open **Settings** (use the gear icon or keyboard shortcut).
3. Navigate to the **Channels** tab within Settings.
4. Locate the **Phone Calling** card (not SMS).
5. If the Credentials row shows a "Set Up" or similar button, click it to open the credential form.
6. Fill the **Account SID** field with the value of `TWILIO_ACCOUNT_SID` from the environment.
7. Fill the **Auth Token** field using `type_env_var` with `TWILIO_AUTH_TOKEN` (this keeps the secret out of logs).
8. Click **Save Credentials** and wait for the save to complete.
9. Verify the Credentials row now shows a configured/saved state (no error text).
10. Open the **Phone Number** row by clicking **Change** (or the equivalent button).
11. If a phone number is listed, click **Use** to assign it. If a number is already assigned (shows "Current"), leave it as-is.
12. Verify the Phone Number row does **not** show "Not assigned".
13. Verify there is no visible error text in the Phone Calling card.
14. Take a screenshot of the final configured Phone Calling card state.
15. Call `report_result` exactly once with the test outcome.

## Expected

- **Credentials** row shows a configured/saved state (not an empty or errored form).
- **Phone Number** row displays an E.164-like phone number (e.g., `+1...`) or at minimum does not show "Not assigned".
- No visible error text anywhere in the Phone Calling card.
