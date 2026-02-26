# Scheduling Architecture

Recurring schedules, watchers, and queued task execution architecture.

## Recurrence Schedules — Cron and RRULE Dual-Syntax Engine

The scheduler supports two recurrence syntaxes for recurring tasks:

- **Cron** — Standard 5-field cron expressions (e.g., `0 9 * * 1-5` for weekday mornings). Evaluated via the `croner` library.
- **RRULE** — iCalendar recurrence rules (RFC 5545). RRULE sets (multiple `RRULE` lines, `RDATE`/`EXDATE` exclusions) are parsed via `rrulestr` with `forceset: true`.

### Supported RRULE Lines

| Line | Purpose | Example |
|------|---------|---------|
| `DTSTART` | Start date/time anchor (required) | `DTSTART:20250101T090000Z` |
| `RRULE:` | Recurrence rule (one or more; multiple lines form a union) | `RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR` |
| `RDATE` | Add one-off dates not covered by the RRULE pattern | `RDATE:20250704T090000Z` |
| `EXDATE` | Exclude specific dates from the recurrence set | `EXDATE:20251225T090000Z` |
| `EXRULE` | Exclude an entire series defined by a recurrence pattern | `EXRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25` |

Bounded recurrence is supported via `COUNT` (e.g., `RRULE:FREQ=DAILY;COUNT=30`) and `UNTIL` (e.g., `RRULE:FREQ=WEEKLY;UNTIL=20250331T235959Z`) parameters on `RRULE` lines.

**Exclusion precedence:** EXDATE and EXRULE exclusions always take precedence over RRULE and RDATE inclusions. A date that matches both an inclusion and an exclusion is excluded.

### Syntax Detection

The `detectScheduleSyntax()` function auto-detects which syntax an expression uses by checking for RRULE markers (`RRULE:`, `DTSTART`, `FREQ=`). When creating or updating a schedule, the caller can explicitly specify `syntax: 'cron' | 'rrule'`, or the system infers it from the expression string via `normalizeScheduleSyntax()`.

### Legacy Compatibility

The database column is named `cron_expression` and the Drizzle table is `cronJobs` for migration compatibility. Code aliases `scheduleJobs` and `scheduleRuns` are preferred in new code. The legacy field names `cron_expression` and `cronExpression` remain supported in API inputs during the transition period. Both `expression` (new) and `cronExpression` (legacy) are accepted when creating or updating schedules.

### Key Source Files

| File | Responsibility |
|------|---------------|
| `assistant/src/schedule/recurrence-types.ts` | `ScheduleSyntax` type, `detectScheduleSyntax()`, `normalizeScheduleSyntax()` |
| `assistant/src/schedule/recurrence-engine.ts` | Validation (`isValidScheduleExpression`), next-run computation, RRULE set detection |
| `assistant/src/schedule/schedule-store.ts` | CRUD operations, claim-based polling, legacy `cronExpression` field support |
| `assistant/src/schedule/scheduler.ts` | 15-second tick loop, fires due schedules and reminders |
| `assistant/src/memory/schema.ts` | `cronJobs` / `scheduleJobs` table, `scheduleSyntax` column |

---

## Reminder Routing — Trigger-Time Multi-Channel Delivery

Reminders support optional routing metadata that controls how the notification pipeline fans out delivery across channels when a reminder fires. This allows a single reminder to reach the user on multiple channels (desktop, Telegram, SMS) without requiring duplicate reminders.

### Routing Metadata Model

Two columns on the `reminders` table carry routing metadata:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `routing_intent` | TEXT | `'single_channel'` | Controls channel coverage: `single_channel`, `multi_channel`, or `all_channels` |
| `routing_hints_json` | TEXT (JSON) | `'{}'` | Free-form hints for the decision engine (e.g. preferred channels) |

### Trigger-Time Data Flow

When the scheduler fires a reminder, routing metadata flows through the full notification pipeline:

