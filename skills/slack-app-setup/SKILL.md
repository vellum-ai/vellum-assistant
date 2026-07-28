---
name: slack-app-setup
description: Connect a Slack app to the Vellum Assistant via Socket Mode. Use whenever the user wants to set up Slack for their assistant, connect a workspace, or get the assistant talking in Slack — opens a guided setup wizard in the side panel so the user can create the app, generate tokens, and connect in one flow.
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

## Step 1 — Check existing configuration

Run `assistant credentials list --search slack_channel` (via the bash tool). Scan the result for entries with `service: slack_channel` and note which of `app_token`, `bot_token` are present.

Then branch:

- If **both ✅** → fully configured. Offer to show status or reconfigure. Stop here unless the user wants a reset.
- **Otherwise** → continue to Step 2.

> ✓ Checkpoint: You named which of `app_token` / `bot_token` are present before branching. Do not skip the `assistant credentials list` call and guess.

## Step 2 — Open the setup wizard

Call `ui_show` with `surface_type: "channel_setup"` and `data: { channel: "slack" }`. This opens the Slack setup wizard in the side panel. The wizard is non-blocking — the tool returns immediately.

⚠️ CRITICAL: **Tool call first, announcement second — in the same turn.** Do not write any message that says the wizard is open (or is opening) until the `ui_show` call has returned success earlier in the same turn. A message claiming the wizard is open when the tool was never called shows the user an empty side panel.

After `ui_show` returns success, tell the user:

> I've opened the Slack setup wizard in the side panel. It will walk you through creating a Slack app from a manifest and connecting it — complete the steps there. The wizard will auto-notify me when you close it. If you run into issues along the way, ask me in chat.

**Hand-off notification (phones and narrow windows).** On phone-sized clients the setup opens on the Contacts page instead of a side drawer, and completing it there cannot auto-notify. The client signals this with a hidden message like `[User action on channel_setup surface: moved the slack setup to the Contacts page]`. When you receive that hand-off notification, tell the user:

> It looks like the setup opened on your Contacts page rather than a side panel — same steps, different spot. When you've finished, come back here and tell me, and I'll verify the connection.

and rely on their confirmation to trigger Step 3 (no wizard-closed notification will arrive).

If the `ui_show` call fails, do NOT send that message — tell the user the wizard could not be opened and troubleshoot (e.g. no connected client) before retrying.

> ✓ Checkpoint: The successful `ui_show` tool result appears earlier in this turn than your announcement. If it does not, the wizard is not open — make the call before claiming it is.

The wizard handles the entire flow: manifest generation, app creation in Slack, and credential storage. The user copies the manifest from the wizard, hands it to Slack's **From a manifest** option, and Slack returns both tokens at once on **Create and Install**. Tokens are entered in secure input fields within the wizard and saved directly via the API — they never enter the chat conversation.

⚠️ CRITICAL: **Do NOT collect tokens in chat.** Do NOT use `assistant credentials prompt` for Slack setup. Do NOT ask the user to paste tokens into the conversation. The wizard's secure input fields are the only path for credential entry.

## Step 3 — Verify completion

