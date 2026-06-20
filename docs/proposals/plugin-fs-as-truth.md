# FS-as-Truth: Kill Both File Watchers

> **Status:** Draft for review. No implementation yet.
>
> **Goal:** Replace both fs.watch-based watchers (`PluginSourceWatcher` and
> `WorkspaceToolsWatcher`) with a pull-based model where the filesystem is
> the single source of truth and in-memory registries act as mtime-keyed
> caches.
>
> **Urgency:** We hit file watcher limits recently. Both watchers consume
> `fs.watch` file descriptors, and the plugin source watcher's
> close-reopen-rescan workaround amplifies fd churn. This is becoming
> urgent — the pull model eliminates all `fs.watch` usage for plugin and
> workspace-tool hot-reload.

## 1. Problem

Two independent watchers share the same architectural flaw: they use
`fs.watch` as a push-based event source, then try to keep an in-memory
registry in sync with disk. Both acknowledge in their own comments that
the watcher "exists to KICK the reconciler, not to be the source of
truth." This proposal takes that principle to its conclusion: drop both
watchers, make the filesystem the source of truth, and have the
registries cache loaded entries keyed by mtime.

### 1a. PluginSourceWatcher

`PluginSourceWatcher` is a push-based fs.watch loop with significant
complexity that exists solely to paper over platform limitations:

- **Linux/Bun recursive-watch is broken.** `fs.watch(dir, { recursive: true })`
  on Linux does not dynamically attach to subdirectories created after the
  watch was established. The watcher works around this by closing and
  reopening the entire watcher on every event burst, then rescanning
  top-level entries to catch missed plugins. This is ~100 lines of
  close-reopen-rescan logic (the `restartWatcher` + `rescanPlugins` path).
- **The watcher is a second source of truth.** The registry holds the
  "current" plugin state, and the watcher tries to keep it in sync with
  disk. But the two can diverge: events are dropped, debounces coalesce
  incorrectly, and the close-reopen gap can lose a brand-new plugin's first
  event. The `rescanPlugins` belt-and-suspenders path exists precisely
  because the watcher cannot be trusted.
- **Event routing is unreliable.** `fs.watch` event types ("rename" vs
  "change") vary across editors and platforms. The watcher already
  acknowledges this in its comments: it does not route on event type, it
  just kicks a reconciler. But the kick itself can fail to arrive.
- **Singleton + lifecycle complexity.** The watcher is a process-wide
  singleton with `start`/`stop`/`ensureStarted` lifecycle hooks, a
  `DebouncerMap` for per-plugin rebuilds, a second `DebouncerMap` for
  watcher restarts, and a rescan path. The daemon wires it into `server.ts`
  at specific lifecycle points.

### 1b. WorkspaceToolsWatcher

`WorkspaceToolsWatcher` watches `<workspaceDir>/tools/` non-recursively
using `fs.watch`. On any add/change/delete event, it debounces per
filename stem (= tool name) and reconciles registry state against on-disk
state. Same push-based flaw, simpler scope but its own complexity:

- **`.removed` sentinel handling.** The watcher's `reconcileStem` handles
  four states: (live, no sentinel), (live, sentinel — ambiguous, tear
  down both), (no live, sentinel — strip core tool), (no live, no
  sentinel — tear down everything). This state machine must be preserved
  in the pull model.
- **Core tool strip/restore.** When a `.removed` sentinel exists,
  `removeCoreToolViaWorkspace(stem)` strips the core tool. When the
  sentinel disappears, `restoreStrippedCoreTool(stem)` brings it back.
  The watcher tracks this via registry queries at reconcile time.
- **Extension precedence.** `.js` > `.ts` > `.json` for the same stem.
  `findWinningWorkspaceToolPath` in `loader.ts` implements this.
- **Feature flag.** The `workspace-tools-watcher` flag gates the watcher.
  After removal, the flag becomes dead code.
- **fd consumption.** Each `fs.watch` call opens a file descriptor. The
  workspace tools watcher adds one more on top of the plugin source
  watcher and the app source watcher. Three concurrent `fs.watch` loops
  is what pushed us into file watcher limits.

## 2. Design

### Core principle: pull, not push

Instead of `fs.watch` pushing change events that trigger reloads, every
read of plugin or workspace-tool state pulls from disk and compares
mtimes. The in-memory registry is a cache: it is valid as long as the
on-disk files haven't changed, and it is transparently invalidated and
rebuilt when they have.

