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

### EVERY snapshot: Dismiss modals FIRST

**Before every other action**, scan the snapshot for **non-functional** modal overlays and dismiss them. Modals block all interactions — clicking behind a modal silently fails.
- **DO NOT dismiss sign-in/login modals** — if you see an email input or sign-in form inside a modal, that IS the sign-in flow. Fill it in, don't close it.
- Dismiss only blocker modals: cookie banners, regulatory notices, promotional popups.
- Look for: "Got It", "Accept", "Close", "OK", "Dismiss" buttons on non-login modals.
- Take a fresh snapshot after dismissing to confirm the modal is gone.

### Step 4: Search for Availability

1. **For OpenTable**, navigate directly to:
   `https://www.opentable.com/s?covers=<party_size>&dateTime=<YYYY-MM-DDTHH:MM>&term=<restaurant_or_location>`
   Construct the URL from the details collected in Step 1. URL-encode the `term` parameter.
2. **For Resy**, navigate to `https://resy.com/cities/<city>` and use the search/filter UI to find available reservations matching the collected details.
3. If a specific restaurant was named, navigate directly to its page if possible (e.g. `https://www.opentable.com/r/<restaurant-slug>` or `https://resy.com/cities/<city>/venues/<restaurant-slug>`).
4. Take a `browser_snapshot` and review the results.

### Step 5: Present Available Slots

1. Extract available time slots from the page.
2. Present them to the user in a clear, organized format.
3. If **NO slots** match the requested time:
   - Offer nearby times on the same date.
   - Offer the same time on adjacent dates.
   - Suggest trying the other provider (OpenTable ↔ Resy).
4. Let the user choose a slot.

### Step 6: First Confirmation — Reservation Details + Policies

Before proceeding to book, show the user a summary:
- Restaurant name
- Date and time
- Party size
- Any special notes

**CRITICAL: Surface cancellation policies and fees prominently.** Look for and extract:
- Cancellation deadlines (e.g., "Cancel by 4 hours before")
- No-show fees (e.g., "$25 per person no-show fee")
- Deposit requirements
- Credit card hold amounts

**If the restaurant charges a cancellation or no-show fee, call it out explicitly in a separate line** — do not bury it in other details. Example: "⚠️ This restaurant charges a $25/person no-show fee."

Ask the user to confirm they want to proceed.

### Step 7: Final Confirmation — Pre-Submit Approval

Immediately before clicking the final "Complete Reservation" / "Confirm" button, ask one more time:
- "Ready to submit this reservation? This action cannot be undone."

Only proceed after explicit user approval.

### Step 8: Submit and Confirm

1. Click the final reservation submit button.
2. Take a `browser_snapshot` to confirm success.
3. Extract and present to the user:
   - Confirmation number / reference ID (if visible)
   - Confirmation page link
   - Final reservation details as shown on the confirmation page
4. If the submission fails, take a fresh `browser_snapshot` and report the error.
