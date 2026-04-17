# Notification System

Signal-driven notification architecture where producers emit free-form events and an LLM-backed decision engine determines whether, where, and how to notify the user.

## Lifecycle

```
Producer → NotificationSignal → Candidate Generation → Decision Engine (LLM) → Deterministic Checks → Broadcaster → Conversation Pairing → Adapters → Delivery
                                                              ↑                                                            ↓
                                                      Preference Summary                                    notification_conversation_created SSE event
                                                      Conversation Candidates                               (creation-only — not emitted on reuse)
```

### 1. Signal

A producer calls `emitNotificationSignal()` with a free-form event name, attention hints (urgency, requiresAction, deadlineAt), and a context payload. The signal is persisted as a `notification_events` row.

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

- **Guardian question request-code enforcement** — `enforceGuardianRequestCode()` ensures request-code instructions (approve/reject or free-text answer) appear in all `guardian.question` notification copy, even when the LLM omits them.
- **Access-request instruction enforcement** — `enforceAccessRequestInstructions()` validates that `ingress.access_request` copy contains: (1) the request-code approve/reject directive, (2) the exact "open invite flow" phrase. If any required element is missing, the full deterministic contract text is appended. This prevents model-generated copy from dropping security-critical action directives.

**Pre-send gate checks** (`deterministic-checks.ts`):

- **Schema validity** -- fail-closed if the decision is malformed
- **Source-active suppression** -- if the user is already viewing the source context, suppress
- **Channel availability** -- at least one selected channel must be connected
- **Deduplication** -- same `dedupeKey` within the dedupe window (1 hour default) is suppressed

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

| Strategy                         | Behavior                                                                                                                                                                                                                                     | Used by                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `start_new_conversation`         | Creates a fresh conversation per delivery. The conversation is surfaced via SSE.                                                                                                                                                             | `vellum`                                 |
| `continue_existing_conversation` | Looks up a previously bound conversation by binding key (sourceChannel + externalChatId) and appends to it. When no bound conversation exists (first delivery to a destination), creates a new one and upserts the binding for future reuse. | `telegram`, `whatsapp`, `slack`, `email` |
| `not_deliverable`                | Channel cannot receive notifications. Pairing returns null IDs.                                                                                                                                                                              | `phone`                                  |

### Helper Functions

- `getDeliverableChannels()` -- returns all `ChannelId` values where `deliveryEnabled` is true
- `getChannelPolicy(channelId)` -- returns the full policy object for a channel
- `isNotificationDeliverable(channelId)` -- boolean check for delivery eligibility
- `getConversationStrategy(channelId)` -- returns the conversation strategy for a channel

### How to Add a New Channel

1. Add the channel to `CHANNEL_IDS` in `channels/types.ts`.
2. Add a policy entry in `CHANNEL_POLICIES` in `channels/config.ts`. The compiler will enforce this.
3. If `deliveryEnabled: true`, add an adapter in `adapters/` and register it in `emit-signal.ts` `getBroadcaster()`.
4. Add a connectivity check in `getConnectedChannels()` in `emit-signal.ts`.
5. Add a destination resolver case in `destination-resolver.ts`.

## Conversation Pairing Invariant

**Every notification delivery gets a conversation.** Before the adapter sends a notification, `pairDeliveryWithConversation()` (in `conversation-pairing.ts`) materializes a conversation and seed message based on the channel's conversation strategy and the decision engine's per-channel conversation action:

### Conversation Reuse Path (`reuse_existing`)

When the decision engine selects `reuse_existing` for a channel with a valid candidate `conversationId`:

1. The pairing function looks up the target conversation.
2. If the conversation exists and has `source: 'notification'`, the seed message is **appended** to the existing conversation (not a new one). The result has `createdNewConversation: false`.
3. If the target is invalid (does not exist, or has a different `source`), the function falls back to creating a new conversation and sets `conversationFallbackUsed: true` on the result. A warning is logged with the invalid target details.

### New Conversation Path (`start_new` / default)

