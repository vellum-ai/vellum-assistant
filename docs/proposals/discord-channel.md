# Discord Channel Provider — Investigation

> **Status: investigation only.** No implementation exists. This document maps what
> a Discord channel would have to implement, corrects two premises that turn out to
> be wrong, and gives a file-level scope estimate.
>
> Related: LUM-2718 (agent hallucinates Discord capability — root cause identified
> below, and it is *not* a hallucination), LUM-2618 (channel-agnostic content model,
> Done — it is the rendering foundation and it already pre-analyzed the Discord seam).

## 0. Verdict up front

Discord is **greenfield as a channel** but *not* greenfield as a surface area. Four
things already exist and point at it:

- A complete, well-written setup skill (`skills/discord-app-setup`) that walks a user
  through creating the app, enabling intents, storing a bot token, and inviting the
  bot — and then dead-ends, because nothing consumes the token.
- A seeded Discord **OAuth** provider (`assistant/src/oauth/seed-providers.ts:438`) —
  a different axis (user-scoped OAuth for reading their own guilds), not bot ingress.
- Generic, already-channel-agnostic plumbing: `channel_bot_identity` (gateway DB),
  `canonicalSenderIdFor`, the admission-policy store, the mdast content model.
- Three separate in-repo comments naming Discord as the worked example of "how you
  would add the next channel" (`approval-source-link.ts:29`,
  `clients/web/src/domains/contacts/channel-linking.ts:10`, `gateway/src/db/schema.ts:72`).

The work is real but mostly *wiring*, not invention. The single largest net-new
component is a Discord Gateway WebSocket client in the gateway service — and Slack
Socket Mode is a direct, 1,791-line precedent for exactly that shape.

## 1. Premise check

I verified each item in the brief. Two are wrong in ways that change the plan.

| Premise | Verdict | Detail |
| --- | --- | --- |
| `messaging/providers/` has slack, telegram-bot, whatsapp, gmail, outlook, a2a; no discord | ✅ Confirmed | Exactly those six directories. |
| `discord` exists as a contact channel type | ⚠️ True but misleading | `assistant/src/contacts/types.ts:70-77` `ChannelType` includes `"discord"`. That is a **contact-record label vocabulary**, unrelated to the routing vocabulary. The routing vocabulary is `ChannelId` in `packages/service-contracts/src/channels.ts`, which does **not** include discord — and `packages/service-contracts/src/__tests__/channels.test.ts:22` explicitly pins `isChannelId("discord") === false`. |
| transport-dispatch asserts `deliver/discord` unsupported | ✅ Confirmed | Three assertions across two files: `transport-dispatch.test.ts:84,91,209` and `callback-routing.test.ts:16`. |
| A **bundled** skill stores `discord_channel:bot_token` | ⚠️ Not bundled | It is a **catalog** skill at `skills/discord-app-setup` (registered in `skills/catalog.json:175`), not a bundled skill under `assistant/src/config/bundled-skills/`. Distribution and lifecycle differ. The token path is correct: `discord_channel:bot_token`, consumed by nothing. |
| LUM-2618 is the rendering foundation | ✅ Confirmed, and stronger than stated | The ticket itself contains a note reasoning about Discord: *"a structured Components-v2 sink would share Slack's mdast path… If Discord becomes a channel, it's a new adapter."* The seam was designed with this case in mind. |
| No prior Discord provider work | ✅ Confirmed greenfield | `git log --all --grep=discord` → empty. `git log --all -S discord -- assistant/src/messaging` → two unrelated commits (a credential-guard test fixture and a health-route fix). Only branch matching `*discord*` is this investigation branch. |

### 1.1 LUM-2718 is not a hallucination

Worth flagging clearly, because it changes how that ticket should be fixed. The user
reported the agent "presented as able to connect to Discord, generated a bot URL to add
to their Discord server, then failed."

Every one of those steps is a **real, working script** in `skills/discord-app-setup`:

- `scripts/store-bot-token.ts` → stores `discord_channel:bot_token`
- `scripts/validate-token.ts` → calls Discord's API and succeeds
- `scripts/print-invite-url.ts` → computes a least-privilege permission integer and
  prints a genuine OAuth2 invite URL
