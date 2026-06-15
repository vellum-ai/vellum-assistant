---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode. Use whenever the user wants to set up Slack for their assistant, connect a workspace, or get the assistant talking in Slack — the skill generates a one-click manifest URL so they only have to name, save, and copy two tokens.
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

The flow has four user actions: **click**, **install**, **copy tokens**, **verify**. Everything else is pre-baked into the manifest the URL creates.

## Value Classification

| Value     | Type       | Storage method                 | Secret? |
| --------- | ---------- | ------------------------------ | ------- |
| App Token | Credential | `assistant credentials prompt` | **Yes** |
| Bot Token | Credential | `assistant credentials prompt` | **Yes** |

A **User OAuth Token** (`xoxp-...`) is _not_ collected by this skill. It's an optional power-user knob for full-workspace visibility — see [Optional: add a User OAuth Token later](#optional-add-a-user-oauth-token-later) at the end.

## Step 1 — Check existing configuration

Run `assistant credentials list --search slack_channel` (via the bash tool). Scan the result for entries with `service: slack_channel` and note which of `app_token`, `bot_token` are present.

Then branch:

- If **both ✅** → fully configured. Offer to show status or reconfigure. Stop here unless the user wants a reset.
- If **exactly one is missing** → resume from the missing step (3a or 3b).
- **Otherwise (both missing)** → continue to Step 2 (default).

An existing `user_token` is never blocking — leave it in place.

> ✓ Checkpoint: You named which of `app_token` / `bot_token` are present before branching. Do not skip the `assistant credentials list` call and guess.

## Step 2 — Create the Slack app (one click)

Infer the bot identity yourself — do not ask the user to confirm before generating the link.

- **Bot name:** your assigned assistant name. If unset → prompt the user to name you first, then come back.
- **Description:** `Assistant for {guardianName}`, from the current user context / `users/default.md`.

Run the bundled script — inputs are JSON on stdin via a single-quoted heredoc, so apostrophes / quotes / backticks / `$` in the bot name or description pass through verbatim and can never break shell quoting or URL encoding:

```
bash {
  command: "bun run skills/slack-app-setup/scripts/build-manifest-url.ts <<'SLACK_INPUT_END'\n{\"name\": \"<bot_name>\", \"desc\": \"<description>\"}\nSLACK_INPUT_END"
  activity: "to generate the Slack app manifest link"
}
```

