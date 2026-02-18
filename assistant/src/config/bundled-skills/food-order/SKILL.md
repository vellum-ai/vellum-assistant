---
name: "Food Order"
description: "Order food from delivery services like DoorDash, Uber Eats, Grubhub"
user-invocable: true
disable-model-invocation: false
metadata: {"vellum": {"emoji": "🍕"}}
---

Order food from delivery services (DoorDash, Uber Eats, Grubhub, etc.) using browser automation.

**Before starting:** Load the `browser` skill if not already loaded (`skill_load` with `skill: "browser"`).

## Ordering Flow — Follow These Steps IN ORDER

### Step 1: Navigate and Sign In FIRST

This is the most important step. Delivery sites block browsing and ordering without being signed in.

1. **Navigate directly to the sign-in page.**
   - **For DoorDash**, use this OAuth URL:
     `https://identity.doordash.com/auth?client_id=1666519390426295040&layout=consumer_web&redirect_uri=https%3A%2F%2Fwww.doordash.com%2Fpost-login%2F&response_type=code&scope=%2A&state=%2Fhome`
   - **For other services** (Uber Eats, Grubhub, etc.), navigate to their homepage and find the "Sign In" button.
2. Take a `browser_snapshot`. If you see a sign-in form (email input), continue to sub-step 5 below (fill the email).
3. **If the direct URL fails** (404, "State cannot be null or empty", or any error): fall back to the homepage approach — navigate to the service's homepage, dismiss non-login modals, and click the "Sign In" button. **On DoorDash, clicking "Sign In" opens a sign-in MODAL — this modal IS the sign-in form, do NOT dismiss it.** Look for an email input inside the modal.
4. If already signed in (you see "Welcome back", account menu, or the user's name), skip to Step 2.
5. Fill the email using `browser_fill_credential` (e.g. service: "doordash", field: "email"). Target the element by its `element_id` — NEVER type into the browser URL bar.
6. Click "Continue" or equivalent submit button.
7. The site will send a verification code via SMS/email. Use `ui_show` with `surface_type: "form"` and `await_action: true` to ask the user for the code. **Wait for the user to submit the form before proceeding** — do NOT use any previously collected code. Verification codes expire quickly; only the code from the most recent form submission is valid. Type the freshly submitted code into the verification input on the page.
8. If the code is rejected, prompt the user again with a fresh `ui_show` form — never retry an old code.

### EVERY snapshot: Dismiss modals FIRST

**Before every other action**, scan the snapshot for **non-functional** modal overlays and dismiss them. Modals block all interactions — clicking behind a modal silently fails.
- **DO NOT dismiss sign-in/login modals** — if you see an email input or sign-in form inside a modal, that IS the sign-in flow. Fill it in, don't close it.
- Dismiss only blocker modals: cookie banners, regulatory notices, promotional popups.
- Look for: "Got It", "Accept", "Close", "OK", "Dismiss" buttons on non-login modals.
- Take a fresh snapshot after dismissing to confirm the modal is gone.
- Common DoorDash blocker modals: "NYC & NY law update" (click "Got It"), cookie banners, promotional popups.

### Step 2: Set Delivery Address

1. Find the address input field in the snapshot.
2. Type the delivery address.
3. Use `browser_press_key` with `ArrowDown` then `Enter` to select from the address suggestion dropdown.
4. Do NOT click dropdown items directly — they are dynamic overlays and clicks are unreliable.

### Step 3: Search for the Restaurant

1. Find the search bar in `browser_snapshot`.
2. Type the restaurant name using `browser_type`.
3. Use `browser_press_key` with `ArrowDown` then `Enter` to select from search suggestions.

### Step 4: Find and Add the Item

1. Browse the restaurant's menu page.
2. Click the desired menu item.
3. If there are required customizations (size, toppings, quantity), select them.
4. Click "Add to Order" / "Add to Cart".

### Step 5: Checkout

1. Navigate to the cart / checkout.
2. Review order details with the user before placing.
3. Confirm payment method and delivery details.
4. Only place the order after explicit user confirmation.

## Critical Rules

- **ALWAYS sign in first.** Do not attempt to search or browse the menu before signing in.
- **NEVER tell the user to sign in themselves.** You handle ALL authentication using `browser_fill_credential` and `ui_show` for verification codes.
- **NEVER give up.** If an interaction fails, take a fresh `browser_snapshot` and retry with updated element IDs.
- **Target elements by `element_id`** from `browser_snapshot`. Never fabricate CSS selectors.
- **Use arrow keys for dropdowns.** Address pickers, search suggestions, and autocomplete menus should be navigated with `ArrowDown`/`ArrowUp` + `Enter`, not clicks.
- **Handle CAPTCHAs:** If a Cloudflare/CAPTCHA challenge appears, wait a few seconds — it often auto-resolves. If it persists, the system will hand off to the user automatically.
- **Fresh snapshots after every action** that changes the page. Element IDs go stale after navigation or DOM updates.
- **Conserve context.** Browser flows are token-heavy. Avoid unnecessary snapshots — only take one when the page changes. Combine multiple actions (dismiss modal + take snapshot) efficiently. Do not narrate every step in detail.
