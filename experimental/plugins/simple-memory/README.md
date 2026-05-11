# Simple Memory — Phase 0 plugin scaffold

Experimental plugin used to prove out the [agent plugin system](../../../assistant/docs/plugins.md) end-to-end before the real memory logic moves into the runtime harness directly. Every hook a memory system would need is wired with the thinnest possible implementation behind it; the value of the scaffold is the surface, not the behavior.

> ⚠️ This is intentionally minimal. It is **not** a replacement for the default memory graph and will not be shipped with the assistant runtime. Phase 1+ will iterate on the contract here and then graduate the real implementation into the agent loop.

## Why this exists

We want to confirm that the documented plugin seams are sufficient to host an alternate memory system without patching the agent loop. The scaffold answers, concretely:

- Can a plugin **replace memory retrieval** for a turn? (`middleware.memoryRetrieval`)
- Can a plugin **inject memory content** into the prompt at the right place? (`injectors[]` with placement `"after-memory-prefix"`)
- Can a plugin **observe what just got persisted** so it can distill notes? (`middleware.persistence`)
- Can the **model deliberately write/read** memory through model-visible tools? (`tools[]`)
- Can a plugin **own a writable storage dir** that survives restart? (`pluginStorageDir` in `init()`)

If any of these answers is "not quite", the gap is what we need to fix before Phase 1.

## Hooks wired

| Capability                     | Plugin field               | Phase 0 behavior                                                                                  |
|--------------------------------|----------------------------|---------------------------------------------------------------------------------------------------|
| Read memory at turn-start      | `middleware.memoryRetrieval` | Calls `next(args)`; logs the default retriever's output alongside our own entry count.            |
| Inject memory into the prompt  | `injectors[]`              | Emits `<simple_memory>` with the conversation's entries, placement `after-memory-prefix`, order 25. |
| Observe writes after a turn    | `middleware.persistence`   | Pass-through; logs that the hook fired.                                                            |
| Model-visible remember/recall  | `tools[]`                  | `simple_memory_remember` appends, `simple_memory_recall` lists, both scoped to conversation.       |
| Setup / teardown               | `init` / `onShutdown`      | Hydrates and flushes a JSONL store at `<pluginStorageDir>/entries.jsonl`.                          |

## Storage

Phase 0 keeps everything in process. On `init()` we hydrate from `<workspaceDir>/plugins-data/simple-memory/entries.jsonl`; on `onShutdown()` we write the same path back out. Each line is a `MemoryEntry`:

```json
{"id":"sm_lwxyz_abc123","conversationId":"<uuid>","text":"User prefers ET timezone","createdAt":1715472000000}
```

Phase 1 swaps this for a real backing store (sqlite or qdrant most likely) — the hook locations don't change.

## Install locally

The assistant scans `<workspaceDir>/plugins/*` for subdirectories containing a `register.{ts,js}` file and dynamic-imports each one during startup. Symlinking is the only zero-edit install path because `register.ts` uses relative imports back into the repo's plugin types.

```bash
# from the vellum-assistant repo root
mkdir -p ~/.vellum/plugins
ln -s "$(pwd)/experimental/plugins/simple-memory" ~/.vellum/plugins/simple-memory
vellum restart
```

Once installed, send any message — `simple-memory initialized` should appear in `~/.vellum/daemon.log` with the resolved store path and hydrated entry count. Ask the model to call `simple_memory_remember`, then `simple_memory_recall`, to exercise the tools. Subsequent turns should include a `<simple_memory>` block in the model's prompt covering what was remembered.

## Uninstall

```bash
rm ~/.vellum/plugins/simple-memory
vellum restart
```

The store at `<workspaceDir>/plugins-data/simple-memory/` is left in place so you can reinstall without losing entries.

## Roadmap (Phase 1+)

1. **Move retrieval logic into the harness directly** so this plugin becomes a behavior shim, not the implementation owner. The plugin stays as the canary for the plugin contract.
2. Replace the JSONL store with a real backing store (sqlite or qdrant).
3. Wire automated distillation into `middleware.persistence` so the model doesn't have to call `simple_memory_remember` explicitly.
4. Gate behind an assistant feature flag (`requiresFlag`) once it starts competing with the default memory graph.
5. Synthesize `memoryGraphBlocks` with a custom `kind` discriminator and short-circuit `next(args)` so we become the sole retriever for the turn.

## See also

- [`assistant/docs/plugins.md`](../../../assistant/docs/plugins.md) — full plugin authoring guide.
- [`assistant/examples/plugins/echo/`](../../../assistant/examples/plugins/echo/) — minimal observer plugin used as the template.
- [`assistant/src/plugins/defaults/memory-retrieval.ts`](../../../assistant/src/plugins/defaults/memory-retrieval.ts) — the default retriever this plugin currently observes (and will eventually replace).
- [`assistant/src/plugins/types.ts`](../../../assistant/src/plugins/types.ts) — `MemoryArgs`/`MemoryResult`/`Injector`/`Plugin` shapes.
