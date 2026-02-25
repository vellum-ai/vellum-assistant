# Notification System

Signal-driven notification architecture where producers emit free-form events and an LLM-backed decision engine determines whether, where, and how to notify the user.

## Lifecycle

```
Producer → NotificationSignal → Decision Engine (LLM) → Deterministic Checks → Broadcaster → Conversation Pairing → Adapters → Delivery
                                       ↑                                                            ↓
                               Preference Summary                                    notification_thread_created IPC
```

### 1. Signal

A producer calls `emitNotificationSignal()` with a free-form event name, attention hints (urgency, requiresAction, deadlineAt), and a context payload. The signal is persisted as a `notification_events` row.

### 2. Decision

The decision engine (`decision-engine.ts`) sends the signal to an LLM (configured via `notifications.decisionModelIntent`) along with available channels and the user's preference summary. The LLM responds with a structured decision: whether to notify, which channels, rendered copy per channel, and a deduplication key.

When the LLM is unavailable or returns invalid output, a deterministic fallback fires: high-urgency + requires-action signals notify on all channels; everything else is suppressed.

### 3. Deterministic Checks

Hard invariants that the LLM cannot override (`deterministic-checks.ts`):

- **Schema validity** -- fail-closed if the decision is malformed
- **Source-active suppression** -- if the user is already viewing the source context, suppress
- **Channel availability** -- at least one selected channel must be connected
- **Deduplication** -- same `dedupeKey` within the dedupe window (1 hour default) is suppressed

### 4. Dispatch

`runtime-dispatch.ts` handles two early-exit cases (shouldNotify=false, no channels), then delegates to the broadcaster.

### 5. Broadcast, Conversation Pairing, and Delivery

The broadcaster (`broadcaster.ts`) iterates over selected channels (vellum first for fast IPC push), resolves destinations via `destination-resolver.ts`, pairs each delivery with a conversation via `conversation-pairing.ts`, pulls rendered copy from the decision (falling back to `copy-composer.ts` templates), and dispatches through channel adapters. Each delivery attempt is recorded in `notification_deliveries` with `conversation_id`, `message_id`, and `conversation_strategy` columns.

## Channel Policy Registry

`../channels/config.ts` is the **single source of truth** for per-channel notification behavior. Every `ChannelId` must have an entry in the `CHANNEL_POLICIES` map. The TypeScript `satisfies Record<ChannelId, ChannelNotificationPolicy>` constraint ensures that adding a new `ChannelId` to `channels/types.ts` will cause a compile error until a policy entry is added.

Each policy defines:

| Field | Type | Description |
|-------|------|-------------|
| `notification.deliveryEnabled` | `boolean` | Whether the channel can receive notification deliveries |
| `notification.conversationStrategy` | `ConversationStrategy` | How conversations are materialized for deliveries on this channel |

### Conversation Strategy Types

| Strategy | Behavior | Used by |
|----------|----------|---------|
| `start_new_conversation` | Creates a fresh conversation per delivery. The thread is surfaced via IPC. | `vellum` |
| `continue_existing_conversation` | Appends to an existing channel-scoped conversation (future: lookup by binding key). Currently materializes a background audit conversation per delivery and records the intended strategy. | `telegram`, `sms`, `whatsapp`, `slack`, `email` |
| `not_deliverable` | Channel cannot receive notifications. Pairing returns null IDs. | `voice` |

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

**Every notification delivery gets a conversation.** Before the adapter sends a notification, `pairDeliveryWithConversation()` (in `conversation-pairing.ts`) materializes a conversation and seed message based on the channel's conversation strategy:

- **`start_new_conversation`**: Creates a new conversation with `threadType: 'standard'` and `source: 'notification'`, plus an assistant message containing the notification copy. Memory indexing is skipped on the seed message to prevent notification copy from polluting conversational recall.
- **`continue_existing_conversation`**: Currently materializes a background audit conversation per delivery (true continuation via binding key lookup is planned for a future PR). The audit trail records the intended strategy without adding visible sidebar threads.
- **`not_deliverable`**: Returns `{ conversationId: null, messageId: null }`.

The pairing function is resilient -- errors are caught and logged. A pairing failure never breaks the delivery pipeline.

## Thread Surfacing via `notification_thread_created` IPC

When a vellum notification thread is paired with a conversation (strategy `start_new_conversation`), the broadcaster emits a `notification_thread_created` IPC event **immediately**, before waiting for slower channel deliveries (e.g. Telegram). This avoids a race where a slow Telegram delivery delays the IPC push past the macOS deep-link retry window.

The IPC event payload:

```ts
{
  type: 'notification_thread_created',
  conversationId: string,
  title: string,
  sourceEventName: string,
}
```

The macOS/iOS client listens for this event and surfaces the thread in the sidebar, enabling deep-link navigation to the notification thread.

### Per-Dispatch Thread Callback

`emitNotificationSignal()` accepts an optional `onThreadCreated` callback. This lets producers run domain side effects (for example, creating cross-channel guardian delivery rows) as soon as vellum pairing occurs, without introducing a second thread-creation path.

## Channel Delivery Architecture

The notification system delivers to two channel types:

### Vellum (always connected)

Local IPC via the daemon's broadcast mechanism. The `VellumAdapter` emits a `notification_intent` message containing:

- `sourceEventName` -- the event that triggered the notification
- `title` and `body` -- rendered notification copy
- `deepLinkMetadata` -- optional metadata for navigating to the relevant context (e.g. `{ conversationId }`)

