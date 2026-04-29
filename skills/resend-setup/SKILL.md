---
name: resend-setup
description: Set up and send emails via a user-provided Resend account (BYO email provider)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📤"
  vellum:
    display-name: "Resend Email Setup"
    user-invocable: true
---

## Overview

Send emails through the user's own Resend account. The user provides their Resend API key and you send via their domain.

## Setup

### Step 0: Check Existing Configuration

Before starting, check whether Resend is already configured:

```bash
bun skills/resend-setup/scripts/check-config.ts
```

The script outputs JSON: `{ "configured": boolean, "hasApiKey": boolean, "hasWebhookSecret": boolean, "details": string }`.

- If `configured` is `true` — Resend is already set up. Offer to verify the connection or reconfigure.
- If `configured` is `false` — continue to Step 1.

### Step 1: Store the API Key

Run the store script to securely collect the API key:

```bash
bun skills/resend-setup/scripts/store-api-key.ts
```

The script opens a secure credential prompt, stores the key with the correct injection templates, and exits. If it exits 0, the key is stored. **Never ask for the key in chat.**

### Step 2: Detect the Domain

After storing the API key, **automatically detect the user's domain** — don't ask them for it. Call the Resend Domains API:

```bash
curl -s https://api.resend.com/domains \
  -H "Content-Type: application/json"
```

Run this with `network_mode: "proxied"` and the resend credential so the Authorization header is injected automatically. The response contains a `data` array of domain objects with `name` and `status` fields. Pick the first domain with `"status": "verified"` (or the only domain if there's just one). If no verified domains are found, tell the user they need to verify a domain in their Resend dashboard first.

Use `hi@<domain>` as the default sender address. Remember the domain for future sends.

### Step 3: Verify the Connection

Send a test request to confirm the API key works:

```bash
curl -s https://api.resend.com/domains \
  -H "Content-Type: application/json"
```

Run with `network_mode: "proxied"` and the resend credential. A successful response (HTTP 200) with domain data confirms the connection.

### Step 4: Webhook Setup (for receiving email)

If the user also wants to **receive** emails via Resend, run the webhook setup script:

```bash
bun skills/resend-setup/scripts/setup-webhook.ts --domain "<verified domain>"
```

This script:

1. Registers a callback URL via the webhooks system
2. Creates the webhook in Resend via their API
3. Automatically stores the returned signing secret in the credential vault

If the script fails because no public base URL is configured (self-hosted only), load the `public-ingress` skill to walk the user through setting one up, then retry.

### Step 5: Report Success

Summarize with the completed checklist:

"Setup complete!
✅ API key configured
✅ Domain detected: `<domain>`
✅ Connection verified
{webhook_line}

Default sender: hi@`<domain>`"

For `{webhook_line}`:

- If webhook was set up: `✅ Webhook configured for inbound email`
- If skipped: `⬜ Webhook — run setup again to enable inbound email`

## Sending Email

Use `bash` with `curl` to call the Resend API. The credential proxy injects the `Authorization: Bearer` header automatically when using `network_mode: "proxied"` with the resend credential.

```bash
curl -X POST https://api.resend.com/emails \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Name <sender@example.com>",
    "to": ["recipient@example.com"],
    "subject": "Hello",
    "text": "Plain text body",
    "html": "<p>HTML body</p>"
  }'
```

### API Parameters

| Parameter  | Type               | Required | Description                                                     |
| ---------- | ------------------ | -------- | --------------------------------------------------------------- |
| `from`     | string             | ✅       | Sender address (`"Name <email>"` format)                        |
| `to`       | string \| string[] | ✅       | Recipient(s), max 50                                            |
| `subject`  | string             | ✅       | Email subject                                                   |
| `text`     | string             |          | Plain text body                                                 |
| `html`     | string             |          | HTML body                                                       |
| `cc`       | string \| string[] |          | CC recipients                                                   |
| `bcc`      | string \| string[] |          | BCC recipients                                                  |
| `reply_to` | string \| string[] |          | Reply-to address                                                |
| `headers`  | object             |          | Custom headers (e.g. `In-Reply-To`, `References` for threading) |

### Threading (replies)

To reply in a thread, include `In-Reply-To` and `References` headers:

```json
{
  "from": "bot@example.com",
  "to": ["user@example.com"],
  "subject": "Re: Original subject",
  "text": "Reply body",
  "headers": {
    "In-Reply-To": "<original-message-id>",
    "References": "<original-message-id>"
  }
}
```

### Response

Success returns `{ "id": "email-id" }` with HTTP 200.

Errors return `{ "message": "error description" }` with 4xx/5xx status.

## Important Notes

- The `from` address must be from a domain verified in the user's Resend account.
- Default sender address is `hi@<domain>` — use this unless the user specifies otherwise.
- Always confirm with the user before sending — never send without explicit permission.
- Use `text` for plain text, `html` for rich formatting. Provide both when possible.
- Rate limits depend on the user's Resend plan.