### Why not split hooks and tools within the plugin cache

`reregisterExternalPlugin` rebuilds a plugin as a unit — hooks + tools +
init/shutdown together. `buildExternalPlugin` returns a single `Plugin`
object containing both. If `getHooksFor` read from the cache while tool
registration still went through the watcher's `reregisterExternalPlugin`,
two systems would build the same plugin and race on tool registration.
The plugin source watcher is one coherent thing — replace it wholesale
in PR A.

"Hooks first" means PR A is the priority because hooks are the urgent
pain point (the advisor plugin's pre-model-call hook fires on every
turn, so plugin reload latency directly affects inference), not that
hooks get a separate half-replacement.

## 3. PR A — Plugin mtime cache (kills `plugin-source-watcher.ts`)

### 3a. Mtime cache shape

Each registry entry stores the mtime of its source files alongside the
loaded `Plugin`:

```ts
interface CachedPlugin {
  plugin: Plugin;
  // mtime (ms) of the newest file the plugin was built from.
  // Covers package.json + every hooks/*.ts + every tools/*.ts.
  sourceMtime: number;
}
```

The cache key is the plugin directory name. The cache value is the loaded
plugin plus the max mtime across all files the loader walked
(`package.json`, `hooks/*`, `tools/*`).

### 3b. Read path: `getPlugin(name)`

```
getPlugin(name):
  1. stat the plugin dir on disk
  2. compute currentMtime = max mtime across package.json + hooks/* + tools/*
  3. if cache[name] exists AND cache[name].sourceMtime === currentMtime:
       return cache[name].plugin      // cache hit, no I/O beyond stat
  4. else:
       plugin = buildExternalPlugin(dir)   // cache miss
       cache[name] = { plugin, sourceMtime: currentMtime }
       return plugin
```

Step 2 is `statSync` on a handful of files — no file reads, no dynamic
imports on a cache hit. The cost is negligible (a few syscalls for stat).

### 3c. Read path: `getAllPlugins()`

```
getAllPlugins():
  1. readdir(pluginsDir)
  2. for each entry: getPlugin(entry)   // individual mtime check
  3. return all cached plugins
```

This replaces `getRegisteredPlugins()` for user plugins. First-party
default plugins stay in a separate always-present list (they don't have
on-disk sources to mtime-check).

### 3d. What triggers a reload

Nothing. There is no trigger. The next consumer that calls `getPlugin(name)`
or `getAllPlugins()` will detect the mtime change and rebuild. This means:

- **`assistant plugins install`** creates files on disk. The next hook
  pipeline run calls `getHooksFor`, which calls `getAllPlugins`, which
  detects the new plugin via `readdir` + mtime miss. No `ensureStarted()`
  needed.
- **Editing a hook file** changes its mtime. The next turn's hook pipeline
  detects the mtime mismatch and rebuilds the plugin before running hooks.
- **Deleting a plugin** removes its directory. The next `getAllPlugins`
  `readdir` no longer sees it. The cache entry is stale but harmful if
  it holds registered tools or running init side effects — see
  "Deleted plugin cleanup" below.

### 3e. Hot-reload latency

The current watcher debounces at 500ms, so the effective latency is
500ms-1s. The pull model's latency is "the next consumer read," which is:

- **During an active conversation:** the next turn's hook pipeline, so
  near-zero (the turn is about to read hooks anyway).
- **While idle:** the next user message, so near-zero from the user's
  perspective (they just typed and hit enter).
- **Post-install:** the next turn, same as above.

This is strictly better than the watcher for the common case (user edits a
plugin, sends a message, sees the change) and equivalent for the edge case
(background install while idle).

### 3f. Init/shutdown lifecycle

The current `bootstrapPlugins()` runs `init()` for every registered plugin
once at daemon startup. With the pull model:

- **Boot:** `loadUserPlugins()` walks `pluginsDir`, calls `getPlugin(name)`
  for each, and runs `init()` on the results. Same as today.
- **Post-boot plugin appearance:** when `getAllPlugins()` detects a new
  plugin (mtime miss, not in cache), it builds the plugin and runs `init()`
  inline. The init result is cached. This replaces
  `reregisterExternalPlugin`'s "register post-boot" branch.
- **Post-boot plugin change:** when `getPlugin(name)` detects an mtime
  mismatch for an already-cached plugin, it runs `shutdown()` on the old
  cached plugin, builds the new one, runs `init()`, and replaces the cache
  entry. This replaces `reregisterExternalPlugin`'s "reload" branch.