- `SKILL.md` Step 6 → prints `Setup complete! ✅ Bot in server: {guild_name}`

The agent followed a skill that terminates in a success banner for a runtime that does
not exist. The fix for LUM-2718 is therefore either (a) build the channel, or (b) gate
or remove the skill from the catalog. It is not a prompting fix.

## 2. Q1 — What a channel provider actually has to implement

**The brief asks for "the provider contract" (singular). There are three, and they live
in two different services.** This is the most important structural finding.

```
 Discord ──WS/HTTP──▶  GATEWAY (ingress)              ASSISTANT (egress + tools)
                       gateway/src/<channel>/         assistant/src/messaging/providers/<channel>/
                       normalize → GatewayInboundEvent
                       → handleInbound (admission)
                       → forward to daemon ─────────▶  runtime inbound stages
                                                       │
                       ◀──── direct delivery ──────────┘  transport.ts (bypasses gateway proxy)
```

### Seam A — Ingress (gateway service)

Owner: `gateway/src/<channel>/`. Per `gateway/CLAUDE.md`, **all** public ingress must be
gateway-side; the daemon is never internet-reachable.

Required pieces, modeled on `gateway/src/slack/`:

| Piece | Contract | Slack reference |
| --- | --- | --- |
| Tolerant Zod schemas | Per `gateway/CLAUDE.md` § *Provider Webhook Payload Validation*: `.optional().catch(undefined)` per field, `safeParse` at the boundary, never a blanket cast | `slack/message-schemas.ts` |
| Normalizers, split by event family | validated event → `GatewayInboundEvent` | `slack/message-normalizer.ts`, `reaction-normalizer.ts`, … |
| Directory/IO layer | authenticated API reads with LRU + in-flight dedup | `slack/user-directory.ts` |
| Pure helpers | actor shaping, attachments, text render | `slack/actor.ts`, `attachments.ts`, `render-text.ts` |
| Connection client | see §3 | `slack/socket-mode.ts` |

The event contract is `gateway/src/channels/inbound-event.ts`. `InboundChannelId` is
currently `telegram | whatsapp | slack | email | a2a` — Discord must be added there, and
the base event's fields are already channel-neutral enough to carry Discord
(`conversationExternalId` = channel/DM id, `actorExternalId` = user snowflake,
`source.threadId` = thread/forum-post id).

Vocabulary rule from `gateway/CLAUDE.md`: trust decisions key on `actorExternalId`
**only** — never fall back to `conversationExternalId`.

### Seam B — Egress (assistant service)

Owner: `assistant/src/messaging/providers/<channel>/transport.ts`, implementing
`ChannelTransport` (`channel-transport.ts:28`):

```ts
interface ChannelTransport {
  readonly channel: ChannelId;
  deliver(ctx, payload): Promise<ChannelDeliveryResult>;
  sendTyping?(ctx, payload);        // routed when payload.chatAction === "typing"
  sendReaction?(ctx, payload);      // routed when payload.reaction is set
  setThreadStatus?(ctx, payload);   // routed when payload.assistantThreadStatus is set
  streamReply?(ctx, payload);       // routed when payload.slackStream is set
}
```

Registration is **type-enforced and exhaustive** — a genuinely nice property here.
`providers/index.ts:28` declares `TRANSPORTS: Record<DirectDeliveryChannel, ChannelTransport>`,
where `DirectDeliveryChannel` is derived from `DIRECT_DELIVERY_CHANNELS` in
`callback-routing.ts:13`. Add `"discord"` to that array and the codebase **fails to
compile** until the transport is registered. There is no second list to drift against.

Callback state rides on the URL: `/deliver/discord?channel=…&threadId=…`, parsed once by
`callbackContext()` and read per-transport.

### Seam C — Tool-facing messaging provider (assistant service)

Owner: `assistant/src/messaging/providers/<channel>/adapter.ts`, implementing
`MessagingProvider` (`messaging/provider.ts:24`). This is what the *agent* uses to list,
search, read, and send — orthogonal to the ingress/egress path.

