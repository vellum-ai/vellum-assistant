# Memory Architecture

Assistant memory and context-injection architecture details.

## Simplified Memory System (Default)

The simplified memory system replaces the legacy item/tier/staleness model with a two-layer architecture: a **brief** (time-relevant context + open loops) plus **archive recall** (observations, chunks, episodes). It is enabled by default via `memory.simplified.enabled: true`.

### Architecture Overview

```mermaid
graph TB
    subgraph "Write Path (Simplified)"
        MSG["Incoming Message"] --> REDUCER["Memory Reducer<br/>(LLM-backed, delayed)"]
        REDUCER --> TC["time_contexts<br/>(brief state)"]
        REDUCER --> OL["open_loops<br/>(brief state)"]
        REDUCER --> OBS_R["Archive Observations<br/>(reducer output)"]
        REDUCER --> EP_R["Archive Episodes<br/>(reducer output)"]

        MSG --> INDEXER["Dual-Write Indexer"]
        INDEXER --> OBS["memory_observations"]
        INDEXER --> CHK["memory_chunks<br/>(content-hash deduped)"]

        COMPACT["Context Compaction"] --> EP["memory_episodes"]
    end

    subgraph "Read Path (Simplified)"
        TURN["User Turn"] --> BRIEF["Memory Brief Compiler"]
        BRIEF --> TC
        BRIEF --> OL
        BRIEF --> BRIEF_OUT["&lt;memory_brief&gt;<br/>Time contexts + Open loops"]

        TURN --> RECALL_GATE["Archive Recall Gate<br/>(keyword + pattern match)"]
        RECALL_GATE --> PREFETCH["Prefetch<br/>(episodes + observations)"]
        RECALL_GATE --> DEEP["Deeper Recall<br/>(episodes + observations + chunks)"]
        DEEP --> RECALL_OUT["&lt;supporting_recall&gt;<br/>Source-linked bullets"]

        BRIEF_OUT --> INJECT["Runtime Injection<br/>(prepend to user message)"]
        RECALL_OUT --> INJECT
    end

    subgraph "Memory Tools (Simplified)"
        SAVE["memory_save"] --> OBS
        RECALL_TOOL["memory_recall"] --> RECALL_GATE
    end
```

### Tables

| Table                 | Purpose                                         | Write source                                            |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `time_contexts`       | Bounded temporal windows for the brief          | Reducer                                                 |
| `open_loops`          | Unresolved follow-up items for the brief        | Reducer                                                 |
| `memory_observations` | Raw factual statements from conversation turns  | Indexer dual-write, reducer, memory_save tool, backfill |
| `memory_chunks`       | Deduplicated content units for embedding/recall | Derived from observations, content-hash deduped         |
| `memory_episodes`     | Narrative summaries of interaction spans        | Compaction, reducer, backfill                           |

### Reducer

The memory reducer is a provider-backed (LLM) background process that analyzes unreduced conversation turns and produces structured CRUD operations for brief-state tables and archive candidates. It runs on a delay after conversation idle or switch, scheduled via the `reduce_conversation_memory` job. The reducer is side-effect-free; results are applied transactionally via `applyReducerResult`.

### Brief

The memory brief is compiled fresh on every turn from active `time_contexts` and `open_loops`. It is rendered as `<memory_brief>` XML and injected as a text block prepended to the user message. Empty sections are omitted.

### Archive Recall

Archive recall runs when the user's turn triggers a recall gate (past-reference language, analogy/debugging patterns, or strong prefetch hits). It queries episodes, observations, and chunks via keyword matching and returns up to 3 source-linked bullets in `<supporting_recall>`. No recall tag is emitted when results are empty.

### Backfill

Existing users have legacy data in `memory_segments`, `memory_summaries`, and `memory_items`. The `backfill_simplified_memory` job migrates this data into the simplified tables:

- `memory_segments` -> `memory_observations` + `memory_chunks`
- `memory_summaries` -> `memory_episodes`
- Active, high-confidence `memory_items` -> `memory_observations` + `memory_chunks`, with unambiguous items also mapped to `time_contexts` or `open_loops`

The backfill is idempotent (content-hash dedup + checkpoint tracking), processes in batches of 200, and self-enqueues continuation jobs for large datasets.

### Rollback Posture

The legacy memory system remains fully available as a short-lived rollback path:

- **Legacy tables are preserved**: `memory_segments`, `memory_items`, `memory_summaries`, and `memory_item_sources` remain in the schema and continue to receive writes from the legacy indexer/extraction pipeline.
- **Flag-gated**: Setting `memory.simplified.enabled: false` reverts to the legacy item/tier/staleness model for both read and write paths.
- **Memory tools**: `memory_save` and `memory_recall` check the flag at call time and route to the appropriate path (simplified observations or legacy items).
- **No data loss**: The backfill copies data without deleting legacy rows. Both systems can coexist.

### Key Files

| File                                                              | Role                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `assistant/src/config/schemas/memory-simplified.ts`               | Config schema with `enabled: true` default       |
| `assistant/src/memory/reducer.ts`                                 | Provider-backed reducer (LLM call + parse)       |
| `assistant/src/memory/reducer-store.ts`                           | Transactional result application                 |
| `assistant/src/memory/reducer-scheduler.ts`                       | Idle-delay and conversation-switch scheduling    |
| `assistant/src/memory/archive-store.ts`                           | Observation/chunk/episode write helpers          |
| `assistant/src/memory/archive-recall.ts`                          | Prefetch + deeper recall over archive tables     |
| `assistant/src/memory/brief.ts`                                   | Brief composer (time contexts + open loops)      |
| `assistant/src/memory/job-handlers/backfill-simplified-memory.ts` | Legacy data migration handler                    |
| `assistant/src/tools/memory/handlers.ts`                          | Memory tool handlers (simplified/legacy routing) |
| `assistant/src/__tests__/simplified-memory-e2e.test.ts`           | End-to-end test suite                            |

---

## Legacy Memory System — Daemon Data Flow

> **Note**: The legacy system below is retained as rollback support. New installations use the simplified system by default.

## Memory System — Daemon Data Flow

