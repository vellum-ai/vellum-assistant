# Plan: Deterministic Slack Bot Setup UI

## Problem

Today, users have **three overlapping paths** to "connect Slack" and it's unclear which one to use:

1. **The skill** (`slack-app-setup`): Multi-turn conversational walkthrough via the assistant. Creates a Slack app from a manifest, collects `app_token` + `bot_token` + optional `user_token` via secure credential prompts, runs guardian verification. Works, but burns 5-8+ LLM turns, tokens, and credits for what is fundamentally a fixed checklist.

2. **Settings > Integrations > OAuth tab > "Slack"**: A standard OAuth provider entry (`seed-providers.ts` key: `slack`). This is the guardian *identity* OAuth — it links the user's personal Slack identity to Vellum. It does NOT create a bot, does NOT collect app/bot tokens, does NOT enable Socket Mode. Users see "Slack" in the integrations list, click "Enable", and go through an OAuth2 consent flow. The result is a personal Slack connection for the assistant to act *as the user* — not a bot.

3. **Contacts > Channels > Slack > "Set up" button**: Fires `onStartSetupConversation("I want to reach you on Slack. Let's set it up.")`, which navigates the user to a chat conversation and triggers the assistant to load the `slack-app-setup` skill. So this is just a shortcut back to path #1.
   - **Expand the row** and there's also a `SlackCredentialEntry` — two bare password inputs for bot token + app token with a Save button. No walkthrough, no context, no links. If users find this, they'd need to already know what tokens to paste.

**The confusion**: "Slack" in Integrations (OAuth identity) vs "Slack" in Contacts/Channels (bot setup via skill) serve completely different purposes but both say "Slack". Users don't know which to use or what the difference is. And the skill path is expensive.

---

## Proposal: Replace the Skill with a 4-Step Guided Setup UI

### Where it lives

Replace the existing `SlackCredentialEntry` component in `assistant-channels-detail.tsx` (the expand-row on the Contacts > Channels page) with a **stepped card walkthrough**. This is where users already go to manage channel connections — Telegram and Twilio credential entry already live here as inline forms.

**Why here, not the Integrations page**: The Integrations page is for OAuth identity connections (Google, Notion, Linear, etc.). The Slack *bot* setup is a channel configuration, not an OAuth identity link. It belongs with the other channel configs (Telegram bot token, Twilio SID+auth). Mixing it into the OAuth integrations page would deepen the existing confusion.

**The Integrations page Slack OAuth entry stays** — it serves a different purpose (guardian identity). But we should consider renaming it to "Slack (Personal)" or adding a subtitle that distinguishes it from bot setup. That's a separate, smaller change.

### What the assistant does instead

When the user says "set up Slack", the assistant no longer runs the full 5-step skill. Instead:

> "Head to **Contacts > Your Assistant > Channels > Slack** and expand the Slack row — there's a step-by-step setup guide right there. I'll be here if you hit any snags."

The skill itself can be simplified to: check if already configured, if not, point to the UI. The skill remains as a fallback for CLI-only users or headless setups but is no longer the primary path.

### The 4 cards

The expanded Slack row shows a vertical sequence of 4 numbered step cards. Each card has:
- Step number + title
- Concise instructions
- Any inputs or action buttons needed
- A completion indicator (checkmark when done)

Steps become active sequentially — each step is visually muted until the previous one completes.

---

#### Card 1: Create Your Slack App

**State**: Active by default (unless app already exists — see Step 0 check below)

**Content**:
- Instructions: "Create a Slack app pre-configured with the right permissions, events, and Socket Mode."
- The UI calls `build-manifest-url.ts` logic (either via a daemon endpoint or by porting the manifest-building to the client) to generate the one-click URL using the assistant's name and guardian's name.
- Primary action: **[Create Slack App]** button (opens the manifest URL in a new tab)
- Caption: "Select your workspace, click **Create**, then come back here."
- A "I've created it" / **[Next]** button to advance to Card 2.

**Key decision**: How to get the manifest URL.
- **Option A**: Add a daemon/gateway endpoint (e.g. `GET /v1/integrations/slack/manifest-url`) that runs the same manifest logic server-side. Clean separation, URL stays server-authoritative.
- **Option B**: Port `build-manifest-url.ts` to a shared util the web client imports directly. Simpler, no new endpoint, but couples client to manifest details.
- **Recommendation**: Option A. The manifest includes scopes and event subscriptions that are security-sensitive and should remain server-authoritative. A thin endpoint keeps the client dumb.