Mandatory: `testConnection`, `listConversations`, `getHistory`, `search`, `sendMessage`.
Optional: `getThreadReplies`, `markRead`, `senderDigest`, `archiveByQuery`.

Two hooks exist specifically for bot-token (non-OAuth) providers, and Discord needs both:

- `isConnected?()` — overrides the default oauth-store check. The docstring already cites
  Telegram as the reason it exists.
- `resolveConnection?(account?)` — custom credential resolution. Docstring cites Slack
  Socket Mode storing under `slack_channel` rather than the OAuth key. Discord's
  `discord_channel:bot_token` is the same shape.

Registered in `assistant/src/daemon/providers-setup.ts:100-105` (a plain call list — no
type enforcement here, unlike Seam B).

### Seam D — Surface state / contact linking (partial, optional)

- **Approval source links** (`assistant/src/runtime/approval-source-link.ts`): four
  layers; the file's own docstring says lighting up a new channel means implementing
  layer 2 (`providers/<channel>/approval-source.ts`) and registering it in
  `SOURCE_RESOLVERS`. Layers 1, 3, 4 need no changes. Slack is the only implementation today.
- **Channel availability** (`assistant/src/runtime/routes/channel-availability-routes.ts:34`):
  add to `BASE_AVAILABLE_CHANNELS` + a `CHANNEL_METADATA` entry in
  `assistant/src/channels/types.ts` (label, subtitle, lucide icon, `supportsVerification`,
  setup-message copy).
- **Contact "Link account"** (`clients/web/src/domains/contacts/channel-linking.ts:10`):
  the file documents the exact three steps for Discord. `LINKABLE_CHANNEL_IDS` is
  Slack-only today (LUM-2701). Deferrable.

### Which analog to use

**Telegram-bot is the right analog for Seams B and C** (bot token, direct-delivery
transport, `isConnected`/`resolveConnection` overrides, mdast renderer). It is the
**wrong** analog for Seam A — see next section.

## 3. Q2 — Connection lifecycle: where a persistent WebSocket lives

### The brief's premise is inverted

Telegram is **not** a long-lived-connection model in this repo. It is a **webhook**:
`gateway/src/http/routes/telegram-webhook.ts` receives POSTs, and
`gateway/src/telegram/webhook-manager.ts` registers the webhook URL with Telegram. There
is no polling loop and no `getUpdates` call anywhere in the tree.

The actual persistent-WebSocket precedent is **Slack Socket Mode**.

### How each channel ingresses today

| Channel | Mechanism | Location |
| --- | --- | --- |
| Slack | **Persistent WebSocket** (Socket Mode) | `gateway/src/slack/socket-mode.ts` (1,791 lines) |
| Telegram | Webhook (POST) | `gateway/src/http/routes/telegram-webhook.ts` |
| WhatsApp | Webhook (POST) | `gateway/src/whatsapp/` + route |
| Email | Webhook (Resend / Mailgun) | `gateway/src/http/routes/{resend,mailgun}-webhook.ts` |
| a2a | HTTP routes | `gateway/src/http/routes/a2a-routes.ts` |

**Discord's Gateway has no webhook alternative for receiving messages.** Discord's
"webhooks" are outbound-only (posting *into* a channel). Receiving `MESSAGE_CREATE`
requires either the Gateway WebSocket or the HTTP polling variant discussed in §4. So
Discord lands squarely in the Slack Socket Mode lane, not the Telegram lane.

### The Slack Socket Mode pattern, and how well it transfers

`SlackSocketModeClient` (class at `socket-mode.ts:144`, factory at `:1786`) already
solves nearly every problem the Discord Gateway poses:

