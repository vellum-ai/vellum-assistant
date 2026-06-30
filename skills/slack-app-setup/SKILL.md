---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode. Use whenever the user wants to set up Slack for their assistant, connect a workspace, or get the assistant talking in Slack — opens the setup wizard in a side panel so the user can complete it at their own pace while continuing the conversation.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "Slack App Setup"
    includes: ["guardian-verify-setup", "slack"]
    activation-hints:
      - "set up Slack"
      - "connect Slack"
      - "add a Slack workspace"
      - "get you on Slack"
      - "install you in Slack"
      - "create a Slack bot"
---

## When to Use

USE THIS SKILL WHEN:

- The user says "set up Slack", "connect Slack", "add a Slack workspace", "get you on Slack", or any variant that means _connect this assistant to Slack_.
- A freshly-provisioned assistant needs a Slack bot identity (tokens, scopes, events) configured for the first time.
- The user wants to switch the assistant to a new Slack workspace or rotate its tokens.

DO NOT use this skill for runtime Slack operations (posting, reading channels, triage). That is the separate `slack` skill.

## Value Classification

| Value     | Type       | Storage method                           | Secret? |
| --------- | ---------- | ---------------------------------------- | ------- |
| App Token | Credential | Saved via setup wizard (API route)       | **Yes** |
| Bot Token | Credential | Saved via setup wizard (API route)       | **Yes** |

Tokens are collected in the setup wizard's secure input fields and stored via the daemon's Slack config API. They never enter the conversation.

A **User OAuth Token** (`xoxp-...`) is _not_ collected by this skill. It's an optional power-user knob for full-workspace visibility — see [Optional: add a User OAuth Token later](#optional-add-a-user-oauth-token-later) at the end.

## Step 1 — Check existing configuration

Run `assistant credentials list --search slack_channel` (via the bash tool). Scan the result for entries with `service: slack_channel` and note which of `app_token`, `bot_token` are present.

Then branch:

- If **both present** → fully configured. Offer to show status or reconfigure. Stop here unless the user wants a reset.
- **Otherwise** → continue to Step 2.

An existing `user_token` is never blocking — leave it in place.

> Checkpoint: You named which of `app_token` / `bot_token` are present before branching. Do not skip the `assistant credentials list` call and guess.

## Step 2 — Open the setup wizard

Call `ui_show` with:

```json
{
  "surface_type": "channel_setup",
  "data": { "channel": "slack" }
}
```

This opens the Slack setup wizard in a side panel. The wizard guides the user through:

1. **Creating the Slack app** — one-click via a pre-filled manifest URL (all scopes, events, and Socket Mode are pre-configured)
2. **Generating an App-Level Token** — with `connections:write` scope
3. **Installing to workspace and saving the Bot Token**

The wizard handles token collection securely (tokens go from input fields directly to the API, never through the conversation).

After calling `ui_show`, tell the user:

> I've opened the Slack setup wizard in the side panel. It'll walk you through three quick steps — creating your app, generating tokens, and connecting.
>
> Feel free to ask me questions along the way, and let me know when you're done!

Do NOT repeat the wizard's instructions in chat — the wizard already provides them. Just be available to answer questions.

> Checkpoint: `ui_show` was called with `surface_type: "channel_setup"` and the user was told the wizard is open.

## Step 3 — Verify completion

When the user says they're done (or any equivalent — "finished", "all set", "connected", etc.), verify the setup:

Run `assistant credentials list --search slack_channel` (via the bash tool). Check that both `app_token` and `bot_token` are present.

- If **both present** → proceed to Step 4.
- If **missing** → let the user know which token is still needed and suggest they check the wizard. Do not collect tokens in chat.

## Step 4 — Verify identity (optional)

Load the **guardian-verify-setup** skill:

- `skill_load` with `skill: "guardian-verify-setup"`.

If the user wants to skip → continue to Step 5, and let them know they can run it later by saying _"verify me on slack"_.

