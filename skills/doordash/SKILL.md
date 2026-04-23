---
name: doordash
description: Order food, groceries, and convenience items from DoorDash using the built-in CLI integration
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🍕"
  vellum:
    display-name: "DoorDash"
---

You can order food from DoorDash for the user using the DoorDash CLI script.

## CLI Setup

**IMPORTANT: Always use `host_bash` (not `bash`) for all DoorDash commands.** The DoorDash CLI needs host access for Chrome CDP and session cookies - none of which are available inside the sandbox.

The DoorDash CLI is invoked via `bun {baseDir}/scripts/doordash-entry.ts`. Do NOT search for the script, inspect it, or try to discover how the CLI works. Just run the commands as documented below.

## Task Progress Widget

A task progress card is shown automatically when you run your first DoorDash command. Its surface ID is `doordash-progress`. As each step completes, call `ui_update` with surface ID `doordash-progress` to update step statuses. Update `data.templateData.steps` - set completed steps to `"status": "completed"` with a `"detail"` string, the current step to `"status": "in_progress"`, and future steps to `"status": "pending"`. Adapt the steps to the actual flow (e.g. skip "Search restaurants" if the user named a specific store).

## Typical Flow

When the user asks you to order food (e.g. "Order pizza from Andiamo's"):

1. **Check session** - run `bun {baseDir}/scripts/doordash-entry.ts status --json`. If `loggedIn` is false or the session is expired, inform the user that their DoorDash session has expired and they need to log in again.

2. **Search** - run `bun {baseDir}/scripts/doordash-entry.ts search "<query>" --json` to find matching restaurants. Present the top results to the user with name, rating, and delivery info. If the user named a specific restaurant, pick the best match. If ambiguous, ask.

3. **Browse menu** - run `bun {baseDir}/scripts/doordash-entry.ts menu <storeId> --json` to get the menu. Show the user the categories and items with prices. If the user already said what they want (e.g. "pepperoni pizza"), find the matching item(s). **For convenience/pharmacy stores** (CVS, Duane Reade, Walgreens etc.), the response will have `isRetail: true` and empty items - use `store-search` instead (see step 3b).

3b. **Search within a retail store** - for convenience/pharmacy stores, run `bun {baseDir}/scripts/doordash-entry.ts store-search <storeId> "<query>" --json` to find specific products. This returns items with IDs, prices, and menuIds that can be added to cart directly.

4. **Get item details** (if needed) - run `bun {baseDir}/scripts/doordash-entry.ts item <storeId> <itemId> --json` to see options/customizations. The response includes:
   - `options`: each option group has `minSelections`/`maxSelections` indicating how many choices are required
   - Each choice has `unitAmount` (price impact in cents), `defaultQuantity`, and possibly `nestedOptions` (sub-choices like milk type within a size selection)
   - `specialInstructionsConfig`: whether special instructions are accepted, max length, and placeholder text

   If the item has required options (like size or toppings), construct the `nestedOptions` JSON from the option/choice IDs and pass it via `--options`. Ask the user for preferences or pick sensible defaults.

5. **Add to cart** - run `bun {baseDir}/scripts/doordash-entry.ts cart add --store-id <id> --menu-id <id> --item-id <id> --item-name "<name>" --unit-price <cents> [--options '<json>'] [--special-instructions "<text>"] --json`. For subsequent items at the same store, pass `--cart-id <id>` from the first add response. Use `--special-instructions` for requests like "extra hot", "no ice", etc. Use `--options` to pass customization choices (see Customization Options below).

6. **Review cart** - run `bun {baseDir}/scripts/doordash-entry.ts cart view <cartId> --json` and show the user what's in their cart with prices. Ask if they want to add anything else or proceed.

7. **Checkout** - run `bun {baseDir}/scripts/doordash-entry.ts checkout <cartId> --json` to get delivery options. Present them to the user.

8. **Payment methods** - run `bun {baseDir}/scripts/doordash-entry.ts payment-methods --json` to see saved cards. Show the user which card will be used (the default one).