```mermaid
graph TB
    subgraph "Write Path"
        MSG_IN["Incoming Message<br/>(HTTP)"]
        STORE["ConversationStore.addMessage()<br/>Drizzle ORM → SQLite"]
        INDEX["Memory Indexer"]
        SEGMENT["Split into segments<br/>→ memory_segments"]
        EXTRACT_JOB["Enqueue extract_items job<br/>→ memory_jobs"]
        SUMMARY_JOB["Enqueue build_conversation_summary<br/>→ memory_jobs"]
    end

    subgraph "Background Worker (polls every 1.5s)"
        WORKER["MemoryJobsWorker"]
        EMBED_SEG["embed_segment<br/>→ Qdrant (dense + sparse)"]
        EMBED_ITEM["embed_item<br/>→ Qdrant (dense + sparse)"]
        EMBED_SUM["embed_summary<br/>→ Qdrant (dense + sparse)"]
        EXTRACT["extract_items<br/>→ memory_items +<br/>memory_item_sources<br/>(LLM-directed supersession)"]
        CLEAN_SUPERSEDED["cleanup_stale_superseded_items<br/>delete stale superseded items<br/>and Qdrant vectors"]
        BUILD_SUM["build_conversation_summary<br/>→ memory_summaries"]
    end

    subgraph "Embedding Provider Selection (selectEmbeddingBackend)"
        PROVIDER_SELECT["Provider Selection<br/>auto: local → OpenAI → Gemini → Ollama<br/>or explicit config override"]
        LOCAL_EMB["Local (ONNX)<br/>bge-small-en-v1.5"]
        OAI_EMB["OpenAI<br/>text-embedding-3-small"]
        GEM_EMB["Gemini<br/>gemini-embedding-001"]
        OLL_EMB["Ollama<br/>nomic-embed-text"]
    end

    subgraph "Sparse Embedding (in-process)"
        SPARSE_GEN["generateSparseEmbedding()<br/>TF-IDF, FNV-1a hashing<br/>(no external calls)"]
    end

    subgraph "Qdrant Vector Store"
        DENSE["Named vector: dense<br/>(cosine similarity)"]
        SPARSE["Named vector: sparse<br/>(TF-IDF based)"]
        RRF["Query API:<br/>Reciprocal Rank Fusion"]
    end

    subgraph "Read Path (Memory Recall)"
        NEEDS_MEM["needsMemory gate<br/>(skip short/empty/tool-result turns)"]
        QUERY["Recall Query Builder<br/>User request + compacted context summary"]
        BUDGET["Dynamic Recall Budget<br/>computeRecallBudget()<br/>from prompt headroom"]
        EMBED_Q["Generate dense + sparse<br/>query embeddings"]
        HYBRID["Hybrid Search<br/>dense + sparse RRF on Qdrant"]
        RECENCY["Recency Search<br/>conversation-scoped, DB only"]
        MERGE["Merge + Deduplicate<br/>weighted score combination"]
        SCOPE["Scope Filter<br/>scope_id filtering<br/>(strict | global_fallback)<br/>Private conversations: own scope + 'default'"]
        TIER["Tier Classification<br/>score > 0.8 → tier 1<br/>score > 0.6 → tier 2<br/>below → dropped"]
        STALE["Staleness Computation<br/>kind-specific lifetimes<br/>+ reinforcement from<br/>source conversation count"]
        DEMOTE["Stale Demotion<br/>very_stale tier 1 → tier 2"]
        INJECT["Two-Layer XML Injection<br/>budget-aware rendering"]
        TELEMETRY["Emit memory_recalled<br/>tier counts + hybrid search ms +<br/>staleness stats"]
    end

    subgraph "Context Window Management"
        CTX["Session Context"]
        COMPACT["Compaction trigger<br/>(approaching token limit)"]
        GUARDS["Cooldown + early-exit guards<br/>with severe-pressure override"]
        SUMMARIZE["Summarize old messages<br/>→ context_summary on conversation"]
        REPLACE["Replace old messages<br/>with summary in context<br/>(originals stay in DB)"]
    end

    subgraph "Overflow Recovery (context-overflow-reducer.ts)"
        OVF_PRE["Preflight budget check<br/>estimate > maxInputTokens × (1 − safetyMarginRatio)"]
        OVF_T1["Tier 1: Forced compaction<br/>force=true, minKeepRecentUserTurns=0"]
        OVF_T2["Tier 2: Tool-result truncation<br/>4,000 chars per result"]
        OVF_T3["Tier 3: Media/file stubbing"]
        OVF_T4["Tier 4: Injection downgrade<br/>→ minimal mode"]
        OVF_POLICY["Overflow policy resolver<br/>auto_compress / request_approval / fail_gracefully"]
        OVF_APPROVE["Approval gate<br/>PermissionPrompter"]
        OVF_DENY["Graceful deny message<br/>(not conversation_error)"]
    end

    MSG_IN --> STORE
    STORE --> INDEX
    INDEX --> SEGMENT
    INDEX --> EXTRACT_JOB
    INDEX --> SUMMARY_JOB

    WORKER --> EMBED_SEG
    WORKER --> EMBED_ITEM
    WORKER --> EMBED_SUM
    WORKER --> EXTRACT
    WORKER --> CLEAN_SUPERSEDED
    WORKER --> BUILD_SUM

    EMBED_SEG --> PROVIDER_SELECT
    EMBED_ITEM --> PROVIDER_SELECT
    EMBED_SUM --> PROVIDER_SELECT
    PROVIDER_SELECT --> LOCAL_EMB
    PROVIDER_SELECT --> OAI_EMB
    PROVIDER_SELECT --> GEM_EMB
    PROVIDER_SELECT --> OLL_EMB
    LOCAL_EMB --> DENSE
    OAI_EMB --> DENSE
    GEM_EMB --> DENSE
    OLL_EMB --> DENSE
    EMBED_SEG --> SPARSE_GEN
    EMBED_ITEM --> SPARSE_GEN
    EMBED_SUM --> SPARSE_GEN
    SPARSE_GEN --> SPARSE

    NEEDS_MEM --> QUERY
    QUERY --> EMBED_Q
    EMBED_Q --> PROVIDER_SELECT
    EMBED_Q --> SPARSE_GEN
    EMBED_Q --> HYBRID
    HYBRID --> RRF
    QUERY --> RECENCY
    HYBRID --> SCOPE
    RECENCY --> SCOPE
    SCOPE --> MERGE
    MERGE --> TIER
    TIER --> STALE
    STALE --> DEMOTE
    BUDGET --> INJECT
    DEMOTE --> INJECT
    INJECT --> TELEMETRY

    CTX --> COMPACT
    COMPACT --> GUARDS
    GUARDS --> SUMMARIZE
    SUMMARIZE --> REPLACE

    %% Overflow recovery flow
    CTX --> OVF_PRE
    OVF_PRE --> OVF_T1
    OVF_T1 --> OVF_T2
    OVF_T2 --> OVF_T3
    OVF_T3 --> OVF_T4
    OVF_T4 --> OVF_POLICY
    OVF_POLICY -->|"interactive"| OVF_APPROVE
    OVF_POLICY -->|"non-interactive"| OVF_T1
    OVF_APPROVE -->|"denied"| OVF_DENY
    OVF_APPROVE -->|"approved"| OVF_T1
    OVF_T1 -.->|"uses"| SUMMARIZE
```

