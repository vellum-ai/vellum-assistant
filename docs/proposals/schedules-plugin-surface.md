# Schedules as a Pluginnable Surface

> **Status:** Proposal. This document describes how to expose *schedules* as a
> plugin/assistant contribution surface backed by workspace files under
> `<workspace>/schedules/`, and how to migrate the existing DB-backed schedules
> onto it without disrupting the proven execution engine.

## 1. Context — how schedules work today

### 1.1 Storage (runtime state, in SQLite)

Schedules live in two DB tables (`assistant/src/persistence/schema/infrastructure.ts`),
aliased in code as `scheduleJobs` / `scheduleRuns`:

- **`cron_jobs`** — one row per schedule. ~30 columns holding *both* the durable
  intent (`name`, `description`, `cron_expression`/`schedule_syntax`/`timezone`,
  `mode`, `message`, `script`, `workflow_name`, `capabilities_json`,
  `routing_intent`, `inference_profile`, `max_retries`, `quiet`, …) *and* the
  volatile execution state (`next_run_at`, `last_run_at`, `last_status`,
  `retry_count`, `status` ∈ `active|firing|fired|cancelled`, `enabled`).
- **`cron_runs`** — execution history, one row per fire
  (`status`, `startedAt`, `finishedAt`, `durationMs`, `output`, `error`,
  `conversationId`).

The schema has grown by ~15 incremental migrations
(`146-schedule-oneshot-routing` … `292-schedule-default-no-reuse-conversation`),
each adding a nullable column per feature. The shape is a flat superset: every
mode's fields coexist on every row, mostly null.

### 1.2 Execution engine (`assistant/src/schedule/scheduler.ts`)

A 15s tick loop (`runScheduleDueWorkOnce`) does:

1. `claimDueSchedules(now)` — atomically claims due rows using an
   optimistic-lock on `next_run_at` + a `status active → firing` transition, so
   concurrent ticks never double-fire.
2. Dispatch by `mode`: `notify` (notification pipeline), `execute` (background
   assistant conversation), `script` (shell), `workflow` (saved workflow run),
   `wake` (resume a conversation).
3. Record a `cron_runs` row; apply the retry policy on failure; recompute
   `next_run_at` for recurring schedules, or transition one-shots to `fired`.

At startup, `recoverStaleSchedules()` reconciles rows left `firing`/`running`
by a crashed process before the tick loop starts. This engine is mature and
correct — **the design below preserves it wholesale.**

### 1.3 Who creates schedules

- `schedule_create/update/delete/list` tools (guardian-gated;
  `assistant/src/tools/schedule/*.ts`) → `createSchedule()` DB insert.
- Settings HTTP routes (`runtime/routes/schedule-routes.ts`).
- The **defer** system (`mode: "wake"` one-shots).
- The **task scheduler** (`tasks/task-scheduler.ts`, `run_task:<id>` messages).
- The **heartbeat** is *separate*: its own `heartbeat_runs` table and timer,
  not a schedule.

There are **no seeded/built-in schedules** — every row is created on demand.

### 1.4 How other plugin surfaces are wired (the pattern to copy)

Plugins contribute `tools`, `hooks`, `routes`, `injectors`, and `jobHandlers`
(`assistant/src/plugins/types.ts`). Each non-hook surface follows an identical
shape:

- A field on `Plugin` (`plugin.jobHandlers?: readonly JobHandlerEntry[]`).
- A global registry with `register/unregister/getRegistered/clear`
  (`plugins/job-handler-registry.ts`, `plugins/injector-registry.ts`), enforcing
  global key-uniqueness.
- Bootstrap (`daemon/external-plugins-bootstrap.ts`) registers the surface
  **before** `init()` and unregisters it on init-failure/shutdown.
- A consumer reads the union (`jobs/register-job-handlers.ts` forwards
  jobHandlers into the worker dispatch table).
- External plugins are discovered on disk by walking a named directory
  (`hooks/`, `tools/`) via `listSurfaceDir`.

The workspace root (`getWorkspaceDir()`) already hosts sibling directories:
`plugins/`, `plugins-data/`, `skills/`, `tools/`, `routes/`, `hooks/`. A new
`schedules/` directory sits naturally alongside them.

