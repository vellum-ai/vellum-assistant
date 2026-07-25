# Memory Plugin — Agent Instructions

Rules for code under `assistant/src/plugins/defaults/memory/` (`MEM/` below).
For the user-facing architecture narrative — what each tier does and how the
write and read paths fit together — read `assistant/docs/architecture/memory.md`
first. This file is the layering contract: where code goes, which names can
never be renamed, and how to retire a tier.

## Directory / tier map

The plugin is layered into **tier directories** plus a **spine** that composes
them. Everything not listed as a tier directory is spine.

| Directory         | What lives there                                                                                                                                                                                                                                                                                                                                                                                                                  | Gate predicate                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `substrate/`      | The shared concept-page substrate (v2 + v3): `page-store`, `page-index`, `edge-index`, `qdrant`, `sim`, `sparse-bm25`, `spread`, `skill-store`, `cli-command-store`, `skill-content`, `cli-command-content`, `injected-block-slugs`, `static-context`, `boot-maintenance`, `frontmatter-sweep`, `consolidation-job`, `sweep-job`, `reembed-job`, `tuning`, `types`, `constants`, `prompts/`.                                      | `usesConceptPageMemory()`     |
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
  `segmenter`, `message-media`, `worker`, `worker-control`,
  `memory-recall-log-store`, `activation-session-store` (the onboarding
  activation rail — **not** a memory tier despite the name),
  `tail-reinjection-strip`, `task-memory-cleanup`, `conversation-memory-purge`,
  `conversation-memory-orphan-sweep`, `fork-conversation-memory`,
  `find-most-recent-retrospective-for`.
- The `memory-retrospective-*` family — tier-agnostic, gated on
  `memory.enabled` alone. The one exception is
  `memory-retrospective-skill-card.ts`, whose upstream enqueue only fires when
  `isProcToSkillsActive()` holds (v3-live).
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
`// V2 ENGINE — delete with v2` / `// SUBSTRATE (v2+v3)` banners —
`grep -rn 'delete with v1' src/plugins/defaults/memory/` finds every v1 arm,
and the `indexer.ts` / `injectors.ts` banners follow the same convention even
where the file touches a single tier.

Both rules are enforced by `__tests__/memory-tier-boundary-guard.test.ts`, which
also carries a reverse stale-exemption test: an allowlist entry whose multi-tier
import disappears fails loudly instead of lingering. Related guards:

- `src/__tests__/plugin-import-boundary-guard.test.ts` — relative-specifier
  baseline for the whole plugin tree.
- `src/__tests__/persistence-layering-guard.test.ts` — one-way
  memory → persistence direction, with the migration registry's
  `v1/graph/bootstrap` entry as a standing exception. It is not permanent: the
  v1 runbook moves `migrateToolCreatedItems` to a surviving home (the
  registration is append-only and must keep running), and the allowlist entry
  is repointed or dropped with it.
- `src/plugins/__tests__/plugin-state-boundary-guard.test.ts` — the
  grandfathered main-DB exception for this plugin (do not grow its surface).

## Which predicate gates what

All predicates live in `assistant/src/config/memory-v3-gate.ts`. **Nothing else
may read raw `memory.v2.*` / `memory.v3.*` tier keys** — those reads are a
layering leak, and the boundary guard's `TIER_KEY_READ_ALLOWLIST` pins the
frozen (path, namespace) exemptions.

| Predicate                      | True when                                                           | Gates                                                                              |
| ------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `isMemoryEnabled`              | `memory.enabled !== false` (master switch, defaults on)             | the whole memory system, the retrospective family, the jobs worker's memory drain  |
| `isMemoryV1Active`             | memory on AND no concept-page consumer                              | everything under `v1/`, the v1 Qdrant collection lifecycle, the v1 job handlers    |
| `isV2InjectionEngineActive`    | memory on AND `memory.v2.enabled === true` AND v3 not live          | v2's turn-time selection — the ONLY correct "should v2 select this turn" check     |
| `isMemoryV2ExplicitlyDisabled` | `memory.v2.enabled === false` (deliberately not the negation above) | `daemon/embedding-reconcile.ts`'s explicit-opt-out suppression                     |
| `usesConceptPageMemory`        | memory on AND (`memory.v3.live` OR `memory.v2.enabled`)             | everything under `substrate/`, the graph tool handlers, the static `<info>` block  |
| `isMemoryV3Live`               | `memory.v3.live === true`                                           | everything under `v3/`, and the v2 suppression at runtime assembly                 |
| `isMemoryGraphSupported`       | memory on AND v3 live                                               | `GET /memory-graph` and the `graph_supported` bit on `GET /memory/stats`           |
| `isProcToSkillsActive`         | v3 live                                                             | procedural-memory-as-skills (retrospective skill authoring + its permission grant) |

