# Conversations Defer — Deferred Self-Wakes

## Overview
Extend the existing schedule system with a `wake` mode that fires `wakeAgentForOpportunity()` on an existing conversation after a delay. This enables the assistant to schedule future work on the current conversation without blocking it — the primary use case is polling Claude Code sessions. The implementation adds a DB column, a new scheduler mode, schedule store filters, three IPC routes, and a CLI subcommand.

## PR 1: Add `wakeConversationId` column and DB migration
### Depends on
None

### Branch
conv-defer/pr-1-db-migration

### Title
feat(schedule): add `wake_conversation_id` column to `cron_jobs`

### Files
- `assistant/src/memory/schema/infrastructure.ts`
- `assistant/src/memory/migrations/226-schedule-wake-conversation-id.ts`
- `assistant/src/memory/migrations/index.ts`
- `assistant/src/memory/db-init.ts`

### Implementation steps
1. In `assistant/src/memory/schema/infrastructure.ts`, add a new column to the `cronJobs` table definition after the `script` column:
   ```ts
   wakeConversationId: text("wake_conversation_id"), // target conversation for wake mode (nullable)
   ```
2. Create `assistant/src/memory/migrations/226-schedule-wake-conversation-id.ts` following the pattern of `223-schedule-script-column.ts`:
   ```ts
   import type { DrizzleDb } from "../db-connection.js";
   import { getSqliteFrom } from "../db-connection.js";

   export function migrateScheduleWakeConversationId(database: DrizzleDb): void {
     const raw = getSqliteFrom(database);
     try {
       raw.exec(`ALTER TABLE cron_jobs ADD COLUMN wake_conversation_id TEXT`);
     } catch {
       // Column already exists — nothing to do.
     }
   }
   ```
3. In `assistant/src/memory/migrations/index.ts`, add the export after the line exporting `migrateOAuthProvidersAvailableScopes`:
   ```ts
   export { migrateScheduleWakeConversationId } from "./226-schedule-wake-conversation-id.js";
   ```
4. In `assistant/src/memory/db-init.ts`, import `migrateScheduleWakeConversationId` and append it to the `migrationSteps` array after `migrateOAuthProvidersAvailableScopes`.

### Acceptance criteria
- `bunx tsc --noEmit` passes with the new column in the Drizzle schema.
- The migration file follows the idempotent try/catch pattern (safe to re-run).
- The migration is registered in both `index.ts` and `db-init.ts`.

## PR 2: Extend schedule store with `wake` mode and new filters
### Depends on
PR 1

### Branch
conv-defer/pr-2-schedule-store

### Title
feat(schedule): add `wake` mode, `wakeConversationId`, and list filters to schedule store

### Files
- `assistant/src/schedule/schedule-store.ts`
- `assistant/src/__tests__/schedule-store.test.ts`

### Implementation steps
1. In `assistant/src/schedule/schedule-store.ts`, update the `ScheduleMode` type to include `"wake"`:
   ```ts
   export type ScheduleMode = "notify" | "execute" | "script" | "wake";
   ```
2. Add `wakeConversationId: string | null` to the `ScheduleJob` interface after the `script` field.
3. Add `wakeConversationId?: string | null` to the `createSchedule` params type.
4. In the `createSchedule` function body, add validation: if `mode === 'wake'` and `wakeConversationId` is not provided, throw `new Error("Wake schedules require wakeConversationId")`.
5. Add `wakeConversationId: params.wakeConversationId ?? null` to the `row` object in `createSchedule`.
6. In `parseJobRow`, add `wakeConversationId: row.wakeConversationId ?? null` to the returned object.
7. Extend `listSchedules` options with three new optional filters:
   ```ts
   mode?: ScheduleMode;
   createdBy?: string;
   conversationId?: string;  // filter wakes by target conversation
   ```
8. In the `listSchedules` function body, add filter conditions:
   - `mode`: `conditions.push(eq(scheduleJobs.mode, options.mode))`
   - `createdBy`: `conditions.push(eq(scheduleJobs.createdBy, options.createdBy))`
   - `conversationId`: `conditions.push(eq(scheduleJobs.wakeConversationId, options.conversationId))`
9. In `assistant/src/__tests__/schedule-store.test.ts`, add tests:
   - Test creating a wake schedule with `wakeConversationId` succeeds and returns the field.
   - Test creating a wake schedule without `wakeConversationId` throws.
   - Test `listSchedules({ mode: 'wake' })` returns only wake schedules.
   - Test `listSchedules({ createdBy: 'defer' })` returns only defer-created schedules.
   - Test `listSchedules({ conversationId: 'conv-123' })` returns only wakes targeting that conversation.