---

## 2. Goals & non-goals

**Goals**

1. Plugins can **declare** scheduled jobs the same way they declare
   `jobHandlers` — a `plugin.schedules` field + a `schedules/` directory.
2. Assistants (and users, via the tool / settings UI) define schedules as
   **files under `<workspace>/schedules/`** — the durable source of truth.
3. Migrate existing `cron_jobs` rows onto the file model without dropping the
   execution engine, run history, or in-flight retry state.
4. Preserve every existing invariant: atomic claiming, crash recovery,
   guardian-only authoring, multi-client sync.

**Non-goals (v1)**

- Rewriting the tick loop, dispatch, or retry machinery.
- Making the volatile execution ledger file-based (see §4 — that would fight
  the atomic-claim model).
- Folding the heartbeat in (deferred to Phase 3 as dogfooding).

---

## 3. Core idea — separate *definition* from *execution state*

The central design decision: today a `cron_jobs` row conflates two things with
opposite lifecycles.

| Concern | Lifecycle | Right home |
| --- | --- | --- |
| **Definition** — name, trigger, mode, message/script, retry policy, timezone, capabilities | Authored rarely; durable; wants to be backed-up, synced, diffable, editable | **File** (`<workspace>/schedules/*.md`, plugin `schedules/*.ts`) |
| **Execution state** — `next_run_at`, `status`, `retry_count`, `last_run_at`, run history | Mutated every tick and every fire; volatile; needs transactional atomic claiming | **DB** (`cron_jobs` narrowed to a projection + `cron_runs`) |

So the model is **two stores with a reconciler between them** (desired-state vs
observed-state, à la a Kubernetes manifest and its controller):

- **Store 1 — Definitions (source of truth, file-based).**
  `<workspace>/schedules/<id>.md` (assistant/user-authored) and
  `<pluginDir>/schedules/<name>.ts` (plugin-contributed). Declarative,
  version-controllable, human-readable.
- **Store 2 — Execution ledger (runtime state, DB).** `cron_jobs` becomes a
  *projection* keyed by definition `id`, holding only volatile scheduling
  fields; `cron_runs` keeps history. Fully rebuildable from Store 1.

A **reconciler** materializes/updates Store 2 from Store 1. The tick loop keeps
operating on Store 2 exactly as today — it never reads files, so scheduling
timing and atomic claiming are unchanged.

> **Hard boundary:** volatile fields (`next_run_at`, `status`, `retry_count`,
> `last_run_at`, `last_status`) are **never** written back into the definition
> file. Files change only when the *intent* changes. This keeps file writes rare
> and keeps the DB the single authority for "who runs this now."

---

## 4. Why not store execution state in files too?

Tempting (it would make `<workspace>/schedules/` fully self-describing), but it
breaks three things:

- **Atomic claiming.** Double-fire prevention relies on a transactional
  compare-and-swap on `next_run_at` + `status`. Files have no equivalent; two
  ticks (or two clients) racing a rename would double-run.
- **Write amplification.** `next_run_at` changes on every fire; `status` flips
  `active→firing→fired`. A file rewrite per tick thrashes disk and pollutes any
  git-tracked/synced workspace with volatile churn.
- **Recovery.** `recoverStaleSchedules()` depends on querying `firing`/`running`
  rows. That's a DB query, not a directory scan.

The definition/execution split gives us the file benefits (portability,
editability, plugin contribution) *and* keeps the execution guarantees.

---

## 5. The `ScheduleDefinition` schema

A normalized, discriminated-union shape — cleaner than the flat 30-column row,
because each mode carries only its own fields:

```ts
export interface ScheduleDefinition {
  /** Globally-unique id. Plugin schedules: `<plugin>:<name>`. Workspace: slug/uuid. */
  id: string;
  name: string;
  description: string;
  enabled: boolean;

  trigger:
    | { kind: "recurring"; syntax: "cron" | "rrule"; expression: string; timezone: string | null }
    | { kind: "one_shot"; fireAt: string /* ISO 8601 with offset */ };

  action:
    | { mode: "execute"; message: string; reuseConversation: boolean; inferenceProfile: string | null }
    | { mode: "notify"; message: string; routingIntent: RoutingIntent; routingHints: Record<string, unknown> }
    | { mode: "script"; script: string; timeoutMs: number | null }
    | { mode: "workflow"; workflowName: string; workflowArgs: unknown; capabilities: unknown | null }
    | { mode: "wake"; wakeConversationId: string };

  retry: { maxRetries: number; backoffMs: number };
  quiet: boolean;

  owner:
    | { kind: "plugin"; plugin: string }
    | { kind: "workspace" }
    | { kind: "user"; conversationId: string | null };
}
```

