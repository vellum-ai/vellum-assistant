---
name: telegram-setup
description: Connect a Telegram bot to the Vellum Assistant gateway with automated webhook registration and credential storage
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "🤖"
  vellum:
    category: "messaging"
    display-name: "Telegram Setup"
    activation-hints:
      - "Telegram bot setup, webhook configuration, or BotFather token"
      - "User wants to connect Telegram to the assistant"
    avoid-when:
      - "User wants to send/receive Telegram messages (use messaging skill instead)"
---

You are helping your user connect a Telegram bot. The wizard collects the token, the daemon and gateway do the setup, and you confirm it worked.

DO NOT use this skill for runtime Telegram operations (sending, replying, reading). That is the separate messaging skill.

## What happens without you

Saving the token in the wizard triggers all of this:

| Step                                               | Runs where                        |
| -------------------------------------------------- | --------------------------------- |
| Validate the token against `getMe`                 | Daemon, on save                   |
| Store `telegram.botId` and `telegram.botUsername`  | Daemon, on save                   |
| Generate the webhook secret                        | Daemon, on save                   |
| Register the platform callback route               | Daemon, on save                   |
| Tell Telegram where to send updates (`setWebhook`) | Gateway, on the credential change |
| Install the bot commands (`setMyCommands`)         | Gateway, on the credential change |

⚠️ CRITICAL: **Never run `setWebhook`, `setMyCommands`, or `assistant webhooks register` yourself, and never generate the webhook secret.** `reconcileTelegramWebhook` is idempotent and already runs on the credential change the save produces. Doing it by hand races it, which is how a webhook ends up pointing somewhere stale.

Your job is Steps 1 to 5 below: open the wizard, confirm delivery, link the user's identity.

## Step 1: Check existing configuration

Run `assistant credentials list --search telegram` (via the bash tool). Note whether `bot_token` and `webhook_secret` are present.

- If **both ✅** → already configured. Offer to show status or reconfigure. Stop here unless the user wants a reset.
- **Otherwise** → continue to Step 2.

> ✓ Checkpoint: You named which fields are present before branching. Do not skip the call and guess.

## Step 2: Open the setup wizard

Call `ui_show` with `surface_type: "channel_setup"` and `data: { channel: "telegram" }`. The wizard is non-blocking: the tool returns immediately.

⚠️ CRITICAL: **Tool call first, announcement second, in the same turn.** Do not write any message saying the wizard is open until `ui_show` has returned success earlier in the same turn. A message claiming the wizard is open when the tool was never called shows the user an empty side panel.

After it returns success, tell the user:

> I've opened the Telegram setup wizard in the side panel. It walks you through creating the bot with @BotFather and brings its token back. It'll let me know when you're done, and I'll check Telegram is actually delivering.

**Hand-off notification (phones and narrow windows).** On phone-sized clients setup opens on the Contacts page instead of a side drawer and cannot auto-notify. The client sends a hidden message like `[User action on channel_setup surface: moved the telegram setup to the Contacts page]`. When you receive it:

> It looks like setup opened on your Contacts page rather than a side panel, same steps in a different spot. When you've finished, come back and tell me and I'll check it's working.

and rely on their confirmation to trigger Step 3.

If `ui_show` fails, do NOT send that message. Tell the user the wizard could not be opened and troubleshoot (e.g. no connected client) before retrying.

⚠️ CRITICAL: **Do NOT collect the token in chat.** Do NOT use `assistant credentials prompt`. The wizard's secure input field is the only path for credential entry.

## Step 3: Confirm Telegram is delivering

Triggered by the wizard-closed notification, `[User action on channel_setup surface: closed the telegram setup wizard]`. Closing the drawer sends it automatically, so do not wait for the user to type a confirmation. If they say they're done or ask you to check, proceed the same way.

1. Run `assistant credentials list --search telegram`. Confirm `bot_token` and `webhook_secret` are both present.

   If `bot_token` is missing the user closed the wizard without saving. Say so and offer to reopen it. When the notification triggered this, the panel is closed and re-running Step 2's `ui_show` is right. When the user asked manually, the wizard may still be open, so point them back to it instead: a second `ui_show` over a live wizard resets their progress.

2. Ask Telegram where it is sending updates. Registration is asynchronous, so allow a moment before the first check:

   ```bash
   BOT_TOKEN=$(assistant credentials reveal --service telegram --field bot_token)
   curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq '{url: .result.url, last_error: .result.last_error_message, pending: .result.pending_update_count}'
   ```

   - **`url` set, no `last_error`** → delivering. Continue to Step 4.
   - **`url` empty** → registration has not landed yet or failed. Wait a few seconds and check once. If still empty, the channel is not live. Tell the user plainly and look at `assistant logs --grep "reconcile Telegram webhook"` for the cause. Do not run `setWebhook` yourself.
   - **`last_error` present** → Telegram is rejecting delivery. Report it verbatim; it usually names the cause (unreachable host, TLS, wrong port).

⚠️ CRITICAL: **Do not report success on stored credentials alone.** The channel indicator turns green on credentials, which is not evidence that messages arrive. `getWebhookInfo` is.

## Step 4: Verify identity

This links the user's Telegram identity so the assistant can deliver to them. Without it the channel works but has nobody to talk to, so do not skip it silently.

Load the **guardian-verify-setup** skill:

- Call `skill_load` with `skill: "guardian-verify-setup"`.

If the user wants to skip, continue to Step 5 and tell them they can verify later by saying _"verify me on Telegram"_.

## Step 5: Report success

Read the bot username from config rather than calling Telegram again:

```bash
assistant config get telegram.botUsername
```

Summarize:

- Bot connected: @{botUsername}
- Telegram confirmed delivering
- Guardian identity: {verified | skipped}

⚠️ CRITICAL: Never post the summary with a literal `{botUsername}` placeholder. Read the config value first and substitute it.

## Completion checklist

- [ ] `assistant credentials list --search telegram` was called and the existing-state branch named explicitly (Step 1).
- [ ] `ui_show` returned success before any message claiming the wizard is open (Step 2).
- [ ] The token was never requested in chat.
- [ ] `getWebhookInfo` showed a URL and no `last_error_message` before any success was claimed (Step 3).
- [ ] `setWebhook`, `setMyCommands` and `assistant webhooks register` were not run by hand.
- [ ] `guardian-verify-setup` was loaded and either completed or explicitly declined (Step 4).

# Clearing credentials

To disconnect Telegram:

```bash
assistant credentials delete --service telegram --field bot_token
assistant credentials delete --service telegram --field webhook_secret
assistant config set telegram.botUsername ""
```