### Acceptance criteria
- `ScheduleMode` includes `"wake"`.
- `ScheduleJob` interface has `wakeConversationId: string | null`.
- `createSchedule` validates `wakeConversationId` is present when `mode === 'wake'`.
- `listSchedules` supports `mode`, `createdBy`, and `conversationId` filters.
- All new tests pass: `bun test src/__tests__/schedule-store.test.ts`.

## PR 3: Add `wake` mode handler to scheduler
### Depends on
PR 2

### Branch
conv-defer/pr-3-scheduler-wake

### Title
feat(schedule): handle `wake` mode in scheduler `runScheduleOnce`

### Files
- `assistant/src/schedule/scheduler.ts`
- `assistant/src/__tests__/schedule-store.test.ts` (or a new `assistant/src/__tests__/scheduler-wake.test.ts`)

### Implementation steps
1. In `assistant/src/schedule/scheduler.ts`, add `import { wakeAgentForOpportunity } from "../runtime/agent-wake.js"` at the top.
2. In `runScheduleOnce`, add a new mode branch **before** the execute mode block (after the script mode block), following the exact pattern from the design doc:
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
3. Add tests in a new `assistant/src/__tests__/scheduler-wake.test.ts`:
   - Test that a due wake schedule calls `wakeAgentForOpportunity` with the correct `conversationId`, `hint` (from `job.message`), and `source: "defer"`.
   - Test that a wake schedule with no `wakeConversationId` is skipped and completed (not failed).
   - Test that a successful wake marks the one-shot as completed.
   - Test that a failed wake marks the one-shot as failed (reverts to active for retry).
   - Test that `quiet: true` suppresses the feed event.
   - Mock `wakeAgentForOpportunity` using the existing test patterns from `scheduler-reuse-conversation.test.ts`.

### Acceptance criteria
- Wake mode fires `wakeAgentForOpportunity` with `{ conversationId, hint: job.message, source: "defer" }`.
- Conversation-not-found = complete (not fail).
- Missing `wakeConversationId` = warn + complete (not fail).
- `quiet: true` suppresses feed event.
- Tests pass: `bun test src/__tests__/scheduler-wake.test.ts`.

## PR 4: Add `wake` to HTTP schedule routes
### Depends on
PR 2

### Branch
conv-defer/pr-4-schedule-routes

### Title
feat(schedule): accept `wake` mode in HTTP schedule routes and daemon message types

### Files
- `assistant/src/runtime/routes/schedule-routes.ts`
- `assistant/src/daemon/message-types/schedules.ts`
- `assistant/src/__tests__/schedule-routes.test.ts`

### Implementation steps
1. In `assistant/src/runtime/routes/schedule-routes.ts`, update `VALID_MODES` to include `"wake"`:
   ```ts
   const VALID_MODES = ["notify", "execute", "script", "wake"] as const;
   ```
2. In the `handleListSchedules` response mapping, add `wakeConversationId: j.wakeConversationId` to each schedule object.
3. In the `handleUpdateSchedule` function, add `"wakeConversationId"` to the list of passthrough keys.
4. In `handleRunScheduleNow`, add a wake-mode branch before the regular message-based block:
   ```ts
   if (schedule.mode === "wake") {
     if (!schedule.wakeConversationId) {
       return httpError("BAD_REQUEST", "Wake schedule has no target conversation", 400);
     }
     const { wakeAgentForOpportunity } = await import("../../runtime/agent-wake.js");
     try {
       await wakeAgentForOpportunity({
         conversationId: schedule.wakeConversationId,
         hint: schedule.message,
         source: "defer",
       });
     } catch (err) {
       const message = err instanceof Error ? err.message : String(err);
       log.warn({ err, jobId: schedule.id }, "Manual wake execution failed");
       return httpError("INTERNAL_ERROR", message, 500);
     }
     return handleListSchedules();
   }
   ```
5. In `assistant/src/daemon/message-types/schedules.ts`, add `wakeConversationId: string | null` to the `SchedulesListResponse` schedule array item type.
6. In `assistant/src/__tests__/schedule-routes.test.ts`, add tests verifying:
   - `"wake"` is accepted as a valid mode in PATCH updates.
   - `handleListSchedules` includes `wakeConversationId` in the response.
   - `run-now` for a wake schedule calls `wakeAgentForOpportunity`.

### Acceptance criteria
- `VALID_MODES` includes `"wake"`.
- List response includes `wakeConversationId`.
- Run-now for wake mode calls `wakeAgentForOpportunity`.
- `SchedulesListResponse` type includes `wakeConversationId`.
- Tests pass: `bun test src/__tests__/schedule-routes.test.ts`.

## PR 5: Add defer IPC routes
### Depends on
PR 2

### Branch
conv-defer/pr-5-ipc-routes

### Title
feat(ipc): add `defer_create`, `defer_list`, `defer_cancel` IPC routes