| Concern | Slack Socket Mode does | Discord Gateway needs |
| --- | --- | --- |
| Connection acquisition | `getWebSocketUrl()` via `apps.connections.open` | `GET /gateway/bot` (also yields shard count + session-start limits) |
| Single active socket | `private ws`, guarded swap, stale-socket check on close (`:710`) | Same |
| Reconnect | capped exponential backoff + jitter, `BASE_BACKOFF_MS` 1s → `MAX_BACKOFF_MS` 30s, attempt reset on open (`:671`) | Same, **plus** close-code discrimination — see below |
| Sleep/wake recovery | `forceReconnect()` (`:325`) with old-socket drain + timeout | Same; reuse the existing sleep-wake detector |
| Missed-message catch-up | `fetchChannelHistorySince` / `fetchThreadRepliesSince` bounded by `MAX_LOOKBACK_MS` + `SAFETY_OVERLAP_MS`, off the open handler | Discord `RESUME` handles this natively (replays missed events) — **simpler**, with a REST-history fallback when resume fails |
| Dedup | 24h TTL dedup cache with hourly cleanup | Same, keyed on message snowflake |
| Bot self-identity | `auth.test` on every reconnect, persisted fallback | `READY` payload carries it; persist to `channel_bot_identity` |
| Ack | ACKs every envelope immediately | N/A (Discord has no per-event ack) |

**Net-new for Discord, with no Slack analog:**

1. **Heartbeat loop.** Discord requires the client to send `OP 1 Heartbeat` every
   `heartbeat_interval` ms (from `OP 10 Hello`), jittered on the first beat, and to track
   `OP 11 Heartbeat ACK`. A missed ACK means close and resume. Slack Socket Mode has no
   equivalent — Slack manages liveness server-side. This is the single most fiddly piece.
2. **IDENTIFY with an intents bitfield.** `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT |
   DIRECT_MESSAGES` at minimum. `MESSAGE_CONTENT` and `GUILD_MEMBERS` are *privileged* —
   the setup skill already instructs users to enable both in the portal (SKILL.md Step 2),
   so the credential path is prepared.
3. **Resume vs. re-identify.** Track `session_id`, `resume_gateway_url`, and last sequence
   number `s`. On resumable closes, reconnect to `resume_gateway_url` and send `OP 6 Resume`.
4. **Close-code handling.** Discord's close codes split into resumable, re-identify, and
   **fatal** buckets. Fatal ones must *not* be retried — `4004` (auth failed) means the
   token is dead, and `4014` (disallowed intents) means the user never enabled the
   privileged intents. Both must surface as actionable config errors, not an infinite
   backoff loop. Slack has no comparable fatal-code taxonomy, so this logic is genuinely new.
5. **Sharding.** Only required past 2,500 guilds. A personal assistant will not hit this.
   Explicitly out of scope, but the `GET /gateway/bot` response should be logged so we
   notice if it's ever approached.

### Where it lives in the daemon lifecycle

Follow `startSlackSocket` exactly (`gateway/src/index.ts:2157`, invoked at `:2488` and
`:2602`):

- Module-scoped `let discordGatewayClient: DiscordGatewayClient | null = null` alongside
  `slackSocketClient` (`:2106`).
- `startDiscordGateway()` reads `credentialKey("discord_channel", "bot_token")` via
  `credentialCache`, and **returns silently if absent** — this is what makes the channel
  inert until the setup skill has run.
- Called on startup and re-called on credential change (the gateway already has a
  `credential-watcher.ts` driving the second call site).
- Stop-then-null on restart, so token rotation cleanly recycles the socket.

Note this lives in the **gateway**, not the assistant daemon. `assistant/CLAUDE.md`'s
"never block startup on subsystem failure" rule is the right spirit but the wrong service;
the gateway equivalent is that `startSlackSocket()` is called with `.catch()` and never awaited.

## 4. Q3 — The minimal read-only slice

**Yes, a read-only slice is coherent, and it is the right first PR.** Ingest messages from
allow-listed channels into conversations, with no send capability.

What it needs:

- `"discord"` added to `CHANNEL_IDS`, `InboundChannelId`, and the contract test flipped.
- Gateway: Gateway client + `MESSAGE_CREATE` normalizer + tolerant schemas.
- Admission policy seeded (§5) — **non-negotiable, not deferrable**.
- Runtime: nothing. The inbound stages are already channel-generic.
- **Deliberately omitted:** `DIRECT_DELIVERY_CHANNELS` entry, `transport.ts`, `adapter.ts`.

