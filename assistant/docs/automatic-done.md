# Automatic Done

Chats Settings exposes `conversations.autoArchive` through the assistant config. `enabled` defaults to `false`; `afterDays` defaults to `7` and accepts `1`, `7`, `14`, or `30`. The worker additionally requires the `sidebar-done` feature flag so the setting cannot activate legacy archive behavior.

Auto Archive marks eligible inactive chats **Done** by setting the existing `archived_at` field. The chat remains visible in All Chats and Done, retains its transcript, and can be reopened. No schedule is cancelled and no data is deleted. New visible activity uses the existing resurfacing path.

## Eligibility

Inactivity is elapsed wall time since the latest of the last message (or creation for an empty chat) and an explicit reopen. Title edits, read receipts, config edits and other `updated_at` writes do not count as conversation activity. Migration `384-conversations-last-reopened-at.ts` adds a nullable marker without backfilling or changing existing chats. Only an actual Done-to-open transition records that marker, giving a reopened chat a full configured interval.

Candidates must be unarchived standard native chats. Native notification-origin chats are eligible; an external channel binding takes precedence over the legacy origin field. Pinned, private, scheduled, background, system, consolidation and child/subagent conversations are excluded. Chats with unread assistant output, pending guardian input, a live ACP session, a running workflow, an active mode session or a nonterminal subagent are excluded.

The final runtime check also excludes accepted sends, queued/processing turns, voice residency, pending standalone surfaces, local interactions, background tool work, wake dispatches and unfinished turn finalization. ACP resume reservations are checked against their persisted parent before the resumed session registers as live.

## Lifecycle and concurrency

The assistant owns one worker, independent of client pages. Its first sweep waits for interrupted conversation recovery, database migration readiness and startup completion. Failed startup recovery leaves the worker paused until restart. Config or assistant feature-flag invalidation and an hourly timer trigger later sweeps; overlapping triggers coalesce. Shutdown cancels retries, removes the subscription/timer and prevents a late recovery promise from starting work.

Each sweep scans bounded pages of 100 candidates with an activity/id keyset. For every page, it reads the exhaustive pending guardian-request list through the gateway. A failed read leaves that page untouched. Final eligibility and the write run synchronously inside each SQLite retry attempt. The SQL compare-and-set checks sampled message/reopen cursors and all persisted eligibility again, so activity, pinning, input-related processing, workflow/session changes, or reopening during the asynchronous gateway read cannot overwrite newer state.

Gateway-owned guardian requests live outside the assistant database. The page read is a snapshot, not a distributed transaction: a remote request created after that read cannot be atomically excluded by SQLite. Local interaction, processing and queue checks close the ordinary same-process window. The worker fails closed on an unavailable gateway or uncertain runtime state; the cross-service snapshot boundary remains explicit.

Successful updates publish the existing conversation-list and per-conversation metadata invalidations once per changed page, including updates committed before a later failure. There is no new transport event or persistent worker cursor. A restart safely scans eligible rows again, and already Done rows are excluded.

## Code and validation

- `src/conversations/auto-archive.ts`: scheduling, startup barrier, guardian snapshot and invalidation batching.
- `src/conversations/auto-archive-activity.ts`: synchronous runtime blockers.
- `src/persistence/conversation-auto-archive.ts`: shared SQL eligibility, paging and conditional writes.
- `src/persistence/conversation-crud.ts`: explicit reopen marker and existing activity resurfacing.

Focused tests cover eligibility and cursor races, reopen grace, paging, pending input, retries, lifecycle cancellation, coalescing and client invalidation. Migration tests verify existing data and idempotence.