### Files
- `assistant/src/ipc/routes/defer.ts` (new file)
- `assistant/src/ipc/routes/index.ts`

### Implementation steps
1. Create `assistant/src/ipc/routes/defer.ts` with three routes, following the pattern from `wake-conversation.ts`:
   ```ts
   import { z } from "zod";
   import type { IpcRoute } from "../cli-server.js";
   import {
     cancelSchedule,
     createSchedule,
     listSchedules,
   } from "../../schedule/schedule-store.js";

   const DeferCreateParams = z.object({
     conversationId: z.string().min(1),
     hint: z.string().min(1),
     delaySeconds: z.number().positive().optional(),
     fireAt: z.number().positive().optional(),
     name: z.string().optional(),
   }).refine(
     (p) => p.delaySeconds != null || p.fireAt != null,
     { message: "Either delaySeconds or fireAt is required" },
   );

   const deferCreateRoute: IpcRoute = {
     method: "defer_create",
     handler: async (params) => {
       const p = DeferCreateParams.parse(params);
       const fireAt = p.fireAt ?? Date.now() + p.delaySeconds! * 1000;
       const job = createSchedule({
         name: p.name ?? "Deferred wake",
         message: p.hint,
         mode: "wake",
         wakeConversationId: p.conversationId,
         nextRunAt: fireAt,
         quiet: true,
         createdBy: "defer",
       });
       return {
         id: job.id,
         name: job.name,
         fireAt: job.nextRunAt,
         conversationId: p.conversationId,
       };
     },
   };

   const DeferListParams = z.object({
     conversationId: z.string().optional(),
   });

   const deferListRoute: IpcRoute = {
     method: "defer_list",
     handler: async (params) => {
       const p = DeferListParams.parse(params ?? {});
       const jobs = listSchedules({
         mode: "wake",
         createdBy: "defer",
         conversationId: p.conversationId ?? undefined,
       });
       // Only show active/firing wakes (not fired/cancelled)
       const active = jobs.filter(
         (j) => j.status === "active" || j.status === "firing",
       );
       return {
         defers: active.map((j) => ({
           id: j.id,
           name: j.name,
           hint: j.message,
           conversationId: j.wakeConversationId,
           fireAt: j.nextRunAt,
           status: j.status,
         })),
       };
     },
   };

   const DeferCancelParams = z.object({
     id: z.string().optional(),
     all: z.boolean().optional(),
     conversationId: z.string().optional(),
   });

   const deferCancelRoute: IpcRoute = {
     method: "defer_cancel",
     handler: async (params) => {
       const p = DeferCancelParams.parse(params ?? {});
       if (p.id) {
         const ok = cancelSchedule(p.id);
         return { cancelled: ok ? 1 : 0 };
       }
       if (p.all) {
         const jobs = listSchedules({
           mode: "wake",
           createdBy: "defer",
           conversationId: p.conversationId ?? undefined,
         });
         let cancelled = 0;
         for (const j of jobs) {
           if (j.status === "active" && cancelSchedule(j.id)) cancelled++;
         }
         return { cancelled };
       }
       throw new Error("Either id or all is required");
     },
   };

   export const deferRoutes: IpcRoute[] = [
     deferCreateRoute,
     deferListRoute,
     deferCancelRoute,
   ];
   ```
2. In `assistant/src/ipc/routes/index.ts`, import and spread `deferRoutes`:
   ```ts
   import { deferRoutes } from "./defer.js";
   ```
   Add `...deferRoutes,` to the `cliIpcRoutes` array.

### Acceptance criteria
- `defer_create` creates a wake schedule with `mode: 'wake'`, `createdBy: 'defer'`, `quiet: true`.
- `defer_list` returns only active/firing deferred wakes, optionally filtered by conversation.
- `defer_cancel` supports single cancel (by id) and bulk cancel (all, optionally scoped by conversation).
- All three routes are registered in the IPC routes index.
- `bunx tsc --noEmit` passes.

## PR 6: Add `conversations defer` CLI subcommand
### Depends on
PR 5

### Branch
conv-defer/pr-6-cli-command

### Title
feat(cli): add `conversations defer` subcommand for deferred wakes

### Files
- `assistant/src/cli/commands/conversations-defer.ts` (new file)
- `assistant/src/cli/commands/conversations.ts`
- `assistant/src/__tests__/conversations-defer-cli.test.ts` (new file)