The existing negative tests are the guardrail that makes this safe: as long as
`deliver/discord` stays unsupported, `deliverDirect()` throws
`deliverDirect called for unsupported callback` rather than silently dropping a reply.
Keep `transport-dispatch.test.ts:209` **green and unchanged** through the read-only slice
— it is the proof that egress is genuinely absent rather than half-wired.

One caveat: a channel that ingests but cannot reply is a strange product experience. It is
a sound *engineering* checkpoint (it proves the Gateway client, intents, and admission
wiring in production) but should be flag-gated rather than shipped as a user-visible state.

### Could REST polling ship before the Gateway?

**Technically yes, but I recommend against it.**

`GET /channels/{id}/messages?after={snowflake}` per allow-listed channel on a timer is
maybe 150 lines, needs no heartbeat/resume/close-code logic, and would prove the
normalizer + admission path end-to-end.

Against it:

- **It does not shorten the path to v1.** The Gateway client is required for send anyway
  (well, send is REST — but typing indicators, reactions, and any reasonable latency are
  not). Polling is throwaway work, not a stepping stone.
- **DMs are effectively unpollable.** There is no "list my DM channels" endpoint for bots;
  DM channels are discovered by receiving an event. A polling variant is guild-channels-only,
  which for a *personal* assistant is the less interesting half.
- **Rate limits scale with channel count**, and the poll interval sets a latency floor that
  will read as "the assistant is broken."
- Discord's rate-limit headers (`X-RateLimit-Bucket`, dynamic per-route buckets) are their
  own non-trivial surface, so "simpler" is partly illusory.

The honest sequencing is: **Gateway client first, read-only**. That is the risky component;
front-load it. Use polling only if the Gateway client hits an unexpected blocker.

## 5. Q4 — Trust floors and admission control

This is where a new channel most easily goes wrong, and the repo's conventions are strict
and well-documented (`gateway/CLAUDE.md` § *Channel Trust Classification & Admission Policy*).

### What Discord gets for free

Adding `"discord"` to `CHANNEL_IDS` is *most* of the work, because the machinery is keyed
on channel id generically:

- `seedAdmissionPolicyDefaults` (`gateway/src/db/seed-admission-policy.ts`) seeds
  `trusted_contacts` for every non-`vellum` channel automatically.
- The `no_one` kill switch (`gateway/src/handlers/handle-inbound.ts:99-112`) hard-denies
  before forwarding, generically.
- The runtime floor check (`assistant/src/runtime/routes/inbound-stages/admission-policy.ts`)
  compares `TRUST_CLASS_RANK[trustClass] >= ADMISSION_FLOOR[policy]`, generically.
- `canonicalSenderIdFor` (`gateway/src/verification/identity.ts:76`) falls through to
  `trimmed` for non-phone/non-email channels. Discord snowflakes are stable opaque strings
  — **correct with zero changes**.
- `channel_bot_identity` (`gateway/src/db/schema.ts:85`) is keyed on `channel_type` and its
  docstring already names Discord. Works as-is.
- The channel-permission matrix (`channel_permission_overrides`) cascades
  `workspace → adapter → channel_type → channel`. Discord's `dm | private | public` maps
  cleanly onto the existing `channel_type` axis — arguably *better* than Slack, which
  currently collapses public and private to `"channel"`.

### What must be done explicitly, or the permission model is bypassed

1. **Do not add Discord to `ADMISSION_POLICY_EXEMPT_CHANNELS`.** Exempt means both gateway
   *and* runtime short-circuit `admitted: true`. Only `platform` and `a2a` qualify. A
   public Discord channel is the highest-exposure surface in the product — anyone in a
   guild can type at the bot.
2. **Consider `ADMISSION_POLICY_HIDDEN_CHANNELS` only if Discord ships un-configurable.**
   Hidden ≠ exempt: hidden channels still enforce their floor but aren't user-editable, and
   the seed re-pins their row at startup. If Discord ships with a "Who Can Reach" card,
   it should be neither hidden nor exempt.
3. **`actorExternalId` must be the Discord user snowflake**, never the channel/guild id.
   The gateway convention is explicit that trust keys on actor identity only.
