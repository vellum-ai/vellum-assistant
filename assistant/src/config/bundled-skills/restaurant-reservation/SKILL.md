---
name: "Restaurant Reservation Booking"
description: "Book reservations on OpenTable or Resy with explicit confirmations"
user-invocable: true
disable-model-invocation: false
metadata: {"vellum": {"emoji": "🍽️"}}
---

Book restaurant reservations on OpenTable or Resy using browser automation.

**Before starting:** Load the `browser` skill if not already loaded (`skill_load` with `skill: "browser"`).

## Booking Flow — Follow These Steps IN ORDER

### Step 1: Collect Reservation Details

Before doing anything, gather the following from the user:

- **Party size** (required)
- **Date** (required)
- **Time or time window** (required)
- **Location / neighborhood / city** (required)
- **Restaurant name** (optional — if not provided, will search)
- **Any preferences** (outdoor seating, dietary needs, etc.)

Do not proceed until all required details have been provided.

### Step 2: Choose Provider

- If the user hasn't specified a provider, ask them to choose between **OpenTable** and **Resy**.
- If a specific restaurant is requested, check which provider has it before asking.

### Step 3: Navigate and Sign In FIRST

This is the most important step. Reservation sites require authentication before booking.

1. **Navigate directly to the sign-in page.**
   - **For OpenTable**, navigate to: `https://www.opentable.com/sign-in`
   - **For Resy**, navigate to: `https://resy.com/login`
2. Take a `browser_snapshot`. If you see a sign-in form (email input), continue to sub-step 5 below (fill the email).
3. **If the direct URL fails** (404, redirect, or any error): fall back to the homepage approach — navigate to the service's homepage and click the "Sign In" / "Log In" button.
4. If already signed in (you see an account menu, the user's name, or other logged-in indicators), skip to the next step.
5. Fill the email using `browser_fill_credential` (e.g. service: "opentable" or "resy", field: "email"). Target the element by its `element_id` — NEVER type into the browser URL bar.
6. Click "Continue" / "Sign In" or equivalent submit button.
7. The site will send a verification code via SMS/email. Use `ui_show` with `surface_type: "form"` and `await_action: true` to ask the user for the code. **Wait for the user to submit the form before proceeding** — do NOT use any previously collected code. Verification codes expire quickly; only the code from the most recent form submission is valid. Type the freshly submitted code into the verification input on the page.
8. If the code is rejected, prompt the user again with a fresh `ui_show` form — never retry an old code.
9. **For password-based login:** If the site presents a password field instead of a verification code, fill the password using `browser_fill_credential` (e.g. service: "opentable" or "resy", field: "password").
