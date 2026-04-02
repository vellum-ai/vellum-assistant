---
name: telegram-setup
description: Connect a Telegram bot to the Vellum Assistant gateway with automated webhook registration and credential storage
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🤖"
  vellum:
    display-name: "Telegram Setup"
    includes:
      - public-ingress
    activation-hints:
      - "Telegram bot setup, webhook configuration, or BotFather token"
      - "User wants to connect Telegram to the assistant"
    avoid-when:
      - "User wants to send/receive Telegram messages (use messaging skill instead)"
---

You are helping your user connect a Telegram bot to the Vellum Assistant gateway. Walk through each step below.

## Value Classification

| Value          | Type       | Storage method                              | Secret? |
| -------------- | ---------- | ------------------------------------------- | ------- |
| Bot Token      | Credential | `credential_store` prompt                   | **Yes** |
| Bot Username   | Config     | `assistant config set telegram.botUsername` | No      |
| Webhook Secret | Credential | `assistant credentials set`                 | **Yes** |

- **Bot Token** is a secret. Always collect via `credential_store` prompt - never accept it pasted in plaintext chat.
- **Bot Username** is derived from the token via the Telegram API and stored as config.

# Setup Steps

## Step 1: Collect Bot Token Securely

Tell the user: **"You'll need a Telegram bot token from @BotFather. Open Telegram, message @BotFather, and use /newbot to create one."**

Collect the token through the secure credential prompt:

- Call `credential_store` with `action: "prompt"`, `service: "telegram"`, `field: "bot_token"`, `label: "Telegram Bot Token"`, `description: "Enter the bot token you received from @BotFather"`, `placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"`.

## Step 2: Validate Token and Configure Bot

```bash
BOT_TOKEN=$(assistant credentials reveal --service telegram --field bot_token)
GETME_RESPONSE=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe")
BOT_USERNAME=$(echo "$GETME_RESPONSE" | jq -r '.result.username')
assistant config set telegram.botUsername "$BOT_USERNAME"
```

If the `curl` call fails, the token is invalid - ask the user to re-enter (repeat Step 1).

## Step 3: Set Up Webhook Routing

First check whether managed platform callback routes are available:

```bash
assistant platform status --json
```

If `isPlatform` is `true` and both `baseUrl` and `assistantId` are present:

- Register the managed callback route:

```bash
ROUTE_RESPONSE=$(assistant platform callback-routes register --path webhooks/telegram --type telegram --json)
CALLBACK_URL=$(echo "$ROUTE_RESPONSE" | jq -r '.callbackUrl')
```

- In this mode, do **not** load `public-ingress` or mention ngrok. The managed platform callback route is the Telegram webhook URL.

Otherwise:

- Telegram needs a publicly reachable URL to send webhook events to. Load the `public-ingress` skill to determine whether a public ingress has been configured and walk the user through setting one up if not.

### Generate Webhook Secret

Check to see if one already exists:

```bash
assistant credentials inspect --service telegram --field webhook_secret
```

If not, generate and set one:

```bash
assistant credentials set --service telegram --field webhook_secret "$(uuidgen)"
```

### Register Webhook with Telegram

After registering the platform route (or obtaining a public ingress URL), you **must** also tell Telegram to send updates to that URL. The gateway may do this automatically on restart, but its safest to also register explicitly:

```bash
BOT_TOKEN=$(assistant credentials reveal --service telegram --field bot_token)
WEBHOOK_SECRET=$(assistant credentials reveal --service telegram --field webhook_secret)
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${CALLBACK_URL}&secret_token=${WEBHOOK_SECRET}"
```

### Verify Webhook

Confirm Telegram has the correct URL registered:

```bash
WEBHOOK_INFO=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo")
echo "$WEBHOOK_INFO" | jq .
REGISTERED_URL=$(echo "$WEBHOOK_INFO" | jq -r '.result.url')
```

Compare `REGISTERED_URL` to `CALLBACK_URL`. If they don't match, the webhook was not set correctly. Retry the `setWebhook` call. **Do not report success until `getWebhookInfo` confirms the correct URL and shows no `last_error_message`.**

## Step 4: Register Bot Commands

```bash
BOT_TOKEN=$(assistant credentials reveal --service telegram --field bot_token)
curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[{"command":"new","description":"Start a new conversation"},{"command":"help","description":"Show available commands"}]}'
```

Non-critical - warn on failure but don't block setup.

## Step 5: Guardian Verification (Optional)

Link the user's Telegram account as a trusted guardian. Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user declines, skip and continue.

## Step 6: Report Success

Summarize:

- Bot verified and credentials stored
- Webhook registered and verified with Telegram (show the confirmed URL)
- Bot commands registered: /new, /help
- Guardian identity: {verified | skipped}

# Clearing Credentials

To disconnect Telegram:

```bash
assistant credentials delete --service telegram --field bot_token
assistant credentials delete --service telegram --field webhook_secret
assistant config set telegram.botUsername ""
```
