---
name: "Telegram Setup"
description: "Connect a Telegram bot to the Vellum Assistant gateway with automated webhook registration and credential storage"
user-invocable: true
includes: ["public-ingress"]
metadata: {"vellum": {"emoji": "\ud83e\udd16"}}
---

You are helping your user connect a Telegram bot to the Vellum Assistant gateway. Telegram webhooks are received exclusively by the gateway (the public ingress boundary) — they never hit the assistant runtime directly. When this skill is invoked, walk through each step below using only existing tools.

## What You Need

1. **Bot token** from Telegram's @BotFather (the user provides this)
2. **Gateway webhook URL** — derived from the canonical ingress setting: `${ingress.publicBaseUrl}/webhooks/telegram`. The gateway is the only publicly reachable endpoint; Telegram sends webhooks to the gateway, which validates and forwards them to the assistant runtime internally. If `ingress.publicBaseUrl` is not configured, load and execute the **public-ingress** skill first (`skill_load` with `skill: "public-ingress"`) to set up an ngrok tunnel and persist the URL before continuing.

If the user has already provided the bot token in the conversation, use it directly. Otherwise, ask for it.

## Setup Steps

### Step 1: Verify the Bot Token

Use `evaluate_typescript_code` to call the Telegram `getMe` API and confirm the token is valid:

```typescript
export default async (input: { token: string }) => {
  const res = await fetch(`https://api.telegram.org/bot${input.token}/getMe`, { method: 'POST' });
  return res.json();
};
```

Pass the bot token via `mock_input_json`. Verify the response has `ok: true` and note the bot's username and ID.

If the token is invalid, tell the user and ask them to double-check it.

### Step 2: Generate a Webhook Secret

Use `evaluate_typescript_code` to generate a random secret:

```typescript
import { randomUUID } from 'node:crypto';
export default () => ({ secret: randomUUID() });
```

Save this value for the next steps.

### Step 3: Webhook Registration (Automatic)

Manual webhook registration is no longer required. The gateway automatically reconciles the Telegram webhook on startup and whenever credentials change. It compares the current webhook URL against `${INGRESS_PUBLIC_BASE_URL}/webhooks/telegram` and updates it if needed, including the webhook secret and allowed updates.

If the ingress URL or webhook secret changes (e.g., tunnel restart, secret rotation), the gateway will detect the drift and re-register the webhook automatically.

You can skip directly to storing credentials.

### Step 4: Register Bot Commands

Use `evaluate_typescript_code` to register the `/new` command:

```typescript
export default async (input: { token: string }) => {
  const res = await fetch(`https://api.telegram.org/bot${input.token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [{ command: 'new', description: 'Start a new conversation' }],
    }),
  });
  return res.json();
};
```

### Step 5: Store Credentials

Use `credential_store` twice to securely save the credentials:

1. **Store the bot token:**
   - action: `store`, service: `telegram`, field: `bot_token`, value: the bot token

2. **Store the webhook secret:**
   - action: `store`, service: `telegram`, field: `webhook_secret`, value: the generated secret

### Step 6: Report Success

Summarize what was done:
- Bot verified: @username (ID: nnn)
- Webhook registration: handled automatically by the gateway
- Bot commands registered: /new
- Credentials stored securely in the vault

The gateway automatically detects credentials from the vault, reconciles the Telegram webhook registration, and begins accepting Telegram webhooks shortly. No manual environment variable configuration or webhook registration is needed. If the ingress URL or secret changes later, the gateway will automatically re-register the webhook.
