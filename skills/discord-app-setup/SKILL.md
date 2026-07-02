---
name: discord-app-setup
description: Connect a Discord bot to the assistant via the Discord Gateway with guided application creation and intent configuration
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "🎮"
  vellum:
    category: "messaging"
    display-name: "Discord App Setup"
---

You are helping your user create a Discord application and connect a Discord bot to the assistant via the Discord Gateway. Walk through each step below.

**CRITICAL: Follow these steps strictly in order. Do NOT combine steps, skip ahead, or ask for the bot token before the bot user has been configured. The token is shown only once after reset — collect it the moment the user generates it, never before.**

## Value Classification

| Value     | Type       | Secret? |
| --------- | ---------- | ------- |
| Bot Token | Credential | **Yes** |

The **Bot Token** is the only value that needs to be persisted. Always collect it via the assistant's secure credential prompt — never accept it pasted in plaintext chat.

The Application ID and Public Key are derivable from the bot token at any time via Discord's API and do not need to be stored separately.

# Setup Steps

## Step 0: Check Existing Configuration

Before starting, run the check script:

```bash
bun skills/discord-app-setup/scripts/check-config.ts
```

The script outputs JSON: `{ "configured": boolean, "details": string }`.

- If `configured` is `true` — Discord is already set up. Offer to verify the connection or reconfigure.
- If `configured` is `false` — continue to Step 1.

## Step 1: Create the Discord Application

Tell the user:

> Open **https://discord.com/developers/applications** and click **New Application** in the top-right. Give it a name (this is how the bot appears to users) and accept the Developer Terms of Service. After creation you'll land on the application's **General Information** page.

Wait for the user to confirm they've created the app before proceeding. Discord does not support manifest-based creation — the rest of the configuration happens step by step in the portal.

## Step 2: Configure the Bot User

Discord automatically attaches a Bot user to every new application. The user only needs to enable the privileged intents this assistant requires.

Direct the user:

> In the left sidebar click **Bot**. Scroll to **Privileged Gateway Intents** and enable:
>
> - ✅ **Message Content Intent** — required to read message text from non-mention messages
> - ✅ **Server Members Intent** — required to receive `GUILD_MEMBER_*` events
>
> Leave **Presence Intent** OFF unless the assistant explicitly needs presence updates. Click **Save Changes**.

> ⚠️ Once the bot is in 100+ servers Discord requires verification + intent whitelisting. Below that threshold you can self-serve.

Wait for the user to confirm the intents are saved before proceeding.

## Step 3: Generate & Collect the Bot Token

**Do NOT skip ahead. The bot token is the only path to the bot's identity — it must be collected immediately on generation, before the user navigates away from the page.**

Direct the user:

> On the same **Bot** page, click **Reset Token** (or **View Token** / **Copy** if this is the first time). Confirm the reset if prompted. Discord will display the token **once** — copy it now and paste it into the secure prompt that appears in your assistant.

Run the store script:

```bash
bun skills/discord-app-setup/scripts/store-bot-token.ts
```

The script opens the assistant's secure credential prompt, validates the entry, and stores it under `discord_channel:bot_token`. Exit code **130** means the user cancelled the prompt — nothing was stored. That's a valid choice, not an error: ask whether they'd like to try again rather than treating it as a failure. Any other non-zero exit is a real failure — ask the user to reset the token and re-run.

## Step 4: Validate the Bot Token

Run:

```bash
bun skills/discord-app-setup/scripts/validate-token.ts
```

The script:

- Calls `GET https://discord.com/api/v10/users/@me` to validate the token and capture `botUserId`, `botUsername`
- Calls `GET https://discord.com/api/v10/oauth2/applications/@me` to capture the application's `id`, `name`, and `verifyKey` (public key)
- Prints a summary of the bot + application identity to stdout
- Exits 0 on success

If the script exits with a 401, the token is invalid — ask the user to reset and re-enter (repeat Step 3). The script does **not** persist any of the captured metadata; it's all derivable from the bot token on demand.

## Step 5: Generate OAuth Invite URL & Add Bot to a Server

The bot needs to be invited to a Discord server (guild) before it can receive or send messages.

Run:

```bash
bun skills/discord-app-setup/scripts/print-invite-url.ts
```

This calls `GET /oauth2/applications/@me` with the stored bot token to discover the application ID, then prints a URL of the form:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=277025770560&scope=bot+applications.commands
```

The default permission integer (`277025770560`) covers: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Use External Emojis, and Use Slash Commands. It deliberately **does not** include Administrator, Manage Channels, Manage Roles, Manage Threads, Create Public Threads, Kick/Ban Members, or Mention Everyone — request more only if a downstream feature requires it, and document the reason.

Direct the user:

> Open the URL in your browser, choose the server you want the bot in, click **Authorize**, and complete the captcha if prompted.

Wait for the user to confirm the bot has joined the server before continuing.

## Step 6: Report Success

Summarize with the completed checklist:

```
Setup complete!
✅ Application created
✅ Bot configured (Message Content + Server Members intents)
✅ Token stored
✅ Bot in server: {guild_name}

Connected: {bot_username} (application: {application_name})
Intents: Message Content, Server Members
```

## Implementation Rules

- All token collection goes through the assistant's secure credential prompt via `scripts/store-bot-token.ts`. Do NOT ask the user to paste the token in chat.
- **Do NOT combine multiple steps into a single message.** Each step must be its own turn. Wait for the user to confirm completion before moving on.
- **Do NOT collect the bot token before Step 3.** The token only matters after the privileged intents are saved — collecting it earlier risks the user having to reset it again if the intents weren't saved correctly.
- **Do NOT request the `Administrator` permission** on the OAuth invite URL. The default permission integer was chosen with the principle of least privilege — only request more if a downstream feature explicitly requires it, and document why.
- **Do NOT enable the Presence Intent** unless the assistant has a feature that consumes presence updates. Presence is privacy-sensitive and Discord requires whitelisting at scale.
- **Do NOT instruct the user to set an Interactions Endpoint URL.** Gateway-connected bots receive interactions over the WebSocket — the HTTP endpoint is only needed for HTTP-only interaction handlers.
- **Do NOT persist the application ID, public key, or bot user metadata** anywhere outside the credential vault. They are derivable from the bot token on demand and persisting them risks staleness after a token reset.

## Disconnecting

To disconnect Discord, delete the `discord_channel:bot_token` credential. Resetting the token in the developer portal also immediately invalidates the old credential. To remove the bot from a specific server, the server owner kicks it from the member list.

For 401/403, intent errors, OAuth invite errors, and token reset guidance, see [`references/troubleshooting.md`](references/troubleshooting.md).
