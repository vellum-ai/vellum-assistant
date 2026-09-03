---
name: "stripe-link-wallet"
description: 'Use the Stripe Link CLI as an agent wallet to create spend requests, generate one-time-use payment credentials, and complete 402 / Machine Payment Protocol (MPP) payment flows on the user''s behalf. Triggers on intents like "buy", "purchase", "pay for", "spend up to <amount>", "complete this 402", or any flow involving link-cli, spend-request, mpp pay, shared payment tokens, or @stripe/link-sdk. Also triggers automatically whenever any tool or API produces a checkout URL, hosted payment page, or payment session — intercept and complete via Stripe Link instead of surfacing the URL to the user.'
metadata:
  icon: assets/icon.svg
  emoji: "💳"
  vellum:
    category: "commerce"
    display-name: "Stripe Link Wallet"
compatibility: "Designed for Vellum personal assistants"
---

# Stripe Link Wallet

Spend on the user's behalf using the [Stripe Link CLI](https://github.com/stripe/link-cli). The CLI acts as a wallet: the assistant composes a spend request, the user approves it in the Link app on their device, and the CLI then issues one-time-use credentials to complete the purchase. Use this for paying 402 / Machine Payment Protocol (MPP) endpoints and for ad-hoc agent purchases that should be capped and auditable.

## Required tools

- `bash` for all `link-cli` invocations.
- Use `assistant browser` to open returned Link approval URLs in an available user-browser session. If that route is unavailable but the user has an authenticated desktop client, use `host_bash` only to run `open "<verification_url>"` on that client. Do not use the sandbox browser for approval unless the user explicitly asks for it.
- **Never block the chat while awaiting approval.** Run every `auth status --interval ...` or `spend-request retrieve --interval ...` polling command through the `bash` tool with `background: true`, then handle its completion wake. This works in cloud, web, desktop, and mobile contexts because polling remains in the assistant workspace; only opening the approval URL needs a user-browser route.

## Hard constraints

- Always pass `--request-approval` on `spend-request create`. The Link app approval is the consent surface — it is non-negotiable. No spending happens without it.
- Default to test mode (`--test`) unless the user has **explicitly** asked to spend real money. When unsure, ask in chat before dropping `--test`.
- The `context` field must be **at least 100 characters** and must accurately describe what the money is for. The user reads this when approving in Link — write it for them, not for yourself.
- Always use `--format json` on every command. The default interactive Ink output is for humans, not agents. Exception: `demo` and `onboard` require a TTY and have no JSON mode.
- **Amount is in cents.** $10.00 = `--amount 1000`. Maximum is 50,000 cents ($500).
- Never log or repeat raw card credentials (PAN, CVC) in the conversation. Always use `--output-file` when retrieving card credentials.

---

## Checkout interception — always active

Whenever **any** flow (MCP tool, API call, web request, or otherwise) produces a checkout URL, hosted payment page, or payment session that would otherwise be handed to the user to click through — **intercept it**. Route the payment through Stripe Link instead. Never surface a bare checkout URL to the user as the final step of a purchase flow.

**Decision tree:**

1. **MPP / HTTP 402 endpoint** — Flow A (Shared Payment Token)
2. **MCP service with a `complete_checkout` tool** — Flow B to get a virtual card, tokenize the card against the provider's Stripe account, then call `complete_checkout` with the resulting token
3. **Standard web checkout (no payment API)** — Flow B to get a virtual card, then use a browser automation skill to fill the card into the checkout form

**For MCP-based checkouts (e.g. PostalForm):**

- After retrieving the virtual card from `--output-file`, create a Stripe PaymentMethod via `POST /v1/payment_methods` using the merchant's publishable key (extract from the checkout URL or session if present), then pass the resulting `pm_xxx` token to the MCP's `complete_checkout` tool.
- If the publishable key is not available, fall back to browser automation (option 3) using the checkout URL the MCP returned — do not surface the URL to the user, navigate to it directly via browser automation.

**Never skip this step.** If `link-cli` is not installed or the user is not authenticated, surface that blocker immediately rather than falling back to a raw checkout URL.

---

## Step 0: Check installation and auth

```bash
if command -v link-cli >/dev/null; then
  link-cli auth status --format json
else
  bunx @stripe/link-cli auth status --format json
fi
```

