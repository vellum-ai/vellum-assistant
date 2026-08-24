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

The script outputs JSON: `{ "configured": boolean, "details": string, "error"?: string }`.

- If `error` is present, **stop**. The check could not run, so the credential state is unknown, and `configured: false` here does **not** mean "not set up". Do not start the setup walkthrough. It will not fix this, and re-running setup on an app that already has a token forces a needless token reset that breaks any other deployment using it.
  - `cli_not_found` means the `assistant` command is missing from this environment's PATH. That is an installation problem. Report it as one, quote `details`, and stop.
  - `cli_failed` or `unparseable_output` means the CLI ran but did not answer usefully. Report `details` verbatim and stop.
- If `configured` is `true` — Discord is already set up. Offer to verify the connection or reconfigure.
- If `configured` is `false` with no `error`, the check ran and found no token. Continue to Step 1.

## Step 1: Create the Discord Application

Tell the user:

> Open **https://discord.com/developers/applications** and click **New Application** in the top-right. Give it a name (this is how the bot appears to users) and accept the Developer Terms of Service. After creation you'll land on the application's **General Information** page.

Wait for the user to confirm they've created the app before proceeding. Discord does not support manifest-based creation — the rest of the configuration happens step by step in the portal.

## Step 2: Configure the Bot User

Discord automatically attaches a Bot user to every new application. This integration needs **no privileged intents**, so the only thing to do here is confirm all three are off.

Direct the user:

> In the left sidebar click **Bot**. Scroll to **Privileged Gateway Intents** and leave all three **OFF**:
>
> - ⬜ **Presence Intent**
> - ⬜ **Server Members Intent**
> - ⬜ **Message Content Intent**
>
> If any are already enabled, turn them off and click **Save Changes**.

Why none are needed: the assistant's Discord client identifies with the non-privileged `GUILDS`, `GUILD_MESSAGES`, and `DIRECT_MESSAGES` intents only. It acts on messages that mention the bot and on DMs sent to it, and Discord exempts four cases from the Message Content restriction: messages that mention your app, DMs with your app, your app's own messages, and the target of a message context-menu command. Every message the assistant reads falls inside that exemption and already arrives with full text. Server Members would deliver `GUILD_MEMBER_*` events that nothing here consumes.

Turning them on would grant access the software never reads, and would opt the app into Discord's privileged-intent review (with annual reapplication) once it is visible to more than 10,000 users.

> ℹ️ Two different Discord thresholds are easy to confuse. **Bot verification** is required past 100 servers. **Privileged-intent review** is required past 10,000 unique users who can see the app. With no privileged intents enabled, the second does not apply to this integration at all.

Wait for the user to confirm the intents are off before proceeding.

## Step 3: Generate & Collect the Bot Token

**Do NOT skip ahead. The bot token is the only path to the bot's identity — it must be collected immediately on generation, before the user navigates away from the page.**

Direct the user:

> On the same **Bot** page, click **Reset Token** and confirm. Discord displays the token **once**, right then: copy it now and paste it into the secure prompt that appears in your assistant.
>
> There is no **Copy** or **View Token** button for a token that already exists. Once the token has been shown and you leave the page, Reset is the only way to get a usable value again.

> ⚠️ If this application is already connected somewhere else, **Reset Token invalidates the old token immediately** and breaks that deployment. Only reset if you are willing to reconnect anything else using this app.

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
https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=277025770560&scope=bot+applications.commands
```

The default permission integer (`277025770560`) covers: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Use External Emojis, and Use Slash Commands. It deliberately **does not** include Administrator, Manage Channels, Manage Roles, Manage Threads, Create Public Threads, Kick/Ban Members, or Mention Everyone — request more only if a downstream feature requires it, and document the reason.

Direct the user:

> Open the URL in your browser, choose the server you want the bot in, click **Authorize**, and complete the captcha if prompted.

Wait for the user to confirm the bot has joined the server before continuing.

## Step 6: Verify the User's Discord Identity

This binds the user's Discord account to their identity, so the bot knows who it is talking to and can address them by name rather than treating them as a stranger. Without it the channel is connected but recognises nobody, so do not skip it silently.

It has to happen after Step 5: the code is delivered as a Discord DM, and Discord only permits a bot to DM someone it shares a server with.

Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

The channel is already `discord`. Do not re-ask which channel to verify.

If the user wants to skip, continue to Step 7 and tell them they can verify later by saying _"verify me on Discord"_.

## Step 7: Report What Setup Delivered

Report exactly what is now true, and what is still required before the bot answers anything. Do **not** claim the bot is live: it appears online in the member list the moment it connects, which reads as "working" even while it ignores every message.

Summarize:

```
Discord connected.
✅ Application created
✅ Privileged intents left off (none are needed)
✅ Token stored and validated
✅ Bot in server: {guild_name}