---

#### Card 2: Generate App Token

**State**: Locked until Card 1 is marked complete

**Content**:
- Instructions: "In your new Slack app, go to **Basic Information > App-Level Tokens**."
  1. Click **Generate Token and Scopes**
  2. Name it (e.g. "Socket Mode")
  3. Add scope: `connections:write`
  4. Click **Generate**
- Password input: `App-Level Token (xapp-...)`
- **[Save]** button that calls the existing `onSaveSlackConfig`-style handler (but saving app token individually first, or batching — see below)
- On success: checkmark, advance to Card 3

**Token storage**: Today, `SlackCredentialEntry` batches both tokens in one `onSaveSlackConfig(botToken, appToken)` call. The stepped UI needs to save them individually since they're collected in separate steps. The daemon's `config-slack-channel.ts` handler already supports partial saves (it warns "incomplete" when only one token is present). We'd need two individual save endpoints or params, or just hold both in local state and submit together at Card 3.

**Recommendation**: Hold in local component state, submit both at Card 3. Simpler, matches the daemon's "both tokens required to activate" model. Cards 2 and 3 are collection steps; the actual save fires after Card 3.

---

#### Card 3: Install App & Get Bot Token

**State**: Locked until Card 2 input is filled

**Content**:
- Instructions: "In the Slack app sidebar, go to **Install App** > **Install to Workspace** > **Allow**."
- Note: "If you see 'Request approval' instead of 'Allow', your workspace admin needs to approve first."
- Password input: `Bot User OAuth Token (xoxb-...)`
- **[Connect]** button that saves both tokens (app token from Card 2 + bot token from Card 3) via the existing Slack config handler
- On success: the handler validates both tokens, stores workspace metadata, activates Socket Mode. Show checkmark + "Connected as @botName in WorkspaceName"

---

#### Card 4: Verify Your Identity (Optional)

**State**: Active after Card 3 succeeds

**Content**:
- Instructions: "Verify your identity so the assistant knows who you are in Slack. This links your Slack account to your guardian identity."
- **[Verify on Slack]** button — triggers the guardian-verify-setup flow for Slack
- **[Skip for now]** link — "You can verify anytime by telling the assistant 'verify me on slack'"
- This step can remain assistant-driven (loads the skill) since it involves a back-and-forth verification handshake that genuinely benefits from the conversational flow.

---

### Step 0: Existing Configuration Check

On mount, the component checks existing credential state (the contacts page already fetches channel readiness via `channelsReadinessGet`). Branch:

| app_token | bot_token | UI state |
|---|---|---|
| - | - | Show all 4 cards, Card 1 active |
| Yes | - | Card 1 checked, Card 2 checked (pre-fill), Card 3 active |
| - | Yes | Card 1 checked, Card 2 active (unusual but handle it) |
| Yes | Yes | All connected — show current status + "Reconfigure" option |

---

### Avatar Sync

There's already a `SlackAvatarSyncer` in `gateway/src/avatar-sync/slack-avatar-syncer.ts` that calls Slack's `users.setPhoto`. Currently it tries to use the bot token, which doesn't work — `users.setPhoto` requires a **user token** (`xoxp`) with `users.profile:write` scope.

The assistant already generates a PNG from avatar traits via `traits-png-sync.ts` (`renderCharacterPng`). The pipeline is:
1. User picks avatar traits (body shape, eye style, color) during onboarding or in Identity settings
2. `writeTraitsAndRenderAvatar()` renders SVG -> PNG via `@resvg/resvg-js` and writes to disk
3. `SlackAvatarSyncer.sync(pngBuffer)` tries to upload to Slack (currently fails with `not_allowed_token_type`)

**To make this work**, two things need to happen:
1. The optional `user_token` (Step 3.5 in the skill) needs `users.profile:write` scope added to the manifest's user scopes. Currently the manifest includes user scopes for reading channels but not profile writing.
2. `SlackAvatarSyncer` should use the user token instead of the bot token for the `setPhoto` call.

**For the setup UI**: Add an optional Card 3.5 or fold it into Card 3's success state: "Want the bot's profile photo to match your assistant's avatar? Copy the **User OAuth Token** (`xoxp-...`) from the Install App page." This is already optional in the skill (Step 3.5) — keep it optional here too. The avatar sync would fire automatically when the user token is saved.

**Separate from the setup flow**: We should also trigger avatar sync whenever the user changes their avatar (in Identity settings). This is a reactive hook, not part of the setup wizard — file an issue for it.