- **`start_new_conversation`**: Creates a new conversation with `conversationType: 'standard'` and `source: 'notification'`, plus an assistant message containing the conversation seed. Memory indexing is skipped on the seed message to prevent notification copy from polluting conversational recall. The result has `createdNewConversation: true`.
- **`continue_existing_conversation`**: Looks up a previously bound conversation by binding key (`sourceChannel` + `externalChatId` via `getBindingByChannelChat()`). When a valid bound conversation with `source: 'notification'` exists, the seed message is appended to it and the binding timestamp is refreshed. When no binding exists or the bound conversation is stale/invalid, a new conversation is created and the binding is upserted for future reuse. The result has `createdNewConversation: false` on reuse, `true` on fresh creation.
- **`not_deliverable`**: Returns `{ conversationId: null, messageId: null }`.

The pairing function is resilient -- errors are caught and logged. A pairing failure never breaks the delivery pipeline.

## Multi-Surface Copy Architecture

The system produces **three distinct copy outputs** per notification:

| Output                    | Purpose                                          | Verbosity                |
| ------------------------- | ------------------------------------------------ | ------------------------ |
| `title` + `body`          | Native notification popup (macOS/iOS banner)     | Short and glanceable     |
| `deliveryText`            | Channel-native chat message text (Telegram)      | Natural chat phrasing    |
| Conversation seed message | Opening message in the notification conversation | Richer and context-aware |

### How It Works

1. The **decision engine** can produce `title`/`body` (popup copy), `deliveryText` (chat copy), and `conversationSeedMessage` (richer conversation content) per channel.
2. **Adapters** use the surface-appropriate field:
   - Vellum/macOS notifications use `title` + `body`.
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

The `notification_conversation_created` SSE event is emitted **only when a brand-new conversation is actually created** by the broadcaster. Reused conversations do not trigger this event — the macOS/iOS client already knows about the conversation from the original creation.

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

When a vellum notification conversation **is** newly created (strategy `start_new_conversation`), the broadcaster emits the SSE event **immediately**, before waiting for slower channel deliveries (e.g. Telegram). This avoids a race where a slow Telegram delivery delays the broadcast past the macOS deep-link retry window.

The SSE event payload:

```ts
{
  type: 'notification_conversation_created',
  conversationId: string,
  title: string,
  sourceEventName: string,
}
```

The macOS/iOS client listens for this event and surfaces the conversation in the sidebar, enabling deep-link navigation to the notification conversation.

### Per-Dispatch Conversation Callback

`emitNotificationSignal()` accepts an optional `onConversationCreated` callback (`options.onConversationCreated`). This lets producers run domain side effects (for example, creating cross-channel guardian delivery rows) as soon as vellum pairing occurs, without introducing a second conversation-creation path.

**Important distinction between the two callbacks:**

- **Per-dispatch `options.onConversationCreated`**: Fires for **both** new and reused vellum conversation pairings. Callers like `dispatchGuardianQuestion` rely on this to create delivery bookkeeping rows before `emitNotificationSignal()` returns, regardless of whether the conversation was newly created or reused.
- **Class-level `this.onConversationCreated` (SSE broadcast)**: Fires **only** when a brand-new conversation is created (`createdNewConversation === true && strategy === 'start_new_conversation'`). This emits the `notification_conversation_created` SSE event so macOS/iOS clients surface the new conversation in the sidebar. Reused conversations do not trigger this event because the client already knows about the conversation.

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
Schedule fires (scheduler.ts: notify mode)
  → notifyScheduleOneShot callback (lifecycle.ts)
    → emitNotificationSignal({ routingIntent, routingHints })
      → Decision Engine (LLM selects channels)
        → enforceRoutingIntent() (post-decision guard)
          → Deterministic Checks
            → Broadcaster → Adapters → Delivery
```

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
  → scheduler.ts: claimDueSchedules() reads routing metadata
    → lifecycle.ts: notifyScheduleOneShot({ routingIntent, routingHints })
      → emitNotificationSignal({ routingIntent, routingHints })
        → signal.ts: NotificationSignal.routingIntent / routingHints
          → decision-engine.ts: evaluateSignal() → enforceRoutingIntent()
            → broadcaster.ts: fan-out to selected channel adapters
```

## Channel Delivery Architecture

The notification system delivers to three channel types:

### Vellum (always connected)

Local SSE via the daemon's broadcast mechanism. The `VellumAdapter` emits a `notification_intent` message containing:

- `sourceEventName` -- the event that triggered the notification
- `title` and `body` -- rendered notification copy
- `deepLinkMetadata` -- optional metadata for navigating to the relevant context (e.g. `{ conversationId }`)

