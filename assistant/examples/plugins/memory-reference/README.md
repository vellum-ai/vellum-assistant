# memory-reference plugin

The **reference implementation of a long-term memory plugin** built entirely on
the public `@vellumai/plugin-api` contract. It implements a real (if
deliberately simple) memory system — `remember`/`recall` tools, per-turn
`<memory>` injection, and post-turn consolidation — using **only the host
facets** the assistant hands a plugin at `init`. It imports nothing from
`assistant/` source: no `getDb`, no `persistence/`, no internal memory modules.

Its purpose is to prove the public contract is sufficient: a third party could
ship this exact plugin against the published `@vellumai/plugin-api` package
alone. It is a bundled **example**, not the live default memory — installing it
does not change the assistant's default behavior.

## What it does

| Surface                 | File                          | Host facet(s) used                                                                                                                                                            |
| ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap               | `hooks/init.ts`               | `host.store` (migrate the fact table), `host.vectorStore` (resolve the collection), `host.jobs` (register the consolidation handler), `host.embeddings` (size the collection) |
| `remember` tool         | `tools/remember.ts`           | `host.embeddings` → `host.store` → `host.vectorStore`                                                                                                                         |
| `recall` tool           | `tools/recall.ts`             | `host.embeddings` → `host.vectorStore` → `host.store`                                                                                                                         |
| Per-turn injection      | `hooks/user-prompt-submit.ts` | `host.history` (recent context) + vector search → injects a `<memory>` block                                                                                                  |
| Post-turn consolidation | `hooks/turn-commit.ts`        | `host.jobs.enqueue` (NO synchronous LLM work)                                                                                                                                 |

The plugin declares `vellum.provides: "memory"` in its manifest — the capability
marker that lets it stand in for the built-in memory system. (Wiring it as a
_selectable / live_ provider is explicit follow-up; this PR ships it as an
example only.)

## How memory is stored

- **Facts** live in a durable, plugin-owned table the host namespaces to
  `plugin_memoryreference_facts`. The store rejects any statement that touches a
  table outside the plugin's `plugin_<id>_` prefix, so the plugin can only read
  and write its own rows.
- **Embeddings** go into a plugin-namespaced dense-vector collection via
  `host.vectorStore`. The plugin learns the backend's vector dimensionality from
  a probe embed at `init` and sizes the collection to match.
- The durable store is the **source of truth** for fact text; the vector
  payload is a denormalized convenience. `recall` searches the vectors, then
  hydrates the canonical rows from the store.

## Consolidation is off the hot path

`turn-commit` does no synchronous work beyond `host.jobs.enqueue` — the
salient-fact extraction, embed, and store run later on the assistant's worker
loop, off the commit path. A production plugin would summarize the turn in that
job handler (still on the worker, never synchronously, never at boot). This
reference keeps the handler LLM-free for determinism: it stores the turn's user
prompt as a fact.

## Layout

```
memory-reference/
├── package.json               # Manifest; peerDependencies["@vellumai/plugin-api"]; vellum.provides = "memory"
├── README.md
├── hooks/
│   ├── init.ts                # Migrate tables, resolve collection, register job handler
│   ├── user-prompt-submit.ts  # Vector search + history context → inject <memory>
│   └── turn-commit.ts         # Enqueue consolidation job (no synchronous work)
├── tools/
│   ├── remember.ts            # embed → store → upsert vector
│   └── recall.ts              # embed query → search → hydrate rows
├── src/
│   └── state.ts               # Shared runtime + pure helpers (NOT a loader surface)
└── __tests__/
    └── memory-reference.test.ts  # remember→recall + injection through mocked host facets
```

## Install locally

The assistant scans `<workspaceDir>/plugins/*` for subdirectories containing a
`package.json` and loads each one at startup. Symlink (or copy) this directory
in:

```bash
mkdir -p "$VELLUM_WORKSPACE_DIR"/plugins
ln -s "$(pwd)/assistant/examples/plugins/memory-reference" "$VELLUM_WORKSPACE_DIR"/plugins/memory-reference
vellum restart
```

Because it declares `provides: "memory"`, the assistant treats it as a memory
provider; with it installed, the built-in memory plugins yield to it.

## Build your own

Copy this directory, rename the manifest `name`, and replace the fact model and
consolidation logic with whatever your memory system needs. As long as you reach
the assistant only through `InitContext.host`, your plugin stays portable across
assistant versions — the host facets are the stable contract.

See [`plugins/README.md`](../../../../plugins/README.md) for the full plugin
authoring guide.