- **Plugin deletion:** when `getAllPlugins()` no longer sees a directory
  for a cached plugin, it runs `shutdown()` on the cached plugin and
  evicts the entry.

### 3g. Registration window

The current `closeRegistration()` latch prevents late-arriving
`registerPlugin()` calls from corrupting the bootstrap. With the pull model,
user plugins never call `registerPlugin()` directly — `buildExternalPlugin`
returns a `Plugin` object that the cache stores, not one that goes through
the registry's `registerPlugin` path. The latch can stay for default
plugins (which still use `registerPlugin`) but is no longer needed for
user plugins.

### 3h. Hook pipeline integration

`runHook(name, ctx)` in `pipeline.ts` currently calls
`getHooksFor(name)` which walks the in-memory registry. Under the new model:

```
runHook(name, ctx):
  plugins = getAllPlugins()      // pull + mtime check
  hooks = plugins.flatMap(p => p.hooks?.[name] ?? [])
  ...chain as today
```

The mtime check happens once per `runHook` call (or once per turn if we
hoist the `getAllPlugins` call to the turn boundary). The cost is N stat
syscalls where N = number of files across all plugins. For a typical
workspace with 2-3 plugins, that's ~10-15 stats — sub-millisecond.

### 3i. Tool registry integration

Plugin tools are currently registered into the global tool registry via
`registerPluginTools` during bootstrap and via `reregisterExternalPlugin`
during reload. Under the pull model, tool registration happens when the
cache entry is built (init time). When a cache entry is invalidated and
rebuilt, the old tools are unregistered and the new ones registered — same
as `reregisterExternalPlugin` does today, just triggered by mtime mismatch
instead of fs.watch events.

### 3j. What gets removed (PR A)

| Component | Fate |
| --- | --- |
| `plugin-source-watcher.ts` | **Deleted.** Entire file goes away. |
| `PluginSourceWatcher` singleton | **Deleted.** No replacement. |
| `restartWatcher` / `rescanPlugins` | **Deleted.** The Linux recursive-watch workaround is no longer needed. |
| `DebouncerMap` (both instances) | **Deleted.** No events to debounce. |
| `ensureStarted()` | **Deleted.** No watcher to ensure. |
| `reregisterExternalPlugin` | **Refactored.** The "build + init + register tools" logic moves into the cache-miss path. The function itself can be deleted or kept as a thin wrapper around `getPlugin(name)` for explicit invalidation if needed. |
| `server.ts` watcher wiring | **Removed.** Lines `pluginSourceWatcher.start()` and `pluginSourceWatcher.stop()` go away. |
| `plugin-source-watcher.test.ts` | **Replaced** with mtime cache tests. |

### 3k. What stays (PR A)

| Component | Fate |
| --- | --- |
| `external-plugin-loader.ts` (`buildExternalPlugin`) | **Unchanged.** Still builds a `Plugin` from a directory. |
| `user-loader.ts` (`loadUserPlugins`) | **Simplified.** No longer calls `closeRegistration()` for user plugins (the latch stays for defaults). Delegates to the cache. |
| `external-plugins-bootstrap.ts` (`bootstrapPlugins`) | **Simplified.** Walks the cache instead of the registry. Init/shutdown logic stays. |
| `registry.ts` | **Simplified.** Keeps `registerPlugin` / `getRegisteredPlugins` for first-party defaults. User plugins move to the mtime cache. `closeRegistration` stays for defaults. |
| `pipeline.ts` (`runHook`) | **Modified.** Reads from the cache instead of the registry. |

## 4. PR B — Workspace tools mtime cache (kills `workspace-tools-watcher.ts`)

### 4a. Why this is a separate PR

Workspace tools are a different system from plugins: no `init()`/`shutdown()`,
no manifest, no hooks — just tool files on disk. The `.removed` sentinel
and core-tool strip/restore logic is unique to workspace tools. The read
paths (`getTool`/`getAllTools` in `tools/registry.ts`) are shared with
core tools and plugin tools, so the integration point is different. A
separate PR keeps the blast radius contained and lets us verify PR A's
pull model in production before replicating the pattern.

### 4b. Mtime cache shape

