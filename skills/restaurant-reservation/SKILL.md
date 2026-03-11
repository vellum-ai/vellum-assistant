---
name: restaurant-reservation
description: Book reservations on OpenTable or Resy with explicit confirmations
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🍽️"
  vellum:
    display-name: "Restaurant Reservation Booking"
    user-invocable: true
    includes: ["browser"]
    disable-model-invocation: true
---

Book restaurant reservations on OpenTable or Resy using browser automation.

## Anti-Loop Guardrails

Each step has a **retry budget of 3 attempts**. An attempt is one try at the step's primary action (e.g., clicking a button, filling a form, navigating a page). If a step fails after 3 attempts:

1. **Stop trying.** Do not continue retrying the same approach.
2. **Fall back to manual.** Tell the user what you were trying to do and ask them to complete that step manually in the browser. Give them the direct URL and clear instructions.
3. **Resume automation** at the next step once the user confirms the manual step is done.

If **two or more steps** require manual fallback, inform the user the automated flow is unreliable and offer to provide the remaining steps as text instructions with links.

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
- Do NOT attempt to browse provider sites to check restaurant availability before signing in — authentication is required first. If the user names a specific restaurant but isn't sure which provider has it, pick the more common one (OpenTable) and fall back to the other if it's not found after searching in Step 4.

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
3. If a specific restaurant was named, navigate directly to its page if possible (e.g. `https://www.opentable.com/r/<restaurant-slug>` or `https://resy.com/cities/<city>/venues/<restaurant-slug>`). **After landing on the restaurant page, reapply the user's date, time, and party size filters** — direct restaurant URLs often show default availability that may not match the user's request. Use the on-page date picker, time selector, and party size controls to set the correct values before reviewing slots.
4. Take a `browser_snapshot` and review the results.
5. **If the named restaurant is not found on this provider**, tell the user and offer to try the other provider (OpenTable <-> Resy). If they agree, go back to Step 3 to sign in to the other provider.

### Step 5: Present Available Slots

1. Extract available time slots from the page.
2. Present them to the user in a clear, organized format.
3. If **NO slots** match the requested time:
   - Offer nearby times on the same date.
   - Offer the same time on adjacent dates.
   - Suggest trying the other provider (OpenTable <-> Resy).
4. Let the user choose a slot.
5. **Click the chosen slot on the page** to select it. Take a fresh `browser_snapshot` to confirm the slot is selected and the booking/confirmation form is now visible. Do not proceed to confirmation steps until the slot is actively selected in the site UI.

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

**If the restaurant charges a cancellation or no-show fee, call it out explicitly in a separate line** — do not bury it in other details. Example: "This restaurant charges a $25/person no-show fee."

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

## Critical Rules

- **ALWAYS sign in first.** Do not attempt to search or browse availability before signing in.
- **NEVER tell the user to sign in themselves.** You handle ALL authentication using `browser_fill_credential` and `ui_show` for verification codes.
- **NEVER give up.** If an interaction fails, take a fresh `browser_snapshot` and retry with updated element IDs — within the 3-attempt budget per step.
- **Target elements by `element_id`** from `browser_snapshot`. Never fabricate CSS selectors.
- **Use `browser_select_option` for native `<select>` dropdowns** (e.g., party size selectors). For non-native dropdowns, ARIA listboxes, and date/time pickers, use `ArrowDown`/`ArrowUp` + `Enter` via `browser_press_key`.
- **Use `browser_scroll`** to reveal off-screen time slots or search results before interacting with them.
- **Handle CAPTCHAs:** If a Cloudflare/CAPTCHA challenge appears, wait a few seconds — it often auto-resolves. If it persists, the system will hand off to the user automatically.
- **Fresh snapshots after every action** that changes the page. Element IDs go stale after navigation or DOM updates.
- **Conserve context.** Browser flows are token-heavy. Avoid unnecessary snapshots — only take one when the page changes. Combine multiple actions efficiently. Do not narrate every step in detail.
- **ALWAYS surface cancellation and no-show fees.** Before confirming any reservation, check for cancellation policies, no-show fees, deposits, and credit card holds. If the restaurant charges any fee, call it out explicitly — do not bury it in other details. The user must acknowledge fees before you proceed.
- **Two confirmations required.** Never submit a reservation without both the policy confirmation (Step 6) and the final pre-submit confirmation (Step 7).

## Error Handling

- **Search returns no results:** Try alternate search terms, broaden the location, or check spelling. If still nothing, suggest the other provider (OpenTable <-> Resy).
- **Expired OTP:** Never retry an old verification code. Always prompt the user for a fresh code via `ui_show` with `await_action: true`.
- **Login fails repeatedly:** After 3 failed attempts, inform the user and ask if they want to try the other provider or handle login manually.
- **Reservation submit fails:** Take a fresh `browser_snapshot`, read the error message, and report it to the user. Common causes: credit card required, party size changed, slot no longer available. Suggest rebooking if the slot was taken.
- **Page unresponsive or stuck:** Wait up to 10 seconds, then try refreshing (`browser_navigate` to the current URL). If still stuck, report to the user.
- **Provider-specific errors:** If one provider consistently errors, suggest switching to the other.
