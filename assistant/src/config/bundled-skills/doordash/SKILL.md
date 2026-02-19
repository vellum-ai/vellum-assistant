---
name: "DoorDash"
description: "Order food, groceries, and convenience items from DoorDash using the built-in CLI integration"
user-invocable: true
metadata: {"vellum": {"emoji": "\uD83C\uDF55"}}
---

You can order food from DoorDash for the user using the `vellum doordash` CLI.

## Task Progress Widget

When executing a food ordering flow, show live progress using the `task_progress` card template. Before starting, call `ui_show` with:
```json
{
  "surface_type": "card",
  "template": "task_progress",
  "templateData": {
    "title": "Ordering from DoorDash",
    "status": "in_progress",
    "steps": [
      { "label": "Check session", "status": "in_progress" },
      { "label": "Search restaurants", "status": "pending" },
      { "label": "Browse menu", "status": "pending" },
      { "label": "Add to cart", "status": "pending" },
      { "label": "Place order", "status": "pending" }
    ]
  }
}
```
As each step completes, call `ui_update` with the same surface ID to update step statuses. Add `detail` to completed steps (e.g. `"detail": "Found Andiamo's"`). Adapt the steps to the actual flow (e.g. skip "Search restaurants" if the user named a specific store).

## Typical Flow

When the user asks you to order food (e.g. "Order pizza from Andiamo's"):

1. **Check session** — run `vellum doordash status --json`. If `loggedIn` is false or the session is expired, tell the user: "A Chrome window will open to the DoorDash login page. Please sign in there — I'll detect your login automatically and minimize the window." Then run `vellum doordash refresh --json`. This starts a Ride Shotgun learn session that records your login and auto-stops once it detects you've signed in. The session is imported automatically. **This command blocks until login is complete — just wait for it.**

   Keep the DoorDash Chrome window open in the background — it's needed for API requests.

2. **Search** — run `vellum doordash search "<query>" --json` to find matching restaurants. Present the top results to the user with name, rating, and delivery info. If the user named a specific restaurant, pick the best match. If ambiguous, ask.

3. **Browse menu** — run `vellum doordash menu <storeId> --json` to get the menu. Show the user the categories and items with prices. If the user already said what they want (e.g. "pepperoni pizza"), find the matching item(s). **For convenience/pharmacy stores** (CVS, Duane Reade, Walgreens etc.), the response will have `isRetail: true` and empty items — use `store-search` instead (see step 3b).

3b. **Search within a retail store** — for convenience/pharmacy stores, run `vellum doordash store-search <storeId> "<query>" --json` to find specific products. This returns items with IDs, prices, and menuIds that can be added to cart directly.

4. **Get item details** (if needed) — run `vellum doordash item <storeId> <itemId> --json` to see options/customizations. The response includes:
   - `options`: each option group has `minSelections`/`maxSelections` indicating how many choices are required
   - Each choice has `unitAmount` (price impact in cents), `defaultQuantity`, and possibly `nestedOptions` (sub-choices like milk type within a size selection)
   - `specialInstructionsConfig`: whether special instructions are accepted, max length, and placeholder text

   If the item has required options (like size or toppings), construct the `nestedOptions` JSON from the option/choice IDs and pass it via `--options`. Ask the user for preferences or pick sensible defaults.

5. **Add to cart** — run `vellum doordash cart add --store-id <id> --menu-id <id> --item-id <id> --item-name "<name>" --unit-price <cents> [--options '<json>'] [--special-instructions "<text>"] --json`. For subsequent items at the same store, pass `--cart-id <id>` from the first add response. Use `--special-instructions` for requests like "extra hot", "no ice", etc. Use `--options` to pass customization choices (see Customization Options below).

6. **Review cart** — run `vellum doordash cart view <cartId> --json` and show the user what's in their cart with prices. Ask if they want to add anything else or proceed.

7. **Checkout** — run `vellum doordash checkout <cartId> --json` to get delivery options. Present them to the user.

8. **Payment methods** — run `vellum doordash payment-methods --json` to see saved cards. Show the user which card will be used (the default one).

9. **Place order** — after the user explicitly confirms, run `vellum doordash order place --cart-id <id> --store-id <id> --total <cents> [--tip <cents>] [--dropoff-option <id>] --json`. The command auto-selects the default payment method if `--payment-uuid` is not provided. The response contains `orderUuid` on success.

## Important Behavior

- **Always confirm before checkout.** Never place an order without explicit user approval.
- **Be proactive.** If the user says "order pizza from Andiamo's", don't ask clarifying questions upfront — search, find the store, show the menu, and suggest items. Only ask when you need a choice the user hasn't specified.
- **Handle expired sessions gracefully.** If any command returns `"error": "session_expired"`, run `vellum doordash refresh --json` to re-capture the session.
- **Show prices.** Always show prices when presenting items or the cart summary.
- **Use `--json` flag** on all commands for reliable parsing.
- **Do NOT use the browser skill.** All DoorDash interaction goes through the CLI, not browser automation.
- **Rate limiting.** DoorDash rate-limits rapid sequential requests. When adding multiple items (e.g. a team order), wait 8–10 seconds between `cart add` calls. If you get a 403 error, wait 15–20 seconds and retry. For large orders (5+ items), consider running `vellum doordash refresh --json` midway through if you hit repeated 403s.
- **Special instructions are unreliable.** Some merchants disable special instructions entirely. Always prefer `--options` for customizations (size, milk type, etc.). Only use `--special-instructions` for free-text requests that aren't covered by the item's option groups. If the merchant rejects special instructions, drop them and proceed without.
- **Customization fallback.** If `cart add` with `--options` fails, or if the item details show options that are hard to construct (deeply nested, unusual format), proactively offer to use `cart learn` so the user can customize the item visually in the browser. Don't silently drop customizations — tell the user what happened and offer alternatives.
- **Always-allow tip.** At the start of an ordering flow, suggest the user enable "always allow" for `vellum doordash` commands: "Tip: You can type 'a' to always allow `vellum doordash` commands for this session so you won't be prompted each time."
- **Error attribution.** When errors occur, assume it's more likely a bug in our query/parsing than a DoorDash API change. Suggest running `vellum doordash record` to capture fresh queries before assuming the schema changed.

## Customization Options

Many items (especially coffee, boba, sandwiches) have required customization options like size, milk type, or toppings. Here's how to handle them:

### Constructing nestedOptions JSON

1. Run `vellum doordash item <storeId> <itemId> --json` to get the item's option groups
2. Each option group has `id`, `name`, `required`, `minSelections`, `maxSelections`, and `choices`
3. Build a JSON array of selections matching the DoorDash format:

```json
[
  {
    "optionId": "<option-group-id>",
    "optionChoiceId": "<choice-id>",
    "quantity": 1,
    "nestedOptions": []
  }
]
```

For choices with nested sub-options (e.g., selecting "Oat Milk" under the "Milk" option within a size), add them to the `nestedOptions` array of the parent choice.

4. Pass the JSON string to `cart add --options '<json>'`

### Special Instructions

Use `--special-instructions` on `cart add` for free-text requests like "extra hot", "no ice", "light foam". The `item` command response includes `specialInstructionsConfig` with the max length and whether instructions are supported.

**Warning:** Some merchants disable special instructions entirely. If `specialInstructionsConfig.isEnabled` is false, or if the add-to-cart call returns an error about special requests, drop the instructions and retry without them. Always prefer `--options` for customizations — special instructions are a last resort for requests not covered by the item's option groups.

### Learning Customizations via Ride Shotgun

For complex items where constructing the JSON manually is difficult, use `cart learn`:

1. Run `vellum doordash cart learn --json`
2. A Chrome window opens — navigate to the item, customize it visually, and click "Add to Cart"
3. The command auto-detects the `updateCartItem` operation and extracts the exact `nestedOptions` and `specialInstructions`
4. Use the extracted options directly with `cart add --options '<json>'`

You can also extract options from an existing recording with `vellum doordash inspect <recordingId> --extract-options --json`.

### Coffee Order Example

**User**: "Order a large oat milk latte with an extra shot from Blue Bottle"

1. `vellum doordash search "Blue Bottle" --json` -> finds store
2. `vellum doordash menu <storeId> --json` -> finds "Latte" item
3. `vellum doordash item <storeId> <latteItemId> --json` -> returns options:
   - Size (required, min:1, max:1): Small (id:101), Medium (id:102), Large (id:103, +$1.00)
   - Milk (required, min:1, max:1): Whole (id:201), Oat (id:202, +$0.70), Almond (id:203, +$0.70)
   - Extras (optional, min:0, max:5): Extra Shot (id:301, +$0.90), Vanilla Syrup (id:302, +$0.60)
4. Construct options JSON and add to cart:
```
vellum doordash cart add --store-id <id> --menu-id <id> --item-id <id> --item-name "Latte" --unit-price 550 --options '[{"optionId":"size-group-id","optionChoiceId":"103","quantity":1,"nestedOptions":[]},{"optionId":"milk-group-id","optionChoiceId":"202","quantity":1,"nestedOptions":[]},{"optionId":"extras-group-id","optionChoiceId":"301","quantity":1,"nestedOptions":[]}]' --special-instructions "Extra hot" --json
```

## Command Reference

```
vellum doordash status --json              # Check if logged in
vellum doordash refresh --json             # Capture fresh session via Ride Shotgun (auto-stops after login)
vellum doordash login --recording <path>   # Import session from a recording file manually
vellum doordash logout --json              # Clear session
vellum doordash search "<query>" --json    # Search restaurants
vellum doordash menu <storeId> --json      # Get store menu (auto-detects retail stores)
vellum doordash store-search <storeId> "<query>" --json  # Search items within a convenience/pharmacy store
vellum doordash item <storeId> <itemId> --json  # Get item details + options
vellum doordash cart add --store-id <id> --menu-id <id> --item-id <id> --item-name "<name>" --unit-price <cents> [--quantity <n>] [--cart-id <id>] [--options '<json>'] [--special-instructions "<text>"] --json
vellum doordash cart remove --cart-id <id> --item-id <orderItemId> --json
vellum doordash cart view <cartId> --json
vellum doordash cart list [--store-id <id>] --json
vellum doordash cart learn --json                 # Learn customization options by recording browser interaction
vellum doordash inspect <recordingId> --extract-options --json  # Extract nestedOptions from a recording
vellum doordash checkout <cartId> [--address-id <id>] --json
vellum doordash payment-methods --json     # List saved payment methods
vellum doordash order place --cart-id <id> --store-id <id> --total <cents> [--tip <cents>] [--delivery-option <type>] [--dropoff-option <id>] [--payment-uuid <uuid>] --json
```

## Example Interaction

**User**: "Order a pepperoni pizza from Andiamo's"

1. `vellum doordash status --json` -> logged in
2. `vellum doordash search "Andiamo's" --json` -> finds store 22926474
3. `vellum doordash menu 22926474 --json` -> finds "Pepperoni Pizza Pie" (item 2956709006, $28.00)
4. Tell user: "I found Pepperoni Pizza Pie at Andiamo's for $28.00. Adding it to your cart."
5. `vellum doordash cart add --store-id 22926474 --menu-id 12847574 --item-id 2956709006 --item-name "Pepperoni Pizza Pie" --unit-price 2800 --json`
6. `vellum doordash cart view <cartId> --json` -> show summary
7. "Your cart has 1x Pepperoni Pizza Pie ($28.00), total $28.00. Ready to check out?"

**User**: "I need Tylenol from CVS"

1. `vellum doordash status --json` -> logged in
2. `vellum doordash search "CVS" --json` -> finds store 1231787
3. `vellum doordash menu 1231787 --json` -> isRetail: true, categories but no items
4. `vellum doordash store-search 1231787 "tylenol" --json` -> finds results
5. Show top results: "Tylenol Extra Strength Gelcaps (24 ct) - $8.79, Tylenol Extra Strength Caplets (100 ct) - $13.49..."
6. User picks one -> add to cart with the item's `id`, `menuId`, and `unitAmount`