The heredoc delimiter `'SLACK_INPUT_END'` is single-quoted on purpose — the shell will not expand anything inside it. Inside the JSON, only `"` and `\` need escaping; apostrophes, dollar signs, and backticks do not.

⚠️ CRITICAL — point of action: **You must run the script.** Do not hand-write the manifest, do not show the user raw YAML or JSON, do not type out a URL from memory. The script is the only source of truth for scopes, events, and Socket Mode settings; anything you write yourself will silently miss pieces and setup will fail downstream.

Output is JSON: `{ "ok": true, "data": { "url": "..." } }`. Extract `data.url`.

⚠️ CRITICAL — point of action: **Render the URL as a markdown link** — `[Click here to create your Slack app](URL)`. Do not paste the raw encoded URL into chat. It is ~1700 characters and will wrap, breaking the click.

Tell the user: _"Click the link, pick your workspace, click **Create**. All scopes, events, and Socket Mode are pre-configured — you don't need to touch anything on the creation page."_

Wait for the user to confirm they clicked Create before moving to Step 3.

## Step 3 — Collect tokens

Slack lands the user on **Basic Information** after Create. The app token lives there; the bot/user tokens live on the **Install App** page.

### Step 3a — App-Level Token (Basic Information page)

Do both of the following in the **same response** — the instruction text and the `assistant credentials prompt` command go out together:

1. Tell the user:

   > Scroll to **App-Level Tokens** → **Generate Token and Scopes** → name it "Socket Mode" → add scope `connections:write` → **Generate**. Copy the token (starts with `xapp-`).
   >
   > **Don't paste it in chat — I'll send you a secure prompt to enter it.**

2. In the same response, run (via the bash tool):

   ```bash
   assistant credentials prompt --service slack_channel --field app_token \
     --label "App-Level Token" --placeholder "xapp-..." \
     --description "Paste the App-Level Token you just generated"
   ```

⚠️ CRITICAL — point of action: **Fire the `assistant credentials prompt` command in this same response. Do not wait for the user to say "okay I have it" before firing it.** The secure prompt queues silently; the user fills it when they're ready. Waiting for verbal confirmation leaves the user stuck staring at instructions with no input field.

⚠️ CRITICAL — point of action: **Always route the token through `assistant credentials prompt`.** Do NOT ask the user to paste tokens in chat. Do NOT use `ui_show` for collection. Do NOT call `assistant credentials reveal`. The prompt is the only handler that validates and stores securely.

### Step 3b — Install + Bot Token

Tell the user:

> In the left sidebar → **Install App** → **Install to Workspace** → **Allow**. The page that loads shows your **Bot User OAuth Token** (`xoxb-...`). Copy it.
>
> **Don't paste it in chat — I'll send you a secure prompt to enter it.**

Then collect:

- Run (via the bash tool):

  ```bash
  assistant credentials prompt --service slack_channel --field bot_token \
    --label "Bot User OAuth Token" --placeholder "xoxb-..." \
    --description "From Install App page — the Bot User OAuth Token"
  ```

> ✓ Checkpoint: After Step 3, the `app_token` and `bot_token` are both in the credential store and the user has confirmed both prompts came back successful. If either prompt failed, re-run it before moving on.

## Step 4 — Verify identity

Load the **guardian-verify-setup** skill:

- `skill_load` with `skill: "guardian-verify-setup"`.

If the user wants to skip → continue to Step 5 (default if they say no), and let them know they can run it later by saying _"verify me on slack"_.

## Step 5 — Report success

**First, fetch the real bot identity** so the success message shows the actual handle + workspace name — not literal `{botUsername}` / `{workspace}` placeholder strings.

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

Extract `user` → botUsername, `team` → workspace. If `ok: false` or the call errors, fall back to `your bot` / `your workspace` rather than typing placeholder strings.

⚠️ CRITICAL — point of action: **Never post the success message with literal `{botUsername}` or `{workspace}` in it.** Those are placeholders. Run `auth.test` first, substitute real values, then post.

If identity was verified:

> Setup complete!
> ✅ App created
> ✅ Tokens configured
> ✅ Connection active
> ✅ Connection tested
>
> Connected: @<botUsername> in <workspace>
> Channels: @mention the bot in any channel to add it, or use `/invite @<botUsername>`. DMs work immediately.
> Identity: verified
>
> Want full workspace visibility (read every channel you're in, even ones the bot isn't a member of)? Ask me to _add a User OAuth Token_ later.

If identity was skipped → swap the last two lines for:

> ⬜ Connection tested — say "verify me on slack" to finish later.
> …
> Identity: skipped

## SKILL COMPLETE WHEN

- [ ] `assistant credentials list` was called and the existing-state branch was named explicitly (Step 1).
- [ ] `bun run skills/slack-app-setup/scripts/build-manifest-url.ts` returned `{ok: true, data: {url}}` and the URL was rendered as a markdown link (Step 2).
- [ ] User confirmed they clicked **Create** in Slack.
- [ ] `assistant credentials prompt` for `app_token` returned successfully (Step 3a).
- [ ] `assistant credentials prompt` for `bot_token` returned successfully (Step 3b).
- [ ] `guardian-verify-setup` was loaded and either completed or the user explicitly declined (Step 4).
- [ ] Success message was posted (Step 5).

## If Something Fails

**Bot doesn't respond in a channel.** The bot must be a member. @mention it (Slack will prompt "Add Them") or `/invite @{botUsername}`.

**Socket Mode keeps disconnecting.** The app token is revoked or expired. Regenerate it in **Basic Information → App-Level Tokens** and re-run the `app_token` prompt.

**Token rejected on prompt.** The handler validates on entry. Re-prompt; double-check you copied the right value — bot token starts `xoxb-`, app token `xapp-`.

**Messages not arriving.** Verify **Event Subscriptions → Subscribe to bot events** includes `message.channels`. The manifest pre-configures it, but it can be edited out by hand.

**No Bot User OAuth Token on the Install App page.** The app was likely created without the manifest. Verify **OAuth & Permissions → Scopes → Bot Token Scopes** is populated; if empty → start over from Step 2 (default). Do not hand-edit scopes.

## Optional: add a User OAuth Token later

A **User OAuth Token** (`xoxp-...`) lets the assistant see every channel you're in, even ones the bot was never invited to. Useful for triage workflows where you want the assistant to summarize across the whole workspace. Not needed for normal messaging — the bot token alone covers every channel the bot is a member of.

To add it later:

1. Open your Slack app at <https://api.slack.com/apps>, pick the app this skill created, go to **Install App**.
2. Copy the **User OAuth Token** (`xoxp-...`).
3. Ask the assistant to _store the User OAuth Token_ — it will send you a secure prompt to paste it into. (Under the hood: `assistant credentials prompt --service slack_channel --field user_token`.)

To revoke it later, clear the `user_token` credential the same way you'd clear any Slack credential — see Clearing Credentials below.

## Clearing Credentials

To disconnect, prefer the Settings UI path so the same Slack settings handler used by Settings clears both the secure tokens and the workspace metadata together.