When reconciled, this flattens back onto the existing `cron_jobs` columns, so
the execution engine sees the same row shape it does today (backward
compatible).

### 5.1 File format for workspace-authored schedules

`<workspace>/schedules/<id>.md` — YAML frontmatter for the structured fields,
markdown body for `message` (execute/notify prompts are often multi-line, e.g.
the Slack-digest example in the schedule SKILL.md). This mirrors `SKILL.md`:

```markdown
---
id: morning-briefing
name: Morning briefing
description: Daily 8am digest of calendar + unread email
enabled: true
trigger:
  kind: recurring
  syntax: cron
  expression: "0 8 * * *"
  timezone: America/Los_Angeles
action:
  mode: execute
  reuseConversation: true
  inferenceProfile: cost-optimized
retry: { maxRetries: 3, backoffMs: 60000 }
quiet: false
owner: { kind: user, conversationId: conv-abc }
---
Check my calendar for today and summarize unread email, then deliver the
digest to me on Telegram.
```

Flat files (not a directory-per-schedule like skills) — schedules bundle no
sibling resources. Fired one-shots are garbage-collected (see §8).

### 5.2 Plugin-contributed schedules

Consistent with `tools/` — a `schedules/<name>.ts` file default-exporting a
definition (minus `id`/`owner`, which the loader stamps):

```ts
// <pluginDir>/schedules/nightly-sync.ts
import type { PluginScheduleDefinition } from "@vellumai/plugin-api";

export default {
  name: "Nightly sync",
  description: "Refresh the cache every night at 2am",
  enabled: true,
  trigger: { kind: "recurring", syntax: "cron", expression: "0 2 * * *", timezone: null },
  action: { mode: "script", script: "vellum-plugin-sync --all", timeoutMs: 120000 },
  retry: { maxRetries: 2, backoffMs: 30000 },
  quiet: true,
} satisfies PluginScheduleDefinition;
```

The loader namespaces the id as `<plugin>:nightly-sync`, sets
`owner: { kind: "plugin", plugin }`, and pushes onto `plugin.schedules`.

---

## 6. Plumbing — mirroring the `jobHandlers` surface

1. **`Plugin` type** (`plugins/types.ts`): add
   `schedules?: readonly ScheduleDefinition[]`.

2. **Registry** (`plugins/schedule-definition-registry.ts`) — copy
   `job-handler-registry.ts`:
   `registerPluginSchedules(pluginName, defs)`,
   `unregisterPluginSchedules(pluginName)`,
   `getRegisteredScheduleDefinitions()`, `clearScheduleDefinitionRegistry()`.
   Enforce globally-unique `id` (plugin namespacing guarantees it).

3. **External loader** (`plugins/external-plugin-loader.ts`): in
   `buildPluginFromDir`, walk `schedules/` via `listSurfaceDir`, `importDefault`
   each, stamp `id`/`owner`, collect into `plugin.schedules`.

4. **Bootstrap** (`daemon/external-plugins-bootstrap.ts`): before `init()`,
   `registerPluginSchedules(name, plugin.schedules)`; unregister on
   init-failure/shutdown — identical to injectors/jobHandlers. After the
   register pass, call `reconcileSchedules()`.

5. **Workspace loader** (`plugins/schedule-workspace-loader.ts`, sibling to
   `user-loader.ts`): scan `<workspace>/schedules/*.md`, parse frontmatter →
   `ScheduleDefinition`, register under a synthetic `"workspace"` owner. A
   file-watcher (reuse the plugin-source-watcher pattern) hot-reloads on change
   and re-reconciles.