```ts
interface CachedWorkspaceTool {
  // The registered Tool object (or null if a .removed sentinel is active).
  tool: Tool | null;
  // mtime (ms) of the newest file the entry was built from.
  // Covers <name>.{js,ts,json} + <name>.removed if present.
  sourceMtime: number;
  // The winning live file path (null when only a .removed sentinel exists).
  sourcePath: string | null;
  // Whether a .removed sentinel is currently active for this stem.
  removed: boolean;
}
```

Simpler than `CachedPlugin` — no init/shutdown lifecycle. The cache key
is the filename stem (tool name).

### 4c. Read path: `reconcileWorkspaceTools()`

The workspace tools cache is reconciled at the top of `getAllTools()`
(or a dedicated entry point called from there). A single `readdirSync`
of the tools directory plus per-stem mtime checks:

```
reconcileWorkspaceTools():
  1. readdir(toolsDir)
  2. group entries by stem (same logic as loadWorkspaceTools)
  3. for each stem in the on-disk set:
       a. compute currentMtime = max mtime across matching files
       b. if cache[stem] exists AND cache[stem].sourceMtime === currentMtime:
            skip (cache hit)
       c. else: reconcileStem(stem)  // same 4-state logic as the watcher
  4. for each stem in cache but NOT in on-disk set:
       tear down (unregister workspace tool or restore stripped core tool)
       evict cache entry
```

This replaces `WorkspaceToolsWatcher.reconcileStem` with identical logic,
just triggered by a read instead of an fs.watch event.

### 4d. The four-state reconciliation (preserved from the watcher)

`reconcileStem(stem)` handles the same states as
`WorkspaceToolsWatcher.reconcileStem`:

- **(live, no sentinel)** → ensure workspace tool is registered using the
  winning live file. If a prior registration pointed at a different path,
  unregister first, then re-import. If a stripped core tool exists for
  this stem, restore it first so the override path sees the expected
  baseline.
- **(live, sentinel)** → ambiguous intent. Tear down both (unregister
  workspace tool, restore stripped core tool). Same as the watcher's
  behavior.
- **(no live, sentinel)** → strip the core tool via
  `removeCoreToolViaWorkspace(stem)`. Unregister any prior workspace
  registration first.
- **(no live, no sentinel)** → tear down everything for this stem:
  unregister workspace tool if present, restore stripped core tool if
  present.

The existing `findWinningWorkspaceToolPath`, `loadSingleWorkspaceTool`,
`unregisterWorkspaceTool`, `removeCoreToolViaWorkspace`,
`restoreStrippedCoreTool`, `getCoreToolOverride`, and `getToolOwner`
functions are reused as-is. The cache layer is a thin wrapper that
decides *when* to call them (on mtime mismatch) instead of the watcher
deciding (on fs.watch event).

### 4e. Where to hook the reconcile

`getAllTools()` in `tools/registry.ts` is the primary consumer — the agent
loop calls it at turn boundaries to build the tool list for the LLM.
Adding `reconcileWorkspaceTools()` at the top of `getAllTools()` covers
all consumers with one entry point. The cost is one `readdirSync` + N
stats per call. For a typical workspace with 5-10 workspace tools, that's
~15-30 stats — sub-millisecond.

`getTool(name)` is called less frequently (mostly by internal dispatch).
It can either call `reconcileWorkspaceTools()` (same cost) or rely on the
fact that `getAllTools()` was called earlier in the turn. Recommend:
`reconcileWorkspaceTools()` in `getAllTools()` only, and `getTool` trusts
the cache. If a caller calls `getTool` without a prior `getAllTools`,
they get the last-reconciled state — same as today (the watcher only
updated on events, not on reads).

### 4f. What gets removed (PR B)

| Component | Fate |
| --- | --- |
| `workspace-tools-watcher.ts` | **Deleted.** Entire file goes away. |
| `WorkspaceToolsWatcher` singleton | **Deleted.** No replacement. |
| `DebouncerMap` (the per-stem instance) | **Deleted.** No events to debounce. |
| `inflight` Map | **Deleted.** Concurrent-read dedup moves to the cache. |
| `server.ts` watcher wiring | **Removed.** Lines `WorkspaceToolsWatcher.getInstance().start()` and `.stop()` go away. |
| `workspace-tools-watcher` feature flag | **Removed.** No watcher to gate. |
| `workspace-tools-watcher.test.ts` | **Replaced** with mtime cache tests. |

### 4g. What stays (PR B)