### Context Compaction and Overflow Recovery Interaction

Normal context compaction (the "Context Window Management" subgraph above) runs proactively as the conversation approaches the token limit, using cooldown guards and a severity-pressure override to balance compaction frequency against cost. This is the primary defense against context overflow.

When compaction alone is insufficient — either because the conversation grew too fast between turns or because a single turn contains extremely large payloads — the overflow recovery pipeline takes over. The pipeline's first tier (forced compaction) reuses the same `maybeCompact()` summarization machinery but with emergency parameters: `force: true` bypasses cooldown guards, `minKeepRecentUserTurns: 0` allows summarizing even the most recent history, and `targetInputTokensOverride` sets a tighter budget. Subsequent tiers (tool-result truncation, media stubbing, injection downgrade) apply progressively more aggressive payload reduction without involving the summarizer.

If all four reducer tiers are exhausted, the overflow policy resolver determines whether to compress the latest user turn. In interactive sessions, the user is prompted for approval before this lossy step. If the user declines, the session emits a graceful assistant explanation message rather than a `conversation_error`, ending the turn cleanly. Non-interactive sessions auto-compress without prompting.

The key distinction: normal compaction is a cost-optimized background process that preserves conversational quality; overflow recovery is a convergence mechanism that prioritizes session survival over context richness. Both share the same summarization infrastructure but operate under different pressure thresholds and constraints.

### Memory Retrieval Config Knobs (Defaults)

| Config key                                            |                   Default | Purpose                                                              |
| ----------------------------------------------------- | ------------------------: | -------------------------------------------------------------------- |
| `memory.retrieval.dynamicBudget.enabled`              |                    `true` | Toggle per-turn recall budget calculation from live prompt headroom. |
| `memory.retrieval.dynamicBudget.minInjectTokens`      |                    `1200` | Lower clamp for computed recall injection budget.                    |
| `memory.retrieval.dynamicBudget.maxInjectTokens`      |                   `10000` | Upper clamp for computed recall injection budget.                    |
| `memory.retrieval.dynamicBudget.targetHeadroomTokens` |                   `10000` | Reserved headroom to keep free for response generation/tool traces.  |
| `memory.retrieval.maxInjectTokens`                    |                   `10000` | Static fallback when dynamic budget is disabled.                     |
| `memory.retrieval.scopePolicy`                        | `'allow_global_fallback'` | Scope filtering strategy: `'strict'` or `'allow_global_fallback'`.   |

### Memory Recall Debugging Playbook

1. Run a recall-heavy turn and inspect `memory_recalled` events in the client trace stream.
2. Validate baseline counters:
   - `semanticHits`
   - `tier1Count`, `tier2Count`
   - `hybridSearchLatencyMs`
   - `mergedCount`, `selectedCount`, `injectedTokens`, `latencyMs`
3. Cross-check context pressure with `context_compacted` events:
   - `previousEstimatedInputTokens` vs `estimatedInputTokens`
   - `summaryCalls`, `compactedMessages`
4. If dynamic budget is enabled, verify `injectedTokens` stays within the configured min/max clamps for `dynamicBudget`.
5. Inspect staleness distribution in debug logs:
   - `fresh`, `aging`, `stale`, `very_stale` counts
   - Check for unexpected tier demotions (very_stale tier 1 items demoted to tier 2)
6. Before tuning ranking settings, run:
   - `cd assistant && bun test src/__tests__/context-memory-e2e.test.ts`
   - `cd assistant && bun test src/__tests__/memory-context-benchmark.benchmark.test.ts`
   - `cd assistant && bun test src/__tests__/memory-recall-quality.test.ts`
7. After tuning, rerun the same suite and compare:
   - tier counts (coverage)
   - selected count / injected tokens (budget safety)
   - latency and ordering regressions via top candidate snapshots

### Write Path — Extraction and Supersession

```mermaid
stateDiagram-v2
    [*] --> ActiveItem : extract_items\n(LLM or pattern-based)
    ActiveItem --> Superseded : explicit supersession\n(overrideConfidence = "explicit"\n+ supersedes = oldItemId)
    ActiveItem --> ActiveItem : tentative/inferred override\n(both items coexist)
    ActiveItem --> Superseded : subject-match fallback\n(same kind + subject,\nno LLM-directed supersession)
    Superseded --> Cleanup : cleanup_stale_superseded_items\n(delete from DB + Qdrant)
```

**Item extraction** uses LLM-powered extraction (with pattern-based fallback) to identify memorable information from conversation messages. Each extracted item belongs to one of eight kinds:

| Kind         | Description                                                        | Base Lifetime |
| ------------ | ------------------------------------------------------------------ | ------------- |
| `identity`   | Personal info, facts, relationships                                | 6 months      |
| `preference` | Likes, dislikes, preferred approaches/tools                        | 3 months      |
| `journal`    | Experiential reflections, journal-style notes, forward-looking items | 3 months      |
| `constraint` | Rules, requirements, directives                                    | 1 month       |
| `project`    | Project details, repos, tech stacks, action items                  | 2 weeks       |
| `decision`   | Choices made, approaches selected                                  | 2 weeks       |
| `event`      | Deadlines, milestones, meetings, dates                             | 3 days        |
| `capability` | Skill catalog entries (system-generated, not LLM-extracted)        | never expires |

