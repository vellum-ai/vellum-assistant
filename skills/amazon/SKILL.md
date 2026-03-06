---
name: "amazon"
description: "Shop on Amazon and Amazon Fresh using the CLI integration"
metadata:
  emoji: "📦"
  vellum:
    user-invocable: true
    cli:
      command: "amazon"
      entry: "scripts/amazon.ts"
---

You can shop on Amazon (and Amazon Fresh for groceries) for the user using the Amazon CLI.

## Usage

Run the Amazon CLI via:

```bash
bun run scripts/amazon.ts <command> [options] --json
```

**IMPORTANT: Always use `host_bash` (not `bash`) for all Amazon commands.** The CLI needs host access for session cookies and the Ride Shotgun session capture — neither of which are available inside the sandbox.

## Typical Flow — Regular Amazon Shopping

When the user asks you to order something from Amazon:

1. **Check session** — run `bun run scripts/amazon.ts status --json`. If `loggedIn` is false or the session is expired, tell the user: "A Chrome window will open to the Amazon login page. Please sign in there — I'll detect your login automatically and minimize the window." Then run `bun run scripts/amazon.ts refresh --json`. This starts a Ride Shotgun learn session that records your login and auto-stops once it detects you've signed in. The session is imported automatically. **This command blocks until login is complete — just wait for it.**

2. **Search** — run `bun run scripts/amazon.ts search "<query>" --json` to find matching products. Present the top results with ASIN, title, price, and Prime status. If the user named a specific product, pick the best match. If ambiguous, ask.

3. **Product details** (if needed) — run `bun run scripts/amazon.ts product <asin> --json` to get full details including price and variations. For products with variants (size, color, etc.), see the Variations section below.

4. **Add to cart** — run `bun run scripts/amazon.ts cart add --asin <asin> [--quantity <n>] --json`. The response includes the updated cart with all items.

5. **Review cart** — run `bun run scripts/amazon.ts cart view --json` and show the user what's in their cart with prices. Ask if they want to add anything else or proceed.

6. **Payment methods** — run `bun run scripts/amazon.ts payment-methods --json` to see saved cards.

7. **Checkout summary** — run `bun run scripts/amazon.ts checkout --json` to get order totals (subtotal, shipping, tax, total).

8. **Place order** — after the user explicitly confirms, run `bun run scripts/amazon.ts order place [--payment-method-id <id>] --json`. The response contains `orderId` on success.

## Typical Flow — Amazon Fresh Groceries

Amazon Fresh delivers groceries. The flow is the same as regular Amazon, with these additions:

1. **Search Fresh** — use the `--fresh` flag: `bun run scripts/amazon.ts search "<query>" --fresh --json`

2. **Add Fresh items** — use the `--fresh` flag: `bun run scripts/amazon.ts cart add --asin <asin> --fresh --json`

3. **Select delivery slot** — Fresh orders require a delivery window:
   - `bun run scripts/amazon.ts fresh delivery-slots --json` — list available slots
   - `bun run scripts/amazon.ts fresh select-slot --slot-id <id> --json` — select a slot
   - Do this BEFORE checkout.

4. **Checkout and order** — same as regular Amazon.

## Handling Variations

Many Amazon products (clothing, electronics) have variations (size, color, style):

1. Run `bun run scripts/amazon.ts product <asin> --json` to get the product and its `variations[]` array
2. Each variation has: `dimensionName` (e.g. "size"), `value` (e.g. "Large"), `asin` (child ASIN), `isAvailable`, `priceValue`
3. Use the child ASIN when adding to cart: `bun run scripts/amazon.ts cart add --asin <child-asin> --json`

Alternatively, run `bun run scripts/amazon.ts variations <asin> --json` to list just the variations.

## Important Behavior

