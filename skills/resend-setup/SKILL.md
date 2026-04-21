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

Send emails through the user's own Resend account. This is for **Bring Your Own** email — the user provides their Resend API key and you send via their domain.

This skill is **not** related to Vellum's managed email (`assistant email` commands). It uses the Resend HTTP API directly.

## Setup

### API Key (for sending)

Use the `credential_store` tool to prompt the user for their API key via the secure UI. **Never ask for the key in chat.**

```
credential_store:
  action: "prompt"
  service: resend
  field: api_key
  label: "Resend API Key"
  placeholder: "re_xxxxxxxxx"
  description: "Your Resend API key for sending emails"
  allowed_domains: ["api.resend.com"]
  injection_templates:
    - hostPattern: "*.resend.com"
      injectionType: header
      headerName: Authorization
      valuePrefix: "Bearer "
```

### Webhook Secret (for receiving)

If the user also wants to **receive** emails via Resend, they need to configure a webhook in their Resend dashboard:

- **URL:** `https://<assistant-ingress>/webhooks/resend`
- **Event:** `email.received`

Then store the webhook signing secret:

```
credential_store:
  action: "prompt"
  service: resend
  field: webhook_secret
  label: "Resend Webhook Signing Secret"
  placeholder: "whsec_xxxxxxxxx"
  description: "Signing secret from your Resend webhook settings (for verifying inbound emails)"
```

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
- Always confirm with the user before sending — never send without explicit permission.
- Use `text` for plain text, `html` for rich formatting. Provide both when possible.
- Rate limits depend on the user's Resend plan.
