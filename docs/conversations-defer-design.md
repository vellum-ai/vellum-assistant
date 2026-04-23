# Conversations Defer — Design Doc

> **Status:** Draft  
> **Author:** Credence  
> **Date:** April 23, 2026

## Problem

The assistant (LLM) needs a way to schedule future work on the **current conversation** without blocking it. The primary use case is orchestrating Claude Code sessions: after kicking off a task, the assistant should be able to say "check back on this in 60 seconds" and then resume the conversation with full context when the timer fires.

Today, the assistant's options are:

1. **`sleep N` in a bash tool call** — blocks the entire conversation; the user can't interact
2. **Forget and wait for the user to ask** — defeats the purpose of autonomous orchestration
3. **Create a one-shot schedule** — fires into a **new** background conversation, losing all context about what was being monitored and why

None of these work. The assistant needs a first-class primitive for **deferred self-wakes**: "wake me back up on *this* conversation in N seconds with this hint."

## Solution

Extend the existing one-shot schedule system with a new `wake` mode that targets an existing conversation via `wakeAgentForOpportunity()` instead of bootstrapping a new one.

### Why extend schedules (not a new system)

The scheduler already provides everything a deferred wake needs:

- **15-second tick loop** — checks for due jobs, good enough for the ±15s jitter tolerance of polling use cases
- **Atomic claiming** — `status: active → firing` prevents double-fires
- **One-shot lifecycle** — auto-disables after firing, retries on failure, supports cancellation
- **SQLite persistence** — survives assistant restarts
- **Run tracking** — `cron_runs` table records execution history

Building a parallel `deferred_wakes` table would duplicate all of this infrastructure for no benefit.

## Schema Change

Add one nullable column to `cron_jobs`:

```sql
ALTER TABLE cron_jobs ADD COLUMN wake_conversation_id TEXT;
```

