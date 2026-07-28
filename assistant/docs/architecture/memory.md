# Memory Architecture

Assistant memory and context-injection architecture. For the memory plugin's
internal layering contract — the tier/directory map, the frozen-name registry,
and the v1/v2 deletion runbooks — see
`src/plugins/defaults/memory/AGENTS.md`.

## Tiers

An assistant runs exactly one memory tier, derived by `memoryTier()` in
`src/config/memory-tier.ts`:

| Tier  | Selected when                                | Injection source                                 |
| ----- | -------------------------------------------- | ------------------------------------------------ |
| `off` | `memory.enabled === false`                   | none                                             |
| `v3`  | `memory.v3.live === true`                    | v3 lanes + card (`v3/injector.ts`)               |
| `v2`  | `memory.v2.enabled === true` and v3 not live | v2 activation/router engine (`v2/`)              |
| `v1`  | otherwise                                    | PKB `<knowledge_base>` block (`v1/pkb/`, legacy) |

New workspaces are switched to `v3` at creation (workspace migration 105).
`v1` and the `v2` injection engine are in retirement; v3 is the target state.

### Tier predicates

Tier decisions are made through named predicates in
`src/config/memory-v3-gate.ts`, never by reading `memory.v2.*` / `memory.v3.*`
directly — `memory.v2.enabled` defaults true and typically stays set on v3-live
assistants, so a raw read misbehaves under v3. `memoryTier()` is fully derived
from those predicates, so the telemetry buckets and the runtime gates can never
disagree. The two that shape this document are `usesConceptPageMemory()` (the
substrate is live) and `isMemoryV3Live()` (v3 is the injected source).

The full predicate table — what each one is true for and, importantly, exactly
which machinery it gates — is in `src/plugins/defaults/memory/AGENTS.md`, which
is authoritative. Consult it before gating new code.

The memory plugin is layered into tier directories (`substrate/`, `v1/`, `v2/`,
`v3/`) that never import each other — multi-tier composition is confined to a
frozen set of spine files, and both rules plus the raw-tier-key ban are enforced
by `src/plugins/defaults/memory/__tests__/memory-tier-boundary-guard.test.ts`.

## The concept-page substrate (`substrate/`)

The durable core shared by v2 and v3 is the **concept-page substrate**:
markdown articles under `memory/concepts/` (plus the aggregate views
`essentials.md`, `threads.md`, `recent.md` and the intake `buffer.md`), their
cached page index, and the concept-page Qdrant collection with dense + BM25
sparse vectors. It lives in
`src/plugins/defaults/memory/substrate/`; it is memory-v3's foundation, and
the v2 injection engine is a second (transitional) consumer.

Substrate activation is a single predicate, `usesConceptPageMemory()` in
`src/config/memory-v3-gate.ts`: memory on AND (`memory.v3.live` OR
`memory.v2.enabled`). Every substrate gate — the write path, consolidation
scheduling, boot-time maintenance, capability seeding, the static `<info>`
memory block, and the v1-machinery suppressions — keys on it. When the v2
engine is removed, the predicate collapses to `memory.enabled`.

### Write path

```mermaid
graph LR
    REM["remember tool /<br/>POST /v1/memory/remember"] --> BUF["memory/buffer.md<br/>+ archive/&lt;date&gt;.md"]
    SWEEP["idle sweep (opt-in)"] --> BUF
    BUF --> CONS["memory_v2_consolidate job<br/>(background agent run)"]
    CONS --> PAGES["concept pages<br/>memory/concepts/**"]
    CONS --> VIEWS["essentials / threads / recent"]
    CONS --> REEMBED["memory_v2_reembed →<br/>concept-page Qdrant collection"]
    CONS --> MAINT["memory_v3_maintain<br/>(v3-live follow-up)"]
```

- `handleRemember` (`graph/tool-handlers.ts`) appends timestamped bullets to
  `memory/buffer.md` + the daily archive whenever memory is enabled. Facts may
  carry `[[slug]]` page hints that consolidation reads first when filing.