---

## Existing Surfaces to Reuse

| Surface | Location | Reuse |
|---|---|---|
| `SlackCredentialEntry` | `assistant-channels-detail.tsx:550` | **Replace** with the stepped cards |
| `ChannelRow` expand/collapse | `assistant-channels-detail.tsx:283` | **Keep** — the stepped UI renders inside the expanded row |
| `Input` (password) | `@vellumai/design-library` | **Reuse** for token inputs |
| `Button` | `@vellumai/design-library` | **Reuse** for actions |
| `Card` | `@vellumai/design-library` | **Reuse** for step cards |
| `DetailCard` | `@/components/detail-card` | Possibly reuse for step card wrapper |
| Step state pattern | `billing-onboarding-modal.tsx` | **Reference** for step state machine pattern (but simpler here — linear steps, no branching) |
| `SecretPromptCard` | `chat/components/secret-prompt-card.tsx` | **Don't reuse** — this is for in-chat secret collection, different context |
| Manifest URL builder | `skills/slack-app-setup/scripts/build-manifest-url.ts` | **Port logic** to a daemon endpoint |

---

## What Changes

### Web client (`clients/web/`)
1. **New component**: `SlackSetupWizard` (or similar) — the 4-step card UI. Replaces `SlackCredentialEntry` inside the Slack `ChannelRow` expanded state.
2. **Modify** `assistant-channels-detail.tsx` — swap `SlackCredentialEntry` for the new wizard component when `!connected && channel.key === "slack"`.
3. **Possibly modify** the Integrations page — add a subtitle/note to the Slack OAuth entry clarifying it's for personal identity, not bot setup. Or link to Contacts > Channels from there.

### Daemon (`assistant/`)
1. **New endpoint**: `GET /v1/integrations/slack/manifest-url` — returns the pre-built manifest creation URL given the assistant's name. Reuses the logic from `build-manifest-url.ts`.
2. **Possibly split** the Slack config save into per-token endpoints, or keep the current two-token batch and have the UI collect both before submitting.

### Skill (`skills/slack-app-setup/`)
1. **Simplify** to: check existing config, if not configured, direct the user to the Contacts > Channels UI. Keep full instructions as a fallback for CLI/headless users.

### Gateway (`gateway/`)
1. **Update** `SlackAvatarSyncer` to use user token instead of bot token (separate PR, independent of UI work).

### Manifest (`skills/slack-app-setup/scripts/build-manifest-url.ts`)
1. **Add** `users.profile:write` to user scopes so avatar sync works when user token is collected.

---

## Open Questions

1. **Should Card 4 (Verify) stay conversational?** The verification flow involves sending a code to Slack and the user confirming it — genuinely interactive. Keeping it assistant-driven seems right, but it means one step still bounces to chat. Alternative: build a verify-inline-UI too (more work, probably not worth it for V1).

2. **Individual token saves vs. batch?** Saving tokens individually lets us show per-step success feedback. Batching matches the daemon's "both required" model. Recommend batch (hold in component state, submit at Card 3) for V1, split later if needed.

3. **Where does the "Slack" OAuth entry on the Integrations page go?** Options:
   - Keep as-is, add subtitle "(Personal Identity)"
   - Hide it behind a feature flag (if it's rarely used / confusing)
   - Add a banner/link: "Looking to set up a Slack bot? Go to Contacts > Channels"
   
4. **Should the manifest URL endpoint be gateway-routed?** Following the gateway AGENTS.md rule that all client-facing endpoints go through the gateway. Probably yes for consistency, even though it's a simple URL builder.

5. **User token for avatar sync**: Should this be part of the initial setup flow (Card 3.5) or offered later? The skill treats it as optional. For the UI, maybe show it as a collapsed "Advanced" section after Card 3 succeeds.

---

## Implementation Phases

**Phase 1** (core value):
- Build the 4-card `SlackSetupWizard` component
- Add the manifest-URL endpoint
- Wire into `assistant-channels-detail.tsx`
- Update the skill to point users to the UI

**Phase 2** (polish):
- Avatar sync: add `users.profile:write` scope, fix `SlackAvatarSyncer` to use user token
- User token collection UI (Card 3.5 / advanced section)
- Auto-trigger avatar sync on avatar change
- Clarify Integrations page Slack entry

**Phase 3** (pattern):
- Evaluate whether Telegram and Twilio channel setup should follow the same stepped-card pattern (they're simpler — 1-2 inputs — so maybe not needed)
