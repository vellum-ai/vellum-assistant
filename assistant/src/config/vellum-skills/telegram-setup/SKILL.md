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

**IMPORTANT — Secure credential collection only:** Never use a bot token that was pasted in plaintext chat. Always collect the bot token through the secure credential prompt flow using `credential_store` with `action: "prompt"` and `service: "telegram"`, `field: "bot_token"`. If the user has already pasted a token in the conversation, inform them that for security reasons you cannot use tokens shared in chat and must collect it through the secure prompt instead.

## Setup Steps

### Step 1: Collect the Bot Token Securely

Collect the bot token through the secure credential prompt:
- Call `credential_store` with `action: "prompt"`, `service: "telegram"`, `field: "bot_token"`, and `prompt: "Enter your Telegram bot token from @BotFather"`.

The token is stored securely and is never exposed in plaintext chat.

### Step 2: Configure via Daemon

After the token is stored, retrieve it and pass it to the daemon's `telegram_config` handler which validates, stores, and configures everything in one step:

1. Call `credential_store` with `action: "retrieve"`, `service: "telegram"`, `field: "bot_token"` to get the stored token.
2. Send the `telegram_config` IPC message with `action: "set"` and `botToken: <retrieved token>`.

The daemon's `telegram_config set` handler automatically:
- Validates the token by calling the Telegram `getMe` API
- Stores the bot token in secure storage with bot username metadata
- Generates a webhook secret if one does not already exist
- Triggers an immediate gateway webhook reconcile

If the token is invalid, the daemon returns an error. Tell the user and ask them to re-enter the token via the secure prompt.

### Step 3: Webhook Registration (Automatic)

Manual webhook registration is no longer required. The gateway automatically reconciles the Telegram webhook on startup and whenever credentials change. It compares the current webhook URL against `${INGRESS_PUBLIC_BASE_URL}/webhooks/telegram` and updates it if needed, including the webhook secret and allowed updates.

If the webhook secret changes (e.g., secret rotation), the gateway's credential watcher detects the change and re-registers the webhook automatically. If the ingress URL changes (e.g., tunnel restart), the assistant daemon triggers an immediate internal reconcile so the webhook re-registers automatically without a gateway restart.

### Step 4: Register Bot Commands

Use `credential_store` with `action: "retrieve"`, `service: "telegram"`, `field: "bot_token"` to get the token, then use `evaluate_typescript_code` to register the `/new` command:

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

### Step 5: Validate Routing Configuration

Verify that the gateway routing is configured to deliver inbound messages to the assistant:

- In **single-assistant mode** (the default local deployment), routing is automatically configured. The CLI sets `GATEWAY_UNMAPPED_POLICY=default` and `GATEWAY_DEFAULT_ASSISTANT_ID` to the current assistant's ID when starting the gateway, so no manual routing configuration is needed.
- In **multi-assistant mode**, the operator must set `GATEWAY_ASSISTANT_ROUTING_JSON` to map specific chat IDs or user IDs to assistant IDs, or configure a default assistant via `GATEWAY_DEFAULT_ASSISTANT_ID` with `GATEWAY_UNMAPPED_POLICY=default`.

If routing is misconfigured, inbound Telegram messages will be rejected and the gateway will send a visible notice to the chat explaining the issue (rate-limited to once per 5 minutes per chat).

### Step 6: Report Success

Summarize what was done:
- Bot verified and credentials stored securely via daemon
- Webhook registration: handled automatically by the gateway
- Bot commands registered: /new
- Routing configuration validated

The gateway automatically detects credentials from the vault, reconciles the Telegram webhook registration, and begins accepting Telegram webhooks shortly. In single-assistant mode, routing is automatically configured — no manual environment variable configuration or webhook registration is needed. If the webhook secret changes later, the gateway's credential watcher will automatically re-register the webhook. If the ingress URL changes (e.g., tunnel restart), the assistant daemon triggers an immediate internal reconcile so the webhook re-registers automatically without a gateway restart.

## Bot-Account Limitations

Telegram bot accounts have inherent limitations imposed by the Bot API:

- **No arbitrary messaging**: Bots cannot initiate conversations with users who have not first interacted with the bot (sent `/start` or added it to a group). Messaging arbitrary phone numbers is not possible.
- **No conversation listing**: The Bot API does not expose a method to enumerate the chats a bot belongs to.
- **No message history retrieval**: Bots cannot fetch past messages from a chat.
- **No message search**: No search API is available for bots.

These limitations apply to all Telegram bots regardless of configuration. Future support for MTProto user-account sessions may lift some of these restrictions.

## Automated vs Manual Steps

The following steps are now **automated** by the gateway and CLI:

| Step | Status | Details |
|------|--------|---------|
| Webhook registration | Automated | The gateway reconciles the webhook URL on startup and when credentials change |
| Routing configuration | Automated (single-assistant) | The CLI sets `GATEWAY_UNMAPPED_POLICY=default` and `GATEWAY_DEFAULT_ASSISTANT_ID` automatically |
| Credential detection | Automated | The gateway watches the credential vault for changes |

The following steps still require **manual** action:

| Step | Details |
|------|---------|
| Bot token from @BotFather | User must create a bot and provide the token via secure prompt |
| Bot command registration | Registered via the setup skill (Step 4 above) |
| Multi-assistant routing | Requires manual `GATEWAY_ASSISTANT_ROUTING_JSON` configuration |