The macOS/iOS client posts a native `UNUserNotificationCenter` notification from this payload. When the user taps the notification, the client uses `deepLinkMetadata` to navigate to the relevant thread.

### Telegram (when guardian binding exists)

HTTP POST to the gateway's `/deliver/telegram` endpoint. The `TelegramAdapter` formats the notification copy as plain text and sends it to the guardian's chat ID (resolved from the active guardian binding).

### Channel Connectivity

Connected channels are resolved at signal emission time by `getConnectedChannels()` in `emit-signal.ts`:

- **Vellum** is always considered connected (IPC socket is always available when the daemon is running)
- **Telegram** is considered connected only when an active guardian binding exists for the assistant (checked via `getActiveBinding()`)

## Conversation Materialization

The system uses a single conversation materialization path for all notifications, including ASK_GUARDIAN:

1. `emitNotificationSignal()` evaluates the signal and dispatches to channels.
2. `NotificationBroadcaster` pairs each delivery with a conversation via `pairDeliveryWithConversation()`.
3. For vellum deliveries, the broadcaster merges `conversationId` into `deepLinkMetadata` and emits `notification_thread_created`.

Guardian dispatch follows this same path and uses the optional `onThreadCreated` callback to attach guardian-delivery bookkeeping to the canonical vellum conversation.

### Conversation Pairing Invariant

For notification flows that create conversations, the conversation must be created **before** the IPC event is emitted. This ensures the macOS client can immediately fetch the conversation contents when it receives the thread-created event.

## Key Files

| File | Purpose |
|------|---------|
| `../channels/config.ts` | Channel policy registry -- single source of truth for per-channel notification behavior |
| `emit-signal.ts` | Single entry point for producers; orchestrates the full pipeline |
| `signal.ts` | `NotificationSignal` and `AttentionHints` type definitions |
| `types.ts` | Channel adapter interfaces, delivery types, decision output contract |
| `conversation-pairing.ts` | Materializes conversation + message per delivery based on channel strategy |
| `decision-engine.ts` | LLM-based routing with forced tool_choice; deterministic fallback |
| `deterministic-checks.ts` | Pre-send gate checks (dedupe, source-active, channel availability) |
| `runtime-dispatch.ts` | Dispatch gating (no-op decisions, empty channels) |
| `broadcaster.ts` | Fan-out to channel adapters with delivery audit trail; emits `notification_thread_created` IPC |
| `copy-composer.ts` | Template-based fallback copy when LLM copy is unavailable |
| `destination-resolver.ts` | Resolves per-channel endpoints (vellum IPC, Telegram chat ID) |
| `adapters/macos.ts` | Vellum adapter -- broadcasts `notification_intent` via IPC with deep-link metadata |
| `adapters/telegram.ts` | Telegram adapter -- POSTs to gateway `/deliver/telegram` |
| `preference-extractor.ts` | Detects notification preferences in conversation messages |
| `preference-summary.ts` | Builds preference context string for the decision engine prompt |
| `preferences-store.ts` | CRUD for `notification_preferences` table |
| `events-store.ts` | CRUD for `notification_events` table |
| `decisions-store.ts` | CRUD for `notification_decisions` table |
| `deliveries-store.ts` | CRUD for `notification_deliveries` table |

## How to Add a New Notification Producer

1. Import `emitNotificationSignal` from `./emit-signal.js`.
2. Call it with the signal parameters:

```ts
import { emitNotificationSignal } from '../notifications/emit-signal.js';

await emitNotificationSignal({
  sourceEventName: 'your_event_name',
  sourceChannel: 'scheduler',       // where the event originated
  sourceSessionId: sessionId,
  attentionHints: {
    requiresAction: true,
    urgency: 'high',
    isAsyncBackground: false,
    visibleInSourceNow: false,
  },
  contextPayload: { /* arbitrary data for the decision engine */ },
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

For vellum (macOS/iOS) deliveries, the audit trail now extends past the IPC broadcast to the actual OS notification post. The `notification_intent` message carries an optional `deliveryId` that the client echoes back in a `notification_intent_result` ack after `UNUserNotificationCenter.add()` completes (or fails).

The ack populates three columns on `notification_deliveries`:

| Column | Type | Description |
|--------|------|-------------|
| `client_delivery_status` | TEXT | `'delivered'` if the OS accepted the notification, `'client_failed'` otherwise |
| `client_delivery_error` | TEXT | Error description when the post failed (e.g. authorization denied) |
| `client_delivery_at` | INTEGER | Epoch ms timestamp of when the client reported the outcome |

When the client reports `errorCode: "authorization_denied"` for a vellum
delivery, the daemon appends an assistant fallback note to the paired
notification conversation. This keeps the failure visible in the same thread
even when the native macOS banner cannot be shown.

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

1. **Detects** preferences via `preference-extractor.ts` -- an LLM call that runs on each user message in `session-process.ts`
2. **Stores** them in `notification_preferences` with structured conditions (`appliesWhen`: timeRange, channels, urgencyLevels, contexts) and a priority level (0=default, 1=override, 2=critical)
3. **Summarizes** them at decision time via `preference-summary.ts`, which builds a compact text block injected into the decision engine's system prompt

Preferences are sanitized against prompt injection (angle brackets replaced with harmless unicode equivalents).

## Configuration

All settings live under the `notifications` key in `config.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `notifications.decisionModelIntent` | string | `"latency-optimized"` | Model intent used for both the decision engine and preference extraction |

The notification pipeline is always active -- signals are processed and dispatched as soon as the daemon is running. The audit trail (events, decisions, deliveries) is written for every signal.
