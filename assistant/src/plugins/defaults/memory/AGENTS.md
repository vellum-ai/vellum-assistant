# Memory Plugin — Agent Instructions

Rules for code under `assistant/src/plugins/defaults/memory/` (`MEM/` below).
For the user-facing architecture narrative — what each tier does and how the
write and read paths fit together — read `assistant/docs/architecture/memory.md`
first. This file is the layering contract: where code goes, which names can
never be renamed, and how to retire a tier.

## Tier movement is one-way

**v1 and v2 are legacy. Assistants move v1 → v2 → v3 and never back.** There is
no supported path from v3 to an earlier tier, so "what happens when an assistant
returns to v1 (or v2)" is not a scenario this code serves.

That rules out a whole class of plausible-sounding work: reconciling state that
a lower tier would need, keeping a lower tier's derived data warm while a higher
tier is live, or postponing a lower tier's jobs so they survive a downgrade.
Review feedback will periodically ask for exactly that — the reasoning looks
sound in isolation, because the state genuinely is missing. Decline it and point
here. The correct fix for a lower tier's stale derived data is to delete the
lower tier (see the runbooks below), not to maintain it.

Two consequences worth stating plainly:

- The return-to-v1 path has been **removed**, not merely left vestigial: the
  `v1_entry_reconcile_done` checkpoint, its re-arm in `jobs-worker.ts`, the boot
  claim in `startup.ts`, and `reconcileCapabilityEmbeddings` in
  `graph/capability-seed.ts` are all gone. Do not reintroduce them. (A stale
  `v1_entry_reconcile_done` row may still sit in `memory_checkpoints` on an
  upgraded install; nothing reads it, so it is inert and needs no migration.)
- Gaps that only manifest after a downgrade are **not bugs**. Record them here
  if they are non-obvious; do not build machinery to close them.

## Directory / tier map

The plugin is layered into **tier directories** plus a **spine** that composes
them. Everything not listed as a tier directory is spine.

| Directory         | What lives there                                                                                                                                                                                                                                                                                                                                                                                                                  | Gate predicate                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `substrate/`      | The shared concept-page substrate (v2 + v3): `page-store`, `page-index`, `edge-index`, `qdrant`, `sim`, `sparse-bm25`, `spread`, `skill-store`, `cli-command-store`, `skill-content`, `cli-command-content`, `injected-block-slugs`, `static-context`, `boot-maintenance`, `frontmatter-sweep`, `consolidation-lock`, `consolidation-job`, `ingest`, `sweep-job`, `reembed-job`, `tuning`, `types`, `constants`, `prompts/`.      | `usesConceptPageMemory()`     |
| `v1/`             | The legacy PKB/graph engine: `pkb/`, `graph/` (retriever, triggers, scoring, serendipity, extraction, extraction-job, decay, consolidation, pattern-scan, narrative, bootstrap, injection, and the hybrid node-search half of `graph-search`), `jobs/embed-pkb-file.ts`, `job-handlers/{backfill,embedding,index-maintenance}.ts`, `pkb-schedule.ts`, `filing-jobs.ts`, `semantic-search.ts`, `identity-context.ts`, `README.md`. | `isMemoryV1Active()`          |
| `v2/`             | The v2 activation/router injection engine: `activation`, `activation-store`, `activation-log-store`, `concept-frequency`, `injection`, `injection-events`, `router`, `reranker`, `rerank-local`, `migration`, `now-text`, `backfill-jobs` (migrate + activation-recompute), `harness/`, `prompts/router`.                                                                                                                         | `isV2InjectionEngineActive()` |
| `v3/`, `v3-eval/` | The v3 lanes, orchestrator, injectors, maintain job, and the eval siblings.                                                                                                                                                                                                                                                                                                                                                       | `isMemoryV3Live()`            |

Everything else under the plugin root is **spine**:

- `graph/` — the **all-tier** legacy-graph store plus the tier dispatcher:
  `conversation-graph-memory.ts` (the v1↔v2 dispatch spine; also owns
  compaction eviction of v2 activation rows and v3 `everInjected` state, and
  the injected-block strip identity), `store.ts`, `tool-handlers.ts`,
  `tools.ts`, `capability-seed.ts`, `in-context-tracker.ts`, `graph-search.ts`
  (node/trigger **embedding** plumbing — the v1 search half lives in
  `v1/graph/graph-search.ts`), `graph-memory-state-store.ts`, `types.ts`,
  `image-ref-utils.ts`. Despite the `memory_graph_*` naming, this directory is
  not v1: capability seeding writes graph nodes on every tier.
- `graph-topology/` — the backend-agnostic memory-graph view served to the web
  Memory tab (`build-memory-graph.ts`, `pending-buffer.ts`).
- Shared infra at the root: `logging`, `paths`, `embeddings`, `anisotropy`,
  `frontmatter`, `validation`, `llm-helpers`, `config`, `memory-db`,
  `host-utils`, `path-containment`, `prompt-override`, `memory-marker`,
  `buffer-format` (the sole owner of the `memory/buffer.md` entry format:
  the writer plus the one matcher every reader uses. It lives at the root
  precisely so `substrate/`, `graph/`, and `graph-topology/` can all reach it
  without a tier importing spine. Do not add a second matcher anywhere),
  `segmenter`, `message-media`, `worker`, `worker-control`,
  `memory-recall-log-store`, `activation-session-store` (the onboarding
  activation rail — **not** a memory tier despite the name),
  `tail-reinjection-strip`, `task-memory-cleanup`, `conversation-memory-purge`,
  `conversation-memory-orphan-sweep`, `fork-conversation-memory`,
  `find-most-recent-retrospective-for`.
- The `memory-retrospective-*` family — tier-agnostic, gated on
  `memory.enabled` alone. The one exception is
  `memory-retrospective-skill-card.ts`, whose upstream enqueue only fires when
  `isV3TierActive()` holds (memory on and v3 live).
- The rest of the spine: `startup.ts`, `jobs-worker.ts`, `job-handlers.ts`,
  `job-handler-registration.ts`, `indexer.ts`, `injectors.ts`, `tools.ts`,
  `hooks/`, `src/` (HTTP routes), `context-search/`.

### The layering rule

**Tier directories never import each other.** The only sanctioned edge is
`substrate/` upward: `v2/` and `v3/`/`v3-eval/` may import `substrate/`, and
`substrate/` imports no tier. `v1/` imports no tier at all.