| Component | Fate |
| --- | --- |
| `loader.ts` (`loadWorkspaceTools`, `loadSingleWorkspaceTool`, `findWinningWorkspaceToolPath`, `classifyWorkspaceToolEntry`) | **Unchanged.** The cache calls these. |
| `registry.ts` (`registerWorkspaceTools`, `unregisterWorkspaceTool`, `removeCoreToolViaWorkspace`, `restoreStrippedCoreTool`) | **Unchanged.** The cache calls these. |
| `loadWorkspaceTools` initial scan | **Unchanged.** Still runs once at boot. The cache is populated from its results. |

## 5. Implementation plan

### PR A — Plugin source watcher removal (priority: hooks-first)

#### Phase 1: Mtime cache (no behavior change)

Add the `CachedPlugin` cache alongside the existing registry. The cache is
populated during `loadUserPlugins()` but nothing reads from it yet. The
watcher stays active. This lets us test the cache in isolation.

Files:
- New: `assistant/src/plugins/mtime-cache.ts` — the cache implementation.
- Modified: `user-loader.ts` — populates the cache in addition to the
  registry.
- New: `mtime-cache.test.ts` — unit tests for cache hit/miss/invalidation.

#### Phase 2: Switch readers to the cache

Change `runHook` and the tool registry to read from the cache instead of
the registry for user plugins. First-party defaults still read from the
registry. The watcher stays active but is now redundant — its reloads
update the registry, which nobody reads for user plugins.

Files:
- Modified: `pipeline.ts` — reads from cache for user plugins.
- Modified: `external-plugins-bootstrap.ts` — tool registration reads from
  cache.
- Modified: `reregisterExternalPlugin` — now also updates the cache (so the
  watcher keeps the cache fresh during the transition).

#### Phase 3: Remove the watcher

Delete `plugin-source-watcher.ts`, remove the wiring in `server.ts`, delete
the test file. The cache's mtime check on read replaces the watcher's
push-based reload. `reregisterExternalPlugin` is deleted or reduced to a
cache-invalidation stub.

Files:
- Deleted: `plugin-source-watcher.ts`, `plugin-source-watcher.test.ts`.
- Modified: `server.ts` — remove watcher import, start, stop.
- Modified: `external-plugins-bootstrap.ts` — delete
  `reregisterExternalPlugin` or reduce to `invalidateCache(name)`.
- Modified: `user-loader.ts` — remove `closeRegistration` for user plugins.
- New: integration test that edits a plugin file mid-turn and verifies the
  next hook run sees the change.

#### Phase 4: Cleanup (optional, fold into PR A or separate)

- Evaluate whether `registry.ts` can be simplified to defaults-only.
- Evaluate whether `closeRegistration` is still needed.
- Update `ARCHITECTURE.md` and `plugins/README.md` to document the
  pull-based model.

### PR B — Workspace tools watcher removal (after PR A lands)

#### Phase 1: Mtime cache (no behavior change)

Add the `CachedWorkspaceTool` cache. Populate it from `loadWorkspaceTools`
results at boot. The watcher stays active.

Files:
- New: `assistant/src/tools/workspace-tools/mtime-cache.ts` — the cache.
- Modified: `loader.ts` — populates the cache after the initial scan.
- New: `mtime-cache.test.ts` — unit tests.

#### Phase 2: Switch `getAllTools` to reconcile from cache

Add `reconcileWorkspaceTools()` call at the top of `getAllTools()`. The
watcher stays active but is now redundant.

Files:
- Modified: `tools/registry.ts` — call `reconcileWorkspaceTools()` at the
  top of `getAllTools()`.
- Modified: `workspace-tools-watcher.ts` — now also updates the cache (so
  the watcher keeps the cache fresh during the transition).

#### Phase 3: Remove the watcher

Delete `workspace-tools-watcher.ts`, remove wiring in `server.ts`, delete
the test file, remove the feature flag.

Files:
- Deleted: `workspace-tools-watcher.ts`, `workspace-tools-watcher.test.ts`.
- Modified: `server.ts` — remove watcher import, start, stop.
- Modified: `tools/registry.ts` — the reconcile call is now the sole
  source of truth for workspace tool freshness.
- Remove: `workspace-tools-watcher` feature flag from config.
- New: integration test that edits a workspace tool file and verifies the
  next `getAllTools()` sees the change.

## 6. Edge cases and risks

### Dynamic import caching

