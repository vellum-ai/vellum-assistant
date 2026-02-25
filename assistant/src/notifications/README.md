# Notification System

Signal-driven notification architecture where producers emit free-form events and an LLM-backed decision engine determines whether, where, and how to notify the user.

## Lifecycle

```
Producer → NotificationSignal → Decision Engine (LLM) → Deterministic Checks → Broadcaster → Adapters → Delivery
                                       ↑
                               Preference Summary
```

### 1. Signal

A producer calls `emitNotificationSignal()` with a free-form event name, attention hints (urgency, requiresAction, deadlineAt), and a context payload. The signal is persisted as a `notification_events` row.

### 2. Decision

The decision engine (`decision-engine.ts`) sends the signal to an LLM (configured via `notifications.decisionModel`) along with available channels and the user's preference summary. The LLM responds with a structured decision: whether to notify, which channels, rendered copy per channel, and a deduplication key.

When the LLM is unavailable or returns invalid output, a deterministic fallback fires: high-urgency + requires-action signals notify on all channels; everything else is suppressed.

### 3. Deterministic Checks

Hard invariants that the LLM cannot override (`deterministic-checks.ts`):

- **Schema validity** -- fail-closed if the decision is malformed
- **Source-active suppression** -- if the user is already viewing the source context, suppress
- **Channel availability** -- at least one selected channel must be connected
- **Deduplication** -- same `dedupeKey` within the dedupe window (1 hour default) is suppressed

### 4. Dispatch

`runtime-dispatch.ts` handles three early-exit cases (shouldNotify=false, shadow mode, no channels), then delegates to the broadcaster.

### 5. Broadcast and Delivery

The broadcaster (`broadcaster.ts`) iterates over selected channels, resolves destinations via `destination-resolver.ts`, pulls rendered copy from the decision (falling back to `copy-composer.ts` templates), and dispatches through channel adapters. Each delivery attempt is recorded in `notification_deliveries`.

## Key Files

| File | Purpose |
|------|---------|
| `emit-signal.ts` | Single entry point for producers; orchestrates the full pipeline |
| `signal.ts` | `NotificationSignal` and `AttentionHints` type definitions |
| `types.ts` | Channel adapter interfaces, delivery types, decision output contract |
| `decision-engine.ts` | LLM-based routing with forced tool_choice; deterministic fallback |
| `deterministic-checks.ts` | Pre-send gate checks (dedupe, source-active, channel availability) |
| `runtime-dispatch.ts` | Dispatch gating (shadow mode, no-op decisions) |
| `broadcaster.ts` | Fan-out to channel adapters with delivery audit trail |
| `copy-composer.ts` | Template-based fallback copy when LLM copy is unavailable |
| `destination-resolver.ts` | Resolves per-channel endpoints (macOS IPC, Telegram chat ID) |
| `adapters/macos.ts` | macOS adapter -- broadcasts `notification_intent` via IPC |
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
| `notifications.enabled` | boolean | `false` | Master switch for the notification pipeline |
| `notifications.shadowMode` | boolean | `true` | When true, decisions are logged but not dispatched |
| `notifications.decisionModel` | string | `"claude-haiku-4-5-20251001"` | Model used for both the decision engine and preference extraction |

Shadow mode is useful for validating decision quality before enabling live delivery. The audit trail (events + decisions) is written regardless of shadow mode.