**Supersession chains** replace the old conflict resolution system. When the LLM extracts a new item that updates an existing one, it sets `supersedes` to the old item's ID and `overrideConfidence` to one of three levels:

- `explicit` — Clear override signal (e.g. "I changed my mind about X"). The old item is marked `superseded` and removed from Qdrant.
- `tentative` — Ambiguous; both items coexist as active.
- `inferred` — Weak signal; both items coexist (logged for observability).

A fallback subject-match supersession also runs for items without LLM-directed supersession: same kind + same subject = old item superseded.

**Semantic density gating** skips extraction for messages that are too short, consist of low-value filler (e.g. "ok", "thanks", "got it"), or have fewer than 3 words.

### Read Path — Hybrid Recall Pipeline

The recall pipeline runs on every turn that passes the `needsMemory` gate (skips empty, very short, and tool-result-only turns). The pipeline is orchestrated by `buildMemoryRecall()` in `retriever.ts`:

1. **Query construction** (`query-builder.ts`): Combines the user request text (up to 2000 chars) with any in-context session summary (up to 1200 chars).

2. **Dense + sparse embedding generation**: The query is embedded using the configured embedding provider (auto-selection order: local → OpenAI → Gemini → Ollama). A TF-IDF sparse embedding is also generated in-process using FNV-1a hashing to a 30K vocabulary with sub-linear TF weighting and L2 normalization.

3. **Hybrid search on Qdrant**: When both dense and sparse vectors are available, the pipeline uses Qdrant's query API with two prefetch stages (dense and sparse, each fetching up to 40 candidates) fused via Reciprocal Rank Fusion (RRF). Falls back to dense-only search when sparse vectors are unavailable.

4. **Recency supplement**: A DB-only recency search fetches the 5 most recent segments from the current conversation, providing conversation-local context even when vector search misses.

5. **Merge and deduplicate**: Hybrid and recency candidates are merged by key. Duplicate entries keep the highest scores from each source. A weighted final score is computed: `semantic * 0.7 + recency * 0.2 + confidence * 0.1`.

6. **Tier classification** (`tier-classifier.ts`): Score-based, deterministic classification:
   - `finalScore > 0.8` → **tier 1** (high relevance)
   - `finalScore > 0.6` → **tier 2** (possibly relevant)
   - Below 0.6 → dropped

7. **Staleness computation** (`staleness.ts`): Each item candidate is annotated with a staleness level based on its age relative to a kind-specific base lifetime (see table above). The effective lifetime is extended by a reinforcement factor: `baseLifetime * (1 + 0.3 * (sourceConversationCount - 1))`, so items mentioned across multiple conversations age more slowly. Staleness levels:
   - `ratio < 0.5` → `fresh`
   - `ratio <= 1.0` → `aging`
   - `ratio <= 2.0` → `stale`
   - `ratio > 2.0` → `very_stale`

8. **Stale demotion**: `very_stale` tier 1 candidates are demoted to tier 2, preventing old information from occupying prime injection space.

9. **Two-layer XML injection** (`formatting.ts`): Budget-aware rendering into four XML sections:

   ```xml
   <memory_context __injected>

   <user_identity>
   <!-- identity-kind tier 1 items (plain statements) -->
   </user_identity>

   <relevant_context>
   <!-- tier 1 non-identity/non-preference items (episode-wrapped with source attribution) -->
   </relevant_context>

   <applicable_preferences>
   <!-- preference/constraint tier 1 items (plain statements) -->
   </applicable_preferences>

   <possibly_relevant>
   <!-- tier 2 items (episode-wrapped with staleness annotations) -->
   </possibly_relevant>

   </memory_context>
   ```

   Empty sections are omitted. Each section has a per-item token budget (150 tokens for tier 1, 100 for tier 2). Tier 1 sections consume budget first; tier 2 uses the remainder.

10. **Injection strategy**: The rendered `<memory_context __injected>` block is prepended as a text content block to the last user message (`injectMemoryRecallAsUserBlock`), following the same pattern as workspace, temporal, and other runtime injections. Stripping is handled by the generic `stripUserTextBlocksByPrefix` mechanism matching the `<memory_context __injected>` prefix (with a backward-compat entry for the legacy `<memory_context>` prefix from older history). This avoids synthetic message pairs and preserves prompt prefix caching between turns.

### Internal-Only Trust Gating

**Provenance-aware pipeline**: Every persisted message carries provenance metadata (`provenanceTrustClass`, `provenanceSourceChannel`, etc.) derived from the `TrustContext` resolved by `trust-context-resolver.ts`.

Two trust gates enforce trust-class-based access control over the memory pipeline:

- **Write gate** (`indexer.ts`): The `extract_items` job only runs for messages from trusted actors (guardian or undefined provenance). Messages from untrusted actors (`trusted_contact`, `unknown`) are still segmented and embedded — so they appear in conversation context — but no item extraction is triggered. This prevents untrusted channels from injecting or mutating long-term memory items.

- **Read gate** (`conversation-memory.ts`): When the current session's actor is untrusted, the memory recall pipeline returns a no-op context — no recall injection. This ensures untrusted actors cannot surface or exploit previously extracted memory.

Trust policy is **cross-channel and trust-class-based**: decisions use `trustContext.trustClass`, not the channel string. Desktop sessions default to `trustClass: 'guardian'`. External channels (Telegram, WhatsApp, phone) provide explicit trust context via the resolver. Messages without provenance metadata are treated as trusted (guardian); all new messages carry provenance.

### Embedding Backend Selection

The embedding backend is selected based on `memory.embeddings.provider` config:

- `auto` (default): Tries local → OpenAI → Gemini → Ollama, using the first available.
- `local`: ONNX-based local model (bge-small-en-v1.5). Lazy-loaded to avoid crashing in compiled binaries where onnxruntime-node is unavailable.
- `openai`: OpenAI text-embedding-3-small. Requires an OpenAI API key in secure storage.
- `gemini`: Gemini gemini-embedding-001. Requires a Gemini API key in secure storage. Only backend supporting multimodal embeddings (images, audio, video).
- `ollama`: Ollama nomic-embed-text. Requires Ollama to be configured.

