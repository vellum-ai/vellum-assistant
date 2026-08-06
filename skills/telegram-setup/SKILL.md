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

You are helping your user connect a Telegram bot. The wizard collects the token, the rest of setup runs automatically, and you confirm it worked.

DO NOT use this skill for runtime Telegram operations (sending, replying, reading). That is the separate messaging skill.

## What happens without you

Saving the token in the wizard triggers all of this:

| Step                                               | Runs                          |
| -------------------------------------------------- | ----------------------------- |
| Validate the token against `getMe`                 | Automatically, on save        |
| Store `telegram.botId` and `telegram.botUsername`  | Automatically, on save        |
| Generate the webhook secret                        | Automatically, on save        |
| Register the platform callback route               | Automatically, on save        |
| Tell Telegram where to send updates (`setWebhook`) | Automatically, after the save |
| Install the bot commands (`setMyCommands`)         | Automatically, after the save |

⚠️ CRITICAL: **Never run `setWebhook`, `setMyCommands`, or `assistant webhooks register` yourself, and never generate the webhook secret.** `reconcileTelegramWebhook` is idempotent and already runs on the credential change the save produces. Doing it by hand races it, which is how a webhook ends up pointing somewhere stale.

Your job is Steps 1 to 5 below: open the wizard, confirm delivery, link the user's identity.

## Step 1: Check existing configuration

⚠️ CRITICAL: **If you got here from a wizard-closed notification, or the user just said they finished setup, go straight to Step 3.** A successful save leaves both credentials in place, so this step would find them and read it as "already configured" at exactly the moment that means the opposite. Stopping there skips the delivery check and the identity verification, which is the failure this flow exists to prevent.

Otherwise, run `assistant credentials list --search telegram` (via the bash tool). Note whether `bot_token` and `webhook_secret` are present.

- **Neither present** → continue to Step 2.
- **Both present** → credentials existing does not mean Telegram works, so
  check before saying so. Run Step 3's `assistant channels get telegram --json`
  and read `webhook_delivery`.
  - **`passed: true`, no `indeterminate`** → already set up and confirmed.
    Offer to show status or reconfigure, and stop here unless the user wants a
    reset.
  - **`passed: true` with `indeterminate: true`** → do NOT stop here. Nothing
    is broken, but nothing is confirmed: the registration record is missing, or
    Telegram was unreachable just now. Stopping would skip both the recovery in
    Step 3 and the identity verification in Step 4. Go to Step 3 and re-check.
  - **`passed: false`** → configured but not delivering. This is what the
    Channels page shows as incomplete, and it is why the user may have asked. Go
    to Step 3 and work the recovery rather than reporting it as already set up.

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

2. Ask whether Telegram is delivering:

   ```bash
   assistant channels get telegram --json
   ```

   `get` is always live: it invalidates the cached snapshot and re-runs the
   remote checks, so it reflects the state now rather than before the save.

   Find the `webhook_delivery` check in `remoteChecks`. It has **three**
   outcomes, and the third is the one that matters:

   - **`passed: true`, no `indeterminate`** → confirmed. Telegram is
     registered at the address this assistant set. Continue to Step 4.
   - **`passed: false`** → the channel is not live. Its `message` already
     names the cause and the fix, including whether this deployment can set
     its own webhook URL, so relay it rather than diagnosing yourself.
   - **`passed: true` with `indeterminate: true`** → nothing is broken, and
     nothing is confirmed either. Telegram could not be reached, or no
     registration was recorded to compare against. Do NOT report success.
     Say plainly that setup is stored but delivery could not be confirmed
     yet, relay the `message`, and offer to check again.

   Registration is asynchronous. If the first check reports no webhook
   registered, or reports `indeterminate`, wait a few seconds and run the
   command once more before treating that as the answer: the recorded
   registration lands when reconciliation completes.

⚠️ CRITICAL: **`passed: true` alone is not confirmation.** An unreachable
Telegram API and a missing registration record both report `passed: true`,
because neither found a fault, and both set `indeterminate`. Treating the
boolean alone as proof is precisely how this flow used to tell users their
channel was live when nothing had verified it.

⚠️ CRITICAL: **Do not report success on stored credentials alone.** Credentials
existing is what you would expect the moment the wizard closes and says nothing
about whether messages arrive. `webhook_delivery` is the check that does, and
it is the same signal the channel indicator uses.

⚠️ CRITICAL: **Do not run `setWebhook` or suggest a tunnel yourself.** If
`webhook_delivery` fails, the `message` says what to do. Registration re-runs
by itself whenever credentials or the ingress URL change, so a fix applied
elsewhere takes effect without you calling Telegram.

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
- Telegram delivery: {confirmed | stored, not yet confirmed}
- Guardian identity: {verified | skipped}

Use "confirmed" only for a `webhook_delivery` that passed without
`indeterminate`. If it was indeterminate, say so in the summary rather than
rounding it up, and tell the user they can ask you to check again.

⚠️ CRITICAL: Never post the summary with a literal `{botUsername}` placeholder. Read the config value first and substitute it.

## Completion checklist

- [ ] `assistant credentials list --search telegram` was called and the existing-state branch named explicitly (Step 1).
- [ ] `ui_show` returned success before any message claiming the wizard is open (Step 2).
- [ ] The token was never requested in chat.
- [ ] `assistant channels get telegram` reported `webhook_delivery` as `passed: true` **without** `indeterminate` before any delivery success was claimed (Step 3).
- [ ] `setWebhook`, `setMyCommands`, `assistant webhooks register` and `getWebhookInfo` were not run by hand.
- [ ] `guardian-verify-setup` was loaded and either completed or explicitly declined (Step 4).

# Clearing credentials

To disconnect Telegram:

```bash
assistant credentials delete --service telegram --field bot_token
assistant credentials delete --service telegram --field webhook_secret
assistant config set telegram.botUsername ""
```
