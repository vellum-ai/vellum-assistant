---
name: discord-app-setup
description: Connect a Discord bot to the Vellum Assistant via the Discord Gateway with guided application creation, intent configuration, and identity verification
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎮"
  vellum:
    display-name: "Discord App Setup"
    includes: ["guardian-verify-setup"]
---

You are helping your user create a Discord application and connect a Discord bot to the Vellum Assistant via the Discord Gateway. Walk through each step below.

**CRITICAL: Follow these steps strictly in order. Do NOT combine steps, skip ahead, or ask for the bot token before the bot user has been configured. The token is shown only once after reset — collect it the moment the user generates it, never before.**

## Value Classification

| Value          | Type       | Storage method                                                | Secret? |
| -------------- | ---------- | ------------------------------------------------------------- | ------- |
| Application ID | Config     | `assistant config set discord_channel.applicationId`          | No      |
| Bot Token      | Credential | `credential_store` prompt                                     | **Yes** |
| Public Key     | Config     | `assistant config set discord_channel.publicKey` _(optional)_ | No      |

- The **Bot Token** is a secret. Always collect via `credential_store` prompt — never accept it pasted in plaintext chat.
- The **Application ID** and **Public Key** are non-sensitive identifiers and may be discovered programmatically (Step 4) once the bot token is stored.

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

Collect the token securely:

- Call `credential_store` with `action: "prompt"`, `service: "discord_channel"`, `field: "bot_token"`, `label: "Discord Bot Token"`, `placeholder: "MTk4NjIyNDgzNzAyNDU0..."`, `description: "Paste the bot token from the Bot tab of your Discord application. Discord shows it only once."`

If the prompt returns an error, ask the user to reset the token again and re-enter.

## Step 4: Validate Token & Capture Application Metadata

Run:

```bash
bun skills/discord-app-setup/scripts/validate-and-configure.ts
```

The script:

- Calls `GET https://discord.com/api/v10/users/@me` with the bot token to validate it and capture `botUserId`, `botUsername`
- Calls `GET https://discord.com/api/v10/oauth2/applications/@me` to capture the application's `id` (client ID) and `verifyKey` (public key)
- Stores `discord_channel.applicationId`, `discord_channel.publicKey`, `discord_channel.botUserId`, `discord_channel.botUsername` via `assistant config set`
- Exits 0 on success and prints a summary of what was stored

If the script exits non-zero with a 401, the token is invalid — ask the user to reset and re-enter (repeat Step 3).

## Step 5: Generate OAuth Invite URL & Add Bot to a Server

The bot needs to be invited to a Discord server (guild) before it can receive or send messages.

Run:

```bash
bun skills/discord-app-setup/scripts/print-invite-url.ts
```

This prints a URL of the form:

```
https://discord.com/api/oauth2/authorize?client_id=<APP_ID>&permissions=277025770560&scope=bot+applications.commands
```

The default permission integer (`277025770560`) covers: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Use External Emojis, and Use Slash Commands. It deliberately **does not** include Administrator, Manage Channels, Manage Roles, Manage Threads, Create Public Threads, Kick/Ban Members, or Mention Everyone — request more only if a downstream feature requires it, and document the reason.

Direct the user:

> Open the URL in your browser, choose the server you want the bot in, click **Authorize**, and complete the captcha if prompted.

Wait for the user to confirm the bot has joined the server before continuing.

## Step 6: Test Your Connection

Verify the user can receive messages from the bot and link their Discord identity for future message delivery.

Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user explicitly wants to skip this step, proceed to Step 7 — let them know they can always verify later by saying "verify me on discord".

## Step 7: Report Success

Summarize with the completed checklist.

If identity was verified:

```
Setup complete!
✅ Application created
✅ Bot configured (Message Content + Server Members intents)
✅ Token stored
✅ Bot in server: {guild_name}
✅ Connection tested

Connected: {bot_username} (application: {application_name})
Intents: Message Content, Server Members
Identity: verified
```

If identity was skipped:

```
Setup complete!
✅ Application created
✅ Bot configured (Message Content + Server Members intents)
✅ Token stored
✅ Bot in server: {guild_name}
⬜ Connection tested — say "verify me on discord" anytime to complete this

Connected: {bot_username} (application: {application_name})
Intents: Message Content, Server Members
Identity: skipped
```

## Troubleshooting

For 401 / 403 / intent-related errors and token reset guidance, see [`references/troubleshooting.md`](references/troubleshooting.md).

## Implementation Rules

- All token collection goes through `credential_store` prompts. Do NOT use `ui_show`, `ui_update`, `assistant credentials reveal`, `curl`, or `assistant credentials set` in chat to collect the bot token. Do NOT ask the user to paste it in chat.
- **Do NOT combine multiple steps into a single message.** Each step must be its own turn. Wait for the user to confirm completion before moving on.
- **Do NOT collect the bot token before Step 3.** The token only matters after the privileged intents are saved — collecting it earlier risks the user having to reset it again if the intents weren't saved correctly.
- **Do NOT request the `Administrator` permission** on the OAuth invite URL. The default permission integer was chosen with the principle of least privilege — only request more if a downstream feature explicitly requires it, and document why.
- **Do NOT enable the Presence Intent** unless the assistant has a feature that consumes presence updates. Presence is privacy-sensitive and Discord requires whitelisting at scale.
- **Do NOT instruct the user to set an Interactions Endpoint URL.** Gateway-connected bots receive interactions over the WebSocket — the HTTP endpoint is only needed for HTTP-only interaction handlers.

## Clearing Credentials

To disconnect Discord:

```bash
assistant credentials delete --service discord_channel --field bot_token
assistant config set discord_channel.applicationId ""
assistant config set discord_channel.publicKey ""
assistant config set discord_channel.botUserId ""
assistant config set discord_channel.botUsername ""
```

To revoke the token on Discord's side, click **Reset Token** on the Bot page of the application — this immediately invalidates the old token. To remove the bot from a specific server, the server owner kicks it from the member list.