6. **Plugin-API export**: add `PluginScheduleDefinition` and the
   `RoutingIntent`/mode enums to `@vellumai/plugin-api`.

---

## 7. Reconciliation engine

`reconcileSchedules()` (single-flight; runs at startup, on registry change, and
on file-watch events):

For each registered `ScheduleDefinition`, upsert a `cron_jobs` row keyed by
`id`, storing a `definition_hash` (hash of the normalized definition):

- **New** (`id` absent) → insert row; compute `next_run_at` via
  `computeNextRunAt` (recurring) or from `fireAt` (one-shot).
- **Changed** (`definition_hash` differs) → update immutable fields; recompute
  `next_run_at` **only if the trigger changed**; reset retry state. Leave
  `next_run_at` untouched when only non-trigger fields changed, so an edit
  doesn't skip/duplicate an imminent fire.
- **Removed** (row present, no backing definition) → for plugin/workspace-owned
  rows, delete or disable the projection (a plugin uninstall stops its
  schedules). Preserve `cron_runs` history.

Ordering guarantees:

- Reconcile is **single-flight** and never mutates volatile fields the tick loop
  owns; it only writes definitional columns + `next_run_at` on genuine trigger
  changes.
- The tick loop remains the sole authority for `active→firing→fired`.
- `recoverStaleSchedules()` still runs first at startup; reconcile runs after
  recovery, before the tick loop, so recovered retry state is respected.

---

## 8. One-shot lifecycle & garbage collection

One-shots fire once → `fired`. To keep `<workspace>/schedules/` from
accumulating dead files:

- On the `firing→fired` transition, a post-run hook deletes the workspace file
  (or moves it to `<workspace>/schedules/.fired/` as a short-lived tombstone for
  auditability, GC'd after N days).
- Plugin-contributed one-shots (rare) mark the row `fired` and are not
  re-materialized on the next reconcile (the `definition_hash` match + `fired`
  status short-circuits).
- Ad-hoc "remind me at 3pm" reminders (created via `schedule_create`) are
  `owner: user` one-shot files — cheap to create/delete, low frequency.

---

## 9. Assistant-facing tools & settings

The tools and the settings HTTP routes both switch from direct DB inserts to
**file writes + reconcile**, so they share one source of truth:

- `schedule_create` / `schedule_update`: validate (same rules as today), write
  `<workspace>/schedules/<id>.md` atomically (temp-write + rename), trigger a
  reconcile, return the same integration-status summary. Guardian-only gate
  preserved (`canManageSchedules`).
- `schedule_delete`: remove the file, reconcile (drops the projection).
- `schedule_list`: read the definition registry **joined** with the DB
  projection (`next_run_at`, `last_status`, `status`) for display.
- Settings routes (`schedule-routes.ts`) operate on the same file store, so the
  UI and the tool never diverge.

Multi-client sync is preserved: after a reconcile, emit the existing
`publishSchedulesChanged()` (`sync_changed`) tag so web/macOS/CLI refetch. No
new bespoke event needed (per the Multi-Client Assistant State Sync convention).

---

## 10. Migration (DB → files)

Two coordinated migrations, in one PR, per the Backwards-Compatibility rule.

**(a) DB migration** (`memory/migrations/`, registered in `db-init.ts`): add
nullable `definition_owner` and `definition_hash` columns to `cron_jobs`. These
mark which rows are file-backed and let the reconciler match on hash. Existing
rows get `NULL` until externalized by (b).

**(b) Workspace migration**
(`workspace/migrations/NNN-externalize-schedules-to-files.ts`, self-contained
per that directory's AGENTS.md):

1. Open the assistant DB with `bun:sqlite` (allowed in migrations); read every
   `cron_jobs` row. No-op gracefully if the DB/table is absent.
2. For each row, synthesize a `ScheduleDefinition` (map flat columns → the
   discriminated union; derive `owner` from `created_by`/message shape: `agent`
   / `user` → `user`; `run_task:` → `user`/`workspace`; defer wakes →
   `workspace`), **preserving the row `id` as the file id** so `cron_runs`
   history and in-flight retry state stay linked.
3. Write `<workspace>/schedules/<id>.md` atomically. Idempotent: skip if the
   file already exists with a matching hash.
4. Set `definition_owner`/`definition_hash` on the row.

**We deliberately keep `cron_jobs`/`cron_runs`** — they become Store 2 (the
execution ledger). Nothing is dropped (also required: migrations are never
deleted). After cutover, new schedules are always file-first; the reconciler
treats pre-existing rows as already-materialized by matching `id`.

Rollback safety: because files carry the durable intent and the DB carries only
volatile state, a reconcile can fully rebuild Store 2 from Store 1 if the ledger
is ever lost.

---

## 11. Security & trust

This is the sharpest new risk and must be designed, not bolted on.

- **Plugin schedules run unattended with elevated effect.** A plugin
  contributing a `script`- or `execute`-mode schedule executes on a timer with
  no user in the loop — bypassing the guardian gate that `schedule_create`
  enforces today. Mitigations:
  - **Restrict modes for untrusted plugins.** Direct-installed (unreviewed)
    plugins may contribute only `notify`-mode schedules by default; `script` /
    `execute` / `workflow` require the plugin to be marketplace-curated **or**
    an explicit guardian opt-in at install time.
  - **Reuse the workflow capability-manifest consent.** `workflow`-mode plugin
    schedules already carry a `capabilities` manifest — make that the single
    consent point (guardian approves once at install), exactly as workflow-mode
    schedules do today.
- **Workspace schedule files are guardian-privileged.** `<workspace>/schedules/`
  must be a guardian-writable location (it is — workspace root), and the
  authoring tool/route keep the `canManageSchedules` gate.
- **No secrets in files.** Per Workspace & Secrets, definition files must never
  embed credentials; `script`/`execute` bodies reference credential ids
  (as the SKILL.md examples already do), never raw secrets.
- **Feature-flag the surface.** Gate the whole surface behind a
  `schedules-plugin-surface` flag (with the required companion Terraform PR) so
  rollout is staged and reversible.

---

## 12. Heartbeat as the canonical dogfood (Phase 3)

The heartbeat is today a parallel timer with its own `heartbeat_runs` table.
Under this design it becomes the *first* plugin-contributed schedule: a
`default-heartbeat` plugin contributes a recurring `execute`/`wake` schedule
declaratively, deleting a bespoke timer subsystem and proving the surface on a
real first-party consumer. Deferred to Phase 3 because the heartbeat has its own
config-override migrations and run table — folding it in is its own migration,
not v1 scope. (Note: heartbeat/user-schedule work is explicitly exempt from the
"No LLM Work at Daemon Startup" rule, so nothing here regresses that.)

---

## 13. Phasing (one PR = one logical change)

1. **Schema + registry.** `ScheduleDefinition` type, `PluginScheduleDefinition`
   export, `schedule-definition-registry.ts`. No behavior change.
2. **Reconciler + DB columns.** `definition_owner`/`definition_hash` migration,
   `reconcileSchedules()`, startup wiring after recovery. Feature-flagged off.
3. **Plugin surface.** `Plugin.schedules`, external-loader `schedules/` walk,
   bootstrap register/unregister. Ship a demo plugin schedule behind the flag.
4. **Workspace loader + file watcher.** `<workspace>/schedules/*.md` discovery
   and hot-reload.
5. **Tool/settings cutover + migration.** Point `schedule_*` tools and settings
   routes at the file store; ship the workspace migration; enable the flag.
6. **Phase 3 (separate):** heartbeat-as-schedule.

---

## 14. Open questions

- **File format:** `.md` + frontmatter (chosen, mirrors SKILL.md and handles
  long `message` bodies) vs `.json` (simpler to machine-edit). Recommend `.md`.
- **Fired-one-shot GC:** delete immediately vs tombstone-then-GC. Recommend
  tombstone with a short TTL for auditability.
- **Untrusted-plugin mode allowlist:** exact default set (`notify` only?) and
  the opt-in UX at install.
- **Task-scheduler & defer:** do they also become file-writers, or keep writing
  DB projections directly and skip Store 1? Recommend: defer wakes and
  `run_task` schedules stay DB-projection-only (they are ephemeral, machine-
  generated, and not user-authored intent), and are exempt from externalization
  — files are for durable, human/plugin-authored definitions.