An in-memory LRU vector cache (32 MB cap, keyed by `sha256(provider + model + content)`) avoids redundant embedding calls for identical content. Sparse embeddings are generated in-process (no external calls).

### Graceful Degradation

When the embedding backend or Qdrant is unavailable:

- A **circuit breaker** on Qdrant (`qdrant-circuit-breaker.ts`) tracks consecutive failures and short-circuits search calls when the breaker is open.
- If embedding generation fails and `memory.embeddings.required` is `true`, recall returns an empty result with a degradation status (`embedding_generation_failed` or `embedding_provider_down`).
- If embeddings are optional (default), the pipeline falls back to recency-only search.
- Degradation status is reported to clients via `memory_status` events.

---

## Private Conversations — Isolated Memory and Strict Side-Effect Controls

Private conversations provide per-conversation memory isolation and stricter tool execution controls. When a conversation is created with `conversationType: 'private'`, the daemon assigns it a unique memory scope and enforces additional safeguards to prevent unintended side effects.

### Schema Columns

Two columns on the `conversations` table drive the feature:

| Column              | Type                               | Values                                                                               | Purpose                                                                                                                        |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `conversation_type` | `text NOT NULL DEFAULT 'standard'` | `'standard'` or `'private'`                                                          | Determines whether the conversation uses shared or isolated memory and permission policies                                     |
| `memory_scope_id`   | `text NOT NULL DEFAULT 'default'`  | `'default'` for standard conversations; `'private:<uuid>'` for private conversations | Scopes all memory writes (items, segments) to this namespace; embeddings are isolated indirectly via their parent item/segment |

### Memory Isolation

```mermaid
graph TB
    subgraph "Standard Conversation"
        STD_WRITE["Memory writes<br/>→ scope_id = 'default'"]
        STD_READ["Memory recall<br/>reads scope_id = 'default' only"]
    end

    subgraph "Private Conversation"
        PVT_WRITE["Memory writes<br/>→ scope_id = 'private:&lt;uuid&gt;'"]
        PVT_READ["Memory recall<br/>reads scope_id = 'private:&lt;uuid&gt;'<br/>+ fallback to 'default'"]
    end

    subgraph "Shared Memory Pool"
        DEFAULT_SCOPE["'default' scope<br/>(all standard conversation memories)"]
        PRIVATE_SCOPE["'private:&lt;uuid&gt;' scope<br/>(isolated to one conversation)"]
    end

    STD_WRITE --> DEFAULT_SCOPE
    STD_READ --> DEFAULT_SCOPE
    PVT_WRITE --> PRIVATE_SCOPE
    PVT_READ --> PRIVATE_SCOPE
    PVT_READ -.->|"fallback"| DEFAULT_SCOPE
```

**Write isolation**: All memory items and segments created during a private conversation are tagged with its `memory_scope_id` (e.g. `'private:abc123'`). Embeddings are isolated indirectly — they reference scoped items/segments via `target_type`/`target_id`, so scope filtering at the item/segment level cascades to their embeddings. All scoped data is invisible to standard conversations and other private conversations.

**Read fallback**: When recalling memories for a private conversation, the retriever queries both the conversation's own scope and the `'default'` scope. This ensures the assistant still has access to general knowledge (user profile, preferences, facts) learned in standard conversations, while private-conversation-specific memories take precedence in ranking. The fallback is implemented via `ScopePolicyOverride` with `fallbackToDefault: true`, which overrides the global scope policy on a per-call basis.

### SessionMemoryPolicy

The daemon derives a `SessionMemoryPolicy` from the conversation's `conversation_type` and `memory_scope_id` when creating or restoring a session:

```typescript
interface SessionMemoryPolicy {
  scopeId: string; // 'default' or 'private:<uuid>'
  includeDefaultFallback: boolean; // true for private conversations
  strictSideEffects: boolean; // true for private conversations
}
```

Standard conversations use `DEFAULT_MEMORY_POLICY` (`{ scopeId: 'default', includeDefaultFallback: false, strictSideEffects: false }`). Private conversations set all three fields: the private scope ID, default-fallback enabled, and strict side-effect controls enabled.

### Strict Side-Effect Prompt Gate

When `strictSideEffects` is `true` (all private conversations), the `ToolExecutor` promotes any `allow` permission decision to `prompt` for side-effect tools — even when a trust rule would normally auto-allow the invocation. Deny decisions are preserved unchanged; only `allow` -> `prompt` promotion occurs.

```mermaid
graph TB
    TOOL["Tool invocation in<br/>private conversation"] --> PERM["Normal permission check<br/>(trust rules + risk level)"]
    PERM --> DECISION{"Decision?"}
    DECISION -->|"deny"| DENY["Blocked<br/>(unchanged)"]
    DECISION -->|"prompt"| PROMPT["Prompt user<br/>(unchanged)"]
    DECISION -->|"allow"| SIDE_CHECK{"isSideEffectTool()?"}
    SIDE_CHECK -->|"no"| ALLOW["Auto-allow<br/>(read-only tools pass)"]
    SIDE_CHECK -->|"yes"| FORCE_PROMPT["Promote to prompt<br/>'Private conversation: side-effect<br/>tools require explicit approval'"]
```

This ensures that file writes, bash commands, host operations, and other mutating tools always require explicit user confirmation in private conversations, providing an additional safety layer for sensitive conversations.

### Key Source Files

| File                                              | Role                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `assistant/src/memory/schema.ts`                  | `conversations` table: `conversationType` and `memoryScopeId` column definitions           |
| `assistant/src/daemon/conversation.ts`            | `SessionMemoryPolicy` interface and `DEFAULT_MEMORY_POLICY` constant                       |
| `assistant/src/daemon/server.ts`                  | `deriveMemoryPolicy()` — maps conversation type to memory policy                           |
| `assistant/src/daemon/conversation-tool-setup.ts` | Propagates `memoryPolicy.strictSideEffects` as `forcePromptSideEffects` into `ToolContext` |
| `assistant/src/tools/executor.ts`                 | `forcePromptSideEffects` gate — promotes allow to prompt for side-effect tools             |
| `assistant/src/memory/search/types.ts`            | `ScopePolicyOverride` interface for per-call scope control                                 |
| `assistant/src/memory/retriever.ts`               | `buildScopeFilter()` — builds scope ID list from override or global config                 |
| `assistant/src/daemon/conversation-memory.ts`     | Wires `scopeId` and `includeDefaultFallback` into recall                                   |

