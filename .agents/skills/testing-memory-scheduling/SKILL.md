---
name: testing-memory-scheduling
description: Test the memory v2 scheduling subsystem (consolidation triggers, buffer-size logic, job enqueue behavior). Use when verifying changes to jobs-worker.ts, consolidation-job.ts, or related scheduling logic.
---

## Overview

The memory scheduling subsystem lives in `assistant/src/memory/`. It controls when consolidation jobs are enqueued based on time intervals, buffer size, and configuration flags.

## Key Files

- `assistant/src/memory/jobs-worker.ts` — `maybeEnqueueGraphMaintenanceJobs()` (schedule logic), `runJob()` (job dispatch)
- `assistant/src/memory/v2/consolidation-job.ts` — `memoryV2ConsolidateJob()` (job handler), `countBufferLines()` helper
- `assistant/src/memory/jobs-store.ts` — `isAutomaticConsolidationJob()`, job DB operations
- `assistant/src/config/schemas/memory-v2.ts` — Config schema (intervals, thresholds, flags)

## Test Files

- `assistant/src/memory/__tests__/jobs-worker-v2-schedule.test.ts` — Schedule trigger tests (time-based, size-based, min-lines noop)
- `assistant/src/memory/v2/__tests__/consolidation-job.test.ts` — Job handler tests (empty buffer, locking, prompt rendering)
- `assistant/src/memory/__tests__/jobs-worker-v2-graph-trigger-embed.test.ts` — Adjacent graph trigger tests

## Running Tests

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd assistant

# Schedule tests (time-based triggers, buffer-size triggers, min-lines noop)
bun test src/memory/__tests__/jobs-worker-v2-schedule.test.ts

# Consolidation job handler tests
bun test src/memory/v2/__tests__/consolidation-job.test.ts

# Graph trigger tests
bun test src/memory/__tests__/jobs-worker-v2-graph-trigger-embed.test.ts

# Typecheck
bunx tsc --noEmit

# Lint
bun run lint
```

## Test Infrastructure

- Tests use `mkdtempSync` temp workspaces pinned via `VELLUM_WORKSPACE_DIR`
- `writeBuffer(n)` helper writes n lines to `memory/buffer.md` in the temp workspace
- `removeBuffer()` deletes the buffer file
- `buildConfig({...})` creates config with overrides (v2Enabled, intervalHours, maxBufferLines, etc.)
- `countPendingJobs(type)` queries the test DB for enqueued jobs
- `resetTestTables("memory_jobs", "memory_checkpoints")` clears state between tests

## Testing Pattern

Schedule tests call `maybeEnqueueGraphMaintenanceJobs(config, nowMs)` directly and assert on DB state. Tests that expect consolidation to be enqueued must write a buffer with >= 10 non-empty lines (the `MIN_BUFFER_LINES_FOR_CONSOLIDATION` threshold).

Use GIVEN/WHEN/THEN comments in new tests per repo conventions.

## No Secrets Needed

All tests run locally with temp workspaces and in-memory SQLite. No credentials or external services required.

## Notes

- Never run `bun test` without file paths — the full suite is too large and will hang
- The consolidation-job test file is at `src/memory/v2/__tests__/` (not `src/memory/__tests__/`)
- Pre-commit hooks run formatting, linting, and typechecking — fix any issues before committing