4. **Guild-membership is not trust.** Discord's model differs from Slack's in a way that
   matters: a Slack workspace is a coarse trust boundary (`isStranger` marks Slack Connect
   users), but *any* guild member can message a bot in a public channel. Every Discord
   actor should start as `unknown` (rank 1) and fail closed under the default
   `trusted_contacts` floor (rank 3). Do not add a "same guild ⇒ `unverified_contact`"
   shortcut.
5. **Channel allow-listing is separate from admission and also required.** A bot invited to
   a busy guild sees every message in every channel it can view. Admission gates *actors*;
   an allow-list gates *rooms*. Slack solves this with `threadMode`
   (`mention_only | mention_then_thread`, `gateway/src/index.ts:2172`). Discord needs an
   equivalent — default to mention-only in guild channels, open in DMs. Without it the
   assistant will process every message in a public server. This is the highest-risk
   omission on the list.
6. **Both-sides enforcement.** The repo records a Codex finding from #35006: exemption
   checks must exist in *both* the gateway route handler and the runtime stage.
   Single-side enforcement creates a misuse wedge. Any Discord-specific admission logic
   inherits that rule.
7. **Bot-to-bot loops.** Discord `MESSAGE_CREATE` carries `author.bot`. Drop self-authored
   messages at the normalizer, and classify other bots as `contactType: "assistant"` — the
   Slack path already does exactly this (`slackBotContactNote`, `gateway/src/index.ts:2249`).

### Verification flow

`CHANNEL_METADATA.supportsVerification` drives whether clients render the
`ChannelVerificationFlowView`. Discord DMs can carry a verification code exchange the same
way Slack/Telegram do (`gateway/src/verification/`), so `true` is achievable — but it is
additional work and can start as `false`, with contacts linked manually via the gateway
contact-channel upsert.

## 6. Q5 — Scope estimate

### Reusable as-is (no changes)

| Component | Why it just works |
| --- | --- |
| `assistant/src/messaging/content/parse.ts` | Channel-neutral mdast. LUM-2618 delivered this. |
| Admission policy store, seed, floors, kill switch | Keyed on channel id generically |
| `canonicalSenderIdFor` | Falls through to trimmed for opaque ids |
| `channel_bot_identity` table | Keyed on `channel_type`; docstring already names Discord |
| Runtime inbound stages, capability resolution | Consume the stamped `trustClass` |
| Channel-permission matrix | `dm/private/public` axis fits Discord natively |
| `CallbackContext` / dispatch in `providers/index.ts` | Generic once the channel is registered |
| `skills/discord-app-setup` | Complete; token path already correct |

### Adapted from an existing channel

| New file | Modeled on | Notes |
| --- | --- | --- |
| `gateway/src/discord/gateway-client.ts` | `slack/socket-mode.ts` | **Largest single piece.** Backoff/jitter/dedup/force-reconnect transfer directly; heartbeat + resume + close-code taxonomy are net-new |
| `gateway/src/discord/message-schemas.ts` | `slack/message-schemas.ts` | Tolerant Zod per `gateway/CLAUDE.md` |
| `gateway/src/discord/message-normalizer.ts` | `slack/message-normalizer.ts` | → `GatewayInboundEvent` |
| `gateway/src/discord/user-directory.ts` | `slack/user-directory.ts` | LRU + in-flight dedup |
| `gateway/src/discord/actor.ts`, `attachments.ts` | Slack siblings | Pure helpers |
| `gateway/src/discord/api.ts`, `send.ts`, `download.ts` | `telegram/` siblings | REST calls |
| `assistant/src/messaging/providers/discord/transport.ts` | `telegram-bot/transport.ts` | ~80 lines |
| `assistant/src/messaging/providers/discord/render.ts` | `telegram-bot/render.ts` | mdast → Discord markdown (or Components v2) |
| `assistant/src/messaging/providers/discord/adapter.ts` | `telegram-bot/adapter.ts` | `MessagingProvider` + `isConnected`/`resolveConnection` |
| `assistant/src/messaging/providers/discord/{api,client,send,types}.ts` | `telegram-bot/` siblings | |
| `assistant/src/messaging/providers/discord/approval-source.ts` | `slack/approval-source.ts` | Optional; layer 2 only |

