---
name: amazon
description: Shop on Amazon and Amazon Fresh using the bundled Amazon scripts
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📦"
  vellum:
    display-name: "Amazon"
    user-invocable: true
---

You can shop on Amazon (and Amazon Fresh for groceries) for the user using the bundled Amazon scripts.

## Script Setup

**IMPORTANT: Always use `host_bash` (not `bash`) for all Amazon commands.** The scripts need host access for session cookies and the `assistant` CLI binary (used for the Chrome extension relay and credential store), which are not available inside the sandbox.

The Amazon scripts are bundled with this skill. Run them via `bun run {baseDir}/scripts/amazon.ts <subcommand> [options]`.

All Amazon interaction goes through the bundled scripts below, not browser automation.

## Typical Flow — Regular Amazon Shopping

When the user asks you to order something from Amazon:

1. **Check session** — run `bun run {baseDir}/scripts/amazon.ts status --json`. If `loggedIn` is false or the session is expired, tell the user: "A Chrome window will open to the Amazon login page. Please sign in there — I'll detect your login automatically and minimize the window." Then run `bun run {baseDir}/scripts/amazon.ts refresh --json`. This captures your session via the browser extension and auto-stops once it detects you've signed in. The session is imported automatically. **This command blocks until login is complete — just wait for it.**

2. **Search** — run `bun run {baseDir}/scripts/amazon.ts search "<query>" --json` to find matching products. Present the top results with ASIN, title, price, and Prime status. If the user named a specific product, pick the best match. If ambiguous, ask.

3. **Product details** (if needed) — run `bun run {baseDir}/scripts/amazon.ts product <asin> --json` to get full details including price and variations. For products with variants (size, color, etc.), see the Variations section below.

4. **Add to cart** — run `bun run {baseDir}/scripts/amazon.ts cart add --asin <asin> [--quantity <n>] --json`. The response includes the updated cart with all items.

5. **Review cart** — run `bun run {baseDir}/scripts/amazon.ts cart view --json` and show the user what's in their cart with prices. Ask if they want to add anything else or proceed.

6. **Payment methods** — run `bun run {baseDir}/scripts/amazon.ts payment-methods --json` to see saved cards.

7. **Checkout summary** — run `bun run {baseDir}/scripts/amazon.ts checkout --json` to get order totals (subtotal, shipping, tax, total).

8. **Place order** — after the user explicitly confirms, run `bun run {baseDir}/scripts/amazon.ts order place [--payment-method-id <id>] --json`. The response contains `orderId` on success.

## Typical Flow — Amazon Fresh Groceries

Amazon Fresh delivers groceries. The flow is the same as regular Amazon, with these additions:

1. **Search Fresh** — use the `--fresh` flag: `bun run {baseDir}/scripts/amazon.ts search "<query>" --fresh --json`

2. **Add Fresh items** — use the `--fresh` flag: `bun run {baseDir}/scripts/amazon.ts cart add --asin <asin> --fresh --json`

3. **Select delivery slot** — Fresh orders require a delivery window:
   - `bun run {baseDir}/scripts/amazon.ts fresh delivery-slots --json` — list available slots
   - `bun run {baseDir}/scripts/amazon.ts fresh select-slot --slot-id <id> --json` — select a slot
   - Do this BEFORE checkout.

4. **Checkout and order** — same as regular Amazon.

## Handling Variations

Many Amazon products (clothing, electronics) have variations (size, color, style):

1. Run `bun run {baseDir}/scripts/amazon.ts product <asin> --json` to get the product and its `variations[]` array
2. Each variation has: `dimensionName` (e.g. "size"), `value` (e.g. "Large"), `asin` (child ASIN), `isAvailable`, `priceValue`
3. Use the child ASIN when adding to cart: `bun run {baseDir}/scripts/amazon.ts cart add --asin <child-asin> --json`

Alternatively, run `bun run {baseDir}/scripts/amazon.ts variations <asin> --json` to list just the variations.

## Session Storage

Session cookies are stored in the encrypted credential store under the key `amazon:session:cookies`. You can inspect the stored session with:

```bash
assistant credentials inspect --service amazon --field session:cookies
```

Session capture (`bun run {baseDir}/scripts/amazon.ts refresh`) and session checks (`bun run {baseDir}/scripts/amazon.ts status`) use the credential store automatically — no manual file management is needed.

## Important Behavior