The macOS/iOS client posts a native `UNUserNotificationCenter` notification from this payload. When the user taps the notification, the client uses `deepLinkMetadata` to navigate to the relevant conversation.

### Telegram (when guardian binding exists)

HTTP POST to the gateway's `/deliver/telegram` endpoint. The `TelegramAdapter` sends channel-native text (`deliveryText` when present) to the guardian's chat ID (resolved from the active guardian binding), with deterministic fallbacks when model copy is unavailable.

### Channel Connectivity

Connected channels are resolved at signal emission time by `getConnectedChannels()` in `emit-signal.ts`:

- **Vellum** is always considered connected (HTTP transport is always available when the daemon is running)
- **Telegram** is considered connected only when an active guardian binding exists for the assistant (checked via `getActiveBinding()`)

## Conversation Materialization

The system uses a single conversation materialization path for **all** notifications -- there are no legacy bypass paths or dual-broadcast mechanisms. Every notification, including guardian questions and ingress escalation alerts, flows through `emitNotificationSignal()`:

1. `emitNotificationSignal()` evaluates the signal and dispatches to channels.
2. `NotificationBroadcaster` pairs each delivery with a conversation via `pairDeliveryWithConversation()`, executing the per-channel conversation action (start_new or reuse_existing).
3. For vellum deliveries, the broadcaster merges `conversationId` into `deepLinkMetadata` and emits `notification_conversation_created` only when a new conversation was created (not on reuse).

Guardian dispatch follows this same path and uses the optional `onConversationCreated` callback to attach guardian-delivery bookkeeping to the canonical vellum conversation.

### Conversation Pairing Invariant

For notification flows that create conversations, the conversation must be created **before** the SSE event is emitted. This ensures the macOS client can immediately fetch the conversation contents when it receives the conversation-created event.

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

Each `guardian_action_request` is assigned a unique 6-character hex code (e.g. `A1B2C3`) at creation time by `generateRequestCode()` in `guardian-action-store.ts`. The code is included in the notification copy delivered to the guardian.

### Disambiguation Flow

The disambiguation logic is identical on all channels — mac/vellum (`conversation-process.ts`) and Telegram (`inbound-message-handler.ts`):

1. **Single pending delivery in the conversation**: The guardian's reply is matched to the sole pending request automatically. No request code prefix is needed. This is the **single-match fast path**.

2. **Multiple pending deliveries in the conversation**: The guardian must prefix their reply with the request code of the question they are answering (e.g. `A1B2C3 yes, allow it`). Matching is case-insensitive.

3. **No code match**: If the guardian's reply does not start with any active request code, a **disambiguation message** is sent back listing all active request codes so the guardian can retry with the correct prefix.

### Channel Parity

The disambiguation invariant is enforced identically across:

- **Mac/Vellum** (`conversation-process.ts`): Intercepts user messages in conversations with pending guardian action deliveries before the agent loop runs.
- **Telegram** (`inbound-message-handler.ts`): Intercepts inbound messages matched to conversations with pending guardian action deliveries.

All three paths use the same pattern: look up pending deliveries by conversation, apply single-match fast path or request-code prefix matching, and send disambiguation messages via the guardian action message composer when ambiguous.

### Disambiguation Message Generation

All disambiguation messages are generated through `composeGuardianActionMessageGenerative()` in `guardian-action-message-composer.ts`, which uses a 2-tier priority chain (LLM generator with deterministic fallback). Three disambiguation scenarios exist:

| Scenario                           | When triggered                                         |
| ---------------------------------- | ------------------------------------------------------ |
| `guardian_disambiguation`          | Multiple pending approval requests in a conversation   |
| `guardian_expired_disambiguation`  | Multiple expired requests with late replies            |
| `guardian_followup_disambiguation` | Multiple follow-up deliveries awaiting guardian action |

## Key Files

