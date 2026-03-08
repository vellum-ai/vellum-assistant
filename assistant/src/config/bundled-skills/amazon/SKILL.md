---
name: amazon
description: Shop on Amazon and Amazon Fresh using the built-in CLI integration
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"📦","vellum":{"display-name":"Amazon","user-invocable":true}}
---

You can shop on Amazon (and Amazon Fresh for groceries) for the user using the `assistant amazon` CLI.

## CLI Setup

**IMPORTANT: Always use `host_bash` (not `bash`) for all `assistant amazon` commands.** The Amazon CLI needs host access for session cookies and the `vellum` binary — neither of which are available inside the sandbox.

`assistant amazon` is a built-in subcommand of the Vellum assistant CLI — it is NOT a separate tool you need to find or install. It should already be on your PATH. If `vellum` is not found, prepend `PATH="$HOME/.local/bin:$PATH"` to the command. Do NOT search for the binary, inspect wrapper scripts, or try to discover how the CLI works. Just run the commands as documented below.

## Typical Flow — Regular Amazon Shopping

When the user asks you to order something from Amazon:

1. **Check session** — run `assistant amazon status --json`. If `loggedIn` is false or the session is expired, tell the user: "A Chrome window will open to the Amazon login page. Please sign in there — I'll detect your login automatically and minimize the window." Then run `assistant amazon refresh --json`. This starts a Ride Shotgun learn session that records your login and auto-stops once it detects you've signed in. The session is imported automatically. **This command blocks until login is complete — just wait for it.**

2. **Search** — run `assistant amazon search "<query>" --json` to find matching products. Present the top results with ASIN, title, price, and Prime status. If the user named a specific product, pick the best match. If ambiguous, ask.

3. **Product details** (if needed) — run `assistant amazon product <asin> --json` to get full details including price and variations. For products with variants (size, color, etc.), see the Variations section below.

4. **Add to cart** — run `assistant amazon cart add --asin <asin> [--quantity <n>] --json`. The response includes the updated cart with all items.

5. **Review cart** — run `assistant amazon cart view --json` and show the user what's in their cart with prices. Ask if they want to add anything else or proceed.

6. **Payment methods** — run `assistant amazon payment-methods --json` to see saved cards.

7. **Checkout summary** — run `assistant amazon checkout --json` to get order totals (subtotal, shipping, tax, total).

8. **Place order** — after the user explicitly confirms, run `assistant amazon order place [--payment-method-id <id>] --json`. The response contains `orderId` on success.

## Typical Flow — Amazon Fresh Groceries

Amazon Fresh delivers groceries. The flow is the same as regular Amazon, with these additions:

1. **Search Fresh** — use the `--fresh` flag: `assistant amazon search "<query>" --fresh --json`

2. **Add Fresh items** — use the `--fresh` flag: `assistant amazon cart add --asin <asin> --fresh --json`

3. **Select delivery slot** — Fresh orders require a delivery window:
   - `assistant amazon fresh delivery-slots --json` — list available slots
   - `assistant amazon fresh select-slot --slot-id <id> --json` — select a slot
   - Do this BEFORE checkout.

4. **Checkout and order** — same as regular Amazon.

## Handling Variations

Many Amazon products (clothing, electronics) have variations (size, color, style):

1. Run `assistant amazon product <asin> --json` to get the product and its `variations[]` array
2. Each variation has: `dimensionName` (e.g. "size"), `value` (e.g. "Large"), `asin` (child ASIN), `isAvailable`, `priceValue`
3. Use the child ASIN when adding to cart: `assistant amazon cart add --asin <child-asin> --json`

Alternatively, run `assistant amazon variations <asin> --json` to list just the variations.

## Important Behavior

- **Chrome extension relay required.** The Amazon CLI uses `assistant browser chrome relay` internally for browser automation. The Chrome extension must be connected before Amazon commands will work. If a command fails with a connection error, tell the user: "Please open Chrome, click the Vellum extension icon, and click Connect — then I'll retry."
- **Always confirm before placing order.** Never call `order place` without explicit user approval. Show the cart and total first.
- **Be proactive.** If the user says "order AA batteries", don't ask clarifying questions upfront — search, find the product, and suggest it. Only ask when you need a choice the user hasn't specified.
- **Handle expired sessions gracefully.** If any command returns `"error": "session_expired"`, run `assistant amazon refresh --json` to re-capture the session.
- **Show prices.** Always show prices when presenting products or the cart summary.
- **Use `--json` flag** on all commands for reliable parsing.
- **Do NOT use the browser skill.** All Amazon interaction goes through the CLI, not browser automation.
- **Rate limiting.** Amazon may rate-limit rapid sequential requests. Wait 8–10 seconds between cart operations. If you get a 403 error, wait 15–20 seconds and retry.
- **Always-allow tip.** At the start of an ordering flow, suggest the user enable "always allow" for `assistant amazon` commands: "Tip: You can type 'a' to always allow `assistant amazon` commands for this session so you won't be prompted each time."
- **Fresh slot required.** Amazon Fresh orders require a delivery slot to be selected before checkout. If the user skips this step, remind them to run `assistant amazon fresh delivery-slots --json` and select a slot.

## Command Reference

```
assistant amazon status --json                     # Check if logged in
assistant amazon refresh --json                    # Capture fresh session via Ride Shotgun
assistant amazon login --recording <path>          # Import session from a recording file
assistant amazon logout                            # Clear session

assistant amazon search "<query>" [--fresh] [--limit <n>] --json
assistant amazon product <asin> [--fresh] --json
assistant amazon variations <asin> --json

assistant amazon cart view --json
assistant amazon cart add --asin <asin> [--quantity <n>] [--fresh] --json
assistant amazon cart remove --cart-item-id <id> --json

assistant amazon fresh delivery-slots --json
assistant amazon fresh select-slot --slot-id <id> --json

assistant amazon payment-methods --json
assistant amazon checkout --json
assistant amazon order place [--payment-method-id <id>] --json
```

## Example Interactions

**User**: "Order a pack of AA batteries from Amazon"

1. `assistant amazon status --json` → logged in
2. `assistant amazon search "AA batteries" --json` → finds products
3. Show top results: "Duracell AA 20-pack ($12.99, Prime), Amazon Basics AA 48-pack ($14.49, Prime)..."
4. User picks Duracell → `assistant amazon cart add --asin B00000J1ER --json`
5. `assistant amazon cart view --json` → show cart summary
6. `assistant amazon checkout --json` → show total
7. "Your cart has 1x Duracell AA Batteries 20-pack ($12.99), total $12.99 with free Prime shipping. Ready to order?"
8. User confirms → `assistant amazon order place --json`

**User**: "Order a large blue t-shirt from Amazon"

1. `assistant amazon search "blue t-shirt" --json` → finds products
2. User picks a shirt → `assistant amazon variations <parentAsin> --json` → shows Size + Color combinations
3. Find the child ASIN for Large + Blue → `assistant amazon cart add --asin <childAsin> --json`

**User**: "Order milk and eggs from Amazon Fresh"

1. `assistant amazon status --json` → logged in
2. `assistant amazon search "whole milk" --fresh --json` → Fresh results
3. `assistant amazon cart add --asin <milkAsin> --fresh --json`
4. `assistant amazon search "eggs" --fresh --json` → Fresh results
5. `assistant amazon cart add --asin <eggsAsin> --fresh --json`
6. `assistant amazon fresh delivery-slots --json` → show available slots
7. User picks a slot → `assistant amazon fresh select-slot --slot-id <id> --json`
8. `assistant amazon checkout --json` → show totals
9. User confirms → `assistant amazon order place --json`