### Edits to existing files

| File | Change |
| --- | --- |
| `packages/service-contracts/src/channels.ts` | Add `"discord"` to `CHANNEL_IDS` |
| `packages/service-contracts/src/__tests__/channels.test.ts:22` | Flip the pinned assertion |
| `gateway/src/channels/inbound-event.ts:11` | Add to `InboundChannelId` + `DiscordInboundEvent` |
| `gateway/src/index.ts` | `startDiscordGateway()` + two call sites, mirroring `startSlackSocket` |
| `assistant/src/messaging/providers/callback-routing.ts:13` | Add `"discord"` → compile error until transport registered |
| `assistant/src/messaging/providers/index.ts:28` | Register `discordTransport` |
| `assistant/src/daemon/providers-setup.ts:100` | `registerMessagingProvider(discordMessagingProvider)` |
| `assistant/src/channels/types.ts` | `CHANNEL_METADATA.discord` entry |
| `assistant/src/runtime/routes/channel-availability-routes.ts:34` | Add to `BASE_AVAILABLE_CHANNELS` |
| `assistant/src/runtime/approval-source-link.ts` | Register in `SOURCE_RESOLVERS` (optional) |
| `assistant/src/messaging/providers/__tests__/{transport-dispatch,callback-routing}.test.ts` | Discord moves from negative to positive case — **only in the egress PR** |
| `gateway/openapi` / admission + permission route tests | Per `gateway/CLAUDE.md` checklist |

### Suggested PR sequence

1. **Vocabulary.** `CHANNEL_IDS` + `InboundChannelId` + contract test + metadata + admission
   seed. No behavior. Small, and unblocks everything.
2. **Gateway client, read-only, flag-gated.** The risky piece, isolated. Ships §3's client
   plus normalizer and schemas. Egress tests stay red-by-design.
3. **Egress.** `callback-routing` + `transport.ts` + `render.ts`. Compiler enforces
   completeness. Flip the three negative assertions here.
4. **Tool-facing provider.** `adapter.ts` + registration — the agent can list/search/send.
5. **Polish.** Approval-source resolver, verification flow, contact linking, channel
   allow-list UI.

Steps 1–3 are the meaningful milestone: Discord works as a channel. Steps 4–5 are
incremental.

### Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Public-channel firehose** — bot in a busy guild processes everything | **High** | Mention-only default in guild channels, before any user-facing ship. Highest-priority item in §5.5. |
| Privileged intents not enabled → close code `4014` | Medium | Fatal-code branch surfacing an actionable error; the setup skill already covers enablement |
| Heartbeat/resume bugs → silent disconnects or duplicate delivery | Medium | The dedup cache bounds duplicate blast radius; heartbeat needs its own tests |
| Discord rate limits (dynamic per-route buckets) | Medium | Honor `X-RateLimit-*`; the existing `runWithConcurrency` helper bounds burst |
| Skill ships ahead of runtime (current LUM-2718 state) | **High, active today** | Gate or remove the catalog skill until step 3 lands |
| `ChannelType` (contacts) vs `ChannelId` (routing) confusion | Low | Called out in §1; they are genuinely different vocabularies |
| Components v2 scope creep in rendering | Low | Start with plain Discord markdown — closer to Telegram's HTML sink than to Slack's Block Kit |
| Sharding at 2,500+ guilds | Very low | Out of scope; log `GET /gateway/bot` shard count |

## 7. Open questions for a human

1. **Is Discord actually wanted as a product surface?** LUM-2718 is one user request. The
   cheap fix (gate the skill) resolves the reported bug at a fraction of the cost.
2. **Guild-scoped or DM-only for v1?** DM-only sidesteps the firehose risk entirely and is
   substantially less work — but a REST-polling variant cannot do DMs, which reinforces
   "Gateway client first."
3. **Should the setup skill be gated now**, independent of whether the channel is built?
   It currently reports success for a capability that does not exist.