---

## Workspace Context Injection — Runtime-Only Directory Awareness

The session injects a workspace top-level directory listing into every user message at runtime, giving the model awareness of the sandbox filesystem structure without persisting it in conversation history.

### Lifecycle

```mermaid
graph TB
    subgraph "Per-Turn Flow"
        CHECK{"workspaceTopLevelDirty<br/>OR first turn?"}
        SCAN["scanTopLevelDirectories(workingDir)<br/>→ TopLevelSnapshot"]
        RENDER["renderWorkspaceTopLevelContext(snapshot)<br/>→ XML text block"]
        CACHE["Cache rendered text<br/>workspaceTopLevelDirty = false"]
        INJECT["applyRuntimeInjections<br/>prepend workspace block<br/>to user message"]
        AGENT["AgentLoop.run(runMessages)"]
        STRIP["stripWorkspaceTopLevelContext<br/>remove block from persisted history"]
    end

    subgraph "Dirty Triggers (tool_result handler)"
        FILE_EDIT["file_edit (success)"]
        FILE_WRITE["file_write (success)"]
        BASH["bash (success)"]
        DIRTY["markWorkspaceTopLevelDirty()"]
    end

    CHECK -->|dirty or null| SCAN
    CHECK -->|clean| INJECT
    SCAN --> RENDER
    RENDER --> CACHE
    CACHE --> INJECT
    INJECT --> AGENT
    AGENT --> STRIP

    FILE_EDIT --> DIRTY
    FILE_WRITE --> DIRTY
    BASH --> DIRTY
```

### Key design decisions

- **Scope**: Sandbox workspace only (`~/.vellum/workspace`). Non-recursive — only top-level directories.
- **Bounded**: Maximum 120 directory entries (`MAX_TOP_LEVEL_ENTRIES`). Excess is truncated with a note.
- **Prepend, not append**: The workspace block is prepended to the user message content so that Anthropic cache breakpoints continue to land on the trailing user text block, preserving prompt cache efficiency.
- **Runtime-only**: The injected `<workspace_top_level>` block is stripped from `this.messages` after the agent loop completes. It never persists in conversation history or the database.
- **Dirty-refresh**: The scanner runs once on the first turn, then only re-runs after a successful mutation tool (`file_edit`, `file_write`, `bash`). Failed tool results do not trigger a refresh.
- **Injection ordering**: Workspace context is injected after other runtime injections (active surface, etc.) via `applyRuntimeInjections`, but because it is **prepended** to content blocks, it appears first in the final message.

### Cache compatibility

The Anthropic provider places `cache_control: { type: 'ephemeral' }` on the **last content block** of the last two user turns. Since workspace context is prepended (first block), the cache breakpoint correctly lands on the trailing user text block. This is validated by dedicated cache-compatibility tests.

### Key files

| File                                                    | Role                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `assistant/src/workspace/top-level-scanner.ts`          | Synchronous directory scanner with `MAX_TOP_LEVEL_ENTRIES` cap                                                                             |
| `assistant/src/workspace/top-level-renderer.ts`         | Renders `TopLevelSnapshot` to `<workspace_top_level>` XML block                                                                            |
| `assistant/src/daemon/conversation-runtime-assembly.ts` | Runtime injections and strip helpers (`<workspace_top_level>`, `<temporal_context>`, `<channel_onboarding_playbook>`, `<onboarding_mode>`) |
| `assistant/src/onboarding/onboarding-orchestrator.ts`   | Builds assistant-owned onboarding runtime guidance from channel playbook + transport metadata                                              |
| `assistant/src/daemon/conversation-agent-loop.ts`       | Agent loop orchestration, runtime injection wiring, strip chain                                                                            |

---

## Temporal Context Injection — Date Grounding

The session injects a `<temporal_context>` block into every user message at runtime, giving the model awareness of the current date, current local time, current UTC time, and timezone source metadata. This enables reliable reasoning about dates and times without persisting volatile temporal data in conversation history.

### Per-turn flow

```mermaid
graph TB
    subgraph "Per-Turn Flow"
        BUILD["buildTemporalContext(timeZone, hostTimeZone, userTimeZone)<br/>→ compact XML block"]
        INJECT["applyRuntimeInjections<br/>prepend temporal block<br/>to user message"]
        AGENT["AgentLoop.run(runMessages)"]
        STRIP["stripTemporalContext<br/>remove block from persisted history"]
    end

    BUILD --> INJECT
    INJECT --> AGENT
    AGENT --> STRIP
```

### Key design decisions

- **Fresh each turn**: `buildTemporalContext()` is called at the start of every agent loop invocation, ensuring the model always sees the current date even in long-running conversations.
- **Clock source invariant**: Absolute time (`now`) always comes from the assistant host clock (`Date.now()`), never from channel/client clocks.
- **Timezone precedence**: If `ui.userTimezone` is configured, temporal context uses it for local-date interpretation. Otherwise it falls back to memory-stored timezone, then assistant host timezone.
- **Timezone-aware**: Uses `Intl.DateTimeFormat` APIs for DST-safe date arithmetic and timezone validation/canonicalization.
- **Runtime-only**: The injected `<temporal_context>` block is stripped from `this.messages` after the agent loop completes via `stripTemporalContext`. It never persists in conversation history.
- **Specific strip prefix**: The strip function matches the exact injected prefix (`<temporal_context>\nToday:`) to avoid accidentally removing user-authored text that starts with `<temporal_context>`.
- **Retry paths**: Temporal context is included in all three `applyRuntimeInjections` call sites (main path, compact retry, media-trim retry).

### Key files

| File                                                    | Role                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `assistant/src/daemon/date-context.ts`                  | `buildTemporalContext()` — generates the `<temporal_context>` XML block                 |
| `assistant/src/daemon/conversation-runtime-assembly.ts` | `injectTemporalContext()` / `stripTemporalContext()` helpers                            |
| `assistant/src/daemon/conversation-agent-loop.ts`       | Wiring: computes temporal context, passes to `applyRuntimeInjections`, strips after run |