9. **Place order** - after the user explicitly confirms, run `bun {baseDir}/scripts/doordash-entry.ts order place --cart-id <id> --store-id <id> --total <cents> [--tip <cents>] [--dropoff-option <id>] --json`. The command auto-selects the default payment method if `--payment-uuid` is not provided. The response contains `orderUuid` on success.

## Important Behavior

- **Always confirm before checkout.** Never place an order without explicit user approval.
- **Be proactive.** If the user says "order pizza from Andiamo's", don't ask clarifying questions upfront - search, find the store, show the menu, and suggest items. Only ask when you need a choice the user hasn't specified.
- **Handle expired sessions gracefully.** If any command returns `"error": "session_expired"`, inform the user that their DoorDash session has expired and they need to log in again.
- **Show prices.** Always show prices when presenting items or the cart summary.
- **Use `--json` flag** on all commands for reliable parsing.
- **Do NOT use the browser skill.** All DoorDash interaction goes through the CLI, not browser automation.
- **Rate limiting.** DoorDash rate-limits rapid sequential requests. When adding multiple items (e.g. a team order), wait 8–10 seconds between `cart add` calls. If you get a 403 error, wait 15–20 seconds and retry.
- **Special instructions are unreliable.** Some merchants disable special instructions entirely. Always prefer `--options` for customizations (size, milk type, etc.). Only use `--special-instructions` for free-text requests that aren't covered by the item's option groups. If the merchant rejects special instructions, drop them and proceed without.
- **Customization fallback.** If `cart add` with `--options` fails, or if the item details show options that are hard to construct (deeply nested, unusual format), proactively offer to use `cart learn` so the user can customize the item visually in the browser. Don't silently drop customizations - tell the user what happened and offer alternatives.
- **Always-allow tip.** At the start of an ordering flow, suggest the user enable "always allow" for DoorDash commands: "Tip: You can type 'a' to always allow DoorDash commands for this conversation so you won't be prompted each time."
- **Error attribution.** When errors occur, assume it's more likely a bug in our query/parsing than a DoorDash API change. Suggest running `bun {baseDir}/scripts/doordash-entry.ts record` to capture fresh queries before assuming the schema changed.

## Customization Options

Many items (especially coffee, boba, sandwiches) have required customization options like size, milk type, or toppings. Here's how to handle them:

### Constructing nestedOptions JSON

1. Run `bun {baseDir}/scripts/doordash-entry.ts item <storeId> <itemId> --json` to get the item's option groups
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

**Warning:** Some merchants disable special instructions entirely. If `specialInstructionsConfig.isEnabled` is false, or if the add-to-cart call returns an error about special requests, drop the instructions and retry without them. Always prefer `--options` for customizations - special instructions are a last resort for requests not covered by the item's option groups.

### Learning Customizations via Browser Recording

For complex items where constructing the JSON manually is difficult, use `cart learn`:

1. Run `bun {baseDir}/scripts/doordash-entry.ts cart learn --json`
2. A Chrome window opens - navigate to the item, customize it visually, and click "Add to Cart"
3. The command auto-detects the `updateCartItem` operation and extracts the exact `nestedOptions` and `specialInstructions`
4. Use the extracted options directly with `cart add --options '<json>'`

You can also extract options from an existing recording with `bun {baseDir}/scripts/doordash-entry.ts inspect <recordingId> --extract-options --json`.

### Coffee Order Example

**User**: "Order a large oat milk latte with an extra shot from Blue Bottle"

1. `bun {baseDir}/scripts/doordash-entry.ts search "Blue Bottle" --json` -> finds store
2. `bun {baseDir}/scripts/doordash-entry.ts menu <storeId> --json` -> finds "Latte" item
3. `bun {baseDir}/scripts/doordash-entry.ts item <storeId> <latteItemId> --json` -> returns options:
   - Size (required, min:1, max:1): Small (id:101), Medium (id:102), Large (id:103, +$1.00)
   - Milk (required, min:1, max:1): Whole (id:201), Oat (id:202, +$0.70), Almond (id:203, +$0.70)
   - Extras (optional, min:0, max:5): Extra Shot (id:301, +$0.90), Vanilla Syrup (id:302, +$0.60)
4. Construct options JSON and add to cart:

