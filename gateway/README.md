# Vellum Gateway

Standalone service that owns Telegram integration end-to-end. Receives Telegram webhooks, routes messages to the correct assistant runtime, and sends replies back to Telegram.

## Architecture

```
Telegram → gateway/ → Assistant Runtime (/v1/assistants/:id/channels/inbound) → gateway/ → Telegram
```

The web app is **not** in the Telegram request path.

## Setup

```bash
cd gateway
bun install
cp .env.example .env
# Edit .env with your configuration
bun run dev
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | — | Secret for verifying webhook requests |
| `TELEGRAM_API_BASE_URL` | No | `https://api.telegram.org` | Override Telegram API base URL |
| `ASSISTANT_RUNTIME_BASE_URL` | Yes | — | Base URL of the assistant runtime HTTP server |
| `GATEWAY_ASSISTANT_ROUTING_JSON` | No | `{}` | JSON mapping of Telegram identities to assistant IDs |
| `GATEWAY_DEFAULT_ASSISTANT_ID` | No | — | Default assistant ID for unmapped users |
| `GATEWAY_UNMAPPED_POLICY` | No | `reject` | Policy for unmapped users: `reject` or `default` |
| `GATEWAY_PORT` | No | `7830` | Port for the gateway HTTP server |
| `GATEWAY_RUNTIME_PROXY_ENABLED` | No | `false` | Enable runtime proxy for non-Telegram requests |
| `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH` | No | `true` | Require bearer auth for proxied requests |
| `RUNTIME_PROXY_BEARER_TOKEN` | Conditional | — | Bearer token for proxy auth (required when proxy + auth enabled) |

## Routing

v1 uses deterministic settings-based routing (no database):

1. **chat_id match** — explicit `chat:<chat_id>` entry in routing JSON
2. **user_id match** — explicit `user:<user_id>` entry in routing JSON
3. **Unmapped policy** — `reject` (drop with message) or `default` (forward to `GATEWAY_DEFAULT_ASSISTANT_ID`)

### Routing JSON format

```json
{
  "chat:12345": "assistant-id-a",
  "user:67890": "assistant-id-b"
}
```

## Setting up the Telegram webhook

After deploying the gateway, register the webhook with Telegram using the `setWebhook` API method. Pass:
- `url` — your gateway URL, e.g. `https://your-host/webhooks/telegram`
- The verify value matching your `TELEGRAM_WEBHOOK_SECRET` env var
- `allowed_updates` — `["message"]`

See the [Telegram Bot API docs](https://core.telegram.org/bots/api#setwebhook) for the full API reference.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Telegram messages not arriving | Is the webhook registered? `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` |
| 401 on webhook | Does `TELEGRAM_WEBHOOK_SECRET` match the `secret_token` in setWebhook? |
| "No route configured" replies | Add a routing entry or set `GATEWAY_UNMAPPED_POLICY=default` with a default assistant |
| Runtime errors | Is `ASSISTANT_RUNTIME_BASE_URL` reachable? Check runtime logs. |
| No reply from assistant | Is the assistant runtime processing messages? Check for `RUNTIME_HTTP_PORT` env var. |
