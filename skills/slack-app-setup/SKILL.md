---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode. Use whenever the user wants to set up Slack for their assistant, connect a workspace, or get the assistant talking in Slack — the skill shows a single in-chat form that generates a one-click manifest URL and collects the two tokens securely.
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

The entire setup happens in **one form card**: the user clicks a pre-configured manifest link to create the app, generates an app-level token, installs the app, and pastes both tokens — all without any back-and-forth. `scripts/setup-form.ts` shows the form and stores the tokens through the same validated credential path the Settings UI uses (validation, workspace metadata, Socket Mode activation).

## Value Classification

| Value     | Type       | Storage method                              | Secret? |
| --------- | ---------- | ------------------------------------------- | ------- |
| App Token | Credential | Form `password` field → credential store    | **Yes** |
| Bot Token | Credential | Form `password` field → credential store    | **Yes** |

Tokens are entered into `password` fields in the form and travel straight to the credential store — they never pass through the chat conversation, the model, or this skill's stdout. A **User OAuth Token** (`xoxp-...`) is _not_ collected here. It's an optional power-user knob — see [Optional: add a User OAuth Token later](#optional-add-a-user-oauth-token-later).

## Step 1 — Check existing configuration

Run `assistant credentials list --search slack_channel` (via the bash tool). Scan for entries with `service: slack_channel` and note which of `app_token`, `bot_token` are present.

- If **both ✅** → already configured. Offer to show status or reconfigure. Stop here unless the user wants to reset (re-running the form overwrites the tokens).
- **Otherwise** → continue to Step 2.

An existing `user_token` is never blocking — leave it in place.

> ✓ Checkpoint: You named which of `app_token` / `bot_token` are present before continuing. Do not skip the `assistant credentials list` call.

## Step 2 — Run the setup form

Infer the bot identity yourself — do not ask the user to confirm before showing the form.

- **Bot name:** your assigned assistant name. If unset → ask the user to name you first, then come back.
- **Description:** `Assistant for {guardianName}`, from the current user context / `users/default.md`.

Run the bundled script — inputs are JSON on stdin via a single-quoted heredoc, so apostrophes / quotes / backticks / `$` in the bot name or description pass through verbatim:

```
bash {
  command: "bun run skills/slack-app-setup/scripts/setup-form.ts <<'SLACK_INPUT_END'\n{\"name\": \"<bot_name>\", \"desc\": \"<description>\"}\nSLACK_INPUT_END"
  timeout_seconds: 600
  activity: "to set up Slack via a single in-chat form"
}
```

The heredoc delimiter `'SLACK_INPUT_END'` is single-quoted on purpose — the shell will not expand anything inside it. Inside the JSON, only `"` and `\` need escaping.

⚠️ CRITICAL — point of action: **Set `timeout_seconds: 600`** (the maximum). The form blocks while the user creates the app, generates a token, installs, and pastes both tokens; a short timeout would kill it mid-setup.

⚠️ CRITICAL — point of action: **You must run the script.** Do not hand-write the manifest, do not show the user raw YAML/JSON, do not type out a URL from memory, do not try to collect tokens yourself with `assistant credentials prompt` or by asking the user to paste them in chat. The script is the only source of truth for the manifest and is the only place the tokens are handled securely.

The script prints a single JSON object on stdout (never the tokens). Branch on `status`:

| `status`        | Meaning                                            | What to do |
| --------------- | -------------------------------------------------- | ---------- |
| `configured`    | Tokens validated and stored; Socket Mode active    | Continue to Step 3. Use `teamName` / `botUsername` from the JSON in the success message. |
| `cancelled`     | User dismissed the form                            | Let them know setup didn't finish and offer to re-run. Stop. |
| `timed_out`     | The form expired                                   | Tell them it timed out and offer to re-run. Stop. |
| `config_failed` | A token was rejected or storage failed (`error`)   | Relay the `error`, then offer to re-run. Common cause: bot token must start `xoxb-`, app token `xapp-`. |
| `error`         | Setup couldn't start (`error`)                     | Relay the `error` and re-run. |

If `configured` includes a `warning`, surface it to the user.

> ✓ Checkpoint: Only continue to Step 3 when `status` is `configured`.

## Step 3 — Verify identity

Load the **guardian-verify-setup** skill:

- `skill_load` with `skill: "guardian-verify-setup"`.

If the user wants to skip → continue to Step 4 (default if they say no), and let them know they can run it later by saying _"verify me on slack"_.

## Step 4 — Report success

Use the `teamName` and `botUsername` returned by `setup-form.ts` in Step 2. If they were absent from the JSON, fall back to `your workspace` / `your bot` rather than typing literal placeholders.

If identity was verified:

> Setup complete!
> ✅ App created
> ✅ Tokens configured
> ✅ Connection active
> ✅ Connection tested
>
> Connected: @\<botUsername> in \<teamName>
> Channels: @mention the bot in any channel to add it, or use `/invite @<botUsername>`. DMs work immediately.
> Identity: verified
>
> Want full workspace visibility (read every channel you're in, even ones the bot isn't a member of)? Ask me to _add a User OAuth Token_ later.

If identity was skipped → swap the last two lines for:

> ⬜ Connection tested — say "verify me on slack" to finish later.
> …
> Identity: skipped

⚠️ CRITICAL — point of action: **Never post a success message with literal `{botUsername}` or `{workspace}` placeholders.** Substitute the real values from the Step 2 JSON.

## SKILL COMPLETE WHEN

- [ ] `assistant credentials list` was called and the existing-state branch was named explicitly (Step 1).
- [ ] `bun run skills/slack-app-setup/scripts/setup-form.ts` was run with `timeout_seconds: 600` and returned `status: "configured"` (Step 2).
- [ ] `guardian-verify-setup` was loaded and either completed or the user explicitly declined (Step 3).
- [ ] Success message was posted with the real bot handle + workspace (Step 4).

## If Something Fails

**Bot doesn't respond in a channel.** The bot must be a member. @mention it (Slack will prompt "Add Them") or `/invite @{botUsername}`.

**Socket Mode keeps disconnecting.** The app token is revoked or expired. Re-run the form (Step 2) and paste a fresh app token from **Basic Information → App-Level Tokens**.

**A token was rejected (`config_failed`).** The handler validates on entry. Re-run the form; double-check you copied the right value — bot token starts `xoxb-`, app token `xapp-`.

**Messages not arriving.** Verify **Event Subscriptions → Subscribe to bot events** includes `message.channels`. The manifest pre-configures it, but it can be edited out by hand.

**No Bot User OAuth Token on the Install App page.** The app was likely created without the manifest. Verify **OAuth & Permissions → Scopes → Bot Token Scopes** is populated; if empty → re-run the form from Step 2. Do not hand-edit scopes.

## Optional: add a User OAuth Token later

A **User OAuth Token** (`xoxp-...`) lets the assistant see every channel you're in, even ones the bot was never invited to. Useful for triage workflows. Not needed for normal messaging — the bot token alone covers every channel the bot is a member of.

To add it later:

1. Open your Slack app at <https://api.slack.com/apps>, pick the app this skill created, go to **Install App**.
2. Copy the **User OAuth Token** (`xoxp-...`).
3. Ask the assistant to _store the User OAuth Token_ — it will send you a secure prompt to paste it into. (Under the hood: `assistant credentials prompt --service slack_channel --field user_token`.)

To revoke it later, clear the `user_token` credential the same way you'd clear any Slack credential — see Clearing Credentials below.

## Clearing Credentials

To disconnect, prefer the Settings UI path so the same Slack settings handler used by Settings clears both the secure tokens and the workspace metadata together.
