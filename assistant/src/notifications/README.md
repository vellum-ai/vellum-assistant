# Notification System

Signal-driven notification architecture where producers emit free-form events and an LLM-backed decision engine determines whether, where, and how to notify the user.

## Lifecycle

```
Producer → NotificationSignal → Decision Engine (LLM) → Deterministic Checks → Broadcaster → Adapters → Delivery
                                       ↑                                                        ↓
                               Preference Summary                              notification_intent IPC (vellum)
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

### 5. Broadcast and Delivery

The broadcaster (`broadcaster.ts`) iterates over selected channels, resolves destinations via `destination-resolver.ts`, pulls rendered copy from the decision (falling back to `copy-composer.ts` templates), and dispatches through channel adapters. Each delivery attempt is recorded in `notification_deliveries`.

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

The system supports two conversation materialization patterns:

### 1. Generic notifications (notification_intent IPC)

The standard pipeline emits `notification_intent` via the Vellum adapter. The decision engine can include `deepLinkTarget` metadata in the decision, which is passed through to the adapter as `deepLinkMetadata`. This allows the client to deep-link to an existing conversation or context without the daemon creating a new conversation.

### 2. Guardian dispatch (guardian_request_thread_created IPC)

The guardian dispatch (`calls/guardian-dispatch.ts`) creates a dedicated server-side conversation **before** entering the notification pipeline:

1. Creates a `guardian_action_request` row
2. Fires `emitNotificationSignal()` (fire-and-forget) for the LLM decision engine
3. Creates a conversation via `getOrCreateConversation()` with key `asst:${assistantId}:guardian:request:${request.id}`
4. Persists the LLM-generated initial message and thread title
5. Emits `guardian_request_thread_created` IPC event with `{ conversationId, requestId, callSessionId, title, questionText }`

The macOS `ThreadManager` listens for this event and creates a visible thread bound to the conversation.

### Conversation Pairing Invariant

For notification flows that create conversations (guardian dispatch, task runs), the conversation must be created **before** the IPC event is emitted. This ensures the macOS client can immediately fetch the conversation contents when it receives the thread-created event.

## Key Files

| File | Purpose |
|------|---------|
| `emit-signal.ts` | Single entry point for producers; orchestrates the full pipeline |
| `signal.ts` | `NotificationSignal` and `AttentionHints` type definitions |
| `types.ts` | Channel adapter interfaces, delivery types, decision output contract |
| `decision-engine.ts` | LLM-based routing with forced tool_choice; deterministic fallback |
| `deterministic-checks.ts` | Pre-send gate checks (dedupe, source-active, channel availability) |
| `runtime-dispatch.ts` | Dispatch gating (no-op decisions, empty channels) |
| `broadcaster.ts` | Fan-out to channel adapters with delivery audit trail |
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
- **`notification_deliveries`** -- per-channel delivery attempts with status (pending/sent/failed/skipped), rendered copy, and error details

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
