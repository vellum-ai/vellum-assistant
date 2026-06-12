---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode. Use whenever the user wants to set up Slack for their assistant, connect a workspace, or get the assistant talking in Slack — the skill generates a one-click manifest URL so they only have to name, save, and copy three tokens.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "Slack App Setup"
    includes: ["guardian-verify-setup"]
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

- The user says "set up Slack", "connect Slack", "add a Slack workspace", "get you on Slack", or any variant that means *connect this assistant to Slack*.
- A freshly-provisioned assistant needs a Slack bot identity (tokens, scopes, events) configured for the first time.
- The user wants to switch the assistant to a new Slack workspace or rotate its tokens.

DO NOT use this skill for runtime Slack operations (posting, reading channels, triage). That is the separate `slack` skill.

## The User Experience

The user does **four things**, in this order:

1. **Click** a link you give them. (Slack opens a pre-filled app creation page; they click **Create**.)
2. **Generate** an App-Level Token on the page Slack lands them on, and paste it into a secure prompt.
3. **Install** the app to their workspace, copy the bot token (and optional user token), and paste each into a secure prompt.
4. **Verify** their identity by responding to a Slack message from the bot.

That's the entire user-visible surface. The user never types a manifest, never thinks about scopes or events, and never types the bot's name into Slack — the name and description arrive pre-filled because you bake them into the URL.

## What You Handle Silently

The user does **not** supply these. You derive them and pass them to the manifest builder. The user only ever sees the resulting Slack creation page with the fields already filled in.

| Input | Where you get it |
| --- | --- |
| `BOT_NAME` | Your assigned assistant name (e.g. "Vex"). |
| `BOT_DESC` | `Assistant for {guardianName}` — guardian name from current user context / `users/default.md`. |

If `BOT_NAME` is unset (a brand-new assistant with no name yet) → pause and ask the user *"What would you like to name me?"* before generating the link. Otherwise (default) → derive both inputs yourself and proceed straight to the script call without asking.

## Value Classification

| Value      | Type       | Storage method            | Secret? |
| ---------- | ---------- | ------------------------- | ------- |
| App Token  | Credential | `credential_store` prompt | **Yes** |
| Bot Token  | Credential | `credential_store` prompt | **Yes** |
| User Token | Credential | `credential_store` prompt | **Yes** |

## Step 1 — Check existing configuration

Call `credential_store` with `action: "list"` (no other arguments). Scan the result for entries with `service: "slack_channel"` and note which of `app_token`, `bot_token`, `user_token` are present.

Then branch:

- If **`app_token` ✅ and `bot_token` ✅ and `user_token` ✅** → fully configured. Offer to show status or reconfigure. Stop here unless the user wants a reset.
- If **`app_token` ✅ and `bot_token` ✅ and `user_token` ❌** → bot-only visibility. Offer Step 3c (user-token collection) and stop after that step.
- If **exactly one of `app_token` / `bot_token` is missing** → resume from the missing step. An orphan `user_token`, if present, will be re-validated at the end.
- **Otherwise (both missing)** → continue to Step 2 (default). An orphan `user_token` will be replaced — tell the user.

`user_token` is optional — its absence is never blocking.

> ✓ Checkpoint: You named which of `app_token` / `bot_token` / `user_token` are present before branching. Do not skip the `credential_store list` call and guess.

## Step 2 — Create the Slack app (one click)

**You (silently):** derive `BOT_NAME` and `BOT_DESC` per "What You Handle Silently" above. Do not ask the user to confirm them before generating the link — they will see and confirm them on Slack's creation page.

Run the bundled script — env vars carry the inputs so quoting can never break the URL:

```
bash {
  command: "BOT_NAME='<bot_name>' BOT_DESC='<description>' bun run skills/slack-app-setup/scripts/build-manifest-url.ts"
  activity: "to generate the Slack app manifest link"
}
```

⚠️ CRITICAL — point of action: **You must run the script.** Do not hand-write the manifest, do not show the user raw YAML or JSON, do not type out a URL from memory. The script is the only source of truth for scopes, events, and Socket Mode settings; anything you write yourself will silently miss pieces and setup will fail downstream.

Output is JSON: `{ "ok": true, "data": { "url": "..." } }`. Extract `data.url`.

⚠️ CRITICAL — point of action: **Render the URL as a markdown link** — `[Click here to create your Slack app](URL)`. Do not paste the raw encoded URL into chat. It is ~1700 characters and will wrap, breaking the click.

**Tell the user, in this shape:**

> Click the link below. It opens Slack's app creation page with everything already filled in — the bot's name (**{BOT_NAME}**), description, all scopes, events, and Socket Mode.
>
> [Click here to create your Slack app](URL)
>
> Pick your workspace, click **Create**. You don't need to change anything on that page. Let me know when you've clicked Create.

**What the user sees on Slack's side:** the manifest creation page opens with the name and description pre-filled, a "Configuration" tab showing scopes/events/Socket Mode already populated, and a workspace dropdown. They pick their workspace and click **Create**. No typing required.

Wait for the user to confirm they clicked Create before moving to Step 3.

## Step 3 — Collect tokens

Slack lands the user on **Basic Information** after Create. The app token lives there; the bot/user tokens live on the **Install App** page.

### Step 3a — App-Level Token (Basic Information page)

**Tell the user:**