| File                            | Purpose                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `../channels/config.ts`         | Channel policy registry -- single source of truth for per-channel notification behavior                    |
| `emit-signal.ts`                | Single entry point for producers; orchestrates the full pipeline                                           |
| `signal.ts`                     | `NotificationSignal` and `AttentionHints` type definitions                                                 |
| `types.ts`                      | Channel adapter interfaces, delivery types, decision output contract, `ConversationAction` union           |
| `conversation-candidates.ts`    | Builds per-channel candidate set of recent notification conversations for the decision engine              |
| `conversation-pairing.ts`       | Materializes conversation + message per delivery based on channel strategy                                 |
| `decision-engine.ts`            | LLM-based routing with forced tool_choice; deterministic fallback                                          |
| `deterministic-checks.ts`       | Pre-send gate checks (dedupe, source-active, channel availability)                                         |
| `runtime-dispatch.ts`           | Dispatch gating (no-op decisions, empty channels)                                                          |
| `broadcaster.ts`                | Fan-out to channel adapters with delivery audit trail; emits `notification_conversation_created` SSE event |
| `copy-composer.ts`              | Template-based fallback notification copy when LLM copy is unavailable                                     |
| `conversation-seed-composer.ts` | Surface-aware conversation seed generation (richer than notification copy)                                 |
| `destination-resolver.ts`       | Resolves per-channel endpoints (vellum SSE, Telegram chat ID)                                              |
| `adapters/macos.ts`             | Vellum adapter -- broadcasts `notification_intent` via SSE with deep-link metadata                         |
| `adapters/telegram.ts`          | Telegram adapter -- POSTs to gateway `/deliver/telegram`                                                   |
| `preference-extractor.ts`       | Detects notification preferences in conversation messages                                                  |
| `preference-summary.ts`         | Builds preference context string for the decision engine prompt                                            |
| `preferences-store.ts`          | CRUD for `notification_preferences` table                                                                  |
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

## How to Add a New Channel

1. Add the channel to `CHANNEL_IDS` in `channels/types.ts`.
2. Create an adapter in `adapters/` implementing the `ChannelAdapter` interface.
3. Register the adapter in `emit-signal.ts` `getBroadcaster()`.
4. Add a connectivity check in `getConnectedChannels()` in `emit-signal.ts`.
5. Add a destination resolver case in `destination-resolver.ts`.
6. Add the channel to the `NotificationChannel` union in `types.ts`.

## Audit Trail

Three SQLite tables form the audit chain:

- **`notification_events`** -- every signal that entered the pipeline, with attention hints and context payload
- **`notification_decisions`** -- the routing decision for each event (shouldNotify, selectedChannels, reasoning, confidence, whether fallback was used)
- **`notification_deliveries`** -- per-channel delivery attempts with status (pending/sent/failed/skipped), rendered copy, error details, conversation pairing data (`conversation_id`, `message_id`, `conversation_strategy`), and client delivery outcome (`client_delivery_status`, `client_delivery_error`, `client_delivery_at`)

### Client Delivery Ack

For vellum (macOS/iOS) deliveries, the audit trail now extends past the SSE broadcast to the actual OS notification post. The `notification_intent` message carries an optional `deliveryId` that the client echoes back in a `notification_intent_result` ack after `UNUserNotificationCenter.add()` completes (or fails).

The ack populates three columns on `notification_deliveries`:

| Column                   | Type    | Description                                                                    |
| ------------------------ | ------- | ------------------------------------------------------------------------------ |
| `client_delivery_status` | TEXT    | `'delivered'` if the OS accepted the notification, `'client_failed'` otherwise |
| `client_delivery_error`  | TEXT    | Error description when the post failed (e.g. authorization denied)             |
| `client_delivery_at`     | INTEGER | Epoch ms timestamp of when the client reported the outcome                     |

This means the audit trail can now answer three questions for each vellum delivery:

1. **Was the intent broadcast?** -- existing `status` column (`sent`)
2. **Did the client attempt to post?** -- `client_delivery_status` is non-null
3. **Did the OS post succeed or fail, and why?** -- `client_delivery_status` + `client_delivery_error`

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

| Key                                  | Type    | Default        | Description                                                                 |
| ------------------------------------ | ------- | -------------- | --------------------------------------------------------------------------- |
| `llm.callSites.notificationDecision` | object  | _(unset)_      | Provider/model/effort/etc. override for the decision engine call site       |
| `llm.callSites.preferenceExtraction` | object  | _(unset)_      | Provider/model/effort/etc. override for the preference extractor call site  |

When a call site override is unset, the resolver falls back to `llm.default`.

The notification pipeline is always active -- signals are processed and dispatched as soon as the daemon is running. The audit trail (events, decisions, deliveries) is written for every signal.
