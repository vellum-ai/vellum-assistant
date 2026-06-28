# Authoring a memory plugin

This guide is for developers building a long-term **memory plugin** against the
public `@vellumai/plugin-api` contract. A memory plugin owns the conversation's
durable memory: the per-turn `<memory>` injection, the `remember`/`recall`
tools the model calls, and the post-turn consolidation that decides what to keep.

The assistant ships its own built-in memory system, and a working **reference
implementation** of an external memory plugin lives at
[`assistant/examples/plugins/memory-reference/`](../examples/plugins/memory-reference/).
Copy it as your starting point — this guide explains the contract it is built on.

## How memory is pluggable

Two layers make memory swappable, and it helps to know which one you are touching:

- **Internal `MemoryProvider` + `memory.provider` selector** — inside the
  assistant, the built-in graph (v1), v2 (concept-page), and v3 (shadow) systems
  are interchangeable implementations of an internal `MemoryProvider` interface
  (`assistant/src/memory/provider/`). The `memory.provider` config field
  (`"auto" | "graph" | "v2" | "v3" | "none"`) selects which one is live;
  `"auto"` reproduces the legacy `v2.enabled`/`v3.live` selection and is the
  default. This is an **internal** seam — third parties do not implement
  `MemoryProvider` directly.
- **Public plugin host facets** — an external plugin reaches the same
  subsystems (embeddings, vector store, history, durable store, jobs, LLM
  providers) through the `InitContext.host` facet bundle, importing nothing from
  `assistant/` source. **This is the contract you build against.** A plugin
  declaring `provides: "memory"` can stand in for the built-in system.

You author against the public host facets and the lifecycle hooks. The internal
`MemoryProvider`/`memory.provider` machinery is how the _built-in_ systems are
selected; you don't touch it.

## What is live vs. example vs. flag-gated

Be clear-eyed about what ships today:

- **Live:** the internal `MemoryProvider` interface, the `memory.provider`
  selector (graph/v2/v3/none), and the public `InitContext.host` facet bundle
  (providers, memory, events, config, identity, platform, logger, registries,
  embeddings, vectorStore, history, store, jobs).
- **Example, not the default:** the `memory-reference` plugin is a bundled
  **example** that proves the public contract is sufficient. Installing it does
  not change the assistant's default behavior, and the built-in memory system
  remains the live default.
- **Flag-gated, default-off:** an external `provides: "memory"` plugin only
  takes over from the built-in system when the `memory-plugin-provider` feature
  flag is **on**. It defaults off, so the built-in memory system stays active
  even when an external memory plugin is installed.

## Plugin shape

A plugin is a directory whose `package.json` is the manifest and whose
`hooks/` / `tools/` subdirectories are the contributions. The host introspects
the directory at load time and wires it in — there is no `Plugin` class to
implement or register. The model is **declarative**:

```
my-memory-plugin/
├── package.json               # Manifest — peerDependencies + vellum.provides
├── hooks/
│   ├── init.ts                # Bootstrap: migrate tables, register job handlers
│   ├── user-prompt-submit.ts  # Per-turn <memory> injection
│   └── turn-commit.ts         # Post-turn consolidation enqueue
└── tools/
    ├── remember.ts            # `remember` tool (filename → tool name)
    └── recall.ts              # `recall` tool
```

Each file under `hooks/` is a hook whose **filename is the hook name** and whose
default export is the `HookFunction`. Each file under `tools/` is a tool whose
**filename is the model-visible tool name** and whose default export is a
`ToolDefinition`. The lifecycle hooks a memory plugin uses:

| Hook                 | Fires                                                      | A memory plugin does                                                             |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `init`               | Once, when the daemon loads the plugin                     | Migrate its tables, size/resolve its vector collection, register its job handler |
| `user-prompt-submit` | Once per user turn, before the agent loop runs             | Retrieve relevant memories and inject a `<memory>` block                         |
| `turn-commit`        | Once per turn, **after** the turn's messages are persisted | **Enqueue** consolidation work — see the no-LLM rule below                       |
| `post-compact`       | After mid-turn compaction strips runtime injections        | Re-apply its `<memory>` block onto the compacted history                         |
| `shutdown`           | Once, when the daemon unloads the plugin                   | Release any per-plugin resources                                                 |

Import the context shapes (`InitContext`, `UserPromptSubmitContext`,
`TurnCommitContext`, …), `ToolDefinition`/`ToolContext`, and the facet
interfaces from `@vellumai/plugin-api`.

### The `turn-commit` no-LLM rule