**Multi-tier composition happens only at the spine.** A spine file that imports
from two or more tier directories is a composition point and must be on the
frozen `SPINE_ALLOWLIST`, which today is exactly:

```
fork-conversation-memory.ts
graph-topology/build-memory-graph.ts
graph/conversation-graph-memory.ts
injectors.ts
job-handlers.ts
jobs-worker.ts
src/memory-v2-routes.ts
startup.ts
```

The list is frozen: new multi-tier composition belongs in one of these files,
and shrinking the list is how the deletion runbooks below retire an engine.
Inside them the tier arms carry `// V1 — delete with v1` /
`// V2 ENGINE — delete with v2` / `// SUBSTRATE (v2+v3)` banners, so
`grep -rn 'delete with v1' src/plugins/defaults/memory/` finds every v1 arm.
Two conventions keep that grep honest, and both are load-bearing:

- **The banner phrase is exact.** `startup.ts` labels its sections
  `// ---- <tier> ... ----` rather than `// V1 …`, so its v1 labels spell out
  `— delete with v1` too (`// ---- v1 (legacy engine) — delete with v1 ----`);
  otherwise its three v1 blocks would be invisible to the grep.
- **Dispatch call sites are banner-marked, not just function bodies.** A v1
  helper is typically an `else` arm calling a banner-marked function
  (`jobs-worker.ts`'s `enqueueV1MaintenanceJobs`, `indexer.ts`'s
  `enqueueV1IndexTriggers`). Deleting only the marked bodies leaves the calls
  dangling, so the call sites carry their own banner.

`indexer.ts`, `injectors.ts`, and `context-search/sources/memory.ts` follow the
same convention even where the file touches a single tier.

**`injectors.ts` is the plugin's single injector entry point.** Its exported
`memoryInjectors` is the complete set `defaultMemoryPlugin` contributes —
including the v3 pair defined in `v3/injector.ts` — so `plugins/defaults/index.ts`
imports the array and nothing else. A new tier injector is added to that array,
never registered from the host.

Both rules are enforced by `__tests__/memory-tier-boundary-guard.test.ts`, which
also carries a reverse stale-exemption test: an allowlist entry whose multi-tier
import disappears fails loudly instead of lingering. Related guards:

- `src/__tests__/plugin-import-boundary-guard.test.ts` — relative-specifier
  baseline for the whole plugin tree.
- `src/__tests__/persistence-layering-guard.test.ts` — one-way
  memory → persistence direction. It holds **two** separate maps, and they mean
  opposite things:
  - `PERSISTENCE_TO_MEMORY_ALLOWLIST` — genuine tech debt, ratcheting to zero.
    Today it holds exactly one file, `persistence/conversation-crud.ts`
    (`fork-conversation-memory`, `indexer`).
  - `MIGRATION_REGISTRY_MEMORY_IMPORTS` — a **permanent** exception, not tech
    debt: `persistence/steps.ts` is the migration registry and references each
    migration in the domain that owns it, today
    `{"v1/graph/bootstrap"}`. Deleting v1 does not retire the exemption, it
    moves the **pointer**: the v1 runbook relocates `migrateToolCreatedItems`
    to a surviving home (the registration is append-only and must keep
    running), and this entry is repointed at that module — or drops out only
    if the function lands inside `persistence/` itself.
- `src/plugins/__tests__/plugin-state-boundary-guard.test.ts` — the
  grandfathered main-DB exception for this plugin (do not grow its surface).

## Which predicate gates what

All predicates live in `assistant/src/config/memory-v3-gate.ts`. **Nothing else
may read raw `memory.v2.*` / `memory.v3.*` tier keys** — those reads are a
layering leak, and the boundary guard's `TIER_KEY_READ_ALLOWLIST` pins the
frozen (path, namespace) exemptions.

| Predicate                      | True when                                                           | Gates                                                                             |
| ------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `isMemoryEnabled`              | `memory.enabled !== false` (master switch, defaults on)             | the whole memory system, the retrospective family, the jobs worker's memory drain |
| `isMemoryV1Active`             | memory on AND no concept-page consumer                              | everything under `v1/`, the v1 job handlers, the v1 maintenance/index triggers    |
| `isV2InjectionEngineActive`    | memory on AND `memory.v2.enabled === true` AND v3 not live          | v2's turn-time selection — the ONLY correct "should v2 select this turn" check    |
| `isMemoryV2ExplicitlyDisabled` | `memory.v2.enabled === false` (deliberately not the negation above) | `daemon/embedding-reconcile.ts`'s explicit-opt-out suppression                    |
| `usesConceptPageMemory`        | memory on AND (`memory.v3.live` OR `memory.v2.enabled`)             | everything under `substrate/`, the graph tool handlers, the static `<info>` block |
| `isMemoryV3Live`               | `memory.v3.live === true`                                           | everything under `v3/`, and the v2 suppression at runtime assembly                |
| `isV3TierActive`               | memory on AND v3 live (the v3 TIER — `memoryTier() === "v3"`)       | `GET /memory-graph` + the `graph_supported` bit, AND procedural-memory-as-skills  |

`memory.v2.enabled` defaults **true** and typically stays set on v3-live
assistants, so a direct read of it misbehaves under v3. That is exactly why
`isV2InjectionEngineActive` exists — reach for the predicate, never the key.

**`isMemoryV1Active` is not the only v1 gate.** Several v1 code paths key on
`!usesConceptPageMemory(config.memory)` instead — notably the v1 Qdrant
collection lifecycle and the PKB index reconcile in `startup.ts`, and the
tier dispatch in `jobs-worker.ts` / `indexer.ts` / `context-search/sources/`.
The two agree everywhere except when memory is OFF: `isMemoryV1Active` is
false, but `!usesConceptPageMemory` is **true**, so those paths still run.
That is observable in `startup.ts`, which has no memory-enabled guard of its
own — a `memory.enabled: false` assistant still ensures/migrates the v1
collection on boot (only the follow-up `rebuild_index` enqueue is
`isMemoryEnabled()`-gated). Read the actual gate before assuming a v1 block
is inert on an off assistant.