- **Consolidation** (`substrate/consolidation-job.ts`) is a background
  agent conversation that files buffer entries into concept pages, rewrites
  the aggregate views, and trims the buffer. Scheduling
  (`maybeEnqueueGraphMaintenanceJobs` in `jobs-worker.ts`):
  - interval-based (`memory.v2.consolidation_interval_hours`, default 8h),
    skipped below `MIN_BUFFER_LINES_FOR_CONSOLIDATION` (10) **unless** the
    non-empty buffer has sat unwritten for a full interval (staleness
    override — a small buffer can never sit unconsolidated forever);
  - size-triggered at `consolidation_max_buffer_lines` (default 100);
  - nudged by the create-memory route after a user-authored save (deduped,
    failure-backoff-respecting);
  - manual "Run now" via `POST /v1/consolidation/run-now`.
    Failed runs enter an exponential backoff (transient vs billing curves).

### Read paths

- **v3 (live)**: per-turn lane selection over concept pages — dense/sparse
  retrieval (`substrate/sim.ts` over the concept-page collection),
  learned edges, entity/hot/fresh/core sets — rendered as the `<memory>`
  card by `v3/injector.ts`. The static `<info>` block
  (`substrate/static-context.ts`: essentials/threads/recent/buffer) also
  injects whenever the substrate is active.
- **v2 (transitional)**: activation/router engine in `v2/`
  (`activation.ts`, `router.ts`, `reranker.ts`, `injection.ts`) selects
  concept pages per turn. Suppressed at assembly when v3 is live. Gated on
  `memory.v2.enabled` and deleted with it.
- **v1 (legacy)**: PKB retrieval over the v1 Qdrant collection. All v1
  machinery (graph extraction, summarization, PKB indexing/filing, PKB
  injection) is suppressed while the substrate is active.

### Boot-time maintenance

`substrate/boot-maintenance.ts`, invoked from the memory plugin's
startup path: skill + CLI-command capability seeding into the concept-page
collection, BM25 corpus-stats rebuild, and collection schema
reconcile/reembed. All gated on `usesConceptPageMemory()`.

## Memory graph (visualization)

`GET /v1/memory-graph` (`graph-topology/build-memory-graph.ts`) renders the
substrate as a backend-agnostic node/edge graph for the web Memory tab:
concept pages as nodes, authored links + learned co-selection associations as
edges, and `memory/buffer.md` entries as `pending` nodes
(`graph-topology/pending-buffer.ts`) so a just-saved fact appears before
consolidation files it. Gated on `isV3TierActive()` — memory enabled and
`memory.v3.live` — which is also the source of the cheap `graph_supported`
bit on `GET /v1/memory/stats`, so the advertised capability and the actual
build can never drift. The same predicate gates procedural-memory-as-skills,
so both v3-tier features honor the Memory opt-out identically. `GET /v1/memory-graph-node` serves node detail,
including `buffer:` ids for pending entries.

`GET /v1/memory/stats` also reports `tier` (`memoryTier()`: `off` / `v1` /
`v2` / `v3`), which is what lets the web Memory tab explain an unavailable
graph instead of stating a bare "not available": `off` is the user's own
Memory opt-out and points at Settings, while `v1`/`v2` point at the v3
migration. `graph_supported` is exactly `tier === "v3"`, so the capability
bit and its explanation are derived from one gate.

## Capture beyond `remember`

- **Retrospective** (`memory-retrospective-*.ts`): periodic per-conversation
  review pass that saves what wasn't captured in the moment (and, on v3-live
  assistants, authors procedural skills).
- **Sweep** (`substrate/sweep-job.ts`, `sweep_enabled` substrate tunable,
  default off): idle-debounced extraction of recent messages into the buffer.

## Config namespaces

Substrate tuning resolves from `memory.substrate.*` with fallback to the
historical `memory.v2.*` keys: every substrate tunable (consolidation
intervals/limits, embedding + retrieval weights, BM25 parameters, sweep
toggle) is optional under `memory.substrate`, and `resolveSubstrateTuning`
(`substrate/tuning.ts`) — the substrate's single config choke point — falls
back per key to the `memory.v2` twin, which supplies the effective defaults
and which the v2 injection engine also reads. v2 engine-only keys (activation
weights, router, rerank) live only under `memory.v2.*`, and v3 lane tuning
under `memory.v3.*`. The `memory.v2.enabled` flag gates only the v2 injection
engine's turn-time selection; the substrate runs whenever
`usesConceptPageMemory()` holds.

`src/plugins/defaults/memory/AGENTS.md` carries the details that matter when
you touch this: the three substrate keys whose names differ from their v2 twin,
the three disjoint places the dense/sparse sum-to-1 invariant is checked, and
why workspace migration 135 copies only explicitly-set NON-DEFAULT `memory.v2`
tunables into `memory.substrate`.
