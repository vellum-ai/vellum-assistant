---
name: mailgun-setup
description: Set up and send emails via a user-provided Mailgun account (BYO email provider)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📬"
  vellum:
    display-name: "Mailgun Email Setup"
    user-invocable: true
---

## Overview

Send emails through the user's own Mailgun account. The user provides their Mailgun API key and domain, and you send via their infrastructure.

## Setup

### Step 0: Check Existing Configuration

Before starting, check whether Mailgun is already configured:

```bash
bun skills/mailgun-setup/scripts/check-config.ts
```

The script outputs JSON: `{ "configured": boolean, "hasApiKey": boolean, "hasWebhookKey": boolean, "details": string }`.

- If `configured` is `true` — Mailgun is already set up. Offer to verify the connection or reconfigure.
- If `configured` is `false` — continue to Step 1.

### Step 1: Store the API Key

Run the store script to securely collect the API key:

```bash
bun skills/mailgun-setup/scripts/store-api-key.ts
```

The script opens a secure credential prompt, stores the key, and exits. If it exits 0, the key is stored. **Never ask for the key in chat.**

**Note:** Mailgun uses HTTP Basic Auth with username `api` and the API key as the password. The credential proxy cannot construct Basic Auth headers automatically. Instead, use `curl -u "api:$KEY"` in bash commands — retrieve the key from the vault at runtime. See the sending examples below.

### Step 2: Detect the Domain

After storing the API key, **automatically detect the user's domain** — don't ask them for it. Retrieve the API key from the vault and call the Mailgun Domains API:

```bash
curl -s --user "api:$MAILGUN_API_KEY" \
  https://api.mailgun.net/v4/domains?state=active
```

The response contains an `items` array of domain objects with `name` and `state` fields. Pick the first domain with `"state": "active"`. If no active domains are found, try the EU endpoint (`https://api.eu.mailgun.net/v4/domains?state=active`). If still none, tell the user they need to verify a domain in their Mailgun dashboard first.

Use `hi@<domain>` as the default sender address. Remember the domain and region (US/EU) for future sends.

### Step 3: Verify the Connection

Confirm the API key works by checking the domain response returned in Step 2. A successful response (HTTP 200) with domain data confirms the connection.

### Step 4: Webhook Setup (for receiving email)

If the user also wants to **receive** emails via Mailgun, run the webhook setup script:

```bash
bun skills/mailgun-setup/scripts/setup-webhook.ts --domain "<verified domain>" [--region eu]
```

This script:

1. Registers a callback URL via the webhooks system
2. Creates an inbound route in Mailgun via their API
3. Prompts the user for their webhook signing key (found in the Mailgun dashboard: **Settings > API Security > HTTP Webhook Signing Key**)

If the script fails because no public base URL is configured (self-hosted only), load the `public-ingress` skill to walk the user through setting one up, then retry.

### Step 5: Report Success

Summarize with the completed checklist:

"Setup complete!
✅ API key configured
✅ Domain detected: `<domain>` (region: US/EU)
✅ Connection verified
{webhook_line}

Default sender: hi@`<domain>`"

For `{webhook_line}`:

- If webhook was set up: `✅ Inbound route and webhook signing key configured`
- If skipped: `⬜ Webhook — run setup again to enable inbound email`

## Sending Email

Use `bash` with `curl` to call the Mailgun API. Pass the API key via `-u` for Basic Auth:

```bash
curl -s --user "api:$MAILGUN_API_KEY" \
  https://api.mailgun.net/v3/DOMAIN/messages \
  -F from="Name <sender@example.com>" \
  -F to="recipient@example.com" \
  -F subject="Hello" \
  -F text="Plain text body" \
  -F html="<p>HTML body</p>"
```

Replace `DOMAIN` with the user's Mailgun sending domain.

### API Parameters

| Parameter       | Type   | Required | Description                                   |
| --------------- | ------ | -------- | --------------------------------------------- |
| `from`          | string | ✅       | Sender address (`"Name <email>"` format)      |
| `to`            | string | ✅       | Recipient(s), comma-separated for multiple    |
| `subject`       | string | ✅       | Email subject                                 |
| `text`          | string |          | Plain text body                               |
| `html`          | string |          | HTML body                                     |
| `cc`            | string |          | CC recipients, comma-separated                |
| `bcc`           | string |          | BCC recipients, comma-separated               |
| `h:Reply-To`    | string |          | Reply-to address                              |
| `h:In-Reply-To` | string |          | Message-ID of parent (for threading)          |
| `h:References`  | string |          | Space-separated chain of ancestor Message-IDs |

### Threading (replies)

To reply in a thread, include custom headers:

```bash
curl -s --user "api:$MAILGUN_API_KEY" \
  https://api.mailgun.net/v3/DOMAIN/messages \
  -F from="bot@example.com" \
  -F to="user@example.com" \
  -F subject="Re: Original subject" \
  -F text="Reply body" \
  -F "h:In-Reply-To=<original-message-id>" \
  -F "h:References=<original-message-id>"
```

### Response

Success returns `{ "id": "<message-id>", "message": "Queued. Thank you." }` with HTTP 200.

Errors return `{ "message": "error description" }` with 4xx/5xx status.

### Regions

Mailgun has US and EU regions:

- **US (default):** `https://api.mailgun.net/v3/DOMAIN/messages`
- **EU:** `https://api.eu.mailgun.net/v3/DOMAIN/messages`

Ask the user which region their account uses if sends fail with 401.

## Important Notes

- The `from` address must be from the user's verified Mailgun domain.
- Default sender address is `hi@<domain>` — use this unless the user specifies otherwise.
- Always confirm with the user before sending — never send without explicit permission.
- Use `text` for plain text, `html` for rich formatting. Provide both when possible.
- Mailgun's free tier allows 100 emails/day. Paid plans have higher limits.