```mermaid
sequenceDiagram
    participant Scheduler as Scheduler<br/>(15s tick)
    participant Store as ReminderStore<br/>(SQLite)
    participant Lifecycle as Daemon Lifecycle<br/>(notifyReminder)
    participant Signal as emitNotificationSignal
    participant Engine as Decision Engine<br/>(LLM)
    participant Enforce as enforceRoutingIntent
    participant Broadcaster as Broadcaster
    participant Adapters as Channel Adapters<br/>(Vellum, Telegram, SMS)

    Scheduler->>Store: claimDueReminders(now)
    Store-->>Scheduler: ReminderRow[] (with routingIntent, routingHints)
    Scheduler->>Lifecycle: notifyReminder({ id, label, message, routingIntent, routingHints })
    Lifecycle->>Signal: emitNotificationSignal({ routingIntent, routingHints, ... })
    Signal->>Engine: evaluateSignal(signal, connectedChannels)
    Engine-->>Signal: NotificationDecision (LLM channel selection)
    Signal->>Enforce: enforceRoutingIntent(decision, routingIntent, connectedChannels)
    Note over Enforce: Override channel selection<br/>based on routing intent
    Enforce-->>Signal: Enforced decision (re-persisted if changed)
    Signal->>Broadcaster: dispatchDecision(signal, decision)
    Broadcaster->>Adapters: Fan-out to each selected channel
```

### Enforcement Behavior

The `enforceRoutingIntent()` step runs after the LLM produces a channel selection but before deterministic checks. It acts as a post-decision guard:

| Intent | Enforcement Rule |
|--------|-----------------|
| `single_channel` | No override. The LLM's channel selection stands. |
| `multi_channel` | If the LLM selected < 2 channels and 2+ are connected, expand to at least two connected channels. |
| `all_channels` | Replace the LLM's selection with all connected channels. |

When enforcement changes the decision, the updated `selectedChannels` and annotated `reasoningSummary` are re-persisted to `notification_decisions` so the audit trail reflects what was actually dispatched.

### Single-Reminder Fanout

One reminder creates one notification signal. The routing intent on that single signal controls how many channels receive the notification. The notification pipeline handles per-channel copy rendering, conversation pairing, and delivery through existing adapters. No duplicate reminders are needed for multi-channel delivery.

### Connected Channels at Fire Time

Channel availability is resolved when the signal is emitted (not when the reminder is created):

- **Vellum** — always connected (local IPC)
- **Telegram** — connected when an active guardian binding exists
- **SMS** — connected when an active guardian binding exists

If a channel becomes unavailable between reminder creation and fire time, it is silently excluded from delivery. The routing intent enforcement operates only on channels that are connected at fire time.

### Key Source Files

| File | Responsibility |
|------|---------------|
| `assistant/src/tools/reminder/reminder-store.ts` | CRUD with `routingIntent` and `routingHints` fields |
| `assistant/src/memory/schema.ts` | `reminders` table schema with `routing_intent` and `routing_hints_json` columns |
| `assistant/src/schedule/scheduler.ts` | Claims due reminders and passes routing metadata to the notifier |
| `assistant/src/daemon/lifecycle.ts` | Wires the reminder notifier to `emitNotificationSignal()` with routing metadata |
| `assistant/src/notifications/emit-signal.ts` | Orchestrates the full pipeline including routing intent enforcement |
| `assistant/src/notifications/decision-engine.ts` | `enforceRoutingIntent()` post-decision guard |
| `assistant/src/notifications/signal.ts` | `RoutingIntent` type and `NotificationSignal` fields |

---

## Watcher System — Event-Driven Polling

Watchers poll external APIs on an interval, detect new events via watermark-based change tracking, and process them through a background LLM session.

```mermaid
graph TD
    subgraph "Scheduler (15s tick)"
        TICK["runScheduleOnce()"]
        CRON["Recurrence Schedules<br/>(cron + RRULE)"]
        REMIND["Reminders"]
        WATCH["runWatchersOnce()"]
    end

    subgraph "Watcher Engine"
        CLAIM["claimDueWatchers()"]
        POLL["provider.fetchNew()"]
        DEDUP["insertWatcherEvent()"]
        PROCESS["processMessage()"]
    end

    subgraph "Provider Registry"
        GMAIL["Gmail Provider"]
        SLACK_W["Slack Provider"]
        GCAL["Google Calendar Provider"]
        GH_W["GitHub Provider"]
        LINEAR_W["Linear Provider"]
        FUTURE["Future Providers..."]
    end

    subgraph "Disposition"
        SILENT["silent → log"]
        NOTIFY["notify → macOS notification"]
        ESCALATE["escalate → user chat"]
    end

    TICK --> CRON
    TICK --> REMIND
    TICK --> WATCH
    WATCH --> CLAIM
    CLAIM --> POLL
    POLL --> GMAIL
    POLL --> SLACK_W
    POLL --> GCAL
    POLL --> GH_W
    POLL --> LINEAR_W
    POLL --> FUTURE
    POLL --> DEDUP
    DEDUP --> PROCESS
    PROCESS --> SILENT
    PROCESS --> NOTIFY
    PROCESS --> ESCALATE
```