`assistant/src/config/memory-tier.ts`'s `memoryTier()` is fully DERIVED from
these predicates (`off` → `v3` → `v2` → `v1`, in that precedence), so the
telemetry buckets and the runtime gates can never disagree.
`persistence/jobs-store.ts`'s config-singleton `isMemoryEnabled()` delegates to
the gate predicate for the same reason.

## Config namespaces

| Namespace                | Role                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.enabled`         | Master switch. `false` turns the whole system off regardless of tier keys.                                                                    |
| `memory.substrate.*`     | **Override-only** substrate tuning. Fifteen keys, every one optional with no default.                                                         |
| `memory.v2.*`            | The v2 engine's own tunables (activation weights, router, rerank) **plus** the historical substrate twins that supply the effective defaults. |
| `memory.v3.*`            | v3 lane/orchestrator tuning, plus `memory.v3.live`.                                                                                           |
| `memory.retrospective.*` | Retrospective cadence and triggers — tier-agnostic.                                                                                           |

`substrate/tuning.ts`'s `resolveSubstrateTuning` is the substrate's **single
config choke point**: each key resolves as `memory.substrate.X ?? memory.v2.X`
(an explicit `null` on a nullable key counts as present and wins).
`spread_k` / `spread_hops` / `ann_candidate_limit` map onto `memory.v2.k` /
`memory.v2.hops` / `memory.v2.ann_candidate_limit`; every other key shares its
name with its twin.

Because a single substrate weight forms its effective pair with the v2 twin,
the dense/sparse sum-to-1 invariant is checked in three places for three
disjoint cases: the substrate schema's own refinement (both set), the v2
schema's (neither set), and the parent `MemoryConfigSchema.superRefine` (the
mixed case, over the RESOLVED pair). Keep all three when touching the weights.

Twelve of the fifteen twins reach the runtime through `resolveSubstrateTuning`
and nothing else, so once the `memory.substrate` key exists a `config set` on
the `memory.v2` twin persists but changes nothing. The other three — `k`,
`hops`, `ann_candidate_limit` — are read a **second** time by the live v2
injection engine straight off `config.memory.v2` (`v2/injection.ts`,
`v2/activation.ts`, `v2/backfill-jobs.ts`), so a write there retunes v2
injection while substrate recall stays on the substrate twin: the two
namespaces hold two effective values at once.

`config/substrate-twin-shadowing.ts` pairs the namespaces and carries the
`alsoReadByV2Engine` flag that separates the two classes, so neither case reads
as the other: the `config_set` route returns a `warning` (a no-op notice for a
substrate-only twin, a divergence notice for an engine-read one) and
`assistant config get` prints the matching `Shadowed:` / `Split:` line.

Workspace migration 135 copies explicitly-set NON-DEFAULT `memory.v2` substrate
tunables into `memory.substrate`. It skips loader-seeded defaults — including
`bm25_b`'s earlier `0.75` default — because raw presence in `config.json` is not
user intent (the loader serializes the fully-parsed config), and copying seeded
values would permanently pin those assistants when substrate defaults are
retuned.

## FROZEN NAMES

These names are durable or wire-visible. **Never rename them**, including
during a tier deletion — several are spelled `v2` but belong to the substrate,
which outlives the v2 engine.

### SQLite tables

Persisted rows; a rename orphans every existing install.

| Table                             | Owner                               |
| --------------------------------- | ----------------------------------- |
| `memory_graph_nodes`              | all-tier (`graph/store.ts`)         |
| `memory_graph_edges`              | all-tier                            |
| `memory_graph_triggers`           | all-tier                            |
| `memory_graph_node_edits`         | all-tier                            |
| `memory_segments`                 | v1 indexing                         |
| `memory_summaries`                | v1 indexing                         |
| `memory_embeddings`               | shared embedding cache              |
| `memory_checkpoints`              | shared (all durable checkpoints)    |
| `memory_jobs`                     | shared job queue                    |
| `memory_recall_logs`              | shared recall audit                 |
| `conversation_graph_memory_state` | `graph/graph-memory-state-store.ts` |
| `activation_state`                | v2 per-conversation activation      |
| `memory_v2_activation_logs`       | v2 inspector/harness                |
| `memory_v2_injection_events`      | v2 scoring feedback                 |
| `memory_v3_selections`            | v3 selection log                    |
| `memory_v3_ever_injected`         | v3 card dedup                       |
| `memory_retrospective_state`      | retrospective (tier-agnostic)       |
| `activation_sessions`             | onboarding activation rail          |

### Job types (`memory_jobs.type`)

Persisted in job rows; unknown types either throw or get silently drained.

- Substrate: `memory_v2_consolidate`, `memory_v2_sweep`, `memory_v2_reembed`,
  `embed_concept_page`
- v2 engine: `memory_v2_migrate`, `memory_v2_activation_recompute`
- v3: `memory_v3_maintain`
- Retrospective: `memory_retrospective`, `memory_retrospective_sweep`,
  `skill_card_insert`
- v1: `graph_extract`, `graph_decay`, `graph_consolidate`, `graph_pattern_scan`,
  `graph_narrative_refine`, `graph_bootstrap`, `embed_pkb_file`, `pkb_filing`,
  `pkb_compaction`, `rebuild_index`, `backfill`, `delete_qdrant_vectors`,
  `sweep_orphaned_graph_node_points`
- All-tier embedding: `embed_graph_node`, `graph_trigger_embed`,
  `embed_segment`, `embed_summary`, `embed_media`, `embed_attachment`
- Retired, still in the union: `memory_v3_consolidate`,
  `memory_v3_index_maintenance`, `memory_v3_edge_learning` (v3-rip casualties —
  handlers removed) and `conversation_analyze` — never enqueued, but they stay
  `MemoryJobType` members **and** `LEGACY_JOB_TYPES` members so pre-upgrade rows
  drain silently
- Retired, `LEGACY_JOB_TYPES` only (already out of the union):
  `memory_v2_rebuild_edges`, `memory_proc_distill`, and the pre-memory batch
  (`embed_item`, `extract_items`, `batch_extract`, `extract_entities`,
  `cleanup_stale_superseded_items`, `backfill_entity_relations`,
  `refresh_weekly_summary`, `refresh_monthly_summary`, `journal_carry_forward`,
  `generate_capability_cards`, `generate_thread_starters`)

Retired types are never deleted from the `MemoryJobType` union — they move to
`LEGACY_JOB_TYPES` in `jobs-worker.ts` so pre-upgrade rows drain instead of
throwing. Dropping a name from **either** list strands the persisted rows that
still carry it: the worker's dispatch falls through to
`Unknown memory job type: <type>` and the row fails forever instead of
completing. The `LEGACY_JOB_TYPES` set is therefore append-only in practice —
prune it only after you can prove no install still holds a pending row.

### Checkpoint keys (`memory_checkpoints.key`)

`GRAPH_MAINTENANCE_CHECKPOINTS` in `jobs-worker.ts`, plus the consolidation
failure record and the section re-embed high-water:

- `memory_v2_consolidate_last_run`, `memory_v3_maintain_last_run` — cadence
- `memory_v2_consolidate_failure_state` (`substrate/consolidation-job.ts`) —
  the consolidation backoff record
- `memory_v3_maintain:sections_embedded_through_ms`
  (`v3/section-dense-store.ts`'s `MAINTAIN_EMBED_HIGH_WATER_KEY`) — durable
  epoch-ms high-water of the last successful section re-embed pass; when it is
  absent the maintain job re-embeds EVERY page, so losing or renaming it forces
  a full rebuild. Distinct from the `memory_v3_maintain_last_run` cadence key
  despite the shared prefix
- v1: `graph_maintenance:{decay,consolidate,pattern_scan,narrative}:last_run`,
  `pkb_filing_last_run`, `pkb_compaction_last_run`,
  `graph_bootstrap:*`, `memory:backfill:*`
- `retro_sweep:last_run` — retrospective sweep cadence

### On-disk / vector-store names

| Name                          | Where                                                                                                       | Why frozen                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `memory_v2_concept_pages`     | `substrate/qdrant.ts` `MEMORY_V2_COLLECTION`                                                                | Qdrant collection on disk. **Duplicated** in `persistence/embeddings/embedding-identity.ts` — change neither. |
| `memory_v3_sections`          | `v3/section-dense-store.ts` `SECTION_COLLECTION`                                                            | Qdrant collection on disk                                                                                     |
| `.memory-v2-reembed-required` | `substrate/qdrant.ts`                                                                                       | on-disk sentinel read across upgrades                                                                         |
| `memory/.v2-state/`           | `getConsolidationLockPath` in `substrate/consolidation-lock.ts`, `v2/migration.ts`, workspace migration 060 | persisted workspace path (consolidation lock, migration sentinel)                                             |

### Wire-visible strings

| Name                                                                                    | Kind                                  | Why frozen                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `memory_v2_consolidation`                                                               | `conversations.source` value          | persisted on every consolidation run                                |
| `memory_retrospective`                                                                  | request origin / `TitleOrigin` member | the permission checker's skill-authoring auto-grant is scoped to it |
| `skill-authored-card`                                                                   | message kind                          | persisted on skill-card messages                                    |
| `memoryV2Consolidation`, `memoryRetrospective`                                          | LLM call-site ids                     | logging/attribution buckets                                         |
| `memoryInjectedBlock`, `memoryV2StaticBlock`, `memoryV3InjectedBlock`, `memoryV3Commit` | message-metadata keys                 | persisted on messages; drives re-injection and the strip            |
| `memory-v2-static`                                                                      | injector + block id                   | `daemon/conversation-runtime-assembly.ts` matches on it             |
| `MEMORY_V2_DISABLED`                                                                    | error code                            | clients branch on it                                                |
| `memory.v2.sweep`                                                                       | notification job identifier           | surfaced in `activity.failed`                                       |

### HTTP surface

Operation ids and endpoints are published in `assistant/openapi.yaml` and
consumed by generated clients:

- `memory-items`, `memory-items/:id` (`listMemoryItems`, `getMemoryItem`,
  `createMemoryItem`, `updateMemoryItem`, `deleteMemoryItem`)
- `memory-nodes`, `memory-nodes/delete`, `memory-nodes/update`
  (`listMemoryNodes`, `deleteMemoryNode`, `updateMemoryNode`)
- `memory/remember` (`createMemory`), `memory/stats` (`getMemoryStats`)
- `memory-graph`, `memory-graph-node` (`getMemoryGraph`, `getMemoryGraphNode`)
- `memory/v2/*` — `backfill`, `compare-retrievers`, `concept-frequency`,
  `concept-page`, `ema-scores`, `list-concept-pages`, `now-text`,
  `reembed-skills`, `router-prompt-template`, `simulate-router`, `validate`
  (operation ids `memory_v2_*`)
- `memory/v3/*` — `backfill-sections`, `rebuild-index`
- `memory/ingest` (IPC method `memory_ingest`; the generated OpenAPI/HTTP
  operation id is `memory_ingest_post`): POST, deterministic batch
  concept-page ingestion
- `memory/worker/*`, `memory/eval/*`
- `consolidation/config`, `consolidation/run-now`, `consolidation/runs`
- `filing/config`, `filing/run-now` (v1)

### Telemetry

| Name                                                                          | Kind                 | Consumer            |
| ----------------------------------------------------------------------------- | -------------------- | ------------------- |
| `memory.enabled`, `memory.v2.enabled`, `memory.v3.live`                       | config-setting keys  | platform dashboards |
| `memory_tier` check_name + `detail.tier` ∈ `off`/`v1`/`v2`/`v3`               | watchdog event       | platform dashboards |
| `memory_v3_injection_gate`, `memory_v3_selection`, `memory_retrospective_run` | watchdog check names | platform dashboards |

Renaming any of these silently breaks a dashboard rather than failing a build —
coordinate with the platform before touching them. The `memory_tier` contract
(check name plus the exact `off`/`v1`/`v2`/`v3` bucket strings) is specified in
`src/telemetry/AGENTS.md` — that is the authoritative statement; do not restate
its rules here.

### Log component names

`getLogger("<scope>")` tags every line the module emits with that scope, so a
scope name is **observable**: saved log queries, `vellum logs` filters, and
support runbooks grep on it. Renaming one does not fail a build and does not
lose data — it silently empties whatever was filtering on the old name. Not
frozen the way a table or a wire string is, but rename deliberately and expect
to update queries.

Two scopes changed in the tier split and are called out here so a stale query
is diagnosable:

| Module                       | Scope now           | Was                                                   |
| ---------------------------- | ------------------- | ----------------------------------------------------- |
| `substrate/boot-maintenance` | `boot-maintenance`  | `memory-v2-startup`                                   |
| `substrate/reembed-job`      | `memory-v2-reembed` | `memory-v2-backfill` (shared with `v2/backfill-jobs`) |

The reembed job was extracted out of `v2/backfill-jobs.ts`, so its lines moved
from the shared `memory-v2-backfill` scope to a dedicated one; the surviving
`memory_v2_migrate` / `memory_v2_activation_recompute` jobs still log under
`memory-v2-backfill`. Note that most substrate scopes keep their `memory-v2-*`
spelling (`memory-v2-qdrant`, `memory-v2-page-index`, `memory-v2-consolidate`,
`memory-v2-sweep`, …) — same rule as the frozen names above: the `v2` spelling
does not make them the v2 engine's, and they must not be renamed
opportunistically with it.

## Deletion runbook: v1

### Prerequisites that BLOCK deletion

Do not start until both are resolved. Each is a live all-tier dependency on
v1-era machinery.

1. **The graph node surface is all-tier.** `graph/store.ts`,
   `graph/capability-seed.ts`, and `graph/tool-handlers.ts` write and read
   `memory_graph_nodes` on **every** tier. The `handleListMemory` /
   `handleDeleteMemory` / `handleUpdateMemory` handlers are gated on
   `usesConceptPageMemory()` yet operate on that v1-era store — so the node
   surface (and the `memory-nodes` routes and `memory items` CLI over it) must
   be ported to the substrate or retired **before** v1 can go. Deleting `v1/`
   does not remove these tables.
2. **`graph/conversation-graph-memory.ts` owns all-tier duties.** Beyond the
   v1↔v2 dispatch it does compaction eviction of v2 activation rows and v3
   `everInjected` state (`onCompacted`), and it defines the injected-block strip
   identity that `daemon/conversation-runtime-assembly.ts` matches on. Those
   move to a tier-neutral home first.

### External consumers to repoint or retire

The steps below cover the plugin's own spine. These three production files sit
**outside** `MEM/` and import `v1/` directly, so a deletion that skips them
leaves broken imports and an unbuildable tree. Handle them in the same change,
before or alongside step 1.

1. **`runtime/routes/global-search-routes.ts`** → `semanticSearch` from
   `v1/semantic-search.ts`. **Retire the route arm.** It backs only
   `searchMemoriesSemantic`, the `deep=true` half of the `memories` category,
   and `semanticSearch` already returns `[]` on any concept-page assistant (its
   own `usesConceptPageMemory` early return), so the arm is dead on every
   non-v1 install. Delete `searchMemoriesSemantic` and its `deep` call site.
   Do **not** repoint it at the substrate: the sibling `searchMemoryItems` is a
   lexical scan of `memory_graph_nodes` — all-tier, and it keeps the category
   answering — while surfacing concept pages here is a new feature over a
   different id space (page slugs, not node ids) and belongs in its own change.
   Both the `deep` query parameter and the response `source` enum
   (`lexical` | `semantic`) are published in `assistant/openapi.yaml`: `deep`
   becomes a no-op and `semantic` an unreachable variant, and narrowing either
   is a separate, client-coordinated spec change.
2. **`tools/filesystem/write.ts`** → `enqueuePkbIndexJob` from
   `v1/jobs/embed-pkb-file.ts`. **Delete the call site.** It fire-and-forgets a
   PKB re-index after a `file_write` under `workspace/pkb/**.md`, and
   `enqueuePkbIndexJob` already returns `""` when `usesConceptPageMemory()`
   holds — the call is inert under the substrate. Drop the whole `pkbRoot` /
   `isInsidePkbRoot` try block; keep the local `isInsidePkbRoot` helper, which
   the apps-dir containment check earlier in the file still uses. There is no
   substrate equivalent to repoint to — concept pages are re-embedded by
   `jobs/embed-concept-page.ts` off the page-write path.
3. **`persistence/steps.ts`** → `migrateToolCreatedItems` from
   `v1/graph/bootstrap.ts`. **MOVE THIS FUNCTION — DO NOT DELETE IT.** It is a
   registered entry in the append-only migration list (slot "101b", between
   `migrateMemoryGraphImageRefs` and `migrateDropMemoryItemsTables`) that
   copies legacy `memory_items` rows into `memory_graph_nodes` — an all-tier
   table that outlives v1. Every fresh install replays the whole chain, so
   deleting the function strands those rows on upgrade paths and defeats
   `migrateDropMemoryItemsTables`'s "already migrated" safety check. Three
   things to preserve when moving it:
   - **The exported name.** Bare-function steps are identified by
     `Function.name` for checkpointing, and `migrateMoveMemoryGraphTablesToMemoryDb`
     names the string `"migrateToolCreatedItems"` in its `dependsOn`. Renaming
     it re-runs the migration on existing installs and breaks that dependency
     edge.
   - **Its position** in the ordered `steps.ts` list — it must still run before
     `migrateDropMemoryItemsTables`.
   - **The persistence-layering guard's exemption.**
     `assistant/src/__tests__/persistence-layering-guard.test.ts` maps
     `assistant/src/persistence/steps.ts` → `{"v1/graph/bootstrap"}` in
     **`MIGRATION_REGISTRY_MEMORY_IMPORTS`** — NOT in
     `PERSISTENCE_TO_MEMORY_ALLOWLIST`, which holds only
     `persistence/conversation-crud.ts`. Editing the wrong map leaves the
     exemption in place and fails the guard. The exemption itself is permanent
     (a migration registry referencing the domain that owns each step is the
     registry's job); what moves is the pointer. Repoint the entry at the new
     module, or drop it only if the function lands inside `persistence/`; the
     guard's stale-entry test fails on a left-behind exemption either way.

   The function reads and writes only `memory_items`, `memory_graph_nodes`, and
   its own memory checkpoint, so `persistence/migrations/` or the all-tier
   `graph/` are both viable homes. `bootstrap.ts`'s other exports
   (`bootstrapFromHistory`, `maybeEnqueueGraphBootstrap`) are genuinely v1 and
   go with the tier.

**Re-run the scan at deletion time** rather than trusting this list — consumers
accrue:
`grep -rnE '(from|import\() *"[^"]*v1/' assistant/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude-dir=v1 | grep -v '\.test\.'`
(spine hits are the composition points the steps below already cover; anything
else is a new external consumer needing its own repoint-or-retire decision).

**Then re-run it WITHOUT the test exclusions** — drop `--exclude-dir=__tests__`
and the `grep -v '\.test\.'`. Test files import `v1/` too, and not all of them
are v1 tier tests that die with the tier; the non-tier ones get **repointed,
not deleted**. Today the test-only hits are:

- v1 tier tests, deleted with the tier: `src/__tests__/pkb-autoinject.test.ts`,
  `injection-block.test.ts`, `graph-extraction-event-date.test.ts`,
  `memory-identity-context-parity.test.ts`,
  `rebuild-index-graph-nodes.test.ts`, and
  `injector-pkb-v2-silenced.test.ts` (its subject is the v1 PKB pair being
  silenced under the substrate — keep its one tier-agnostic `now-md` case by
  moving it, rather than losing the coverage).
- **not** v1 tests — repoint: `src/__tests__/injector-chain.test.ts` and
  `src/__tests__/conversation-runtime-assembly.test.ts` both pull `getPkbRoot`
  from `v1/pkb/types.js` purely to place a temp workspace; they cover the
  injector chain and runtime assembly on every tier.
- a false positive: `MEM/__tests__/memory-tier-boundary-guard.test.ts` matches
  on `"./v1/a.js"`-style string literals in its own parser tests.

### Steps

1. Delete `MEM/v1/**` (including `v1/README.md` and `v1/graph/graph-search.ts`,
   the hybrid node-SEARCH half) — **after** `migrateToolCreatedItems` has been
   moved out of `v1/graph/bootstrap.ts` per the external-consumers section
   above. `graph/graph-search.ts` is the all-tier embedding plumbing and
   **stays**.
2. Delete `runtime/routes/filing-routes.ts` and drop its `ROUTES` entry from
   `runtime/routes/index.ts`.
3. Retire the `memory-items` route family (`MEM/src/memory-item-routes.ts`'s
   item half) and `cli/commands/memory/items.ts`. Re-verify callers at deletion
   time with `grep -rl 'memory-items' --exclude-dir=node_modules .` — today the
   only hits outside the assistant are the generated `assistant/openapi.yaml`
   and one web test (`clients/web/src/lib/api-interceptors.test.ts`); there are
   no hand-written web callers.
4. Remove the v1 arm of `graph/conversation-graph-memory.ts` (its
   `../v1/graph/injection.js` and `../v1/graph/retriever.js` imports and the
   branches they feed).
5. Remove the v1 branch of `context-search/sources/memory.ts` — it is the file's
   only non-substrate path (`searchGraphNodes` from `v1/graph/graph-search.ts`),
   so the source collapses to its `usesConceptPageMemory` early return.
6. Delete the v1 sections of the spine files. Every one is banner-marked, so
   `grep -rn 'delete with v1' src/plugins/defaults/memory/` is the authoritative
   list — it covers `startup.ts`'s `---- v1 (legacy engine) ----` section labels
   (which spell out the banner phrase for exactly this reason) and the dispatch
   call sites, not only the function bodies:
   `startup.ts` (**three** blocks — the v1 Qdrant ensure and the PKB reconcile,
   both covered by step 8, and the graph-bootstrap tail),
   `jobs-worker.ts` (`enqueueV1MaintenanceJobs` **and** the `else` arm
   that calls it), `job-handlers.ts`, `indexer.ts` (`enqueueV1IndexTriggers`
   **and** its call site), `injectors.ts` (the PKB injector pair). The same grep
   also returns `graph/conversation-graph-memory.ts` and
   `context-search/sources/memory.ts` — steps 4 and 5 above.
7. Delete `V1_QDRANT_JOB_TYPES` and the `SweepPostponedOffV1Error` postpone
   path in `jobs-worker.ts`, plus the v1 job handlers
   (`v1/job-handlers/{backfill,embedding,index-maintenance}.ts`) and their
   `job-handlers.ts` registrations. Move retired job types into
   `LEGACY_JOB_TYPES`; do NOT remove them from `MemoryJobType`.
8. Delete the v1 Qdrant collection lifecycle in `startup.ts` (the
   `config.memory.qdrant.collection` `ensureCollection` block and the PKB index
   reconcile). Both are gated on `!usesConceptPageMemory(config.memory)`, **not
   on `isMemoryV1Active`** — and `runMemoryStartup` has no memory-enabled guard
   of its own, so today they run on `memory.enabled: false` assistants too.
   Delete them outright rather than assuming step 9 already reaches them. Leave
   the lexical-messages collection alone — it is independent.
9. Collapse `isMemoryV1Active` call sites, then delete the predicate. Sweep for
   `!usesConceptPageMemory(...)` separately: it is the actual v1 gate in
   `startup.ts`, `jobs-worker.ts`, `indexer.ts`, and
   `context-search/sources/memory.ts`, and those arms collapse the other way
   (the substrate branch becomes unconditional).
10. Repoint or delete the tests pinned to v1 — the test-inclusive re-scan above
    lists the ones the import scan finds. One more it cannot find:
    `src/__tests__/memory-jobs-worker-lanes.test.ts` sets
    `memory.v2.enabled: false` so v1 is the live tier and its slow-lane job
    (`graph_consolidate`) genuinely runs instead of no-opping under the
    substrate. Repoint it at a surviving slow-lane job type — the lane
    independence it covers is tier-agnostic and worth keeping.
11. `memoryTier()`'s `"v1"` bucket becomes unreachable. **Coordinate with the
    platform telemetry dashboard before removing the bucket** — see
    `src/telemetry/AGENTS.md` for the `memory_tier` contract.
12. Shrink the boundary guard: drop `v1` from `TIER_DIRS` /
    `FORBIDDEN_TIER_IMPORTS`, and drop any `SPINE_ALLOWLIST` entry whose second
    tier was v1 (the reverse stale-exemption test will name them for you).

## Deletion runbook: v2

**Read this first:** the frozen substrate names merely SPELLED "v2" — the
`memory_v2_concept_pages` collection, the `memory_v2_consolidate` /
`memory_v2_sweep` / `memory_v2_reembed` job types, the `memory_v2_consolidation`
conversation source, the `memoryV2Consolidation` call-site id, the
`memory/.v2-state/` path, the `.memory-v2-reembed-required` sentinel, the
`memory-v2-static` injector id, and `memoryV2StaticBlock` — belong to the
**substrate**, which outlives the v2 engine. They survive this deletion and must
not be renamed opportunistically.

### External consumers to repoint or retire

Eight production files import `v2/` today. Three are composition points the
steps below already name (`graph/conversation-graph-memory.ts`,
`job-handlers.ts`, `MEM/src/memory-v2-routes.ts`); the remaining **five** are
itemized here, and **four of the five sit outside the plugin entirely**.
Deleting the tier without handling them cannot produce a buildable tree.

1. **`MEM/fork-conversation-memory.ts`** (spine, on the `SPINE_ALLOWLIST`) →
   `forkActivationState` / `seedForkActivationState` from
   `v2/activation-store.ts`. Remove the v2 arm; the module survives as a
   substrate + v3 fork path (injected-block slugs, `v3/ever-injected-store`,
   graph state, retrospective state). It stays on the `SPINE_ALLOWLIST` after
   the cut — `substrate` is itself a tier directory in the guard's `TIER_DIRS`,
   so substrate + v3 is still multi-tier and step 10 must **not** drop this
   entry.
2. **`runtime/routes/conversation-query-routes.ts`** →
   `getMemoryV2ActivationLogByMessageIds` from `v2/activation-log-store.ts`.
   This is the route end of the inspector chain below: it fills the
   `memoryV2Activation` field of the LLM-context response. It is **deleted**
   with that surface, not replaced — the tier-agnostic
   `getMemoryRecallLogByMessageIds` and the v3
   `getMemoryV3SelectionForInspectorByMessageIds` reads alongside it stay.
3. **`daemon/conversation-agent-loop-handlers.ts`** →
   `backfillMemoryV2ActivationMessageId` from `v2/activation-log-store.ts`. The
   turn-end stamp that keys the activation row to the assistant `messageId` so
   the inspector can find it. **Delete the try block**; no replacement is
   needed, because with the engine gone nothing writes the log in the first
   place (`v2/injection.ts`'s `recordMemoryV2ActivationLog` call dies with
   step 1). Its two siblings — the memory-recall-log and v3-selection backfills
   — are unaffected.
4. **`cli/commands/memory/memory-v2.ts`** → `import type { ComparisonReport }`
   from `v2/harness/runner.ts`. Type-only, and it feeds `memory v2 compare`,
   which step 1 already retires with the engine. Drop the import together with
   the subcommand and its `memory-v2-compare-render.js` imports; the surviving
   `reembed` / `reembed-skills` / `validate` subcommands never touch
   `harness/`.
5. **`cli/commands/memory/memory-v2-compare-render.ts`** → the same
   `import type { ComparisonReport }`. The renderer for `memory v2 compare`;
   deleted whole in step 1, so it needs no separate decision — it is listed
   only so the scan below reconciles against a complete list.

**The activation-log chain, end to end.** Retiring `memory_v2_activation_logs`
spans five layers, split across this section and steps 7–8. Land them together
or the tree and the published spec go out of sync:

- **writer** — `v2/injection.ts`'s `recordMemoryV2ActivationLog`, deleted with
  `MEM/v2/**` (step 1), plus the daemon's turn-end `messageId` backfill
  (item 3 above);
- **route** — `conversation-query-routes.ts`'s read (item 2 above);
- **wire contract** — `assistant/src/api/responses/memory-v2-activation-log.ts`
  (`MemoryV2ActivationLogSchema`, re-exported from `src/api/index.ts` and so
  published through `@vellumai/assistant-api`), embedded in
  `api/responses/llm-context-response.ts`. `memoryV2Activation` is a
  **required** property on both LLM-context responses in
  `assistant/openapi.yaml`, so removing it regenerates the spec and the
  generated client types — coordinate it with the web change;
- **web consumer** — the inspector's `memoryV2Activation` surface (step 8);
- **table** — the `memory_v2_activation_logs` drop (step 7).

**Re-run the scan at deletion time** rather than trusting this list — consumers
accrue:
`grep -rnE '(from|import\() *"[^"]*v2/' assistant/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ --exclude-dir=v2 | grep -v '\.test\.'`
(hits inside `MEM/` are the composition points the steps below cover; anything
else is a new external consumer needing its own repoint-or-retire decision).

**Then re-run it WITHOUT the test exclusions** — drop `--exclude-dir=__tests__`
and the `grep -v '\.test\.'`. Test files import `v2/` too, and not all of them
are v2 tier tests that die with the tier; the non-tier ones get **repointed,
not deleted**. Today the test-only hits are:

- v2 tier tests and fixtures, deleted with the tier:
  `MEM/__tests__/memory-v2-activation-log-store.test.ts`,
  `MEM/__tests__/memory-v2-concept-frequency.test.ts`,
  `MEM/__tests__/fixtures/memory-v2-activation-fixtures.ts` (a fixture module,
  not a `.test.` file — the `grep -v '\.test\.'` misses it either way),
  `MEM/graph/__tests__/conversation-graph-memory-v2-routing.test.ts` (the v2
  half of the dispatch spine), and
  `cli/commands/memory/__tests__/memory-v2-compare-render.test.ts`.
- **not** v2 tests — repoint by dropping their v2 arms:
  `src/__tests__/injector-v3-suppression.test.ts` (pulls `INJECTION_HEADER`
  from `v2/injection.js` to assert the v3 suppression),
  `src/__tests__/conversation-fork-crud.test.ts` (pulls `hydrate` from
  `v2/activation-store.js` while covering all-tier fork behavior),
  `MEM/__tests__/memory-log-stores-degraded.test.ts` (degraded-mode coverage
  spanning the recall log, the v2 activation log, and v3 stores), and
  `runtime/routes/__tests__/conversation-query-routes.test.ts` (the route test
  whose sibling recall-log and v3-selection assertions stay).
- a false positive: `MEM/__tests__/memory-tier-boundary-guard.test.ts` matches
  on `"./v2/a.js"`-style string literals in its own parser tests.

### Steps

1. Delete `MEM/v2/**` and `cli/commands/memory/memory-v2-compare-render.ts`.
   Two modules **split** rather than delete:
   - `MEM/src/memory-v2-routes.ts` — the only multi-tier route module. Four of
     its handlers read the substrate and must survive —
     `memory/v2/concept-page`, `memory/v2/list-concept-pages`,
     `memory/v2/reembed-skills`, `memory/v2/validate` — so move them (endpoint
     strings, operation ids, and the `MEMORY_V2_DISABLED` code unchanged; they
     are frozen wire surface) into a substrate-owned routes module.
     `memory/v2/backfill` (operation id `memory_v2_backfill`) splits **by
     operation** rather than dying whole: `MemoryV2BackfillParams`'s `op` enum
     accepts three values, and `OP_TO_JOB_TYPE` sends `migrate` →
     `memory_v2_migrate` and `activation-recompute` →
     `memory_v2_activation_recompute` (both v2-engine jobs, retired in step 9)
     but `reembed` → `memory_v2_reembed`, a **substrate** job whose handler
     lives at `substrate/reembed-job.ts` and survives this deletion. Carry the
     `reembed` arm across with its frozen operation id and endpoint intact —
     narrow the `op` enum to `["reembed"]` and move the route with the other
     survivors — or land a compatibility-preserving replacement first. Deleting
     the route wholesale removes the only on-demand concept-page reembed
     command an operator has; every other enqueue of that job is automatic
     (consolidation follow-ups, boot maintenance, the embedding reconciler,
     workspace migrations). Delete the remaining engine-only routes:
     `compare-retrievers`, `concept-frequency`, `ema-scores`, `now-text`,
     `router-prompt-template`, `simulate-router`. Publishing substrate-named
     aliases and retiring the `memory/v2/*` spellings is a separate,
     client-coordinated change.
   - `cli/commands/memory/memory-v2.ts` — follows its routes rather than being
     deleted outright. `memory v2 reembed` (which posts the surviving `reembed`
     backfill op), `memory v2 reembed-skills`, and `memory v2 validate` keep
     working and move with the substrate routes; `memory v2 activation` (the
     `activation-recompute` op), `memory v2 ema`, `memory v2 simulate`, and
     `memory v2 compare` go with the engine. There is no `migrate` subcommand —
     the route is that job's only enqueue path.
2. Remove the v2 arm of `graph/conversation-graph-memory.ts` (activation-store,
   injection, now-text, router-pair imports) and the
   `shouldRunLegacyMemoryRetrieval` path in `hooks/user-prompt-submit.ts`.
3. Remove the v2-suppression strip in `daemon/conversation-runtime-assembly.ts`
   (`suppressV2MemoryForV3`, the `memory-v2-static` capture, and the
   `memoryV2StaticBlock` plumbing) — with no v2 engine there is nothing to
   suppress, but the static `<info>` injector itself stays.
4. Delete the v2 sections of `job-handlers.ts` marked
   `// V2 ENGINE — delete with v2`.
   `context-search/sources/memory-v2.ts` is misnamed, not v2-owned — it reads
   only `substrate/` and survives; rename it (the filename is not a frozen
   name) rather than deleting it.
5. Collapse `usesConceptPageMemory()` to `isMemoryEnabled()` and delete
   `isV2InjectionEngineActive`. For `isMemoryV2ExplicitlyDisabled`, decide what
   `daemon/embedding-reconcile.ts`'s explicit-opt-out branch should mean once
   `memory.v2.enabled` no longer exists — either drop the branch or re-express
   it against `memory.enabled`.
6. Drop the `memory.v2` schema subtree and the `orV2` fallback in
   `substrate/tuning.ts`, giving `memory.substrate` **real defaults** (the
   values currently in `config/schemas/memory-v2.ts`). Migration 135 copied
   user overrides, but it deliberately skips values equal to a shipped default
   — including `bm25_b: 0.75`, the pre-migration-075 default. On a workspace
   still persisting `0.75`, that value reaches the runtime **only** through the
   `orV2` fallback, so dropping the fallback silently retunes it to `0.4`.
   **Land a sweep migration first**: for every substrate tunable, copy the
   resolved effective value into `memory.substrate` wherever it is absent there
   and present under `memory.v2`, this time regardless of whether it matches a
   shipped default. Only then remove the fallback. Fold the parent
   `MemoryConfigSchema.superRefine`'s mixed-case weight check back into the
   substrate schema's own refinement.
7. Drop tables `memory_v2_activation_logs`, `memory_v2_injection_events`, and
   `activation_state` via a normal `persistence/migrations/` step (append-only —
   never edit an existing migration). Keep the `conversation-memory-purge.ts`
   deletes in sync.
8. Web surfaces to retire or repoint:
   - the inspector memory tab's `memoryV2Activation` context
     (`clients/web/src/domains/chat/inspector/inspector-api.ts`,
     `components/tabs/memory-tab.tsx`, `inspector-export.ts`) — this is the web
     end of the activation-log chain spelled out in the external-consumers
     section above; land it with the route, the daemon backfill, the
     `api/responses/memory-v2-activation-log.ts` wire contract, and the step-7
     table drop,
   - the router playground (`memory-router-playground-page.tsx`,
     `memory-router-simulator-api.ts`, and its `routes.tsx` entry),
   - `concept-page-api.ts` and
     `domains/intelligence/memory-v2/list-concept-pages.ts` — these call the
     two substrate-reading routes that survive step 1, so they keep working
     unchanged; only rename the modules/directory if you want to.
9. Move the retired v2-engine job types (`memory_v2_migrate`,
   `memory_v2_activation_recompute`) into `LEGACY_JOB_TYPES`.
10. Shrink the boundary guard: drop `v2` from `TIER_DIRS` /
    `FORBIDDEN_TIER_IMPORTS` and from `TIER_KEY_READ_ALLOWLIST`, and remove the
    `SPINE_ALLOWLIST` entries that were v2 composition points — only those left
    importing fewer than two tier directories. `fork-conversation-memory.ts`
    still spans `substrate/` + `v3/` and stays; let the reverse
    stale-exemption test tell you which entries actually went single-tier.

## Where to add new code

- New shared concept-page capability (retrieval, consolidation, page/edge
  storage, capability seeding) → `substrate/`.
- New lane, scorer, or injector behavior for the live engine → `v3/`.
- Tier-agnostic capture (retrospective, sweep triggers) → the plugin root.
- Multi-tier wiring → an existing spine composition point on the
  `SPINE_ALLOWLIST`; do not create a new one.
- **Never add to `v1/` or `v2/`.** Both are in retirement; a new feature there
  is work that has to be deleted twice.