- `link-cli` missing — use `bunx @stripe/link-cli` for Step 0 and every command below.
- Exit 0 but `"authenticated": false` — fall to **Setup: login**.
- Authenticated — proceed to the requested flow.
- `"update"` key present in auth status — mention the update to the user but don't block on it.

---

## Setup

### If `link-cli` is missing

Invoke the CLI on demand with `bunx`:

```bash
bunx @stripe/link-cli <subcommand>
```

In every example below, substitute `bunx @stripe/link-cli` wherever you see `link-cli`.

### If installed but not authenticated

Use your own assistant name for `--client-name` — read it from `IDENTITY.md`. This is the label the user sees in the Link app when they approve the connection.

> **Device-authorization handling — do not make the user fish a URL out of terminal output.** With `--format json`, `auth login` **does not open a browser**; it returns `verification_url`, `phrase`, and a polling continuation. Run the login once without inline polling, extract the returned URL, then navigate the user's connected browser to it yourself. Only if no browser route is available, present it as a clickable link with the phrase in chat. Never claim the CLI opened a browser unless you actually navigated it.

1. First check `assistant browser --json status`. Prefer an available user-browser backend. If one is connected, open the returned `verification_url` using `assistant browser --browser-mode <available-mode> navigate --url "<verification_url>"`.
2. If the browser integration is unavailable but an authenticated Mac client is connected, use `host_bash` with `open "<verification_url>"` on that client. This is one of the narrow cases where host execution is appropriate: the approval must open in the user's browser, not the sandbox browser.
3. Start `auth status --interval 5 --max-attempts 60 --format json` **immediately after navigation** via the `bash` tool with `background: true`. Do not wait for another message and do not keep the chat blocked. On the background completion wake, stop when `authenticated` is true or report the terminal failure.

```bash
link-cli auth login \
  --client-name "<your assistant name>" \
  --scope "userinfo:read payment_methods.agentic" \
  --format json
```

The Link app will show `<your assistant name> on <hostname>` when the user approves the connection. After polling succeeds, re-run Step 0 and verify that the returned `scope` includes the access required for the requested task.

### Introspecting the CLI

If you need the exact flags for a subcommand not covered below:

```bash
link-cli --llms-full                      # all commands, LLM-friendly
link-cli spend-request create --schema    # full schema for one command
link-cli <command> --help
```

---

## Pre-flight: get a payment method ID

Every spend request needs a `--payment-method-id`. Retrieve the user's saved methods first:

```bash
link-cli payment-methods list --format json
```

