---
name: amazon
description: Shop on Amazon and Amazon Fresh with browser automation plus deterministic parsing helpers
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🛒"
  vellum:
    display-name: "Amazon"
    includes: ["browser"]
---

Use browser automation for all Amazon actions. Use helper scripts with `host_bash` to normalize extraction results and decide the next step.

## Required tools

- Browser tools: `browser_navigate`, `browser_snapshot`, `browser_extract`, `browser_click`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_select_option`, `browser_screenshot`, `browser_fill_credential`, `browser_wait_for`.
- Host tool: `host_bash` for deterministic helper scripts under `scripts/`.

## Hard constraints

- Do not call `assistant browser chrome relay`.
- Do not use legacy relay-backed scripts.
- Always require explicit user confirmation before final order submission.

## Step graph (state machine)

### Step 1: Classify workflow state

Run this early in each turn when intent is unclear:

```bash
bun {baseDir}/scripts/amazon-intent.ts --request "<latest user request>" --checkout-reviewed <true|false> --has-cart-items <true|false>
```

Use the returned `step` to route to one of: `search`, `variant_select`, `cart_review`, `checkout_review`, `fresh_slot`, `place_order`.

### Step 2: Product discovery (`search`)

1. Navigate to search results page:

```text
browser_navigate { "url": "https://www.amazon.com/s?k=<urlencoded query>" }
```

2. Capture current state:

```text
browser_snapshot {}
browser_extract { "include_links": true }
```

3. Parse candidates deterministically:

```bash
bun {baseDir}/scripts/amazon-parse-search.ts --query "<query>" --input-json '<json payload with extracted text/links>'
```

4. Present top options with title, price, ASIN (if present), Prime/Fresh hints.

### Step 3: Product detail + variant resolution (`variant_select`)

1. Open product result.
2. Re-snapshot + re-extract.
3. Parse product details:

```bash
bun {baseDir}/scripts/amazon-parse-product.ts --input-json '<json payload with extracted text/links>'
```

4. If variation hints are present, resolve user choice before add-to-cart.

### Step 4: Add to cart + verify (`cart_review`)

1. Click Add to Cart on product page.
2. Navigate to cart page and extract:

```text
browser_navigate { "url": "https://www.amazon.com/gp/cart/view.html" }
browser_snapshot {}
browser_extract { "include_links": true }
```

3. Parse cart summary:

```bash
bun {baseDir}/scripts/amazon-parse-cart.ts --input-json '<json payload with extracted text>'
```

4. Show parsed line items and totals. Ask user to confirm cart contents.

### Step 5: Fresh slot validation (`fresh_slot`)

For Amazon Fresh flows, explicitly verify slot selection in UI before checkout:

1. Navigate to Fresh delivery slot surface if needed.
2. Snapshot + extract delivery slot details.
3. Confirm selected slot text is visible before proceeding.

If slot cannot be verified after retries, stop and ask user to choose slot manually.

### Step 6: Checkout sanity (`checkout_review`)

1. Navigate to checkout review page.
2. Snapshot, extract, and capture a full-page screenshot:

```text
browser_snapshot {}
browser_extract { "include_links": false }
browser_screenshot { "full_page": true }
```

3. Validate readiness:

```bash
bun {baseDir}/scripts/amazon-checkout-sanity.ts --cart-confirmed true --input-json '<json payload with extracted text>'
```

4. Report missing markers (shipping/payment/total/submit action) before any submission.

### Step 7: Final submit gate (`place_order`)

Immediately before clicking final submit button:

1. Ask for explicit final confirmation in plain language.
2. If user confirms, click final submit action (`Place your order`, `Buy now`, or equivalent).
3. Take post-submit snapshot/screenshot and report confirmation details.

## Retry and fallback policy

- Retry budget: 3 attempts per step that mutates page state.
- After each mutation, run a fresh `browser_snapshot` before the next click/type.
- If a step fails 3 times, stop and ask user to complete that step manually, then resume.

## Example helper payload shape

```json
{
  "phase": "search",
  "context": {"checkoutReviewed": false, "hasCartItems": false},
  "extracted": {"text": "...", "links": ["https://www.amazon.com/dp/B08XGDN3TZ"]},
  "userIntent": "order aa batteries"
}
```

## Safety rules

- Always show price/totals before confirmation.
- Never infer final consent from prior messages; ask again right before submission.
- If CAPTCHA or anti-bot challenge appears, ask user to solve it and continue after refresh.
