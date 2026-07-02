# Job-handler registration: making handlers "already registered"

**Status:** design exploration
**Motivation:** the parked PR #36817 (move `runMemoryStartup` into the memory
plugin `init` hook) surfaced an import cycle whose root cause is that job-handler
**registration is imperative** — something in the startup path has to _call_
`registerMemoryJobHandlers()`. This note explores making the handlers **already
registered** (declaratively, at module load) so no startup/init code needs to
call anything, and shows how that removes the coupling that forms the cycle.

---

## 1. How it works today

### 1a. The worker dispatch table

The worker owns a plain mutable map, populated imperatively:

```ts
// persistence/jobs-worker.ts
export type JobHandler = (job: MemoryJob, config: AssistantConfig) => unknown;
const jobHandlers = new Map<string, JobHandler>(); // :61
export function registerJobHandler(type, handler) {
  // :67
  jobHandlers.set(type, handler); // last write wins
}
```

Dispatch reads the map fresh each job, with **config passed per-dispatch** (not
captured at registration):

```ts
// runMemoryJobsOnce reads config = getConfig() each tick, threads it down:
async function processJob(job, config) {
  // :631
  const handler = jobHandlers.get(job.type);
  if (handler) return handler(job, config);
  if (LEGACY_JOB_TYPES.has(job.type)) return; // silently drop retired
  throw new Error(`Unknown memory job type: ${job.type}`); // :649 → job failed
}
```

**Key facts that make declarative registration viable:**

- Registration captures nothing config- or singleton-dependent — `config` arrives
  at dispatch time.
- Registration is **unconditional**: every handler is always registered; all v1/v2/v3
  gating happens at _dispatch_ (`processJob` short-circuits, or handlers self-gate).
- The only thing an unknown type does is fail the job with `Unknown memory job type`.

### 1b. Two categories of handler, two registration owners