When you receive the wizard-closed notification (or the user says they're done, or asks you to check), verify the connection. The notification arrives as a message like `[User action on channel_setup surface: closed the slack setup wizard]` — closing the wizard drawer sends it automatically, so do not wait for the user to type a confirmation. If the user manually says they're done or asks you to check, proceed with the same verification.

1. Run `assistant credentials list --search slack_channel` (via the bash tool). Confirm both `app_token` and `bot_token` are present.

2. If both are present, fetch the bot identity:

   ```
   bash {
     command: "curl -s -X POST https://slack.com/api/auth.test"
     network_mode: "proxied"
     credential_ids: ["slack_channel/bot_token"]
     activity: "to verify bot identity"
   }
   ```

   Extract `user` → botUsername, `team` → workspace from the JSON response. If `ok: false` or the call errors, fall back to `your bot` / `your workspace`.

3. If either token is missing, tell the user which one is missing. When verification was triggered by the wizard-closed notification, the side panel is no longer open — offer to re-open it and re-run Step 2's `ui_show` call if they accept. When the user asked manually, the wizard may still be open in the side panel — point them back to it instead of re-opening (a second `ui_show` over a live wizard resets their progress).

## Step 4 — Verify identity (optional)

Load the **guardian-verify-setup** skill:

- `skill_load` with `skill: "guardian-verify-setup"`.

If the user wants to skip → continue to Step 5, and let them know they can run it later by saying _"verify me on slack"_.

## Step 5 — Report success

⚠️ CRITICAL: **Never post the success message with literal `{botUsername}` or `{workspace}` in it.** Those are placeholders. Run `auth.test` first (Step 3), substitute real values, then post.

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
- [ ] `ui_show` with `surface_type: "channel_setup"` was called and returned success before any message claiming the wizard is open (Step 2).
- [ ] The wizard-closed notification arrived (or the user asked to check) and both tokens are verified present (Step 3).
- [ ] `guardian-verify-setup` was loaded and either completed or the user explicitly declined (Step 4).
- [ ] Success message was posted with real bot identity values (Step 5).

## If Something Fails

**Bot doesn't respond in a channel.** The bot must be a member. @mention it (Slack will prompt "Add Them") or `/invite @{botUsername}`.

**Socket Mode keeps disconnecting.** The app token is revoked or expired. Regenerate it in **Basic Information → App-Level Tokens** and re-enter it in the wizard.

**Token rejected on save.** The wizard validates token prefixes on entry. Double-check you copied the right value — bot token starts `xoxb-`, app token `xapp-`.

**Messages not arriving.** Verify **Event Subscriptions → Subscribe to bot events** includes `message.channels`. The manifest pre-configures it, but it can be edited out by hand.

**No tokens after creating the app.** Slack shows both under **Your app credentials** in the "your app is ready" modal, collapsed behind a toggle — expand it. If that panel is missing entirely, the app was created from a template (**AI agent**, **Starter app**, **Blank app**) rather than **From a manifest**; scopes will be wrong too, so start over from Step 1. Do not hand-edit scopes.

**Calls fail with `missing_scope` even though setup succeeded.** Slack sometimes installs an app carrying only a fraction of the manifest's scopes — a live install produced 2 of 18. `auth.test` still passes, so a green connection check does not prove the scopes arrived. Confirm by reading the `x-oauth-scopes` response header on any Slack API call and comparing it against the scopes in the manifest.

To fix, in this order:

1. Open the app at <https://api.slack.com/apps>. Slack interrupts with a prompt to **update** the app — accept it. Reinstalling without this step does not restore the scopes.
2. Go to **OAuth & Permissions → Reinstall to Workspace**.

The same bot token then carries the full scope set — it is not rotated, so nothing needs re-entering in the wizard.

## Optional: add a User OAuth Token later

A **User OAuth Token** (`xoxp-...`) lets the assistant see every channel you're in, even ones the bot was never invited to. Useful for triage workflows where you want the assistant to summarize across the whole workspace. Not needed for normal messaging — the bot token alone covers every channel the bot is a member of.

To add it later:

1. Open your Slack app at <https://api.slack.com/apps>, pick the app this skill created, go to **Install App**.
2. Copy the **User OAuth Token** (`xoxp-...`).
3. Ask the assistant to _store the User OAuth Token_ — it will send you a secure prompt to paste it into. (Under the hood: `assistant credentials prompt --service slack_channel --field user_token`.)

To revoke it later, clear the `user_token` credential the same way you'd clear any Slack credential — see Clearing Credentials below.

## Clearing Credentials

To disconnect, prefer the Settings UI path so the same Slack settings handler used by Settings clears both the secure tokens and the workspace metadata together.
