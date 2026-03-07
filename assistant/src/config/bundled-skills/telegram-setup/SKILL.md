---
name: telegram-setup
description: Connect a Telegram bot to the Vellum Assistant gateway with automated webhook registration and credential storage
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🤖","vellum":{"display-name":"Telegram Setup","user-invocable":true,"includes":["public-ingress"]}}
---

You are helping your user connect a Telegram bot to the Vellum Assistant gateway. Walk through each step below.

## Prerequisites

1. **Gateway is running:** `curl -sf "$INTERNAL_GATEWAY_BASE_URL/healthz"` should return `{"status":"ok"}`. If not, tell the user to run `vellum wake`.
2. **Public ingress is configured.** If not, load the **public-ingress** skill first (`skill_load` with `skill: "public-ingress"`).

## Value Classification

| Value          | Type       | Storage method                              | Secret? |
| -------------- | ---------- | ------------------------------------------- | ------- |
| Bot Token      | Credential | `credential_store` prompt                   | **Yes** |
| Bot Username   | Config     | `assistant config set telegram.botUsername` | No      |
| Webhook Secret | Credential | `assistant credentials set`                 | No      |

- **Bot Token** is a secret. Always collect via `credential_store` prompt — never accept it pasted in plaintext chat.
- **Bot Username** is derived from the token via the Telegram API and stored as config.

# Setup Steps

## Step 1: Collect Bot Token Securely

Tell the user: **"You'll need a Telegram bot token from @BotFather. Open Telegram, message @BotFather, and use /newbot to create one."**

Collect the token through the secure credential prompt:

- Call `credential_store` with `action: "prompt"`, `service: "telegram"`, `field: "bot_token"`, `label: "Telegram Bot Token"`, `description: "Enter the bot token you received from @BotFather"`, `placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"`.

## Step 2: Validate Token and Configure Bot

```bash
BOT_TOKEN=$(assistant credentials reveal telegram:bot_token)
GETME_RESPONSE=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe")
BOT_USERNAME=$(echo "$GETME_RESPONSE" | jq -r '.result.username')
assistant config set telegram.botUsername "$BOT_USERNAME"
```

If the `curl` call fails, the token is invalid — ask the user to re-enter (repeat Step 1).

## Step 3: Generate Webhook Secret

Skip if one already exists (`assistant credentials inspect telegram:webhook_secret`).

```bash
assistant credentials set telegram:webhook_secret "$(uuidgen)"
```

## Step 4: Register Platform Callback Route

```bash
assistant platform callback-routes register --path webhooks/telegram --type telegram --json
```

Only needed for containerized deployments. A "not available" error is expected locally — ignore it.

## Step 5: Register Bot Commands

```bash
BOT_TOKEN=$(assistant credentials reveal telegram:bot_token)
curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[{"command":"new","description":"Start a new conversation"},{"command":"help","description":"Show available commands"}]}'
```

Non-critical — warn on failure but don't block setup.

## Step 6: Guardian Verification (Optional)

Link the user's Telegram account as the trusted guardian. Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user declines, skip and continue.

## Step 7: Report Success

Summarize:

- Bot verified and credentials stored
- Bot commands registered: /new, /help
- Guardian identity: {verified | skipped}

## Clearing Credentials

To disconnect Telegram:

```bash
assistant credentials delete telegram:bot_token
assistant credentials delete telegram:webhook_secret
assistant config set telegram.botUsername ""
```