### Implementation steps
1. Create `assistant/src/cli/commands/conversations-defer.ts` with a `registerConversationsDeferCommand(parent: Command)` function that registers the `defer` subcommand on the `conversations` command. Follow the pattern from the `wake` subcommand in `conversations.ts`.

   **`defer` (create) subcommand:**
   ```
   conversations defer [conversationId] --in <duration> --hint <text>
   conversations defer [conversationId] --at <iso8601> --hint <text>
   ```
   - `conversationId` argument is optional. Resolution precedence:
     1. Explicit positional argument
     2. `$__SKILL_CONTEXT_JSON` env var → parse JSON and extract `conversationId`
     3. `$__CONVERSATION_ID` env var
     4. Error with actionable message
   - `--in <duration>` — parse with `parseDuration()` (implement inline): accepts `60`, `60s`, `5m`, `1h`, `1h30m`.
   - `--at <iso8601>` — parse as `new Date(value).getTime()`, validate it's in the future.
   - `--hint <text>` — required.
   - `--name <text>` — optional, defaults to "Deferred wake".
   - `--json` — output result as JSON.
   - Calls `cliIpcCall("defer_create", { conversationId, hint, delaySeconds?, fireAt?, name })`.

   **`defer list` subcommand:**
   ```
   conversations defer list [--conversation-id <id>] [--json]
   ```
   - Calls `cliIpcCall("defer_list", { conversationId })`.
   - Formats output as a table (ID, Fire At, Hint) or JSON.

   **`defer cancel` subcommand:**
   ```
   conversations defer cancel <deferId>
   conversations defer cancel --all [--conversation-id <id>]
   ```
   - Single cancel: `cliIpcCall("defer_cancel", { id: deferId })`.
   - Bulk cancel: `cliIpcCall("defer_cancel", { all: true, conversationId })`.
   - `--json` — output result as JSON.

2. Implement `parseDuration(input: string): number` as a module-level function in the same file:
   ```ts
   function parseDuration(input: string): number {
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

3. In `assistant/src/cli/commands/conversations.ts`, import and call `registerConversationsDeferCommand(conversations)` after `registerConversationsImportCommand(conversations)`.

4. In `assistant/src/__tests__/conversations-defer-cli.test.ts`, add unit tests for `parseDuration`:
   - `"60"` → 60
   - `"60s"` → 60
   - `"5m"` → 300
   - `"1h"` → 3600
   - `"1h30m"` → 5400
   - `"90s"` → 90
   - `"invalid"` → throws
   - `""` → throws

### Acceptance criteria
- `assistant conversations defer --in 60 --hint "check progress"` creates a deferred wake via IPC.
- `assistant conversations defer list` shows pending wakes in a formatted table.
- `assistant conversations defer cancel <id>` cancels a single wake.
- `assistant conversations defer cancel --all` cancels all pending wakes.
- `conversationId` resolution works from positional arg, `$__SKILL_CONTEXT_JSON`, and `$__CONVERSATION_ID`.
- Duration parsing is correct for all documented formats.
- Tests pass: `bun test src/__tests__/conversations-defer-cli.test.ts`.

## PR 7: Filter deferred wakes from default schedule list
### Depends on
PR 2

### Branch
conv-defer/pr-7-filter-schedule-list

### Title
feat(schedule): exclude `createdBy: 'defer'` from default schedule list

### Files
- `assistant/src/runtime/routes/schedule-routes.ts`
- `assistant/src/__tests__/schedule-routes.test.ts`

### Implementation steps
1. In `assistant/src/runtime/routes/schedule-routes.ts`, update `handleListSchedules` to accept an optional `excludeCreatedBy` parameter. The HTTP route handler should read `?exclude_created_by=defer` from the URL query params and pass it through.
2. Update the `handleListSchedules` function to filter out schedules where `createdBy` matches the exclusion value:
   ```ts
   function handleListSchedules(excludeCreatedBy?: string): Response {
     const jobs = listSchedules();
     const filtered = excludeCreatedBy
       ? jobs.filter((j) => j.createdBy !== excludeCreatedBy)
       : jobs;
     return Response.json({
       schedules: filtered.map((j) => ({ ... })),
     });
   }
   ```
3. Update the GET `/schedules` route handler to extract the query param:
   ```ts
   handler: ({ url }) => {
     const excludeCreatedBy = url.searchParams.get("exclude_created_by") ?? undefined;
     return handleListSchedules(excludeCreatedBy);
   },
   ```
4. In the daemon WebSocket handler for `schedules_list` (find in the codebase — likely in `assistant/src/daemon/ws-handlers.ts` or similar), pass `exclude_created_by=defer` by default so the Settings UI doesn't show deferred wakes.
5. Add tests verifying:
   - `GET /schedules` without query param returns all schedules including defers.
   - `GET /schedules?exclude_created_by=defer` excludes deferred wakes.

### Acceptance criteria
- HTTP `GET /schedules?exclude_created_by=defer` filters out deferred wakes.
- Settings UI schedule list excludes deferred wakes by default.
- Tests pass.