---

## Workspace Git Tracking — Change Management

The workspace sandbox (`~/.vellum/workspace`) is automatically tracked by a per-workspace git repository. Every file change made by the assistant is captured in structured commits, providing a full audit trail and natural undo/history exploration via standard git commands.

### Architecture overview

```mermaid
graph TB
    subgraph "Turn-boundary commits (primary)"
        SESSION["Session.processMessage()"]
        TURN_COMMIT["commitTurnChanges()<br/>awaited, timeout-protected"]
        MSG_PROVIDER["CommitMessageProvider<br/>buildImmediateMessage()"]
        GIT_SERVICE["WorkspaceGitService<br/>mutex + circuit breaker"]
    end

    subgraph "Heartbeat safety net (secondary)"
        HEARTBEAT["HeartbeatService<br/>setInterval every 5 min"]
        CHECK["check(): age > 5 min<br/>OR files > 20"]
    end

    subgraph "Post-commit enrichment (async)"
        ENRICHMENT["CommitEnrichmentService<br/>bounded queue, fire-and-forget"]
        GIT_NOTES["git notes --ref=vellum<br/>JSON metadata"]
    end

    subgraph "Lifecycle"
        STARTUP["Daemon startup<br/>lifecycle.ts"]
        SHUTDOWN["Graceful shutdown<br/>commitAllPending()"]
    end

    SESSION -->|"await + timeout"| TURN_COMMIT
    TURN_COMMIT --> MSG_PROVIDER
    MSG_PROVIDER --> GIT_SERVICE
    TURN_COMMIT -->|"fire-and-forget"| ENRICHMENT
    HEARTBEAT --> CHECK
    CHECK --> MSG_PROVIDER
    CHECK -->|"fire-and-forget"| ENRICHMENT
    ENRICHMENT --> GIT_NOTES
    STARTUP --> HEARTBEAT
    SHUTDOWN -->|"await"| HEARTBEAT
    SHUTDOWN -->|"drain in-flight"| ENRICHMENT
```

### How it works

1. **Lazy initialization**: The git repository is created on first use, not at workspace creation. When `ensureInitialized()` is called, it checks for a `.git` directory. If absent, it runs `git init`, creates a `.gitignore` (excluding `data/`, `logs/`, `*.log`, `*.sock`, `*.pid`, `session-token`), sets the git identity to "Vellum Assistant", and creates an initial baseline commit capturing any pre-existing files. The baseline commit is intentional — it makes `git log`, `git diff`, and `git revert` work cleanly from the start. Both new and existing workspaces get the same treatment. For existing repos (e.g. created by older versions or external tools), `.gitignore` rules and git identity are set idempotently on each init, ensuring proper configuration regardless of how the repo was originally created.

2. **Turn-boundary commits**: After each conversation turn (user message + assistant response cycle), `conversation.ts` commits workspace changes via `commitTurnChanges(workspaceDir, sessionId, turnNumber)`. The commit runs in the `finally` block of `runAgentLoop`, guarded by a `turnStarted` flag that is set once the agent loop begins executing. This guarantees a commit attempt even when post-processing (e.g. `resolveAssistantAttachments`) throws, or when the user cancels mid-turn. The commit is raced against a configurable timeout (`workspaceGit.turnCommitMaxWaitMs`, default 4s) via `Promise.race`. If the commit exceeds the timeout, the turn proceeds immediately while the commit continues in the background. Note: the background commit is NOT awaited before the next turn starts, so brief cross-turn file attribution windows are possible but accepted as a tradeoff for responsiveness. Commit outcomes are logged with structured fields (`sessionId`, `turnNumber`, `filesChanged`, `durationMs`) for observability.

3. **Heartbeat safety net**: A `HeartbeatService` runs on a 5-minute interval, checking all tracked workspaces for uncommitted changes. It auto-commits when changes exceed either an age threshold (5 minutes since first detected) or a file count threshold (20+ files). This catches changes from long-running bash scripts, background processes, or crashed sessions that miss turn-boundary commits.

4. **Shutdown safety net**: During graceful daemon shutdown, `commitAllPending()` is called twice: once before `server.stop()` (pre-stop) and once after (post-stop). The pre-stop sweep captures any pending workspace changes. The post-stop sweep catches writes that occurred during server shutdown (e.g. in-flight tool executions completing during drain). Both calls are wrapped in try/catch to prevent commit failures from deadlocking shutdown.

5. **Corrupted repo recovery**: If a `.git` directory exists but is corrupted (e.g. missing HEAD), the service detects this via `git rev-parse --git-dir`, removes the corrupted directory, and reinitializes cleanly.

6. **Commit message provider abstraction**: All commit message construction is handled by a `CommitMessageProvider` interface (`commit-message-provider.ts`). The `DefaultCommitMessageProvider` produces deterministic messages based on trigger type (turn, heartbeat, shutdown). Both `turn-commit.ts` and `heartbeat-service.ts` accept an optional custom provider, creating a seam for future LLM-powered enrichment without changing the synchronous commit path.

7. **Circuit breaker with exponential backoff**: `WorkspaceGitService` tracks consecutive commit failures and backs off exponentially (2s, 4s, 8s... up to 60s configurable max). When the breaker is open, `commitIfDirty()` short-circuits without attempting git operations. On success, the breaker resets. State transitions are logged at info/warn level with structured fields (`consecutiveFailures`, `backoffMs`).

8. **Turn-commit timeout protection**: The turn-boundary commit in `conversation.ts` uses `Promise.race` with a configurable timeout (`workspaceGit.turnCommitMaxWaitMs`, default 4s). If the commit exceeds the timeout, the turn proceeds immediately (the commit continues in the background). This prevents slow git operations from blocking the conversation loop.

9. **Non-blocking enrichment queue**: After each successful commit, a `CommitEnrichmentService` runs async enrichment fire-and-forget. The queue has configurable max size (default 50), concurrency (default 1), per-job timeout (default 30s), and retry count (default 2 with exponential backoff). On queue overflow, the oldest job is dropped with a warning log. On graceful shutdown, in-flight jobs drain while pending jobs are discarded. Currently writes placeholder JSON metadata to git notes (`refs/notes/vellum`) as a scaffold for future LLM enrichment.

