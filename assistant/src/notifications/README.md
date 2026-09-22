# Notification System

Signal-driven notification architecture where producers emit free-form events and an LLM-backed decision engine determines whether, where, and how to notify the user.

## Lifecycle

```
Producer → NotificationSignal → Source-Active Gate → Candidate Generation → Decision Engine (LLM) → Deterministic Checks → Broadcaster → Conversation Pairing → Adapters → Delivery
                                                              ↑                                                            ↓
                                                      Preference Summary                                    notification_conversation_created SSE event
                                                      Conversation Candidates                               (creation-only — not emitted on reuse)
```

### 1. Signal

A producer calls `emitNotificationSignal()` with a free-form event name, attention hints (urgency, requiresAction, deadlineAt), and a context payload. The signal is persisted as a `notification_events` row. A `dedupeKey` the producer passes is claimed by that row on insert, with no time window: a later signal carrying a key an existing row holds gets no row of its own and returns `deduplicated: true` before anything below runs. See [Choosing `dedupeKey`](#choosing-dedupekey).

Immediately after persistence, a **source-active pre-gate** runs (`checkSourceActiveSuppression`): when `visibleInSourceNow` is set, a hard signal-only invariant the decision engine cannot override, the signal is suppressed and short-circuits here, before candidate generation and the LLM decision. This keeps an always-suppressed signal (e.g. trusted-contact `verification_sent`) from spending an LLM inference whose result would be discarded. The `notification_events` row is still written for the audit trail.

The hint is not a static `false` for every producer. A conversation-scoped producer derives it per signal through `resolveVisibleInSourceNow()` in `resolve-visible-in-source.ts`, so the same producer suppresses or notifies depending on what the user has on screen. The bar for deriving it rather than passing `false` is high; see [Choosing `visibleInSourceNow`](#choosing-visibleinsourcenow).

### 2. Candidate Generation

Before the decision engine runs, the system builds a **conversation candidate set** per channel (`conversation-candidates.ts`). This is a compact snapshot of recent notification-sourced conversations that the decision engine can choose to reuse instead of starting a new conversation.

**How candidates are generated:**

- For each selected channel, the system queries `notification_deliveries` joined with `notification_decisions` and `notification_events` to find conversations that were created by the notification pipeline within the last 24 hours.
- Up to 5 candidates per channel are returned, deduplicated by conversation ID, most-recent first.
- Each candidate includes: `conversationId`, `title`, `updatedAt`, `latestSourceEventName`, and `channel`.
- **Guardian context enrichment**: When candidates exist, a batch query counts pending (unresolved) guardian approval requests per conversation. Candidates with `pendingUnresolvedRequestCount > 0` carry a `guardianContext` field so the LLM can make informed reuse decisions for conversations with active guardian questions.
- **Candidate-affinity hints**: Guardian dispatch (`guardian-dispatch.ts`) includes `activeGuardianRequestCount` in the signal's `contextPayload`. When multiple guardian questions arise in the same call session, this hint nudges the decision engine toward reusing the existing conversation rather than creating a new one for each question.

The candidate set is serialized into a compact `<conversation-candidates>` block in the decision engine's system prompt. Candidate generation is wrapped in try/catch — a failure does not block the decision path; the engine simply proceeds without candidates (all channels default to `start_new`).

### 3. Decision

The decision engine (`decision-engine.ts`) sends the signal to an LLM (configured via `llm.callSites.notificationDecision`) along with available channels, the user's preference summary, and the conversation candidate set. The LLM responds with a structured decision: whether to notify, which channels, rendered copy per channel, a deduplication key, and **per-channel conversation actions**.

**Conversation actions:** For each selected channel, the LLM decides:

- `start_new` — create a fresh conversation for this delivery.
- `reuse_existing` — append to an existing candidate conversation (must provide a `conversationId` from the candidate set).

The LLM is guided to prefer `reuse_existing` when the signal is a continuation or update of an existing notification conversation (same event type, related context), and `start_new` when the signal is a distinct event deserving its own conversation.

**Validation and fallback:** Conversation actions are strictly validated against the candidate set (`validateConversationActions` in `decision-engine.ts`):

- A `reuse_existing` action with an empty or missing `conversationId` is downgraded to `start_new` with a warning.
- A `reuse_existing` action referencing a conversation ID not in the candidate set is downgraded to `start_new` with a warning.
- Unknown action values are silently ignored; the channel defaults to `start_new` downstream.
- Channels with no conversation action in the decision output default to `start_new`.

When the LLM is unavailable or returns invalid output, a deterministic fallback fires: high-urgency + requires-action signals notify on all channels; everything else is suppressed. The fallback path does not produce conversation actions (all channels use `start_new`).

### 4. Deterministic Checks

Hard invariants that the LLM cannot override:

**Post-generation enforcement** (`decision-engine.ts`):

- **Reply mechanics never ride in copy**: `stripReplyMechanics()` removes request-code reply instructions the model wrote into any channel's `guardian.question` or `ingress.access_request` copy, as whole sentences (`Reference code: X`, `Reply "X approve"`, a paraphrase or negation of either, `Reply "X trust"`, `Use reference code X`). The mechanics live in exactly one place, the broadcaster's `plainTextFallback` (`buildGuardianRequestCodeInstruction` for questions and approvals, `buildAccessRequestReplyMechanics` for access requests), and a transport appends it only when it sends text without buttons: a rich delivery that failed, or a request with no actions to draw (an option-less voice question, or a coded question that failed strict parsing). The bell, the banner, the push, and every card with buttons therefore show the ask alone. The access-request invite-flow directive is context, not mechanics: no surface has a button for it, so it stays in `buildAccessRequestContextText` on every surface and is ensured into model-composed copy that leaves it out (`ensureAccessRequestInviteDirectiveInCopy`).

**Pre-send gate checks** (`deterministic-checks.ts`) — these all depend on the decision, so they run here, after it:

- **Schema validity** -- fail-closed if the decision is malformed
- **Channel availability** -- at least one selected channel must be connected
- **Deduplication** -- the decision's `dedupeKey` matches another event row younger than the dedupe window (1 hour default). This is the engine's own key; the producer's key was already checked at event insert in step 1, with no window.
- **Rendered copy quality** -- fail-closed on empty copy or a fallback leak (body equal to the raw event name)

Source-active suppression depends only on the signal, so it runs earlier — as the pre-decision gate in `emit-signal.ts` (see step 1), not as a pre-send check here.

### 5. Dispatch

`runtime-dispatch.ts` handles two early-exit cases (shouldNotify=false, no channels), then delegates to the broadcaster.

### 6. Broadcast, Conversation Pairing, and Delivery

The broadcaster (`broadcaster.ts`) iterates over selected channels (vellum first for fast SSE push), resolves destinations via `destination-resolver.ts`, pairs each delivery with a conversation via `conversation-pairing.ts`, pulls rendered copy from the decision (falling back to `copy-composer.ts` templates), and dispatches through channel adapters. Each delivery attempt is recorded in `notification_deliveries` with `conversation_id`, `message_id`, and `conversation_strategy` columns. The broadcaster emits `notification_conversation_created` SSE events for new vellum conversations.

## Channel Policy Registry

`../channels/config.ts` is the **single source of truth** for per-channel notification behavior. Every `ChannelId` must have an entry in the `CHANNEL_POLICIES` map. The TypeScript `satisfies Record<ChannelId, ChannelNotificationPolicy>` constraint ensures that adding a new `ChannelId` to `channels/types.ts` will cause a compile error until a policy entry is added.

Each policy defines:

| Field                               | Type                   | Description                                                       |
| ----------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `notification.deliveryEnabled`      | `boolean`              | Whether the channel can receive notification deliveries           |
| `notification.conversationStrategy` | `ConversationStrategy` | How conversations are materialized for deliveries on this channel |

### Conversation Strategy Types

| Strategy                         | Behavior                                                                                                                                                      | Used by                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `start_new_conversation`         | Pairs the delivery with a new or reused conversation, or appends to the producing one (see Conversation Pairing below).                                       | `vellum`                                                                                     |
| `continue_existing_conversation` | Resolves the destination chat's home conversation, creating one on first delivery. The delivered post is written there only once the channel acknowledges it. | `telegram`, `slack`, `discord`, and the non-deliverable `whatsapp`, `email`, `a2a`, `plugin` |
| `push_only`                      | Pairs nothing. The push deep-links through the vellum delivery's conversation.                                                                                | `platform`                                                                                   |
| `not_deliverable`                | Channel cannot receive notifications. Pairing returns null IDs.                                                                                               | `phone`                                                                                      |

### Helper Functions

- `getDeliverableChannels()` -- returns all `ChannelId` values where `deliveryEnabled` is true
- `getChannelPolicy(channelId)` -- returns the full policy object for a channel
- `isNotificationDeliverable(channelId)` -- boolean check for delivery eligibility
- `getConversationStrategy(channelId)` -- returns the conversation strategy for a channel

### How to Add a New Channel

1. Add the channel to `CHANNEL_IDS` in `packages/service-contracts/src/channels.ts` (re-exported through `channels/types.ts`).
2. Add its policy to `CHANNEL_POLICIES` in `channels/config.ts`; the compiler requires an entry for every channel. `deliveryEnabled: true` makes it a `NotificationChannel` (`DeliverableChannelId` is derived from these policies), and `conversationStrategy` decides what conversation pairing does for it.
3. For a deliverable channel, add an adapter in `adapters/` implementing `ChannelAdapter` and register it in `getBroadcaster()` in `emit-signal.ts`.
4. Add its case to `getConnectedChannels()` in `emit-signal.ts` and to `resolveDestinations()` in `destination-resolver.ts`. Both switch over deliverable channels, so the compiler flags a missing case.

## Conversation Pairing

Before an adapter sends a notification, `pairDeliveryWithConversation()` (in `conversation-pairing.ts`) decides which conversation the delivery belongs to, from the channel's `conversationStrategy` and the decision engine's per-channel conversation action. The module header and the function's inline comments are the source of truth for the details. The rules that hold across them:

- **Vellum (`start_new_conversation`)**:
  - A signal that sets `requiresConversation` gets a conversation of its own, created with its seed message before the send (`standard` unless the producer overrides `conversationType`). An explicit `reuse_existing` action appends to a valid target instead, and falls back to a new conversation (`conversationFallbackUsed: true`) when the target is stale.
  - A signal that does not set it creates no conversation, except that with `assistant-initiated-threads` on, an `assistant.share` with no `conversationMetadata.source` of its own is promoted to one when its producing conversation is a background or scheduled run, or does not resolve (`withAssistantInitiatedThread()`). Otherwise its body is appended to the conversation that produced it (resolved from `sourceContextId`). A `chat.assistant_reply` appends nothing, because the full reply is already in that transcript.
- **External channels (`continue_existing_conversation`)**: only the chat's home conversation is resolved, and nothing is written. The broadcaster records the delivered post as an assistant row once the channel acknowledges it (`recordDeliveredChannelPost`), so a failed or pending delivery never reads as something the assistant said.
- **`push_only`** (platform) and **`not_deliverable`**: nothing is paired. Platform push deep-links through the vellum delivery's conversation.
- **Guardian-request deliveries to channels** pair nothing either: they are projections of a canonical request, and only their vellum delivery carries a conversation (see `notifications/AGENTS.md`).

Pairing is resilient: errors are caught and logged, and a pairing failure never breaks the delivery pipeline.

## Multi-Surface Copy Architecture

The system produces **three distinct copy outputs** per notification:

| Output                    | Purpose                                          | Verbosity                |
| ------------------------- | ------------------------------------------------ | ------------------------ |
| `title` + `body`          | OS notification banner (desktop and mobile apps) | Short and glanceable     |
| `deliveryText`            | Channel-native chat message text (Telegram)      | Natural chat phrasing    |
| Conversation seed message | Opening message in the notification conversation | Richer and context-aware |

### How It Works

1. The **decision engine** can produce `title`/`body` (popup copy), `deliveryText` (chat copy), and `conversationSeedMessage` (richer conversation content) per channel.
2. **Adapters** use the surface-appropriate field:
   - Vellum notifications use `title` + `body`.
   - Telegram delivery prefers `deliveryText` and falls back to `conversationSeedMessage`, then `body`, then `title`.
3. **Conversation pairing** uses the conversation seed as the conversation's opening message:
   - If the LLM produced a valid `conversationSeedMessage`, it is used directly (after a sanity check rejects empty, too-short, JSON dumps, or excessively long values).
   - Otherwise, the **runtime conversation seed composer** (`conversation-seed-composer.ts`) generates a deterministic, surface-aware seed.

### Surface-Aware Verbosity

The conversation seed composer adapts verbosity to the delivery surface:

| Channel    | Default Interface | Verbosity | Style                                          |
| ---------- | ----------------- | --------- | ---------------------------------------------- |
| `vellum`   | `macos`           | Rich      | 2-4 short sentences with context and next step |
| `telegram` | `telegram`        | Compact   | 1-2 concise sentences                          |

Interface inference strategy:

1. Explicit `interfaceHint` in the signal's `contextPayload` (if valid `InterfaceId`).
2. `sourceInterface` from the originating conversation (if valid `InterfaceId`).
3. Channel default mapping (`vellum` → `macos` → rich, `telegram` → `telegram` → compact).

### Example: Reminder Notification

**Native popup (vellum/macos):**

```
Title: Reminder
Body:  Take out the trash
```

**Telegram chat delivery (`deliveryText`):**

```
Take out the trash
```

**Conversation seed on vellum/macos (rich):**

```
Reminder. Take out the trash. Action required.
```

## Conversation Surfacing via `notification_conversation_created` Event (Creation-Only)

The `notification_conversation_created` SSE event is emitted **only when a brand-new conversation is actually created** by the broadcaster. Reused conversations do not trigger it.

This is enforced in `broadcaster.ts` by gating the event emission on `pairing.createdNewConversation === true`:

```ts
// Emit notification_conversation_created only when a NEW conversation was
// actually created. Reusing an existing conversation should not fire the SSE
// event — the client already knows about the conversation.
if (
  pairing.createdNewConversation &&
  pairing.strategy === "start_new_conversation"
) {
  // ... emit SSE event
}
```

When a vellum notification conversation **is** newly created (strategy `start_new_conversation`), the broadcaster emits the SSE event **immediately**, before slower channel deliveries such as Telegram, so a slow channel send cannot delay it.

The payload is `NotificationConversationCreatedEventSchema` in `api/events/notification-conversation-created.ts`.

No first-party client acts on this event: the shared web renderer (browser, desktop app, mobile apps) lists it as a no-op in `use-stream-event-handler.ts`.

### Per-Dispatch Conversation Callback

`emitNotificationSignal()` accepts an optional `onConversationCreated` callback (`options.onConversationCreated`). This lets producers run domain side effects (for example, creating cross-channel guardian delivery rows) as soon as vellum pairing occurs, without introducing a second conversation-creation path.

**Important distinction between the two callbacks:**

- **Per-dispatch `options.onConversationCreated`**: Fires for **both** new and reused vellum conversation pairings. Callers like `dispatchGuardianQuestion` rely on this to create delivery bookkeeping rows before `emitNotificationSignal()` returns, regardless of whether the conversation was newly created or reused.
- **Class-level `this.onConversationCreated` (SSE broadcast)**: Fires **only** when a brand-new conversation is created (`createdNewConversation === true && strategy === 'start_new_conversation'`). This emits the `notification_conversation_created` SSE event. Reused conversations do not trigger it.

## Schedule Routing Metadata and Trigger-Time Enforcement

Schedules (both recurring and one-shot) carry optional routing metadata that controls how notifications fan out across channels when the schedule fires in `notify` mode. This enables a single schedule to produce multi-channel delivery without requiring the user to create duplicate schedules per channel.

### Routing Intent Model

The `routing_intent` field on each `schedule_jobs` row specifies the desired channel coverage:

| Intent           | Behavior                                              | When to use                                                         |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `single_channel` | Default LLM-driven routing (no override)              | Standard schedules where the decision engine picks the best channel |
| `multi_channel`  | Ensures delivery on 2+ channels when 2+ are connected | Important schedules the user wants on both desktop and phone        |
| `all_channels`   | Forces delivery on every connected channel            | Critical schedules that must reach the user everywhere              |

The default is `all_channels`. Routing intent is persisted in the `schedule_jobs` table (`routing_intent` column) and carried through the notification signal as `routingIntent`.

### Routing Hints

The `routing_hints_json` field is free-form JSON metadata passed alongside the routing intent. It flows through the signal as `routingHints` and is included in the decision engine prompt, allowing producers to communicate channel preferences or contextual hints without requiring schema changes.

### Trigger-Time Enforcement Flow

When a schedule fires in `notify` mode, the routing metadata flows through the notification pipeline with a post-decision enforcement step:

```
Schedule fires (schedule worker: runDueSchedulesOnce in scheduler.ts, notify mode)
  → emitScheduleNotifySignal (scheduler.ts)
    → emitNotificationSignal({ routingIntent, routingHints })
      → Decision Engine (LLM selects channels)
        → enforceRoutingIntent() (post-decision guard)
          → Deterministic Checks
            → Broadcaster → Adapters → Delivery
```

`contextPayload.channelAllowlist` is an exclusive channel set. When present, emit-signal intersects it with connected channels, skips urgent vellum/platform force, and skips routing-intent expansion. `--preferred-channels` stays additive and is ignored when an allowlist is present. Access-request signals still force the in-app vellum card.

The `enforceRoutingIntent()` function in `decision-engine.ts` runs after the LLM produces its channel selection but before deterministic checks. It overrides the decision's `selectedChannels` based on the routing intent:

- **`all_channels`**: Replaces `selectedChannels` with all connected channels (from `getConnectedChannels()`).
- **`multi_channel`**: If the LLM selected fewer than 2 channels but 2+ are connected, expands `selectedChannels` to at least two connected channels.
- **`single_channel`**: No override -- the LLM's selection stands.

When enforcement changes the decision, the updated channel selection is re-persisted to the `notification_decisions` table so the stored decision matches what was actually dispatched. The `reasoningSummary` is annotated with the enforcement action (e.g. `[routing_intent=all_channels enforced: vellum, telegram]`).

### Single-Schedule Fanout

A key design principle: **one schedule produces one notification signal that fans out to multiple channels**. The user never needs to create separate schedules for each channel. The routing intent metadata on the single schedule controls the fanout behavior, and the notification pipeline handles per-channel copy rendering, conversation pairing, and delivery through the existing adapter infrastructure.

### Data Flow

```
schedule_jobs table (routing_intent, routing_hints_json)
  → schedule-store.ts: claimDueSchedules() reads routing metadata
    → scheduler.ts: emitScheduleNotifySignal({ routingIntent, routingHints })
      → emitNotificationSignal({ routingIntent, routingHints })
        → signal.ts: NotificationSignal.routingIntent / routingHints
          → decision-engine.ts: evaluateSignal() → enforceRoutingIntent()
            → broadcaster.ts: fan-out to selected channel adapters
```

## Channel Delivery Architecture

The notification system delivers to five channel types:

### Vellum (always connected)

Local SSE via the assistant's broadcast mechanism. The `VellumAdapter` emits a `notification_intent` message containing:

- `sourceEventName` -- the event that triggered the notification
- `title` and `body` -- rendered notification copy
- `deepLinkMetadata` -- optional metadata for navigating to the relevant context (e.g. `{ conversationId }`)

Every first-party client runs the shared web renderer (browser, desktop app, mobile apps), which posts a local notification from this payload and acks the delivery. When the user taps the notification, the client uses `deepLinkMetadata` to navigate to the relevant conversation.

A guardian-sensitive notification (approval requests, access requests, channel activation codes) carries `targetGuardianPrincipalId` and is published with `targetActorPrincipalId`, so the event hub delivers it only to connections authenticated as the guardian. The client shows it when the sending assistant is new enough to apply that targeting (`clients/web/src/lib/backwards-compat/guardian-notification-targeting.ts`) and drops it otherwise.

### Platform (always connected)

The `PlatformPushAdapter` posts the notification to the platform's `/v1/assistants/{id}/push/dispatch/` endpoint, which fans it out to the bound user's registered devices for native mobile push. Without platform credentials the delivery is recorded as failed.

### External channels: Telegram, Slack, Discord

The assistant sends these itself. Each adapter calls the provider's API through the send module in `../messaging/providers/<channel>/`; nothing goes through the gateway.

- **Telegram**: the `TelegramAdapter` sends channel-native text (`deliveryText` when present) to the guardian's chat ID through `telegram-bot/send.ts`, which calls the Telegram Bot API. Approval cards carry inline keyboard buttons and fall back to plain text with typed-reply instructions if the rich send fails.
- **Slack**: the `SlackAdapter` posts to the guardian's DM through `slack/send.ts`. Approval cards render as a Card block with the approval's action buttons.
- **Discord**: the `DiscordAdapter` opens the guardian's DM from their user ID through the Discord REST API and sends through `discord/send.ts`. Approval cards render component buttons.

The destination for each comes from the guardian delivery list in `destination-resolver.ts`, with deterministic fallback copy when model copy is unavailable.

### Channel Connectivity

Connected channels are resolved at signal emission time by `getConnectedChannels()` in `emit-signal.ts`, from the guardian delivery list (`getGuardianDelivery()`):

- **Vellum** is always considered connected (the local transport is always available when the assistant is running)
- **Platform** is always considered connected; a missing credential surfaces as a failed delivery
- **Telegram** is connected when the guardian has a chat ID on the channel
- **Slack** is connected when the guardian's chat ID is a DM channel (`D`-prefixed), so a binding made from a shared channel never receives notifications
- **Discord** is connected when a guardian binding names a user to DM

## Conversation Materialization

The system uses a single conversation materialization path for **all** notifications -- there are no legacy bypass paths or dual-broadcast mechanisms. Every notification, including guardian questions and access-request alerts, flows through `emitNotificationSignal()`:

1. `emitNotificationSignal()` evaluates the signal and dispatches to channels.
2. `NotificationBroadcaster` pairs each delivery with a conversation via `pairDeliveryWithConversation()`, executing the per-channel conversation action (start_new or reuse_existing).
3. For vellum deliveries, the broadcaster merges `conversationId` into `deepLinkMetadata` and emits `notification_conversation_created` only when a new conversation was created (not on reuse).

Guardian dispatch follows this same path and uses the optional `onConversationCreated` callback to attach guardian-delivery bookkeeping to the paired vellum conversation.

### Conversation-Before-Event Invariant

For notification flows that create conversations, the conversation must be created **before** the SSE event is emitted. This ensures a client can immediately fetch the conversation contents when it receives the conversation-created event.

## Conversation Decision Audit Trail

Every conversation routing decision is persisted for observability:

### Decision-Level Audit (`notification_decisions`)

When the decision is persisted, a `conversationActions` summary is included in `validationResults`:

```json
{
  "conversationActions": {
    "vellum": "start_new",
    "telegram": "reuse:conv-abc-123"
  }
}
```

### Delivery-Level Audit (`notification_deliveries`)

Three columns on `notification_deliveries` record the per-channel conversation decision:

| Column                       | Type    | Description                                                                                                 |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `conversation_action`        | TEXT    | `'start_new'` or `'reuse_existing'` — what the model decided                                                |
| `conversation_target_id`     | TEXT    | The candidate `conversationId` when action is `reuse_existing`                                              |
| `conversation_fallback_used` | INTEGER | `1` if `reuse_existing` was attempted but the target was invalid, so a new conversation was created instead |

### Query Examples

```sql
-- Conversation reuse decisions with fallback tracking
SELECT d.channel, d.conversation_action, d.conversation_target_id,
       d.conversation_fallback_used, d.conversation_id
FROM notification_deliveries d
WHERE d.conversation_action IS NOT NULL
ORDER BY d.created_at DESC
LIMIT 20;

-- Reuse failures (model hallucinated an invalid conversation ID)
SELECT d.channel, d.conversation_target_id, d.conversation_id
FROM notification_deliveries d
WHERE d.conversation_fallback_used = 1
ORDER BY d.created_at DESC;
```

## Guardian Multi-Request Disambiguation in Reused Conversations

When the decision engine routes multiple guardian questions to the **same** conversation (via `reuse_existing`), those questions share a single conversation. The guardian needs a way to indicate which question they are answering. This is handled via **request-code disambiguation**.

### How Request Codes Work

Each guardian request is assigned a unique 6-character hex code (e.g. `A1B2C3`) at creation time, generated gateway-side during `guardian_requests_create` (`generateRequestCode()` in `gateway/src/db/guardian-request-store.ts`). The guardian sees the code only where they need to type it: in the plain-text fallback a transport appends when it sends a request without buttons, and in the router's disambiguation reply when several requests are pending.

### Reply Routing and Disambiguation

Every guardian reply typed in the app, and every reply or button press arriving on a channel, goes through `routeGuardianReply()` in `runtime/guardian-reply-router.ts`: from `conversation-process.ts` and `conversation-routes.ts` for the app, and from `inbound-stages/guardian-reply-intercept.ts` for channels. Buttons on the app's own cards skip the router: `surface-action-routes.ts` and `guardian-action-routes.ts` call `processGuardianDecision()` directly. In priority order the router tries:

1. A channel button callback (`apr:<requestId>:<action>`).
2. A request-code prefix on the reply. Matching is case-insensitive.
3. `open invite flow` while an access request is pending, which passes through to the normal assistant turn.
4. A bare-text answer, when exactly one question is pending in the conversation it was asked in.
5. An explicit approve or reject phrase, applied when exactly one request is pending.
6. Natural-language classification, only where the caller passes an `approvalConversationGenerator`: channels do, app sessions do not.

When several requests are pending and the reply names none of them, the router answers with `composeDisambiguationReply()`, listing each request's code and how to reply to it:

- for an explicit approve or reject phrase, everywhere;
- where classification runs, for any reply it does not resolve to one request. `runApprovalConversationTurn()` returns `keep_pending` for indecision and for every failure (generator error, malformed output, a decision with no target), so on those channels any other code-less reply is consumed here.

Where classification does not run, any other code-less reply falls through to the normal message pipeline. With one request pending, a `keep_pending` classification returns the engine's own reply as `nl_keep_pending`: the channel intercept treats it as consumed, while `conversation-routes.ts` lets the message through. Every decision applies through `applyGuardianDecision()`. The end-to-end map is [docs/guardian-request-flow.md](../../docs/guardian-request-flow.md).

## Key Files

| File                            | Purpose                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `../channels/config.ts`         | Channel policy registry -- single source of truth for per-channel notification behavior                    |
| `emit-signal.ts`                | Single entry point for producers; orchestrates the full pipeline; runs the source-active pre-decision gate |
| `signal.ts`                     | `NotificationSignal` and `AttentionHints` type definitions                                                 |
| `types.ts`                      | Channel adapter interfaces, delivery types, decision output contract, `ConversationAction` union           |
| `conversation-candidates.ts`    | Builds per-channel candidate set of recent notification conversations for the decision engine              |
| `conversation-pairing.ts`       | Materializes conversation + message per delivery based on channel strategy                                 |
| `decision-engine.ts`            | LLM-based routing with forced tool_choice; deterministic fallback                                          |
| `deterministic-checks.ts`       | Post-decision pre-send gate checks (schema, dedupe, channel availability, copy quality)                    |
| `runtime-dispatch.ts`           | Dispatch gating (no-op decisions, empty channels)                                                          |
| `broadcaster.ts`                | Fan-out to channel adapters with delivery audit trail; emits `notification_conversation_created` SSE event |
| `copy-composer.ts`              | Template-based fallback notification copy when LLM copy is unavailable                                     |
| `conversation-seed-composer.ts` | Surface-aware conversation seed generation (richer than notification copy)                                 |
| `destination-resolver.ts`       | Resolves per-channel endpoints (Telegram and Slack chat ID, Discord user ID)                               |
| `adapters/macos.ts`             | Vellum adapter -- broadcasts `notification_intent` via SSE with deep-link metadata                         |
| `adapters/platform.ts`          | Platform adapter: posts to the platform push-dispatch endpoint for native mobile push                      |
| `adapters/telegram.ts`          | Telegram adapter: calls the Telegram Bot API through `messaging/providers/telegram-bot/send.ts`            |
| `adapters/slack.ts`             | Slack adapter: posts to the guardian's DM through `messaging/providers/slack/send.ts`                      |
| `adapters/discord.ts`           | Discord adapter: sends to the guardian's DM through `messaging/providers/discord/send.ts`                  |
| `preference-extractor.ts`       | Detects notification preferences in conversation messages                                                  |
| `preference-summary.ts`         | Builds preference context string for the decision engine prompt                                            |
| `preferences-store.ts`          | Create and list for the `notification_preferences` table                                                   |
| `events-store.ts`               | CRUD for `notification_events` table                                                                       |
| `decisions-store.ts`            | CRUD for `notification_decisions` table                                                                    |
| `deliveries-store.ts`           | CRUD for `notification_deliveries` table                                                                   |

## How to Add a New Notification Producer

1. Import `emitNotificationSignal` from `./emit-signal.js`.
2. Call it with the signal parameters:

```ts
import { emitNotificationSignal } from "../notifications/emit-signal.js";

await emitNotificationSignal({
  sourceEventName: "your_event_name",
  sourceChannel: "scheduler", // where the event originated
  sourceContextId: conversationId,
  attentionHints: {
    requiresAction: true,
    urgency: "high",
    isAsyncBackground: false,
    // `false` is the correct default. Only a producer that can prove this
    // arrival already rendered the event in the conversation may resolve the
    // hint instead, and each one needs a flag that names it. See
    // "Choosing `visibleInSourceNow`" below.
    visibleInSourceNow: false,
  },
  contextPayload: {
    /* arbitrary data for the decision engine */
  },
  // Optional: control multi-channel fanout behavior
  routingIntent: "multi_channel", // 'single_channel' | 'multi_channel' | 'all_channels'
  routingHints: { preferredChannels: ["telegram"] },
});
```

3. Optionally add a fallback copy template in `copy-composer.ts` keyed by your `sourceEventName`. Without a template, the generic fallback produces a human-readable version of the event name.

The call is fire-and-forget safe by default -- errors are caught and logged internally unless you pass `throwOnError: true`.

### Choosing `visibleInSourceNow`

Step 1 suppresses on this hint before anything else runs, and nothing downstream can rescue a signal it swallows, so a wrong `true` deletes the notification outright. All four rules below must hold before a producer resolves the hint instead of passing `false`.

- **Opt in only when the notification duplicates something that conversation has already rendered, and only behind a flag that names your producer.** `resolveVisibleInSourceNow()` reads `activity-presence-suppression`, which gates the background-activity failure producer alone, so a new producer needs its own flag or an extension of that one before it calls the resolver. Otherwise the flag silently governs a producer its description does not cover. Having a conversation id in scope is not sufficient; the producer must know that _this_ arrival put the announced thing on screen there. `runtime/background-job-runner.ts` is the worked example: one catch block is reached from several directions, and it passes `presenceConversationId` only when the failure carries a `turnFailure`, the one arrival whose conversation is guaranteed to have emitted a `conversation_error` the user can read. A runner timeout leaves the turn still rendering as in progress and a bootstrap throw never reaches the agent loop, so both keep notifying.
- **Pass a literal `false` for global and infra signals.** Heartbeat, credential health, webhook health, and worker liveness have no source surface to watch, so there is nothing to duplicate.
- **Never opt in a `guardian.question` producer.** The card _is_ the prompt, so a `true` suppresses the question's only rendering and the tool hangs until the prompt timeout. `runtime/question-request-guardian-bridge.ts` carries the rationale at its hint block, and three regression pins hold the line: `runtime/__tests__/question-request-guardian-bridge.test.ts`, `__tests__/confirmation-request-guardian-bridge.test.ts`, and `__tests__/notification-guardian-path.test.ts`.
- **A producer running outside the main assistant process cannot read presence at all.** The schedule worker (`schedule/worker.ts`) and the memory jobs worker (`plugins/defaults/memory/worker.ts`) are standalone OS processes, while the resolver reads `assistantEventHub` through `isWebConversationFocused()` and that hub's SSE clients exist only in the assistant process. Every presence read from a worker resolves `false`, whatever the user is watching. The trap is in testing: a test that drives the producer and mocks presence in one process passes while the shipped worker suppresses nothing. Tracked as JARVIS-1711. The boundary runs the other way too: a hub publish from a worker is forwarded to the assistant process best-effort (`runtime/assistant-event-hub.ts`, logged rather than thrown on failure). A worker-side producer is therefore guaranteed its event row and nothing past it: the home-feed write is best-effort in every process (`writeHomeFeedItemForSignal` returns `null` for an ineligible signal, a missing summary, or a failed write, and `emit-signal.ts` only logs a rejection), and the live push to open clients depends on the forward as well.

### Choosing `dedupeKey`

There are two keys and they do different jobs. Choose the producer's by what it names, not by how often it fires.

- **The producer's key is a permanent claim, not a rate limit.** `createEvent` refuses a second row for a key any row already holds (`events-store.ts`), however old that row is. Key on a durable identity (a job row, a request id) to attempt a thing at most once ever; key on that identity plus a time bucket to attempt it at most once per bucket. A key with no identity in it silences every later instance for the whole bucket, whether or not it was the same thing. At most once, not exactly once: the claim lands at insert, before the decision and dispatch, so a process that dies between the two leaves the key claimed with nothing announced, and the retry short-circuits `deduplicated: true` and reports success. A producer that must not lose an announcement across a mid-pipeline shutdown (routine during an app update) needs its own record of delivery, not the key.
- **A failed pipeline releases the claim; a retry re-emits.** When the pipeline fails after the row landed and no channel ran (`hasChannelSideEffect` is false), `emit-signal.ts` writes the key back to `null`, so the same producer can retry the same key. When any channel already ran, the claim stays: releasing it would double-send to those channels. This is what makes a crash retry idempotent against a double send for a producer keyed on a durable row id: `plugins/defaults/memory/skill-update-receipt-job.ts` keys on its job row, so a retry past the event row meets the claim, is reported `deduplicated: true, pipelineFailed: false`, and completes.
- **The decision's key is windowed.** The engine picks its own key per decision; step 4 checks it against event rows inside the 1-hour window and writes it onto the row only when the producer passed none. A producer never passes the engine's key and never appeals its verdict.

## Audit Trail

Three SQLite tables form the audit chain:

- **`notification_events`** -- every signal that entered the pipeline, with attention hints and context payload
- **`notification_decisions`** -- the routing decision for each event (shouldNotify, selectedChannels, reasoning, confidence, whether fallback was used)
- **`notification_deliveries`** -- per-channel delivery attempts with status (pending/sent/failed/skipped), rendered copy, error details, conversation pairing data (`conversation_id`, `message_id`, `conversation_strategy`), and client delivery outcome (`client_delivery_status`, `client_delivery_error`, `client_delivery_at`)

### Client Delivery Ack

For vellum deliveries, the audit trail extends past the SSE broadcast to the OS notification post. The `notification_intent` message carries an optional `deliveryId`; after posting the notification (or deciding not to, for the conversation already on screen), the client reports the outcome to `POST notification-intent-result` through `sendNotificationIntentAck()` in `clients/web/src/runtime/notifications.ts`.

The ack populates three columns on `notification_deliveries`:

| Column                   | Type    | Description                                                                                               |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `client_delivery_status` | TEXT    | `'delivered'` if the client handled the intent, `'client_failed'` otherwise. Last writer wins (see below) |
| `client_delivery_error`  | TEXT    | Error description when the post failed (e.g. authorization denied)                                        |
| `client_delivery_at`     | INTEGER | Epoch ms timestamp of when the client reported the outcome                                                |

`'delivered'` covers two outcomes the column cannot tell apart: the OS accepted a posted banner, or the client deliberately showed none (the intent was `silent`, the user was already watching that conversation, or the sending assistant predates guardian targeting and the intent was guardian-scoped). The intent goes to every eligible connection, and each one acks the same `deliveryId`. `handleNotificationIntentResult()` in `runtime/routes/notification-routes.ts` overwrites the row with no client key, so the status holds the last client to report, not an aggregate, and `client_delivery_error` is only ever set, so it can outlive a later success. The audit trail answers three questions for each vellum delivery:

1. **Was the intent broadcast?** -- existing `status` column (`sent`)
2. **Did any client report back?** -- `client_delivery_status` is non-null
3. **Did the last client to report fail, and why?** -- `client_delivery_status = 'client_failed'` + `client_delivery_error`

Query examples:

```sql
-- Recent decisions that resulted in notifications
SELECT e.source_event_name, d.should_notify, d.selected_channels, d.reasoning_summary
FROM notification_decisions d
JOIN notification_events e ON d.notification_event_id = e.id
WHERE d.should_notify = 1
ORDER BY d.created_at DESC
LIMIT 20;

-- Failed deliveries
SELECT d.channel, d.error_message, d.rendered_title
FROM notification_deliveries d
WHERE d.status = 'failed'
ORDER BY d.created_at DESC;

-- Deliveries with conversation pairing
SELECT d.channel, d.conversation_id, d.message_id, d.conversation_strategy, d.rendered_title
FROM notification_deliveries d
WHERE d.conversation_id IS NOT NULL
ORDER BY d.created_at DESC;

-- Vellum deliveries where the client failed to post the notification
SELECT d.rendered_title, d.client_delivery_status, d.client_delivery_error, d.client_delivery_at
FROM notification_deliveries d
WHERE d.channel = 'vellum' AND d.client_delivery_status = 'client_failed'
ORDER BY d.created_at DESC;
```

## Conversational Preferences

Users express notification preferences in natural language during conversations (e.g., "Use Telegram for urgent alerts", "Mute notifications after 10pm"). The system:

1. **Detects** preferences via `preference-extractor.ts` -- an LLM call that runs on each user message in `conversation-process.ts`
2. **Stores** them in `notification_preferences` with structured conditions (`appliesWhen`: timeRange, channels, urgencyLevels, contexts) and a priority level (0=default, 1=override, 2=critical)
3. **Summarizes** them at decision time via `preference-summary.ts`, which builds a compact text block injected into the decision engine's system prompt

Preferences are sanitized against prompt injection (angle brackets replaced with harmless unicode equivalents).

## Configuration

The decision engine and preference extractor pick their per-call LLM config
from the unified `llm` block. Override defaults by setting either of:

| Key                                  | Type   | Default   | Description                                                                |
| ------------------------------------ | ------ | --------- | -------------------------------------------------------------------------- |
| `llm.callSites.notificationDecision` | object | _(unset)_ | Provider/model/effort/etc. override for the decision engine call site      |
| `llm.callSites.preferenceExtraction` | object | _(unset)_ | Provider/model/effort/etc. override for the preference extractor call site |

When a call site override is unset, the resolver falls back to the shipped call-site default profile.

The notification pipeline is always active -- signals are processed and dispatched as soon as the assistant is running. The audit trail (events, decisions, deliveries) is written for every signal.
