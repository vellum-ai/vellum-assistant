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

Send emails through the user's own Mailgun account. This is for **Bring Your Own** email — the user provides their Mailgun API key and domain, and you send via their infrastructure.

This skill is **not** related to Vellum's managed email (`assistant email` commands). It uses the Mailgun HTTP API directly.

## Setup

### API Key (for sending)

Use the `credential_store` tool to prompt the user for their API key via the secure UI. **Never ask for the key in chat.**

```
credential_store:
  action: "prompt"
  service: mailgun
  field: api_key
  label: "Mailgun API Key"
  placeholder: "key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  description: "Your Mailgun API key for sending emails"
  allowed_domains: ["api.mailgun.net", "api.eu.mailgun.net"]
```

**Note:** Mailgun uses HTTP Basic Auth with username `api` and the API key as the password. The credential proxy cannot construct Basic Auth headers automatically (it would need to base64-encode `api:<key>`). Instead, use `curl -u "api:$KEY"` in bash commands — retrieve the key from the vault at runtime. See the sending examples below.

### Domain Detection

After storing the API key, **automatically detect the user's domain** — don't ask them for it. Retrieve the API key from the vault and call the Mailgun Domains API:

```bash
curl -s --user "api:$MAILGUN_API_KEY" \
  https://api.mailgun.net/v4/domains?state=active
```

The response contains an `items` array of domain objects with `name` and `state` fields. Pick the first domain with `"state": "active"` (or the only domain if there's just one). If no active domains are found, try the EU endpoint (`https://api.eu.mailgun.net/v4/domains?state=active`). If still none, tell the user they need to verify a domain in their Mailgun dashboard first.

Use `hi@<domain>` as the default sender address (consistent with Vellum's native email convention). Remember the domain for future sends.

### Webhook Setup (for receiving)

If the user also wants to **receive** emails via Mailgun, you need to get a webhook URL and create an inbound route in Mailgun.

#### Getting the webhook URL

Use the unified webhooks CLI to get a callback URL. This handles both platform-managed and self-hosted assistants automatically:

```bash
CALLBACK_URL=$(assistant webhooks register mailgun --source "$DOMAIN")
```

If the command fails because no public base URL is configured (self-hosted only), load the `public-ingress` skill to walk the user through setting one up, then retry the command.

#### Creating the inbound route in Mailgun

Create an inbound route via the Mailgun API using the webhook URL from above:

```bash
curl -s --user "api:$MAILGUN_API_KEY" \
  https://api.mailgun.net/v3/routes \
  -F priority=0 \
  -F description="Forward inbound email to assistant" \
  -F expression="match_recipient('.*@DOMAIN')" \
  -F action="forward('<webhook URL>')" \
  -F action="stop()"
```

Replace `DOMAIN` with the user's Mailgun receiving domain. Retrieve the API key from the vault at runtime (do not hardcode it). For EU-region accounts, use `https://api.eu.mailgun.net/v3/routes` instead.

#### Storing the webhook signing key

Store the signing key so the gateway can verify inbound webhooks:

```
credential_store:
  action: "prompt"
  service: mailgun
  field: webhook_signing_key
  label: "Mailgun Webhook Signing Key"
  placeholder: "key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  description: "Webhook signing key from your Mailgun dashboard (for verifying inbound emails)"
```

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