10. **Provider-aware commit message generation (optional)**: When `workspaceGit.commitMessageLLM.enabled` is `true`, turn-boundary commits attempt to generate a descriptive commit message using the configured LLM provider before falling back to deterministic messages. The feature ships disabled by default and is designed to never degrade turn completion guarantees.

    **Commit message LLM fallback chain**: The generator runs a sequence of pre-flight checks before calling the LLM. Each check that fails produces a machine-readable `llmFallbackReason` in the structured log output and immediately returns a deterministic message. The checks, in order:
    1. `disabled` — `commitMessageLLM.enabled` is `false` or `useConfiguredProvider` is `false`
    2. `missing_provider_api_key` — the configured provider's API key is not found in secure storage (skipped for keyless providers like Ollama that run without an API key)
    3. `breaker_open` — the generator's internal circuit breaker is open after consecutive LLM failures (exponential backoff)
    4. `insufficient_budget` — the remaining turn budget (`deadlineMs - Date.now()`) is below `minRemainingTurnBudgetMs`
    5. `missing_fast_model` — no fast model could be resolved for the configured provider (see below); the provider is **not** called
    6. `provider_not_initialized` — the configured provider is not registered/bootstrapped (e.g., `getProvider()` throws)
    7. `timeout` — the LLM call exceeded `timeoutMs` (AbortController fires)
    8. `provider_error` — the provider threw an exception during the LLM call
    9. `invalid_output` — the LLM returned empty text, the literal string "FALLBACK", or total output > 500 chars
    - **Subject line capping**: If the LLM subject line exceeds 72 chars it is deterministically truncated to 72 chars. This is NOT treated as a failure (no breaker penalty, no deterministic fallback).

    **Fast model resolution**: The LLM call uses a small/fast model to minimize latency and cost. The model is resolved **before** any provider call as a pre-flight check:
    - If `commitMessageLLM.providerFastModelOverrides[provider]` is set, that model is used.
    - Otherwise, a built-in default is used: `anthropic` -> `claude-haiku-4-5-20251001`, `openai` -> `gpt-4o-mini`, `gemini` -> `gemini-2.0-flash`.
    - If the configured provider has no override and no built-in default (e.g., `ollama`, `fireworks`, `openrouter`), the generator returns a deterministic fallback with reason `missing_fast_model` and the provider is never called. To enable LLM commit messages for such providers, set `providerFastModelOverrides[provider]` to the desired model.

    **Pre-mutex LLM attempt**: The LLM generation runs BEFORE entering `commitIfDirty()` (outside the git mutex). Changed files are captured from a read-only `getStatus()` call (the "pre-status") outside the mutex. This avoids holding the mutex during network calls. The `commitIfDirty` callback uses its own mutex-protected status for the actual commit, so the file list used for commit and for the LLM prompt may differ slightly if files change between the two status calls — this is accepted as a tradeoff for not blocking concurrent git operations on LLM latency.

### Design decisions

- **Commit at turn boundaries, not per-tool-call**: A single commit per turn captures all file mutations from that turn atomically. This avoids noisy per-file commits and keeps the history meaningful.
- **Lazy init with baseline commit**: The repo is created on first use, not at daemon startup. Existing workspaces get their files captured in an "Initial commit: migrated existing workspace" on first use, rather than requiring an explicit migration step. The baseline commit ensures `git log`, `git diff`, and `git revert` work cleanly from the start.
- **Mutex serialization**: All git operations go through a per-workspace `Mutex` to prevent concurrent `git add`/`git commit` from corrupting the index. The mutex uses a FIFO wait queue.
- **Finally-block commit guarantee in conversation-agent-loop.ts**: Turn commits run in the `finally` block of `runAgentLoop`, ensuring they execute even when post-processing throws or the user cancels. The `turnStarted` flag prevents commits for turns that were blocked before the agent loop started. All errors are caught and logged as warnings. The commit is raced against a timeout (`turnCommitMaxWaitMs`, default 4s); if it exceeds the timeout the turn proceeds and the commit continues in the background without synchronization. Brief cross-turn file attribution is accepted as a tradeoff for keeping the conversation loop responsive.
- **Branch enforcement at init time**: `ensureOnMainLocked()` is called during initialization to ensure the workspace is on the `main` branch. If the workspace is on the wrong branch or in a detached HEAD state, it auto-corrects to `main` with a warning log. Per-commit enforcement is unnecessary since nothing in the codebase switches branches.
- **We intentionally don't provide custom history APIs** -- assistants should use git commands naturally via Bash (e.g. `git log`, `git diff`, `git show`). The workspace git repo is a standard git repository that any tool can interact with.

### Key files

| File                                                           | Role                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `assistant/src/workspace/git-service.ts`                       | `WorkspaceGitService`: lazy init, mutex, circuit breaker, `commitIfDirty()`, `getHeadHash()`, `writeNote()`, singleton registry |
| `assistant/src/workspace/commit-message-provider.ts`           | `CommitMessageProvider` interface, `DefaultCommitMessageProvider`, `CommitContext`/`CommitMessageResult` types                  |
| `assistant/src/workspace/commit-message-enrichment-service.ts` | `CommitEnrichmentService`: bounded async queue, fire-and-forget enrichment, git notes output                                    |
| `assistant/src/workspace/turn-commit.ts`                       | `commitTurnChanges()`: turn-boundary commit with structured metadata + enrichment enqueue                                       |
| `assistant/src/workspace/provider-commit-message-generator.ts` | `ProviderCommitMessageGenerator`: LLM-based commit message generation with circuit breaker and deterministic fallback           |
| `assistant/src/workspace/heartbeat-service.ts`                 | `HeartbeatService`: periodic safety-net auto-commits, shutdown commits, enrichment enqueue                                      |
| `assistant/src/daemon/conversation-agent-loop.ts`              | Integration: turn-boundary commit with `raceWithTimeout` protection in `runAgentLoop` finally block                             |
| `assistant/src/daemon/lifecycle.ts`                            | Integration: `HeartbeatService` start/stop and shutdown commit                                                                  |
| `assistant/src/config/schema.ts`                               | `WorkspaceGitConfigSchema`: timeout, backoff, and enrichment queue configuration                                                |

---
