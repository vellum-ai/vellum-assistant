---
name: telegram-setup
description: Connect a Telegram bot to the Vellum Assistant gateway with automated webhook registration and credential storage
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🤖"
  vellum:
    display-name: "Telegram Setup"
    includes: ["public-ingress"]
---

You are helping your user connect a Telegram bot to the Vellum Assistant gateway. Walk through each step below.

## Value Classification

| Value          | Type       | Storage method            | Secret? |
| -------------- | ---------- | ------------------------- | ------- |
| Bot Token      | Credential | `credential_store` prompt | **Yes** |
| Bot Username   | Config     | Telegram config handler   | No      |
| Webhook Secret | Credential | Telegram config handler   | **Yes** |

- **Bot Token** is a secret. Always collect via `credential_store` prompt - never accept it pasted in plaintext chat.
- **Bot Username** and **Webhook Secret** are managed by the same Telegram config handler used by Settings.

# Setup Steps

## Step 1: Collect Bot Token Securely

Tell the user: **"You'll need a Telegram bot token from @BotFather. Open Telegram, message @BotFather, and use /newbot to create one."**

Collect the token through the secure credential prompt:

- Call `credential_store` with `action: "prompt"`, `service: "telegram"`, `field: "bot_token"`, `label: "Telegram Bot Token"`, `description: "Enter the bot token you received from @BotFather"`, `placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"`.

The `telegram` secure prompt already routes through the same Telegram config handler used by Settings. Treat that tool result as authoritative:

- If it succeeds, continue.
- If it says the prompt was cancelled, stop and tell the user Telegram setup was cancelled and no bot token was saved.
- If it returns an error, ask the user to re-enter the token.
- If it returns a warning, continue but mention the warning briefly.

## Step 2: Confirm Telegram Config Result

After the secure prompt succeeds, the same Telegram config handler used by Settings has already:

- validated the bot token with Telegram
- stored the bot token securely
- generated a webhook secret if one was missing
- stored the bot ID and bot username
- attempted platform callback registration automatically when platform callbacks are enabled

Use the most recent `credential_store` result as the source of truth instead of re-validating with shell commands.

## Step 3: Register Default Bot Commands If Needed

Saving or re-prompting for a bot token should not overwrite existing custom Telegram commands.

- If this bot already has custom commands configured and the user wants to keep them, skip this step.
- If the user wants the default assistant commands, register them explicitly through the internal Telegram commands endpoint:

```bash
curl -sSf -X POST "$INTERNAL_GATEWAY_BASE_URL/v1/integrations/telegram/commands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[{"command":"new","description":"Start a new conversation"},{"command":"help","description":"Show available commands"}]}'
```

- If this succeeds, continue.
- If it fails, tell the user the bot token was stored successfully but the default bot commands were not registered yet. They can still continue setup and send messages manually.

## Step 4: Set Up Public Ingress if Needed

### Verify Managed Platform Callback Registration

In managed/platform deployments, explicitly register the Telegram callback route so callback-registration failures are surfaced before you declare setup complete:

```bash
assistant platform callback-routes register --path webhooks/telegram --type telegram --json
```

- If this succeeds, continue.
- If it returns a "not available" style response, you're likely in a local deployment - continue with the public-ingress check below.
- If it fails for any other reason, tell the user Telegram credentials were stored but inbound webhook delivery is not configured yet, surface the error briefly, and stop before declaring setup complete.

### Verify Public Ingress is Set Up

Telegram needs a publicly reachable URL to send webhook events to in local or self-hosted deployments. Load the `public-ingress` skill to determine whether a public ingress has been configured and walk the user through setting one up if not.

- In managed/platform deployments, platform callback registration is already handled by the Telegram config handler and no tunnel setup is needed.
- In local deployments, the gateway will reconcile the Telegram webhook automatically once `ingress.publicBaseUrl` is configured.

## Step 5: Guardian Verification (Optional)

Link the user's Telegram account as a trusted guardian. Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user declines, skip and continue.

## Step 6: Report Success

Summarize:

- Bot verified and credentials stored
- Inbound delivery path configured
- Default bot commands: {configured | preserved existing | skipped}
- Guardian identity: {verified | skipped}

# Clearing Credentials

To disconnect Telegram, prefer the Settings UI path so the same Telegram config flow clears the bot token, webhook secret, and bot metadata together.

# Implementation Rules

All bot-token collection goes through `credential_store` prompts. Do NOT use `assistant credentials reveal`, `assistant credentials set`, `assistant config set telegram.*`, or direct `curl` calls to Telegram APIs in chat. Do NOT ask the user to paste the token in chat - always use the secure credential prompt. If you need to register default commands, use the internal `integrations/telegram/commands` endpoint rather than calling Telegram directly.
