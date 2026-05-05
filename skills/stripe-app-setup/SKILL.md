---
name: stripe-app-setup
description: Create and configure a Stripe restricted API key so the assistant can manage payments, subscriptions, and customers under its own scoped identity
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💳"
  vellum:
    display-name: "Stripe App Setup"
    user-invocable: true
---

## Overview

Set up a **Stripe restricted API key** so the assistant can interact with a Stripe account — querying customers, managing subscriptions, processing refunds, reading invoices, and monitoring payments as a scoped entity.

Restricted API keys (RAKs) limit access to only the specific Stripe resources the assistant needs, reducing the blast radius if a key is ever compromised. RAKs are drop-in replacements for secret keys — they work identically with every Stripe API.

**Total manual effort: ~2 interactions** — create the restricted key in the Dashboard and hand it over via secure prompt.

## Prerequisites

- User must have **admin or developer access** to the Stripe account
- User must be logged into the Stripe Dashboard in their browser

## Setup Flow

### Step 0: Check Existing Configuration

Before starting, check whether Stripe is already configured by running the check script:

```bash
bun skills/stripe-app-setup/scripts/check-config.ts
```

The script outputs JSON: `{ "configured": boolean, "details": string }`.

- If `configured` is `true` — Stripe is already set up. Offer to verify the connection or reconfigure.
- If `configured` is `false` — continue to Step 1.

### Step 1: Create the Restricted API Key

Direct the user to create a new restricted key:

> Open **https://dashboard.stripe.com/apikeys** and click **+ Create restricted key**.

When Stripe asks "How will you use this API key?", select **Providing this key to another website** and enter the assistant's name.

Guide them through the permissions. A good default for managing payments, customers, and subscriptions:

| Resource            | Access Level |
| ------------------- | ------------ |
| **Customers**       | Read & Write |
| **Charges**         | Read & Write |
| **Invoices**        | Read & Write |
| **Payment Intents** | Read & Write |
| **Subscriptions**   | Read & Write |
| **Products**        | Read         |
| **Prices**          | Read         |
| **Balance**         | Read         |
| **Disputes**        | Read         |
| **Payouts**         | Read         |

Adjust permissions up or down based on the user's needs. The principle of least privilege applies — only request what the assistant will actually use. For read-only monitoring, set everything to Read.

> Click **Create key** when done.

**Important:** The restricted key is revealed only once after creation. The user must copy it immediately.

### Step 2: Collect the API Key

After the user copies their restricted key, run the store script to securely collect and store it:

```bash
bun skills/stripe-app-setup/scripts/store-key.ts
```

The script opens a secure credential prompt in the user's app, stores the key in the encrypted vault with the correct injection templates for `api.stripe.com`, and exits. If it exits 0, the key is stored.

### Step 3: Verify

After storing the key, verify the connection:

```bash
curl -s https://api.stripe.com/v1/balance
```

Run with `network_mode: "proxied"` and the stripe credential. A successful response returns the account's balance object with `available` and `pending` arrays.

If the response returns a 401, the key is invalid or revoked. If 403, the key doesn't have the required permissions for the endpoint.

### Step 4: Report Success

Summarize with the completed checklist:

"Setup complete!
✅ Restricted API key configured
✅ Connection verified — balance accessible

Key type: Restricted API key (`rk_...`)
Permissions: {list the configured permission levels}
Key management: https://dashboard.stripe.com/apikeys"

## API Usage

After setup, use `bash` with `curl` to call the Stripe API. The credential proxy injects the `Authorization: Bearer` header automatically when using `network_mode: "proxied"` with the stripe credential.

### Common API Calls

**List customers:**

```bash
curl -s https://api.stripe.com/v1/customers?limit=10
```

**Create a customer:**

```bash
curl -s https://api.stripe.com/v1/customers \
  -d "email=customer@example.com" \
  -d "name=Jane Doe"
```

**List recent payments:**

```bash
curl -s https://api.stripe.com/v1/payment_intents?limit=10
```

**List subscriptions:**

```bash
curl -s https://api.stripe.com/v1/subscriptions?limit=10
```

**Retrieve an invoice:**

```bash
curl -s https://api.stripe.com/v1/invoices/{invoice_id}
```

**Issue a refund:**

```bash
curl -s https://api.stripe.com/v1/refunds \
  -d "payment_intent={pi_id}"
```

All calls use `network_mode: "proxied"` with the stripe credential.

### Pagination

Stripe uses cursor-based pagination. Use `starting_after` with the last object's ID to page forward:

```bash
curl -s "https://api.stripe.com/v1/customers?limit=100&starting_after=cus_lastId"
```

### Sandbox vs Live

Stripe has separate sandbox and live modes with separate API keys. Keys starting with `rk_test_` are sandbox keys; `rk_live_` are live keys. The assistant uses whichever key the user provides.

## Credential Reference

All credentials are stored under `service: stripe`:

| Field     | Description                                   | When Set |
| --------- | --------------------------------------------- | -------- |
| `api_key` | Restricted API key (`rk_live_` or `rk_test_`) | Step 2   |

## Troubleshooting

### 401 Unauthorized

The API key is invalid or has been revoked. Create a new restricted key in the Dashboard and re-run Step 2.

### 403 Forbidden / "Insufficient permissions"

The restricted key doesn't have the required permission for the API endpoint being called. Edit the key's permissions in the Dashboard at https://dashboard.stripe.com/apikeys (click the overflow menu → Edit key).

### "No such customer" / "No such subscription"

Sandbox and live mode are separate environments. A sandbox key can't access live mode objects and vice versa. Confirm the key mode matches the data being queried.

## Important Notes

- Restricted API keys do not expire automatically. They remain valid until revoked in the Dashboard.
- Live mode restricted keys can only be revealed once — the user must copy immediately after creation.
- Always confirm with the user before performing write operations (creating charges, issuing refunds, modifying subscriptions).
- Stripe rate limits API calls — standard limit is 100 read operations/second and 100 write operations/second per key.