```
bun {baseDir}/scripts/doordash-entry.ts cart add --store-id <id> --menu-id <id> --item-id <id> --item-name "Latte" --unit-price 550 --options '[{"optionId":"size-group-id","optionChoiceId":"103","quantity":1,"nestedOptions":[]},{"optionId":"milk-group-id","optionChoiceId":"202","quantity":1,"nestedOptions":[]},{"optionId":"extras-group-id","optionChoiceId":"301","quantity":1,"nestedOptions":[]}]' --special-instructions "Extra hot" --json
```

## Command Reference

```
bun {baseDir}/scripts/doordash-entry.ts status --json              # Check if logged in
bun {baseDir}/scripts/doordash-entry.ts logout --json              # Clear session
bun {baseDir}/scripts/doordash-entry.ts search "<query>" --json    # Search restaurants
bun {baseDir}/scripts/doordash-entry.ts menu <storeId> --json      # Get store menu (auto-detects retail stores)
bun {baseDir}/scripts/doordash-entry.ts store-search <storeId> "<query>" --json  # Search items within a convenience/pharmacy store
bun {baseDir}/scripts/doordash-entry.ts item <storeId> <itemId> --json  # Get item details + options
bun {baseDir}/scripts/doordash-entry.ts cart add --store-id <id> --menu-id <id> --item-id <id> --item-name "<name>" --unit-price <cents> [--quantity <n>] [--cart-id <id>] [--options '<json>'] [--special-instructions "<text>"] --json
bun {baseDir}/scripts/doordash-entry.ts cart remove --cart-id <id> --item-id <orderItemId> --json
bun {baseDir}/scripts/doordash-entry.ts cart view <cartId> --json
bun {baseDir}/scripts/doordash-entry.ts cart list [--store-id <id>] --json
bun {baseDir}/scripts/doordash-entry.ts cart learn --json                 # Learn customization options by recording browser interaction
bun {baseDir}/scripts/doordash-entry.ts inspect <recordingId> --extract-options --json  # Extract nestedOptions from a recording
bun {baseDir}/scripts/doordash-entry.ts checkout <cartId> [--address-id <id>] --json
bun {baseDir}/scripts/doordash-entry.ts payment-methods --json     # List saved payment methods
bun {baseDir}/scripts/doordash-entry.ts order place --cart-id <id> --store-id <id> --total <cents> [--tip <cents>] [--delivery-option <type>] [--dropoff-option <id>] [--payment-uuid <uuid>] --json
```

## Example Interaction

**User**: "Order a pepperoni pizza from Andiamo's"

1. `bun {baseDir}/scripts/doordash-entry.ts status --json` -> logged in
2. `bun {baseDir}/scripts/doordash-entry.ts search "Andiamo's" --json` -> finds store 22926474
3. `bun {baseDir}/scripts/doordash-entry.ts menu 22926474 --json` -> finds "Pepperoni Pizza Pie" (item 2956709006, $28.00)
4. Tell user: "I found Pepperoni Pizza Pie at Andiamo's for $28.00. Adding it to your cart."
5. `bun {baseDir}/scripts/doordash-entry.ts cart add --store-id 22926474 --menu-id 12847574 --item-id 2956709006 --item-name "Pepperoni Pizza Pie" --unit-price 2800 --json`
6. `bun {baseDir}/scripts/doordash-entry.ts cart view <cartId> --json` -> show summary
7. "Your cart has 1x Pepperoni Pizza Pie ($28.00), total $28.00. Ready to check out?"

**User**: "I need Tylenol from CVS"

1. `bun {baseDir}/scripts/doordash-entry.ts status --json` -> logged in
2. `bun {baseDir}/scripts/doordash-entry.ts search "CVS" --json` -> finds store 1231787
3. `bun {baseDir}/scripts/doordash-entry.ts menu 1231787 --json` -> isRetail: true, categories but no items
4. `bun {baseDir}/scripts/doordash-entry.ts store-search 1231787 "tylenol" --json` -> finds results
5. Show top results: "Tylenol Extra Strength Gelcaps (24 ct) - $8.79, Tylenol Extra Strength Caplets (100 ct) - $13.49..."
6. User picks one -> add to cart with the item's `id`, `menuId`, and `unitAmount`