## Step 5 — Report success

Fetch the real bot identity so the success message shows the actual handle and workspace name:

```
bash {
  command: "curl -s -X POST https://slack.com/api/auth.test"
  network_mode: "proxied"
  credential_ids: ["slack_channel/bot_token"]
  activity: "to fetch bot identity for the success message"
}
```

The `slack_channel/bot_token` credential is bound via `credential_ids` so the proxy injects the `Authorization: Bearer` header. Response is JSON:

```json
{
  "ok": true,
  "url": "https://...",
  "team": "<workspace>",
  "user": "<botUsername>",
  "team_id": "...",
  "user_id": "..."
}
```

Extract `user` -> botUsername, `team` -> workspace. If `ok: false` or the call errors, fall back to `your bot` / `your workspace` rather than typing placeholder strings.

CRITICAL: **Never post the success message with literal `{botUsername}` or `{workspace}` in it.** Those are placeholders. Run `auth.test` first, substitute real values, then post.

If identity was verified:

> Setup complete!
> - App created
> - Tokens configured
> - Connection active
> - Connection tested
>
> Connected: @<botUsername> in <workspace>
> Channels: @mention the bot in any channel to add it, or use `/invite @<botUsername>`. DMs work immediately.
> Identity: verified
>
> Want full workspace visibility (read every channel you're in, even ones the bot isn't a member of)? Ask me to _add a User OAuth Token_ later.

If identity was skipped, note it:

> Identity: skipped — say "verify me on slack" to finish later.

## SKILL COMPLETE WHEN

- [ ] `assistant credentials list` was called and the existing-state branch was named explicitly (Step 1).
- [ ] `ui_show` was called with `surface_type: "channel_setup"` and `data.channel: "slack"` (Step 2).
- [ ] User confirmed they completed the wizard.
- [ ] `assistant credentials list` verified both `app_token` and `bot_token` are present (Step 3).
- [ ] `guardian-verify-setup` was loaded and either completed or the user explicitly declined (Step 4).
- [ ] Success message was posted with real bot identity values (Step 5).

## If Something Fails

**Wizard didn't open.** The client may not support the `channel_setup` surface (e.g., CLI-only channel). Fall back to directing the user to the contacts/settings page to set up Slack manually.

**Bot doesn't respond in a channel.** The bot must be a member. @mention it (Slack will prompt "Add Them") or `/invite @{botUsername}`.

**Socket Mode keeps disconnecting.** The app token is revoked or expired. Regenerate it in **Basic Information -> App-Level Tokens** and re-save in the wizard.

**Messages not arriving.** Verify **Event Subscriptions -> Subscribe to bot events** includes `message.channels`. The manifest pre-configures it, but it can be edited out by hand.

**No Bot User OAuth Token on the Install App page.** The app was likely created without the manifest. Verify **OAuth & Permissions -> Scopes -> Bot Token Scopes** is populated; if empty, start over from Step 2. Do not hand-edit scopes.

## Optional: add a User OAuth Token later

A **User OAuth Token** (`xoxp-...`) lets the assistant see every channel you're in, even ones the bot was never invited to. Useful for triage workflows where you want the assistant to summarize across the whole workspace. Not needed for normal messaging — the bot token alone covers every channel the bot is a member of.

To add it later:

1. Open your Slack app at <https://api.slack.com/apps>, pick the app this skill created, go to **Install App**.
2. Copy the **User OAuth Token** (`xoxp-...`).
3. Ask the assistant to _store the User OAuth Token_ — it will send you a secure prompt to paste it into. (Under the hood: `assistant credentials prompt --service slack_channel --field user_token`.)

To revoke it later, clear the `user_token` credential the same way you'd clear any Slack credential — see Clearing Credentials below.

## Clearing Credentials

To disconnect, prefer the Settings UI path so the same Slack settings handler used by Settings clears both the secure tokens and the workspace metadata together.