| Category                                                                                                                                                                                | Where the impls live                                                         | How registered today                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Non-plugin domain handlers** (~12: `prune_old_*`, lexical index/backfill, `build_conversation_summary`, `media_processing`, `conversation_analyze`, `generate_conversation_starters`) | `persistence/job-handlers/`, `conversations/`, `media/`, `home/`, `runtime/` | direct `registerJobHandler(...)` calls in `jobs/register-job-handlers.ts:57-100`                |
| **Plugin-contributed handlers** (memory's ~24 types)                                                                                                                                    | `plugins/defaults/memory/**`                                                 | the memory plugin's `memoryJobHandlers` array → plugin registry → forwarded into the worker map |

`registerMemoryJobHandlers()` (`jobs/register-job-handlers.ts:37`) does **both**:

1. `registerDefaultPluginJobHandlers()` + `registerDefaultPluginPersistenceHooks()`
   — imported from the `plugins/defaults/index.js` **barrel**;
2. forwards `getRegisteredJobHandlers()` (the plugin registry) into the worker map;
3. registers the ~12 domain handlers directly.

### 1c. Two processes call it

- **Daemon**: bootstrap (`external-plugins-bootstrap.ts`) already registers plugin
  handlers into the registry; then `runMemoryStartup` → `registerMemoryJobHandlers()`
  re-registers (idempotent) + forwards + adds domain handlers, then starts the worker.
- **Standalone worker** (`jobs/worker.ts`): does **not** run plugin bootstrap, so
  `registerMemoryJobHandlers()` is the _only_ thing that populates the registry and
  the persistence seam before it starts the in-process worker.

---

## 2. There is no cycle on `main` — but the coupling is a latent one

Contrary to the framing in #36817, `madge` shows **no closed cycle** through
`register-job-handlers.ts` on `main`. The edges are:

- `jobs/register-job-handlers.ts → plugins/defaults/index.js` (the barrel), for the
  default-plugin self-registration helpers.
- `plugins/defaults/memory/startup.ts → jobs/register-job-handlers.js` (the memory
  plugin's one "escaping import", recorded in the import-boundary baseline).

These don't close because **nothing in the barrel's import closure imports
`startup.ts`** — `startup.ts` is imported only by `daemon/lifecycle.ts`.

The cycle appears the moment a module _inside the barrel's closure_ imports
`register-job-handlers` (directly or transitively). #36817 did exactly that: moving
`runMemoryStartup` into `memory/hooks/init.ts` made
`init.ts → startup.ts → register-job-handlers.ts → defaults/index barrel → init.ts`.

So the real problem isn't the current graph — it's that **imperative registration
forces the startup path to import `register-job-handlers`, and that module reaches
the whole-plugin barrel.** Any future "move startup work into a plugin hook" trips it.

---

## 3. What "already registered" looks like

The two handler categories have different owners, so they get different treatments.

### 3a. Domain handlers → a static manifest the worker imports directly

The ~12 non-plugin handlers are daemon/persistence-owned (not a plugin's), so the
worker may hard-import them. Replace the imperative block with a declarative manifest:

```ts
// persistence/job-handlers/manifest.ts  (new)
import { pruneOldConversationsJob, ... } from "./cleanup.js";
import { indexMessageLexicalJob, ... } from "./message-lexical.js";
// ...conversations / media / home / runtime domain handlers...

/** Daemon-owned job handlers, keyed by job type. Arrow wrappers read the
 *  binding at dispatch so per-test `mock.module` overrides are honored. */
export const DOMAIN_JOB_HANDLERS: Readonly<Record<string, JobHandler>> = {
  prune_old_conversations: (job, config) => pruneOldConversationsJob(job, config),
  index_message_lexical:   (job, config) => indexMessageLexicalJob(job, config),
  build_conversation_summary: async (job, config) => {
    if (config.memory.v2.enabled) return;              // dispatch-time gate preserved
    await buildConversationSummaryJob(job, config);
  },
  // ...
};
```

The worker seeds itself from this at module load — no call needed:

```ts
// persistence/jobs-worker.ts
import { DOMAIN_JOB_HANDLERS } from "./job-handlers/manifest.js";
const jobHandlers = new Map<string, JobHandler>(
  Object.entries(DOMAIN_JOB_HANDLERS),
);
```

### 3b. Plugin handlers → the worker reads the registry directly (no forward step)

Keep the plugin registry (`jobHandlersByPlugin`) as the contribution surface. Instead
of _forwarding_ registry → worker map, have `processJob` fall through to the registry
on a miss:

```ts
// persistence/jobs-worker.ts
function resolveHandler(type: string): JobHandler | undefined {
  return (
    jobHandlers.get(type) ?? // domain (static) + any test overrides
    getRegisteredJobHandlerFor(type)
  ); // plugin registry, keyed lookup
}
```

`getRegisteredJobHandlerFor(type)` is a small addition to `job-handler-registry.ts`
(a type-keyed index alongside the existing per-plugin store). Now:

- **Daemon**: bootstrap populates the registry _before_ the worker starts → handlers
  are resolvable with no imperative forward.
- No `registerMemoryJobHandlers()` on the daemon path at all.

### 3c. The standalone worker keeps working without the barrel

The standalone worker still needs the default plugins' handlers in the registry (it
skips bootstrap). Give it a **narrow** self-register module that imports only the
job-handler arrays — never the plugin definitions (hooks/tools/injectors):

```ts
// plugins/defaults/job-handlers.ts  (new, narrow — no barrel)
import { memoryJobHandlers } from "./memory/job-handlers.js";
import { registerPluginJobHandlers } from "../job-handler-registry.js";

/** Register the default plugins' job-handler contributions into the registry
 *  without importing the plugin definitions (hooks/tools). Used by the standalone
 *  worker, which does not run plugin bootstrap. */
export function registerDefaultJobHandlers(): void {
  registerPluginJobHandlers("default-memory", memoryJobHandlers);
}
```

```ts
// jobs/worker.ts (standalone)
registerDefaultJobHandlers(); // narrow — no plugins/defaults/index barrel
registerDefaultPluginPersistenceHooks(); // (kept — see §5)
startInProcessMemoryJobsWorker();
```

`plugins/defaults/index.ts`'s `defaultMemoryPlugin` already imports `memoryJobHandlers`
for its `jobHandlers` field, so this module reuses the same leaf array — no new
plugin→host coupling, and crucially **no path back through the plugin hooks.**

---

## 4. How this removes the cycle (and the P2 ordering bug)

- **`jobs/register-job-handlers.ts` disappears** (its two jobs split into §3a manifest
  - §3c narrow default-register). Nothing imports the `plugins/defaults/index` barrel
    for job-handler purposes.
- **`memory/startup.ts` and `memory/hooks/init.ts` import nothing job-registration-
  related** → the memory plugin's `jobs/register-job-handlers.js` escaping import is
  deleted from the boundary baseline, and moving `runMemoryStartup` into `init` can
  never close a cycle.
- **The register-before-claim race (#36817 P2) dissolves.** Domain handlers are present
  at worker module-load; plugin handlers are in the registry after bootstrap (which
  runs before the worker). There's no imperative registration step left to race the
  worker's first `runMemoryJobsOnce()`.

---

## 5. Constraints to preserve

- **`config` is per-dispatch** — unaffected; the manifest stores `(job, config) => …`.
- **`mock.module` test overrides** — the domain manifest must keep the arrow-wrapper
  indirection (`(job, config) => impl(job, config)`) so a per-test module mock of the
  underlying handler is still read at dispatch. Same trick the current code uses.
- **Persistence seam** (`registerDefaultPluginPersistenceHooks`) is a _separate_ concern
  from job handlers; it's currently piggy-backed inside `registerMemoryJobHandlers`. Keep
  it explicit on the standalone-worker entry (and it already runs at daemon bootstrap).
  It is **not** part of the manifest.
- **User-plugin job handlers** are still daemon-only (bootstrap). Unchanged: the
  standalone worker never loaded user plugins.
- **Guard tests** need updates: `job-handler-registry-guard.test.ts` (asserts the exact
  contributed/non-plugin sets) and `plugin-import-boundary-guard.test.ts` (drop the
  `memory → register-job-handlers.js` baseline entry).

## 6. Risks

- **Eager import cost.** The domain manifest hard-imports all ~12 handler modules at
  worker module-load, where today they load only when `registerMemoryJobHandlers()`
  runs. These are daemon-side modules already loaded on the daemon path; verify the
  standalone worker's import graph doesn't grow a heavy/side-effectful import, and run
  `madge` to confirm the manifest introduces no _new_ cycle of its own.
- **Dispatch fallthrough vs. single map.** §3b adds a registry lookup on cache miss. If
  we prefer one map, keep a bootstrap-time forward instead — but that reintroduces an
  imperative call (just relocated to bootstrap, which is acceptable since bootstrap is
  not in a plugin's import closure). Both break the cycle; §3b is the most "already
  registered."

## 7. Recommendation

Do §3a (static domain manifest) + §3c (narrow default-register) first — these alone
delete `register-job-handlers.ts`'s barrel import and the memory escaping import,
which is the entire cycle root. Adopt §3b (registry fallthrough) if we want to drop
the daemon-side forward entirely; otherwise move the forward into bootstrap. Land it
as its own PR, then rebase #36817 on top — with the coupling gone, moving
`runMemoryStartup` into the `init` hook is a clean, cycle-free change and the P2
ordering concern no longer applies.

## 8. Concrete change list

- **New** `persistence/job-handlers/manifest.ts` — `DOMAIN_JOB_HANDLERS` (from
  `register-job-handlers.ts:57-100`).
- **New** `plugins/defaults/job-handlers.ts` — narrow `registerDefaultJobHandlers()`.
- **Edit** `persistence/jobs-worker.ts` — seed `jobHandlers` from the manifest at
  module load; optional `resolveHandler` registry fallthrough (§3b).
- **Edit** `plugins/job-handler-registry.ts` — add a type-keyed lookup (only if §3b).
- **Delete** `jobs/register-job-handlers.ts` and its callers:
  `memory/startup.ts:17,213`, `jobs/worker.ts:45` (replace with §3c call).
- **Edit** guard tests: `job-handler-registry-guard.test.ts`,
  `plugin-import-boundary-guard.test.ts` (drop the stale baseline entry).