> You should be on the **Basic Information** page now. Scroll down to **App-Level Tokens** → click **Generate Token and Scopes** → name it "Socket Mode" → add the scope `connections:write` → click **Generate**. Copy the token that appears (it starts with `xapp-`) and paste it into the secure prompt I'm about to open.

Then collect:

- `credential_store` `action: "prompt"`, `service: "slack_channel"`, `field: "app_token"`, `label: "App-Level Token"`, `placeholder: "xapp-..."`, `description: "Paste the App-Level Token you just generated"`.

**What the user sees:** a secure modal in chat with a single password-style input. They paste, click submit, the value never appears in conversation.

⚠️ CRITICAL — point of action: **Always route the token through `credential_store` prompt.** Do not ask the user to paste a token directly in chat, do not use `ui_show` for collection, do not call `assistant credentials reveal`. The prompt is the only handler that validates and stores securely.

### Step 3b — Install + Bot Token

**Tell the user:**

> Now in the left sidebar → click **Install App** → **Install to Workspace** → **Allow** on Slack's authorization screen. The page that loads shows your **Bot User OAuth Token** (`xoxb-...`) and possibly a **User OAuth Token** (`xoxp-...`). Copy the **bot** token and paste it into the prompt I'm about to open.

Then collect:

- `credential_store` `action: "prompt"`, `service: "slack_channel"`, `field: "bot_token"`, `label: "Bot User OAuth Token"`, `placeholder: "xoxb-..."`, `description: "From Install App page — the Bot User OAuth Token"`.

### Step 3c — User Token (optional, same page)

If the Install App page also shows a **User OAuth Token** → collect it for full triage visibility. It lets the assistant see every channel the user is in, not just channels the bot was added to.

**Tell the user:**

> Looks like the Install App page also shows a **User OAuth Token** (`xoxp-...`). It's optional — copying it gives me visibility into every channel you're in (not just ones where the bot is a member). Paste it into the prompt, or tell me to skip.

- `credential_store` `action: "prompt"`, `service: "slack_channel"`, `field: "user_token"`, `label: "User OAuth Token"`, `placeholder: "xoxp-..."`, `description: "From Install App page — the User OAuth Token (optional, for full channel visibility)"`.

If the User OAuth Token is **not** shown on the page → skip this step (default). Tell the user it's optional and they can add it later.

> ✓ Checkpoint: After Step 3, the `app_token` and `bot_token` are both in the credential store and the user has confirmed both prompts came back successful. If either prompt failed, re-run it before moving on.

## Step 4 — Verify identity

Load the **guardian-verify-setup** skill:

- `skill_load` with `skill: "guardian-verify-setup"`.

**What the user sees:** the bot DMs them in Slack and asks them to confirm their identity. They reply once.

If the user wants to skip → continue to Step 5 (default if they say no), and let them know they can run it later by saying *"verify me on slack"*.

## Step 5 — Report success

If identity was verified:

> Setup complete!
> ✅ App created
> ✅ Tokens configured
> ✅ Connection active
> ✅ Connection tested
> {triage_line}
>
> Connected: @{botUsername} in {workspace}
> Channels: @mention the bot in any channel to add it, or use `/invite @{botUsername}`. DMs work immediately.
> Identity: verified

If identity was skipped → swap the last two lines for:

> ⬜ Connection tested — say "verify me on slack" to finish later.
> …
> Identity: skipped

`{triage_line}` is:

- `✅ Triage visibility: full (can read all your channels)` if a user token was collected, OR
- `⬜ Triage visibility: bot-only (only channels the bot is a member of) — collect a user token anytime to enable full triage` otherwise (default).

## SKILL COMPLETE WHEN

- [ ] `credential_store list` was called and the existing-state branch was named explicitly (Step 1).
- [ ] `bun run skills/slack-app-setup/scripts/build-manifest-url.ts` returned `{ok: true, data: {url}}` and the URL was rendered as a markdown link (Step 2).
- [ ] User confirmed they clicked **Create** in Slack.
- [ ] `credential_store prompt` for `app_token` returned successfully (Step 3a).
- [ ] `credential_store prompt` for `bot_token` returned successfully (Step 3b).
- [ ] `credential_store prompt` for `user_token` either returned successfully or was explicitly skipped because the Install App page did not show one (Step 3c).
- [ ] `guardian-verify-setup` was loaded and either completed or the user explicitly declined (Step 4).
- [ ] Success message was posted with the correct `{triage_line}` (Step 5).

## If Something Fails

**Bot doesn't respond in a channel.** The bot must be a member. @mention it (Slack will prompt "Add Them") or `/invite @{botUsername}`.

**Socket Mode keeps disconnecting.** The app token is revoked or expired. Regenerate it in **Basic Information → App-Level Tokens** and re-run the `app_token` prompt.

**Token rejected on prompt.** The handler validates on entry. Re-prompt; double-check you copied the right value — bot token starts `xoxb-`, app token `xapp-`, user token `xoxp-`.

**Messages not arriving.** Verify **Event Subscriptions → Subscribe to bot events** includes `message.channels`. The manifest pre-configures it, but it can be edited out by hand.

**No Bot User OAuth Token on the Install App page.** The app was likely created without the manifest. Verify **OAuth & Permissions → Scopes → Bot Token Scopes** is populated; if empty → start over from Step 2 (default). Do not hand-edit scopes.

## Clearing Credentials

To disconnect, prefer the Settings UI path — it clears both the secure tokens and the workspace metadata together, matching the in-app Settings handler.