`turn-commit` runs on the turn-commit path. It must do **no synchronous LLM
work** — enqueue a background job and return. Generating on every turn would
charge the user before they have asked for anything. The reference plugin's
`turn-commit` hook does nothing but `host.jobs.enqueue`; the actual fact
extraction runs later on the worker loop in the job handler registered at
`init`.

## The host facets

At `init`, the plugin receives `InitContext.host` — a `PluginHost` bundle that
is the plugin's **only** sanctioned route to the assistant's subsystems. Direct
`assistant/` source imports remain forbidden for external plugins. The facets a
memory plugin typically uses:

| Facet              | Purpose                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.store`       | Durable structured storage in plugin-owned `plugin_<id>_`-prefixed tables, with append-only scoped migrations. Confined to your own tables — the store rejects DDL/queries touching another plugin's or core tables. |
| `host.embeddings`  | Embed text into dense vectors via the host's configured backend (no plugin-supplied API key). Probe once to learn the vector dimensionality.                                                                         |
| `host.vectorStore` | Upsert/search/delete dense vectors in a plugin-namespaced collection, so two memory plugins can't collide.                                                                                                           |
| `host.history`     | Read-only conversation/message history (`getRecentMessages`, paginated history), trust/visibility filtered the same way UI-facing loads are. Writes go through `host.memory.addMessage`.                             |
| `host.jobs`        | Enqueue and handle the plugin's own background jobs on the assistant's durable worker queue. Job types are `plugin:<id>:`-namespaced. Jobs run on the worker loop / on demand, never at boot.                        |
| `host.providers`   | Resolve LLM/STT/TTS providers for a call site to run inference through the workspace's configured profiles and credentials.                                                                                          |
| `host.config`      | Read assistant feature flags and typed config sections.                                                                                                                                                              |
| `host.events`      | Publish/subscribe to runtime events.                                                                                                                                                                                 |
| `host.logger`      | Obtain scoped structured loggers.                                                                                                                                                                                    |

A robust plugin no-ops when `ctx.host` is absent — lightweight test contexts may
construct an `InitContext` without a host. See the reference plugin's `init.ts`
for the pattern.

### Storage model

The reference plugin's model generalizes well:

- **Durable rows are the source of truth.** Fact text lives in a
  `host.store`-owned table (`plugin_<id>_facts`). The store namespaces the table
  under the plugin id and rejects any statement that touches a table outside the
  `plugin_<id>_` prefix.
- **Vectors are a denormalized convenience.** Embeddings go into a
  plugin-namespaced `host.vectorStore` collection. `recall` searches the vectors,
  then hydrates the canonical rows from the store.
- **Size the collection from a probe embed** at `init` so it matches the host's
  configured embedding backend dimensionality.

## The `provides: "memory"` rule

Declare the capability marker in your manifest:

```jsonc
{
  "name": "@example/plugin-my-memory",
  "peerDependencies": { "@vellumai/plugin-api": "^0.8.0" },
  "vellum": { "provides": "memory" },
}
```

The conversation's memory system is owned by **exactly one** plugin at a time.
Rules:

- The built-in memory plugins provide it by default.
- An external plugin declaring `provides: "memory"` takes over **only when the
  `memory-plugin-provider` flag is on** (default off). When it takes over, the
  built-in memory plugins yield — their hooks are filtered out so they
  contribute neither injection nor turn-commit work.
- Two simultaneously-active external memory plugins is a misconfiguration: the
  built-in cannot yield to both, so bootstrap rejects it with a clear error.

## Installing locally

The assistant scans `<workspaceDir>/plugins/*` for subdirectories containing a
`package.json` and loads each at startup. Symlink or copy your plugin in:

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR"/plugins
ln -s "$(pwd)/my-memory-plugin" "$VELLUM_WORKSPACE_DIR"/plugins/my-memory-plugin
vellum restart
```

With the `memory-plugin-provider` flag enabled, the built-in memory plugins
yield to your `provides: "memory"` plugin.

## Portability

As long as you reach the assistant only through `InitContext.host` and the
`@vellumai/plugin-api` types, your plugin stays portable across assistant
versions — the host facets are the stable contract. The compat contract is the
host version against your `peerDependencies["@vellumai/plugin-api"]` semver
range, enforced at load time by the external-plugin loader.

## See also

- [`assistant/examples/plugins/memory-reference/`](../examples/plugins/memory-reference/) — the reference plugin and its README
- [`assistant/src/plugin-api/`](../src/plugin-api/) — the public contract surface (`index.ts`, `types.ts`, `constants.ts`)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the persistence/memory split and provider/facet model
- [`assistant/docs/architecture/memory.md`](architecture/memory.md) — the built-in memory system deep dive