`memory.v2.enabled` defaults **true** and typically stays set on v3-live
assistants, so a direct read of it misbehaves under v3. That is exactly why
`isV2InjectionEngineActive` exists — reach for the predicate, never the key.

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

Because `memory.substrate` wins, a `config set` on a shadowed `memory.v2` twin
persists but changes nothing. `config/substrate-twin-shadowing.ts` pairs the two
namespaces so that no-op is visible: the `config_set` route returns a `warning`
naming the winning key, and `assistant config get` prints a `Shadowed:` line
with the value actually in effect.

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
- `v1_entry_reconcile_done` — the one-shot v1-entry reconcile marker
- v1: `graph_maintenance:{decay,consolidate,pattern_scan,narrative}:last_run`,
  `pkb_filing_last_run`, `pkb_compaction_last_run`,
  `graph_bootstrap:*`, `memory:backfill:*`
- `retro_sweep:last_run` — retrospective sweep cadence

### On-disk / vector-store names

| Name                          | Where                                                                        | Why frozen                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `memory_v2_concept_pages`     | `substrate/qdrant.ts` `MEMORY_V2_COLLECTION`                                 | Qdrant collection on disk. **Duplicated** in `persistence/embeddings/embedding-identity.ts` — change neither. |
| `memory_v3_sections`          | `v3/section-dense-store.ts` `SECTION_COLLECTION`                             | Qdrant collection on disk                                                                                     |
| `.memory-v2-reembed-required` | `substrate/qdrant.ts`                                                        | on-disk sentinel read across upgrades                                                                         |
| `memory/.v2-state/`           | `substrate/consolidation-job.ts`, `v2/migration.ts`, workspace migration 060 | persisted workspace path (consolidation lock, migration sentinel)                                             |

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
coordinate with the platform before touching them.

## Deletion runbook: v1

### Prerequisites that BLOCK deletion

Do not start until all three are resolved. Each is a live all-tier dependency
on v1-era machinery.

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
3. **The v1-entry reconcile goes with v1.** `maybeRunV1EntryReconcile` in
   `jobs-worker.ts` and its `v1_entry_reconcile_done` checkpoint exist only to
   re-run bootstrap + capability seeders when an assistant enters v1. Three
   sites carry it and all go in the same change: the reconcile itself,
   `rearmV1EntryReconcile` (clears the marker on every tick that is off v1), and
   the boot-time claim in `startup.ts` that keeps the daemon's own seeding pass
   from racing the worker's.

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
   - **The persistence-layering guard's allowlist.**
     `assistant/src/__tests__/persistence-layering-guard.test.ts` maps
     `assistant/src/persistence/steps.ts` → `{"v1/graph/bootstrap"}` in
     `PERSISTENCE_TO_MEMORY_ALLOWLIST`. Repoint that entry at the new module,
     or drop it entirely if the function lands inside `persistence/`; the
     guard's stale-entry test fails on a left-behind exemption.

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
6. Delete the v1 sections of the spine files, marked
   `// V1 — delete with v1` / `// ── V1 (legacy engine) …`:
   `startup.ts` (three blocks), `jobs-worker.ts`, `job-handlers.ts`,
   `indexer.ts`, `injectors.ts` (the PKB injector pair).
7. Delete `V1_QDRANT_JOB_TYPES` and the `SweepPostponedUnderV2Error` postpone
   path in `jobs-worker.ts`, plus the v1 job handlers
   (`v1/job-handlers/{backfill,embedding,index-maintenance}.ts`) and their
   `job-handlers.ts` registrations. Move retired job types into
   `LEGACY_JOB_TYPES`; do NOT remove them from `MemoryJobType`.
8. Delete the v1 Qdrant collection lifecycle in `startup.ts` (the
   `config.memory.qdrant.collection` `ensureCollection` block and the PKB index
   reconcile). Leave the lexical-messages collection alone — it is independent.
9. Collapse `isMemoryV1Active` call sites, then delete the predicate.
10. `memoryTier()`'s `"v1"` bucket becomes unreachable. **Coordinate with the
    platform telemetry dashboard before removing the bucket** — the
    `memory_tier` watchdog's value set is a dashboard contract.
11. Shrink the boundary guard: drop `v1` from `TIER_DIRS` /
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

Beyond the composition points the steps below name, four production files still
import `v2/` — three of them from outside the plugin entirely. Deleting the tier
without handling them cannot produce a buildable tree.

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
   `harness/`. (`cli/commands/memory/memory-v2-compare-render.ts` carries the
   same type import and is deleted whole in step 1.)

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
   values currently in `config/schemas/memory-v2.ts`). Workspace migration 135
   has already copied user overrides, so no data migration is needed here.
   Fold the parent `MemoryConfigSchema.superRefine`'s mixed-case weight check
   back into the substrate schema's own refinement.
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