- **Chrome extension relay required.** The Amazon scripts use `assistant browser chrome relay` internally for browser automation. The Chrome extension must be connected before Amazon commands will work. If a command fails with a connection error, tell the user: "Please open Chrome, click the Vellum extension icon, and click Connect — then I'll retry."
- **Always confirm before placing order.** Never call `order place` without explicit user approval. Show the cart and total first.
- **Be proactive.** If the user says "order AA batteries", don't ask clarifying questions upfront — search, find the product, and suggest it. Only ask when you need a choice the user hasn't specified.
- **Handle expired sessions gracefully.** If any command returns `"error": "session_expired"`, run `bun run {baseDir}/scripts/amazon.ts refresh --json` to re-capture the session.
- **Show prices.** Always show prices when presenting products or the cart summary.
- **Use `--json` flag** on all commands for reliable parsing.
- **Always use `host_bash`** for these commands, never `bash`.
- **Do NOT use the browser skill.** All Amazon interaction goes through the bundled scripts, not browser automation.
- **Rate limiting.** Amazon may rate-limit rapid sequential requests. Wait 8-10 seconds between cart operations. If you get a 403 error, wait 15-20 seconds and retry.
- **Always-allow tip.** At the start of an ordering flow, suggest the user enable "always allow" for the Amazon script commands: "Tip: You can type 'a' to always allow Amazon commands for this session so you won't be prompted each time."
- **Fresh slot required.** Amazon Fresh orders require a delivery slot to be selected before checkout. If the user skips this step, remind them to run `bun run {baseDir}/scripts/amazon.ts fresh delivery-slots --json` and select a slot.

## Command Reference

```
bun run {baseDir}/scripts/amazon.ts status --json                     # Check if logged in
bun run {baseDir}/scripts/amazon.ts refresh --json                    # Capture fresh session via browser extension
bun run {baseDir}/scripts/amazon.ts refresh-headless --json           # Capture session from Chrome's cookie database
bun run {baseDir}/scripts/amazon.ts logout                            # Clear session

bun run {baseDir}/scripts/amazon.ts search "<query>" [--fresh] [--limit <n>] --json
bun run {baseDir}/scripts/amazon.ts product <asin> [--fresh] --json
bun run {baseDir}/scripts/amazon.ts variations <asin> --json

bun run {baseDir}/scripts/amazon.ts cart view --json
bun run {baseDir}/scripts/amazon.ts cart add --asin <asin> [--quantity <n>] [--fresh] --json
bun run {baseDir}/scripts/amazon.ts cart remove --cart-item-id <id> --json

bun run {baseDir}/scripts/amazon.ts fresh delivery-slots --json
bun run {baseDir}/scripts/amazon.ts fresh select-slot --slot-id <id> --json

bun run {baseDir}/scripts/amazon.ts payment-methods --json
bun run {baseDir}/scripts/amazon.ts checkout --json
bun run {baseDir}/scripts/amazon.ts order place [--payment-method-id <id>] --json
```

## Example Interactions

**User**: "Order a pack of AA batteries from Amazon"

1. `bun run {baseDir}/scripts/amazon.ts status --json` -> logged in
2. `bun run {baseDir}/scripts/amazon.ts search "AA batteries" --json` -> finds products
3. Show top results: "Duracell AA 20-pack ($12.99, Prime), Amazon Basics AA 48-pack ($14.49, Prime)..."
4. User picks Duracell -> `bun run {baseDir}/scripts/amazon.ts cart add --asin B00000J1ER --json`
5. `bun run {baseDir}/scripts/amazon.ts cart view --json` -> show cart summary
6. `bun run {baseDir}/scripts/amazon.ts checkout --json` -> show total
7. "Your cart has 1x Duracell AA Batteries 20-pack ($12.99), total $12.99 with free Prime shipping. Ready to order?"
8. User confirms -> `bun run {baseDir}/scripts/amazon.ts order place --json`

**User**: "Order a large blue t-shirt from Amazon"

1. `bun run {baseDir}/scripts/amazon.ts search "blue t-shirt" --json` -> finds products
2. User picks a shirt -> `bun run {baseDir}/scripts/amazon.ts variations <parentAsin> --json` -> shows Size + Color combinations
3. Find the child ASIN for Large + Blue -> `bun run {baseDir}/scripts/amazon.ts cart add --asin <childAsin> --json`

**User**: "Order milk and eggs from Amazon Fresh"

1. `bun run {baseDir}/scripts/amazon.ts status --json` -> logged in
2. `bun run {baseDir}/scripts/amazon.ts search "whole milk" --fresh --json` -> Fresh results
3. `bun run {baseDir}/scripts/amazon.ts cart add --asin <milkAsin> --fresh --json`
4. `bun run {baseDir}/scripts/amazon.ts search "eggs" --fresh --json` -> Fresh results
5. `bun run {baseDir}/scripts/amazon.ts cart add --asin <eggsAsin> --fresh --json`
6. `bun run {baseDir}/scripts/amazon.ts fresh delivery-slots --json` -> show available slots
7. User picks a slot -> `bun run {baseDir}/scripts/amazon.ts fresh select-slot --slot-id <id> --json`
8. `bun run {baseDir}/scripts/amazon.ts checkout --json` -> show totals
9. User confirms -> `bun run {baseDir}/scripts/amazon.ts order place --json`