- `NULL` for all existing schedules (notify, execute, script modes)
- Set only when `mode = 'wake'`
- References a conversation ID; **not** a foreign key (conversations may be deleted before the wake fires — that's a graceful no-op, not an error)

Add `'wake'` to the `mode` column's valid values (currently `notify | execute | script`).

### Drizzle schema update

In `assistant/src/memory/schema/infrastructure.ts`, add to the `cronJobs` table:

```ts
wakeConversationId: text("wake_conversation_id"), // only set when mode = 'wake'
```

## Scheduler Change

In `assistant/src/schedule/scheduler.ts` → `runScheduleOnce()`, add a new mode branch **before** the execute-mode block:

```ts
// ── Wake mode (deferred conversation wake) ──────────────────────
if (job.mode === "wake") {
  const wakeConversationId = job.wakeConversationId;
  if (!wakeConversationId) {
    log.warn(
      { jobId: job.id, name: job.name },
      "Wake schedule has no target conversation — skipping",
    );
    if (isOneShot) completeOneShot(job.id);
    processed += 1;
    continue;
  }

  try {
    log.info(
      { jobId: job.id, name: job.name, wakeConversationId, isOneShot },
      "Firing deferred wake",
    );
    const result = await wakeAgentForOpportunity({
      conversationId: wakeConversationId,
      hint: job.message,
      source: "defer",
    });

    if (isOneShot) {
      // Wake completed (even if conversation was not found — that's
      // a graceful no-op, not a retryable failure)
      completeOneShot(job.id);
    }

    if (!job.quiet) {
      emitScheduleFeedEvent({
        title: job.name,
        summary: result.invoked
          ? "Deferred wake fired."
          : `Wake skipped: ${result.reason ?? "unknown"}.`,
        dedupKey: `schedule-wake:${job.id}`,
      });
    }
  } catch (err) {
    log.warn(
      { err, jobId: job.id, name: job.name, wakeConversationId, isOneShot },
      "Deferred wake failed",
    );
    if (isOneShot) failOneShot(job.id);
  }
  processed += 1;
  continue;
}
```

### Key design decisions

1. **Conversation-not-found = complete, not fail.** If the conversation was deleted or archived before the wake fires, we mark it complete. Retrying is pointless — the conversation isn't coming back.

2. **Conversation-busy = complete (wake queues internally).** `wakeAgentForOpportunity` already handles concurrency — if a user turn is in flight, the wake queues behind it. The scheduler doesn't need to retry.

3. **No schedule run record for wakes.** Unlike execute mode, wakes don't create their own conversation, so there's no `conversationId` to record in `cron_runs`. We could create a synthetic run record with `conversationId = wakeConversationId`, but it adds complexity for little value. The feed event provides observability. _Open question: worth adding for auditability?_

4. **`quiet: true` by default for deferred wakes.** These are internal bookkeeping, not user-facing reminders. The CLI should default to `quiet: true` (the `schedule_create` tool defaults to `false`).

## Schedule Store Changes

### `createSchedule` params

Add optional `wakeConversationId` to the params type:

```ts
export function createSchedule(params: {
  // ... existing params ...
  wakeConversationId?: string | null;  // NEW: target conversation for wake mode
}): ScheduleJob { ... }
```

Validation: if `mode === 'wake'` and `wakeConversationId` is not provided, throw.

### `ScheduleJob` type

Add `wakeConversationId: string | null` to the returned type.

### `listSchedules` filter

Add a `mode` filter option:

```ts
export function listSchedules(options?: {
  enabledOnly?: boolean;
  oneShotOnly?: boolean;
  recurringOnly?: boolean;
  mode?: ScheduleMode;          // NEW
  createdBy?: string;           // NEW — filter by 'defer', 'agent', 'user'
  conversationId?: string;      // NEW — filter wakes by target conversation
}): ScheduleJob[]
```

This enables `conversations defer list` to query only deferred wakes, optionally scoped to a specific conversation.

### `createdBy` convention

Deferred wakes use `createdBy: 'defer'` to distinguish them from user-created schedules (`'user'`) and LLM-created schedules (`'agent'`). The existing `schedule_list` HTTP route and Settings UI can filter these out by default.

## CLI: `assistant conversations defer`

New subcommand on the existing `conversations` command. Uses IPC (via the existing `cliIpcCall` mechanism) to call new IPC routes that wrap the schedule store.

### Commands

```
assistant conversations defer [conversationId] --in <duration> --hint <text>
assistant conversations defer [conversationId] --at <iso8601> --hint <text>
assistant conversations defer list [--conversation-id <id>] [--json]
assistant conversations defer cancel <deferId>
assistant conversations defer cancel --all [--conversation-id <id>]
```

### `defer` (create)

```
Arguments:
  conversationId    Target conversation (optional — resolved from
                    $__CONVERSATION_ID env or $__SKILL_CONTEXT_JSON)

Options:
  --in <duration>   Delay before wake. Accepts: 60 (seconds), 60s, 5m, 1h, 1h30m
  --at <iso8601>    Absolute fire time (must include timezone offset)
  --hint <text>     Message visible to the LLM when woken (required)
  --name <text>     Human-readable label (default: "Deferred wake")
  --json            Output result as JSON
```

Resolution precedence for `conversationId` (same pattern as existing `task` command):
1. Explicit positional argument
2. `$__SKILL_CONTEXT_JSON` env var (skill sandbox)
3. `$__CONVERSATION_ID` env var (bash tool subprocess)
4. Error with actionable message

Under the hood: calls `createSchedule({ mode: 'wake', wakeConversationId, message: hint, quiet: true, createdBy: 'defer', ... })`.

### `defer list`

```
Options:
  --conversation-id <id>   Filter to wakes targeting a specific conversation
  --json                   Output as JSON
```

Calls `listSchedules({ mode: 'wake', createdBy: 'defer', conversationId })`. Shows only active/firing wakes by default (not fired/cancelled).

### `defer cancel`

```
Arguments:
  deferId           Schedule ID to cancel

Options:
  --all             Cancel all pending wakes (optionally scoped by --conversation-id)
  --conversation-id <id>   Scope --all to a specific conversation
  --json            Output as JSON
```

Calls `cancelSchedule(id)` for single cancel, or queries + cancels matching wakes for `--all`.

### Duration parsing

The `--in` flag accepts human-friendly durations:

| Input | Seconds |
|-------|---------|
| `60` | 60 |
| `60s` | 60 |
| `5m` | 300 |
| `1h` | 3600 |
| `1h30m` | 5400 |
| `90s` | 90 |

Implementation: simple regex parser, no external dependency.

```ts
function parseDuration(input: string): number {
  // Pure number = seconds
  if (/^\d+$/.test(input)) return parseInt(input, 10);

  let total = 0;
  const re = /(\d+)(h|m|s)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    const val = parseInt(match[1], 10);
    switch (match[2]) {
      case "h": total += val * 3600; break;
      case "m": total += val * 60; break;
      case "s": total += val; break;
    }
  }
  if (total === 0) throw new Error(`Invalid duration: "${input}"`);
  return total;
}
```

## IPC Routes

Three new IPC routes (registered in `assistant/src/ipc/routes/index.ts`):

### `defer_create`

```ts
// Params: { conversationId, hint, delaySeconds?, fireAt?, name? }
// Returns: { id, name, fireAt, conversationId }
```

Validates inputs, computes `fireAt` from `delaySeconds` if needed, calls `createSchedule()`.

### `defer_list`

```ts
// Params: { conversationId? }
// Returns: { defers: Array<{ id, name, hint, conversationId, fireAt, status }> }
```

Wraps `listSchedules({ mode: 'wake', createdBy: 'defer', ... })`.

### `defer_cancel`

```ts
// Params: { id?, all?: boolean, conversationId? }
// Returns: { cancelled: number }
```

Single cancel or bulk cancel.

## What changes where

| File | Change |
|------|--------|
| `assistant/src/memory/schema/infrastructure.ts` | Add `wakeConversationId` column to `cronJobs` |
| `assistant/src/schedule/schedule-store.ts` | Accept `wakeConversationId` in `createSchedule`, add to `ScheduleJob` type, add `mode`/`createdBy`/`conversationId` filters to `listSchedules` |
| `assistant/src/schedule/scheduler.ts` | Add `wake` mode branch in `runScheduleOnce` |
| `assistant/src/runtime/routes/schedule-routes.ts` | Add `wake` to `VALID_MODES`, pass through `wakeConversationId` in update/create handlers, handle `run-now` for wake mode |
| `assistant/src/ipc/routes/defer.ts` | **New file.** `defer_create`, `defer_list`, `defer_cancel` routes |
| `assistant/src/ipc/routes/index.ts` | Register defer routes |
| `assistant/src/cli/commands/conversations.ts` | Register `defer` subcommand with create/list/cancel |
| `assistant/src/daemon/message-types/schedules.ts` | Add `wakeConversationId` to `SchedulesListResponse` items |
| DB migration | `ALTER TABLE cron_jobs ADD COLUMN wake_conversation_id TEXT` |

## Usage Patterns

### Basic: check on Claude Code in 60 seconds

```bash
assistant conversations defer --in 60 \
  --hint "Check Claude Code tmux session 'scope-ladder' for progress. Report status to Noa."
```

### Polling: check every 60s for up to 5 minutes

```bash
for i in 60 120 180 240 300; do
  assistant conversations defer --in $i \
    --hint "Poll #$((i/60)): Check CC session 'scope-ladder'. Cancel remaining defers if done."
done
```

The assistant can cancel remaining defers from within the woken conversation:

```bash
assistant conversations defer cancel --all
```

### Absolute time: post a tweet

```bash
assistant conversations defer --at "2026-04-24T08:00:00-04:00" \
  --hint "Post the Credence+Claude Code tweet via the post-tweet API action."
```

### List pending wakes

```bash
assistant conversations defer list
# ID                                    Fire At              Hint
# a1b2c3d4-...                          Apr 23 4:15 PM       Check CC session 'scope-ladder'...
# e5f6g7h8-...                          Apr 23 4:16 PM       Poll #2: Check CC session...
```

## Timing Precision

The scheduler ticks every **15 seconds**. A defer with `--in 60` will fire between 60–75 seconds after creation. This is acceptable for all known use cases:

- CC polling (60s granularity, ±15s is noise)
- Tweet posting (8:00 AM ± 15s is fine)
- Meeting reminders (5 minutes before ± 15s is fine)

If sub-second precision is ever needed, that would require a separate timer mechanism (e.g., `setTimeout` in the daemon process). Out of scope.

## Schedule List Pollution

Deferred wakes use `createdBy: 'defer'` so they can be filtered out of user-facing schedule lists. The strategy:

- `assistant schedule list` (Settings UI, CLI) → **excludes** `createdBy: 'defer'` by default
- `assistant conversations defer list` → **includes only** `createdBy: 'defer'`
- HTTP `GET /schedules` → returns all by default, accepts `?exclude_created_by=defer` query param

This is a presentation concern, not a data model concern. All deferred wakes are normal rows in `cron_jobs` — they can be inspected, toggled, and deleted through the standard schedule management APIs if needed.

## Open Questions

1. **Should wakes create `cron_runs` records?** Pro: consistent audit trail. Con: the `conversationId` recorded would be the target conversation, not a conversation the schedule *created*, which breaks the existing semantic. Leaning toward yes with a note that `conversationId` means "target" for wake runs.

2. **Max concurrent deferred wakes per conversation?** Probably worth a soft cap (e.g., 20) to prevent runaway polling loops. The assistant could create hundreds of defers if a polling pattern goes wrong. Easy to add as a validation check in `defer_create`.

3. **Auto-cancel on conversation close?** When a conversation is archived or deleted, should we cancel all pending deferred wakes targeting it? They'd no-op anyway, but cancelling is cleaner. Could be a lifecycle hook in conversation CRUD.