Bun caches dynamic `import()` calls by URL. `buildExternalPlugin` already
handles this via cache-busting query strings in the import URL
(`?t=<mtime>`). The mtime cache should use the same technique: when
rebuilding a plugin on mtime mismatch, the import URL includes the new
mtime so Bun fetches the fresh module instead of returning the cached one.

The workspace tools loader uses the same pattern (`?v=<counter>`). The
workspace tools cache should switch to `?t=<mtime>` for consistency and
determinism (a counter resets across restarts; an mtime is stable for the
same file content).

### Concurrent reads

Multiple hook pipelines could call `getAllPlugins()` simultaneously. The
cache must be safe for concurrent reads (it is — `Map` reads are
synchronous). Concurrent cache misses for the same plugin should not
trigger two `buildExternalPlugin` calls. A per-plugin in-flight promise
(the same `Map<string, Promise>` pattern from
`workspace-tools-watcher.ts`) handles this.

Same pattern applies to workspace tools: concurrent `reconcileWorkspaceTools`
calls should not trigger two `loadSingleWorkspaceTool` calls for the same
stem.

### Init/shutdown ordering

When a plugin is rebuilt on mtime mismatch, `shutdown()` on the old plugin
must complete before `init()` on the new one. The cache-miss path must
await shutdown before building the replacement. This is the same ordering
`reregisterExternalPlugin` uses today (unregister old tools -> build new ->
register new tools), just with explicit shutdown/init.

Not applicable to workspace tools (no init/shutdown).

### Deleted plugin cleanup

If a plugin directory is deleted, the cache entry still holds a `Plugin`
with registered tools and potentially a running `init()` side effect. The
`getAllPlugins()` scan must detect the missing directory and run
`shutdown()` + tool unregister + cache eviction for any cached plugin
whose directory no longer exists.

For workspace tools: if a tool file is deleted, the cache entry holds a
registered tool. The reconcile must unregister it (or restore a stripped
core tool if a `.removed` sentinel was also removed). This is the same
teardown logic the watcher uses today.

### Performance under high plugin/tool count

The mtime check is O(files) per plugin. A workspace with 50 plugins
averaging 5 files each = 250 stat syscalls per `getAllPlugins()` call. At
~1us per stat that's 250us — negligible. If this ever becomes a concern,
the cache can track a "last full scan" time and skip per-plugin mtime
checks within a short TTL (e.g., 100ms), but this is premature
optimization for the foreseeable scale.

Workspace tools: 50 tools = 50-100 stats (1-2 files per stem). Even more
negligible.

### The `ensureStarted` gap

Today, `PluginSourceWatcher.ensureStarted()` is called after
`assistant plugins install` to start watching if the plugins dir didn't
exist at boot. Under the pull model, `getAllPlugins()` creates the plugins
dir if it doesn't exist (same as `loadUserPlugins` does today) and reads
from it. No `ensureStarted` equivalent is needed.

Workspace tools have no `ensureStarted` equivalent — the watcher just
doesn't start if the dir doesn't exist. The cache handles this naturally:
`reconcileWorkspaceTools()` no-ops when the dir doesn't exist.

## 7. Test strategy

### PR A tests

- **Unit tests** for the mtime cache: cache hit (same mtime), cache miss
  (changed mtime), cache invalidation (deleted file), concurrent miss
  deduplication.
- **Integration test**: write a plugin to disk, run a hook, edit the
  plugin's hook file, run the hook again, verify the new hook logic is
  used. This replaces the watcher's "edit -> event -> reload" test with
  "edit -> next read -> rebuild."
- **Integration test**: install a plugin (create dir + files), verify the
  next `getAllPlugins()` picks it up and runs `init()`.
- **Integration test**: delete a plugin dir, verify the next
  `getAllPlugins()` runs `shutdown()` and evicts.

### PR B tests

- **Unit tests** for the workspace tools mtime cache: cache hit, cache
  miss, `.removed` sentinel appearance/disappearance, extension precedence
  flip (add `.js` next to `.ts`), concurrent miss dedup.
- **Integration test**: write a workspace tool to disk, call
  `getAllTools()`, edit the tool file, call `getAllTools()` again, verify
  the new tool logic is used.
- **Integration test**: add a `.removed` sentinel for a core tool, call
  `getAllTools()`, verify the core tool is stripped. Remove the sentinel,
  call `getAllTools()`, verify the core tool is restored.
- **Integration test**: delete a workspace tool file, call `getAllTools()`,
  verify the tool is unregistered.