Connected: {bot_username} (application: {application_name})
Intents: Guilds, Guild Messages, Direct Messages (no privileged intents)

⚠️ The bot will not respond yet. It only acts in channels you explicitly
   allow, and that list starts empty.
```

Then tell the user how to finish:

> In a server the bot replies only when it is **@mentioned in an allow-listed channel**. The allow-list is empty by default, which means it currently ignores everything there, and being invited to a server is not consent to every channel in it.
>
> DMs are separate: the bot can be messaged directly without any allow-list entry, because a DM is already addressed to it alone. Who it answers in a DM is still governed by the channel's admission policy, which admits trusted contacts rather than anyone who shares a server with it.
>
> To allow a channel: enable Developer Mode in Discord (**User Settings → Advanced → Developer Mode**), right-click the channel and choose **Copy Channel ID**, then run:
>
> ```bash
> assistant config set discord.allowedChannelIds '["<channel id>"]'
> ```
>
> Pass the full list to allow more than one channel. Once a channel is on the list, mention the bot there and it will reply.

Two things still gate a reply after that, and are worth naming if the bot stays silent: the mention itself (it does not respond to unmentioned messages), and the channel's admission policy, which by default admits trusted contacts rather than anyone in the server.

## Implementation Rules

- All token collection goes through the assistant's secure credential prompt via `scripts/store-bot-token.ts`. Do NOT ask the user to paste the token in chat.
- **Do NOT combine multiple steps into a single message.** Each step must be its own turn. Wait for the user to confirm completion before moving on.
- **Do NOT collect the bot token before Step 3.** The token is shown once and cannot be retrieved later, so it must be collected in the same turn the user generates it, with the secure prompt already open.
- **Do NOT request the `Administrator` permission** on the OAuth invite URL. The default permission integer was chosen with the principle of least privilege — only request more if a downstream feature explicitly requires it, and document why.
- **Do NOT enable any privileged intent.** The client identifies with `GUILDS`, `GUILD_MESSAGES`, and `DIRECT_MESSAGES` only, all three non-privileged, and nothing reads presence, member, or non-mention guild-message events. Enabling one grants access the software never uses and opts the app into Discord's privileged-intent review past 10,000 users.
- **Do NOT claim the bot can reply once setup finishes.** It goes online, and looks working, while ignoring every message until a channel is on `discord.allowedChannelIds`. Always report that gap (Step 7).
- **Do NOT instruct the user to set an Interactions Endpoint URL.** Gateway-connected bots receive interactions over the WebSocket — the HTTP endpoint is only needed for HTTP-only interaction handlers.
- **Do NOT end setup without offering identity verification.** A connected bot that recognises nobody treats its own owner as a stranger. Step 6 is a skip the user declines explicitly, never one taken on their behalf.
- **Do NOT persist the application ID, public key, or bot user metadata** anywhere outside the credential vault. They are derivable from the bot token on demand and persisting them risks staleness after a token reset.

## Disconnecting

To disconnect Discord, delete the `discord_channel:bot_token` credential. Resetting the token in the developer portal also immediately invalidates the old credential. To remove the bot from a specific server, the server owner kicks it from the member list.

For 401/403, intent errors, OAuth invite errors, and token reset guidance, see [`references/troubleshooting.md`](references/troubleshooting.md).