**Key design decisions:**

| Decision | Rationale |
|----------|-----------|
| Watermark-based polling | Efficient change detection without webhooks; each provider defines its own cursor format |
| Background conversations | LLM retains context across polls (e.g. "already replied to this thread"); invisible to user's chat |
| Circuit breaker (5 errors → disable) | Prevents runaway polling when credentials expire or APIs break |
| Provider interface | Extensible: implement `WatcherProvider` for any external API (Gmail, Stripe, Gong, Salesforce, etc.) |
| Optimistic claim locking | Prevents double-polling in concurrent scheduler ticks |

**Data tables:** `watchers` (config, watermark, status, error tracking) and `watcher_events` (detected events, dedup on `(watcher_id, external_id)`, disposition tracking).

## Task Queue — Queued Task Execution and Review

The Task Queue builds on top of the existing Tasks system to provide an ordered execution pipeline with human-in-the-loop review.

### Terminology

- **Task** — A reusable prompt template stored in the `tasks` table. Each Task has a title, a Handlebars template body, an optional JSON input schema, and can be executed many times (each execution creates a `task_runs` row). Tasks are the definition of something the assistant can do repeatedly — think of them as "Actions."
- **Task Queue** — An ordered list of Tasks queued up for execution and review. Each entry is a `work_items` row pointing to a Task template via `task_id`. The queue tracks run state through a defined lifecycle. "Awaiting review" means the Task ran and its output is ready for the user to inspect before being marked done.
- **WorkItem** — The backend name for a Task Queue entry. Maps 1:1 to a row in the `work_items` table.

### Data Model

The `work_items` table links to the existing `tasks` table and tracks execution state:

| Column | Type | Description |
|--------|------|-------------|
| `id` | text (PK) | Unique work item identifier |
| `task_id` | text (FK → `tasks`) | The Task template to execute |
| `title` | text | Display title (may differ from the Task's title) |
| `notes` | text | Optional user-provided notes or context |
| `status` | text | Lifecycle state (see below) |
| `priority_tier` | integer (0–3) | Priority bucket; lower = higher priority |
| `sort_index` | integer | Manual ordering within a priority tier |
| `last_run_id` | text | Most recent `task_runs.id` for this item |
| `last_run_conversation_id` | text | Conversation used by the last run |
| `last_run_status` | text | Status of the last run (`completed`, `failed`, etc.) |
| `source_type` | text | Reserved — origin type (e.g., `watcher`, `manual`) |
| `source_id` | text | Reserved — origin identifier |
| `created_at` | integer | Epoch ms |
| `updated_at` | integer | Epoch ms |

**Ordering:** `priority_tier ASC, sort_index ASC, updated_at DESC`. Items with a lower priority tier appear first; within a tier, manual `sort_index` controls order; ties broken by most-recently-updated.

### Status Lifecycle

```
queued → running → awaiting_review → done → archived
                 ↘ failed ↗
```

| Status | Meaning |
|--------|---------|
| `queued` | Waiting to be executed |
| `running` | Task is currently executing |
| `awaiting_review` | Task ran successfully; output is ready for user review |
| `failed` | Task execution failed (can be retried → `running`) |
| `done` | User reviewed and accepted the output |
| `archived` | Completed item moved out of active view |

### Data Flow

```mermaid
flowchart TD
    subgraph "Model Tools"
        TLA[task_list_add]
        TLU[task_list_update]
        TLS[task_list_show]
    end

    subgraph "Resolution"
        RWI[resolveWorkItem]
        DUPE[Duplicate Check<br/>findActiveWorkItemsByTitle]
    end

    subgraph "Store"
        WIS[work-item-store]
        DB[(SQLite)]
    end

    subgraph "Daemon IPC Handlers"
        HC[handleWorkItemCreate]
        HU[handleWorkItemUpdate]
        HCo[handleWorkItemComplete]
        HR[handleWorkItemRunTask]
        BC[tasks_changed broadcast]
    end

    subgraph "macOS Client"
        TW[TasksWindowView]
        DC[DaemonClient]
    end

    TLA -->|"if_exists check"| DUPE
    DUPE -->|"no match"| WIS
    DUPE -->|"match found → reuse/update"| TLU
    TLU --> RWI
    RWI --> WIS
    TLS --> WIS
    WIS --> DB

    HC --> WIS
    HU --> WIS
    HCo --> WIS
    HR --> WIS
    HC --> BC
    HU --> BC
    HCo --> BC
    HR --> BC

    BC -->|"via socket"| DC
    DC -->|"onTasksChanged"| TW
    TW -->|"debounced refetch (300ms)"| DC
```

**Key behaviors:**

- **`task_list_update`** uses `resolveWorkItem` to find the target work item by work item ID, task ID, or title (case-insensitive exact match). When multiple items match by task ID or title, the resolver applies a deterministic tie-break (lowest priority tier, then earliest `createdAt`).
- **`task_list_add`** has duplicate prevention via the `if_exists` parameter (default: `reuse_existing`). Before creating, it calls `findActiveWorkItemsByTitle` to check for active items with the same title. If a match is found, the tool either returns the existing item (`reuse_existing`), updates it in place (`update_existing`), or proceeds to create a duplicate (`create_duplicate`).
- **All daemon work-item handlers** (`handleWorkItemCreate`, `handleWorkItemUpdate`, `handleWorkItemComplete`, `handleWorkItemRunTask`) emit a `tasks_changed` broadcast after mutations via `ctx.broadcast({ type: 'tasks_changed' })`. They also emit the more specific `work_item_status_changed` with the affected item's current state.
- **The macOS Tasks window** (`TasksWindowView`) subscribes to both `tasks_changed` and `work_item_status_changed` callbacks on `DaemonClient`. Both trigger a debounced refetch (300ms) so rapid successive mutations coalesce into a single re-fetch.

### IPC Messages

**Client → Server:**

| Message | Purpose |
|---------|---------|
| `work_items_list` | List work items, filterable by status |
| `work_item_get` | Fetch a single work item with full details |
| `work_item_create` | Create a new work item pointing to a Task |
| `work_item_update` | Update title, notes, priority, or sort order |
| `work_item_complete` | Mark an item as `done` after review |
| `work_item_run_task` | Trigger execution of a queued work item |
| `work_item_delete` | Delete a work item from the queue |

**Server → Client (push):**

| Message | Purpose |
|---------|---------|
| `work_item_status_changed` | Notify the client when a work item transitions state (includes item snapshot) |
| `tasks_changed` | Lightweight broadcast after any work-item mutation; triggers client-side refetch |

### Run-Button State Machine

When the user clicks "Run" on a queued work item, the button follows a deterministic state machine:

```
idle (visible) → in-flight (hidden) → success/failure → re-enabled (via refetch)
```

**Sequence:**

1. **Idle** — The run button is visible only when `item.status == "queued"`. The `TasksWindowRow` renders it conditionally based on the `WorkItemStatus` enum.
2. **In-flight** — The client sends `work_item_run_task` with the work item ID. The daemon validates the request, sets the item's status to `running`, and returns `work_item_run_task_response` with `success: true`. It then broadcasts `work_item_status_changed` and `tasks_changed`. The client's debounced refetch picks up the `running` status, which hides the run button and shows a spinner in the status column.
3. **Completion** — The daemon executes the task asynchronously. On success, the item transitions to `awaiting_review`; on failure, to `failed`. Both trigger another `work_item_status_changed` + `tasks_changed` broadcast, which the client refetches and renders accordingly (showing a "Reviewed" button for `awaiting_review`, or the run button again for `failed` to allow retry).

**Error handling in `work_item_run_task_response`:**

The response includes a typed `errorCode` field (`WorkItemRunTaskErrorCode`) so the client can deterministically decide what to do without parsing error strings:

| `errorCode` | Meaning | Client behavior |
|-------------|---------|-----------------|
| `not_found` | Work item does not exist (deleted concurrently) | Refetch removes the stale row |
| `already_running` | Item is already executing | No-op; status column already shows spinner |
| `invalid_status` | Item is `done` or `archived` and cannot be run | Refetch updates the row to reflect terminal status |
| `no_task` | The associated Task template was deleted | Refetch; row may show an error state |

In all error cases, the subsequent `tasks_changed` broadcast triggers a refetch that brings the UI back to a consistent state, so the button is never stuck in a disabled/hidden state without a path to recovery.

### Delete Flow

Deletion uses optimistic UI with rollback:

1. **Optimistic removal** — `TasksWindowViewModel.removeTask()` snapshots the current `items` array, then immediately removes the target item with animation.
2. **IPC request** — Sends `work_item_delete` with the item ID. The daemon looks up the item; if found, deletes it and responds with `work_item_delete_response { success: true }`, then broadcasts `tasks_changed`.
3. **Failure rollback** — If the send throws (socket error), the view model restores the snapshot with animation. If the daemon responds with `success: false` (item not found), the `onWorkItemDeleteResponse` callback triggers a full refetch to reconcile.