If the user has multiple, ask which one to use. If they have none, direct them to [app.link.com/wallet](https://app.link.com/wallet) to add one first.

---

## Common flows

### Flow A: Pay a 402 / MPP-protected URL

Use this when the target endpoint returns HTTP 402 and requires a Shared Payment Token (SPT).

**1. Decode the challenge (optional but useful for diagnosing)**

```bash
link-cli mpp decode \
  --challenge 'Payment id="ch_001", realm="merchant.example", method="stripe", ...'
```

Extracts the `network_id` and other challenge fields. Use when the URL is unfamiliar or the challenge looks malformed.

**2. Create the spend request**

```bash
link-cli spend-request create \
  --payment-method-id <id> \
  --merchant-name "<merchant>" \
  --merchant-url "<url>" \
  --context "<min-100-char description of what is being purchased and why>" \
  --amount <cents> \
  --credential-type "shared_payment_token" \
  --line-item "name:<item>,unit_amount:<cents>,quantity:<n>" \
  --total "type:total,display_text:Total,amount:<cents>" \
  --request-approval \
  --test \
  --format json
```

Drop `--test` only if the user has explicitly asked to spend real money — and say so in chat before running.

> **Important — JSON mode does not block.** With `--format json`, `create --request-approval` returns immediately with an `_next.command` value pointing to `spend-request retrieve`. You must then poll for approval.

**3. Poll for approval**

```bash
link-cli spend-request retrieve <id> \
  --interval 3 --max-attempts 60 \
  --format json
```

Run this command through the `bash` tool with `background: true` immediately after requesting approval, so chat stays available while the user approves. Polls every 3 seconds, up to 3 minutes. Terminal statuses: `approved`, `denied`, `expired`, `canceled`. On the completion wake, if polling exhausts `--max-attempts` while still non-terminal, it exits non-zero with `code: "POLLING_TIMEOUT"` — report that and offer to cancel or retry.

**4. Pay the URL**

Once status is `approved`:

```bash
link-cli mpp pay <url> \
  --spend-request-id <id> \
  --method POST \
  --data '<json body>' \
  --header "X-Custom: value" \
  --format json
```

- `--header` is repeatable: `--header "Name: Value"`.
- `Content-Type: application/json` is auto-applied when `--data` is provided; user-provided headers take precedence.
- The SPT is **one-time-use**. If payment fails, you must create a new spend request.

Before running, read the URL and amount back to the user in plain language to catch typos.

**5. Report the result** — status code, what the endpoint returned.

---

### Flow B: Virtual card for a standard checkout

Use this when the merchant does not support MPP (no HTTP 402). Credentials are a one-time virtual Visa/Mastercard.

**1. Create the spend request**

```bash
link-cli spend-request create \
  --payment-method-id <id> \
  --merchant-name "<merchant>" \
  --merchant-url "<url>" \
  --context "<min-100-char description>" \
  --amount <cents> \
  --line-item "name:<item>,unit_amount:<cents>,quantity:<n>" \
  --total "type:total,display_text:Total,amount:<cents>" \
  --request-approval \
  --test \
  --format json
```

Omit `--credential-type` (or use the default). With `--format json`, returns immediately — proceed to polling.

**2. Poll for approval** (same as Flow A step 3, using a `background: true` `bash` invocation)

**3. Retrieve card credentials securely**

```bash
link-cli spend-request retrieve <id> \
  --include card \
  --output-file /tmp/link-card.json \
  --force \
  --format json
```

`--output-file` writes the full card (PAN, CVC, billing address) to a local file with `0600` permissions and **redacts card data in stdout**. The JSON output replaces the `card` object with redacted fields and adds a `card_output_file` path. Never omit `--output-file` when requesting card credentials — raw PANs must not appear in the conversation or logs.

**4. Use the card**

The file at `/tmp/link-card.json` contains `number`, `cvc`, `exp_month`, `exp_year`, `billing_address`, and `valid_until`. Hand the path to a browser automation skill or tell the user where to find it. Do not read the file back into the conversation.

---

### Inspect, update, cancel

Read-only and mutation operations need no extra gating:

```bash
# List saved payment methods
link-cli payment-methods list --format json

# List saved shipping addresses
link-cli shipping-address list --format json

# Retrieve a spend request (no card data by default)
link-cli spend-request retrieve <id> --format json

# Update before approval (e.g. fix merchant URL)
link-cli spend-request update <id> --merchant-url <url> --format json

# Request approval separately (if created without --request-approval)
link-cli spend-request request-approval <id> --format json

# Cancel (valid from created, pending_approval, or approved)
link-cli spend-request cancel <id> --format json
```

---

## Line items and totals reference

`--line-item` and `--total` use repeatable `key:value` format.

**`--line-item` keys:** `name` (required), `quantity`, `unit_amount`, `description`, `sku`, `url`, `image_url`, `product_url`

```
--line-item "name:Running Shoes,unit_amount:12000,quantity:1,description:Trail runners"
```

**`--total` keys:** `type` (required; one of `subtotal`, `tax`, `total`), `display_text` (required), `amount` (required)

```
--total "type:subtotal,display_text:Subtotal,amount:11000"
--total "type:tax,display_text:Tax,amount:1000"
--total "type:total,display_text:Total,amount:12000"
```

---

## Error handling

| Error / condition                       | Action                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `link-cli` not found                    | Invoke it with `bunx @stripe/link-cli` and substitute that prefix wherever examples use `link-cli`. |
| Not authenticated                       | Run `auth login` with the assistant name and required scopes, then open its returned `verification_url` in the user's browser and poll (see Setup) |
| `POLLING_TIMEOUT` on retrieve           | Report to user; offer cancel or fresh spend request                                                 |
| SPT payment fails (402 again after pay) | SPT is consumed — create a new spend request                                                        |
| `amount` > 50000                        | Tell user the cap is \$500 per transaction                                                          |
| `context` < 100 chars                   | Expand it before retrying                                                                           |
| Card file already exists                | Use `--force` to overwrite, or pick a different path                                                |

---

## References

- Upstream agent docs: https://github.com/stripe/link-cli/blob/main/CLAUDE.md
- README with full flag reference: https://github.com/stripe/link-cli/blob/main/README.md
- Machine Payments Protocol: https://mpp.dev
- Stripe SPT docs: https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens
