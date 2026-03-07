---
name: telegram-setup
description: Connect a Telegram bot to the Vellum Assistant gateway with automated webhook registration and credential storage
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🤖","vellum":{"display-name":"Telegram Setup","user-invocable":true,"includes":["public-ingress"]}}
---

You are helping your user connect a Telegram bot to the Vellum Assistant gateway. Telegram webhooks are received exclusively by the gateway (the public ingress boundary) — they never hit the assistant runtime directly. When this skill is invoked, walk through each step below using only existing tools.

## Prerequisites — Check Before Starting

Before beginning setup, verify these conditions are met:

1. **Gateway API base URL is set and reachable:** Use the injected `INTERNAL_GATEWAY_BASE_URL`, then run `curl -sf "$INTERNAL_GATEWAY_BASE_URL/healthz"` — it should return gateway health JSON (for example `{"status":"ok"}`). If it fails, tell the user to start the assistant with `vellum wake` and wait for it to become healthy before continuing.
2. **Public ingress URL is configured.** The gateway webhook URL is derived from `${ingress.publicBaseUrl}/webhooks/telegram`. If the ingress URL is not configured, load and execute the **public-ingress** skill first (`skill_load` with `skill: "public-ingress"`) to set up an ngrok tunnel and persist the URL before continuing.

## What You Need

1. **Bot token** from Telegram's @BotFather (the user provides this)
2. **Gateway webhook URL** — derived from the canonical ingress setting: `${ingress.publicBaseUrl}/webhooks/telegram`. The gateway is the only publicly reachable endpoint; Telegram sends webhooks to the gateway, which validates and forwards them to the assistant runtime internally.

**IMPORTANT — Secure credential collection only:** Never use a bot token that was pasted in plaintext chat. Always collect the bot token through the secure credential prompt flow using `credential_store` with `action: "prompt"` and `service: "telegram"`, `field: "bot_token"`. If the user has already pasted a token in the conversation, inform them that for security reasons you cannot use tokens shared in chat and must collect it through the secure prompt instead.

## Setup Steps

### Step 1: Collect the Bot Token Securely

Collect the bot token through the secure credential prompt:

- Call `credential_store` with `action: "prompt"`, `service: "telegram"`, `field: "bot_token"`, `label: "Telegram Bot Token"`, `description: "Enter the bot token you received from @BotFather"`, and `placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"`.

The token is collected securely via a system-level prompt and is never exposed in plaintext chat.

### Step 2: Configure Bot and Register Commands

After the token is collected, run the following decomposed commands to validate the token, store configuration, and register bot commands.

**2a. Validate the bot token via Telegram API:**

```bash
BOT_TOKEN=$(assistant credentials reveal telegram:bot_token)
GETME_RESPONSE=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe")
```

This retrieves the bot token from secure storage and validates it by calling the Telegram `getMe` API. If the `curl` call fails (non-zero exit code or empty response), the token is invalid — tell the user and ask them to re-enter the token via the secure prompt (repeat Step 1).

**2b. Store the bot username in config:**

```bash
BOT_USERNAME=$(echo "$GETME_RESPONSE" | jq -r '.result.username')
assistant config set telegram.botUsername "$BOT_USERNAME"
```

This parses the bot username from the `getMe` response and stores it in the assistant config. If the `config set` command fails, report the error to the user.

**2c. Generate and store webhook secret:**

```bash
assistant credentials set telegram:webhook_secret "$(uuidgen)"
```

This generates a random webhook secret and stores it in the credential vault. Skip this step if a webhook secret already exists (check with `assistant credentials reveal telegram:webhook_secret` first). If the `credentials set` command fails, report the error to the user.

**2d. Register platform callback route (containerized deployments only):**

```bash
assistant platform callback-routes register --path webhooks/telegram --type telegram --json
```

This registers the Telegram webhook callback route with the platform. This is only required for containerized deployments — if the command returns a "not available" error, that is expected for local deployments and can be safely ignored. Continue to the next step.

**2e. Register bot commands via Telegram API:**

```bash
curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[{"command":"new","description":"Start a new conversation"},{"command":"help","description":"Show available commands"}]}'
```

This registers the `/new` and `/help` bot commands with Telegram so they appear in the command menu. If this call fails, warn the user but do not block setup — command registration is non-critical and can be retried later.

On success, confirm to the user: "Bot validated, credentials stored, and commands registered (/new, /help)."

### Step 3: Webhook Registration (Automatic)

Manual webhook registration is no longer required. The gateway automatically reconciles the Telegram webhook on startup and whenever credentials change. It compares the current webhook URL against `${INGRESS_PUBLIC_BASE_URL}/webhooks/telegram` and updates it if needed, including the webhook secret and allowed updates.

If the webhook secret changes (e.g., secret rotation), the gateway's credential watcher detects the change and re-registers the webhook automatically. If the ingress URL changes (e.g., tunnel restart), the assistant triggers an immediate internal reconcile so the webhook re-registers automatically without a gateway restart.

### Step 4: Verify Guardian Identity

Now link the user's Telegram account as the trusted guardian for this bot. Tell the user: "Now let's verify your guardian identity. This links your Telegram account as the trusted guardian for this bot."

Load the **guardian-verify-setup** skill to handle the verification flow:

- Call `skill_load` with `skill: "guardian-verify-setup"` to load the dependency skill.

The guardian-verify-setup skill manages the full outbound verification flow for Telegram, including:

- Collecting the user's Telegram chat ID or @handle as the destination
- Starting the outbound verification session via `assistant channel-verification-sessions create --channel telegram --destination <dest> --json`
- Handling the bootstrap deep-link flow when the user provides an @handle (the response includes a `telegramBootstrapUrl` that the user must click before receiving the code)
- Guiding the user to send the verification code back in the Telegram bot chat
- Checking guardian status to confirm the binding was created
- Handling resend, cancel, and error cases

Tell the user: _"I've loaded the guardian verification guide. It will walk you through linking your Telegram account as the trusted guardian."_

After the guardian-verify-setup skill completes (or the user skips), continue to Step 5.

**Note:** Guardian verification is optional but recommended. If the user declines or wants to skip, proceed to Step 5 without blocking.

### Step 5: Validate Routing Configuration

Verify that the gateway routing is configured to deliver inbound messages to the assistant:

- In **single-assistant mode** (the default local deployment), routing is automatically configured. The CLI sets `GATEWAY_UNMAPPED_POLICY=default` and `GATEWAY_DEFAULT_ASSISTANT_ID` to the current assistant's ID when starting the gateway, so no manual routing configuration is needed.
- In **multi-assistant mode**, the operator must set `GATEWAY_ASSISTANT_ROUTING_JSON` to map specific chat IDs or user IDs to assistant IDs, or configure a default assistant via `GATEWAY_DEFAULT_ASSISTANT_ID` with `GATEWAY_UNMAPPED_POLICY=default`.

If routing is misconfigured, inbound Telegram messages will be rejected and the gateway will send a visible notice to the chat explaining the issue (rate-limited to once per 5 minutes per chat).

### Step 6: Verify Binding State

Before reporting success, confirm the guardian binding was actually created. Check guardian binding status via Vellum CLI:

```bash
assistant channel-verification-sessions status --channel telegram --json
```

If the binding is absent and the user said they completed the verification:

1. Tell the user the verification does not appear to have succeeded.
2. Offer to re-run the guardian-verify-setup skill (repeat Step 4).
3. Only proceed to Step 7 once binding state is confirmed or the user explicitly skips guardian verification.

### Step 7: Report Success

Summarize what was done:

- Bot verified and credentials stored securely
- Webhook registration: handled automatically by the gateway
- Bot commands registered: /new
- Guardian identity: {verified | not configured}
- Guardian verification status: {verified via outbound flow | skipped}
- Routing configuration validated
- To re-check guardian status later, use: `assistant channel-verification-sessions status --channel telegram --json`

The gateway automatically detects credentials from the vault, reconciles the Telegram webhook registration, and begins accepting Telegram webhooks shortly. In single-assistant mode, routing is automatically configured — no manual environment variable configuration or webhook registration is needed. If the webhook secret changes later, the gateway's credential watcher will automatically re-register the webhook. If the ingress URL changes (e.g., tunnel restart), the assistant triggers an immediate internal reconcile so the webhook re-registers automatically without a gateway restart.

## Bot-Account Limitations

Telegram bot accounts have inherent limitations imposed by the Bot API:

- **No arbitrary messaging**: Bots cannot initiate conversations with users who have not first interacted with the bot (sent `/start` or added it to a group). Messaging arbitrary phone numbers is not possible.
- **No conversation listing**: The Bot API does not expose a method to enumerate the chats a bot belongs to.
- **No message history retrieval**: Bots cannot fetch past messages from a chat.
- **No message search**: No search API is available for bots.

These limitations apply to all Telegram bots regardless of configuration. Future support for MTProto user-account sessions may lift some of these restrictions.

## Automated vs Manual Steps

The following steps are now **automated** by the gateway and CLI:

| Step                  | Status                       | Details                                                                                         |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Webhook registration  | Automated                    | The gateway reconciles the webhook URL on startup and when credentials change                   |
| Routing configuration | Automated (single-assistant) | The CLI sets `GATEWAY_UNMAPPED_POLICY=default` and `GATEWAY_DEFAULT_ASSISTANT_ID` automatically |
| Credential detection  | Automated                    | The gateway watches the credential vault for changes                                            |

The following steps still require **manual** action:

| Step                                       | Details                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Bot token from @BotFather                  | User must create a bot and provide the token via secure prompt                                     |
| Bot configuration and command registration | Configured via the setup skill (Step 2 above) using decomposed CLI and curl commands |
| Guardian verification                      | Handled via the guardian-verify-setup skill using the outbound verification flow (Step 4 above)    |
| Multi-assistant routing                    | Requires manual `GATEWAY_ASSISTANT_ROUTING_JSON` configuration                                     |
