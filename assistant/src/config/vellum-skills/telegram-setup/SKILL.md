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

### Step 3: Register the Webhook

Use `evaluate_typescript_code` to register the webhook with Telegram:

```typescript
export default async (input: { token: string; url: string; secret: string }) => {
  const res = await fetch(`https://api.telegram.org/bot${input.token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: input.url,
      secret_token: input.secret,
      allowed_updates: ['message', 'edited_message'],
    }),
  });
  return res.json();
};
```

Verify the response has `ok: true`.

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
- Webhook registered at the provided URL
- Bot commands registered: /new
- Credentials stored securely in the vault

The gateway automatically detects credentials from the vault and will begin accepting Telegram webhooks shortly. No manual environment variable configuration is needed.