- **Always confirm before placing order.** Never call `order place` without explicit user approval. Show the cart and total first.
- **Be proactive.** If the user says "order AA batteries", don't ask clarifying questions upfront — search, find the product, and suggest it. Only ask when you need a choice the user hasn't specified.
- **Handle expired sessions gracefully.** If any command returns `"error": "session_expired"`, run `bun run scripts/amazon.ts refresh --json` to re-capture the session.
- **Handle extension errors.** If a command fails with a message about the browser extension not being connected, tell the user: "Please open Chrome, click the Vellum extension icon, and click Connect — then I'll retry." Do NOT try to interact with the relay directly.
- **Show prices.** Always show prices when presenting products or the cart summary.
- **Use `--json` flag** on all commands for reliable parsing.
- **Do NOT use the browser skill.** All Amazon interaction goes through the CLI, not browser automation.
- **Rate limiting.** Amazon may rate-limit rapid sequential requests. Wait 8–10 seconds between cart operations. If you get a 403 error, wait 15–20 seconds and retry.
- **Always-allow tip.** At the start of an ordering flow, suggest the user enable "always allow" for Amazon commands: "Tip: You can type 'a' to always allow Amazon commands for this session so you won't be prompted each time."
- **Fresh slot required.** Amazon Fresh orders require a delivery slot to be selected before checkout. If the user skips this step, remind them to select a delivery slot.

## Command Reference

```
bun run scripts/amazon.ts status --json                     # Check if logged in
bun run scripts/amazon.ts refresh --json                    # Capture fresh session via Ride Shotgun
bun run scripts/amazon.ts login --recording <path>          # Import session from a recording file
bun run scripts/amazon.ts logout                            # Clear session

bun run scripts/amazon.ts search "<query>" [--fresh] [--limit <n>] --json
bun run scripts/amazon.ts product <asin> [--fresh] --json
bun run scripts/amazon.ts variations <asin> --json

bun run scripts/amazon.ts cart view --json
bun run scripts/amazon.ts cart add --asin <asin> [--quantity <n>] [--fresh] --json
bun run scripts/amazon.ts cart remove --cart-item-id <id> --json

bun run scripts/amazon.ts fresh delivery-slots --json
bun run scripts/amazon.ts fresh select-slot --slot-id <id> --json

bun run scripts/amazon.ts payment-methods --json
bun run scripts/amazon.ts checkout --json
bun run scripts/amazon.ts order place [--payment-method-id <id>] --json
```

## Example Interactions

**User**: "Order a pack of AA batteries from Amazon"

1. `bun run scripts/amazon.ts status --json` → logged in
2. `bun run scripts/amazon.ts search "AA batteries" --json` → finds products
3. Show top results: "Duracell AA 20-pack ($12.99, Prime), Amazon Basics AA 48-pack ($14.49, Prime)..."
4. User picks Duracell → `bun run scripts/amazon.ts cart add --asin B00000J1ER --json`
5. `bun run scripts/amazon.ts cart view --json` → show cart summary
6. `bun run scripts/amazon.ts checkout --json` → show total
7. "Your cart has 1x Duracell AA Batteries 20-pack ($12.99), total $12.99 with free Prime shipping. Ready to order?"
8. User confirms → `bun run scripts/amazon.ts order place --json`

**User**: "Order a large blue t-shirt from Amazon"

1. `bun run scripts/amazon.ts search "blue t-shirt" --json` → finds products
2. User picks a shirt → `bun run scripts/amazon.ts variations <parentAsin> --json` → shows Size + Color combinations
3. Find the child ASIN for Large + Blue → `bun run scripts/amazon.ts cart add --asin <childAsin> --json`

**User**: "Order milk and eggs from Amazon Fresh"

1. `bun run scripts/amazon.ts status --json` → logged in
2. `bun run scripts/amazon.ts search "whole milk" --fresh --json` → Fresh results
3. `bun run scripts/amazon.ts cart add --asin <milkAsin> --fresh --json`
4. `bun run scripts/amazon.ts search "eggs" --fresh --json` → Fresh results
5. `bun run scripts/amazon.ts cart add --asin <eggsAsin> --fresh --json`
6. `bun run scripts/amazon.ts fresh delivery-slots --json` → show available slots
7. User picks a slot → `bun run scripts/amazon.ts fresh select-slot --slot-id <id> --json`
8. `bun run scripts/amazon.ts checkout --json` → show totals
9. User confirms → `bun run scripts/amazon.ts order place --json`
