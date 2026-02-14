# Context Window Management

This document explains the context window strategy implemented in the assistant daemon and summarizes relevant long-horizon memory techniques from current literature and provider guidance.

## Problem

Without compaction, every turn appends to the prompt history. Over long-running sessions this causes:

- context overflow errors,
- rising latency and cost,
- degraded response quality from noisy/stale history.

## Implemented Strategy (v1)

The current implementation uses **rolling summary compaction with recency pinning**:

1. Estimate prompt input tokens before each model call.
2. Trigger compaction when estimated input tokens exceed:
   - `contextWindow.maxInputTokens * contextWindow.compactThreshold`.
3. Preserve the most recent `contextWindow.preserveRecentUserTurns` user turns verbatim.
4. Replace older turns with a structured summary message (`[Context Summary v1] ...`).
5. Persist summary state (`context_summary`, `context_compacted_message_count`) in `conversations`, so state survives daemon restarts.
6. Emit a `context_compacted` IPC event so clients can show what happened.

This keeps recent interaction fidelity while preventing unbounded growth.

## Why This Matches SOTA Practice

This design is a practical subset of state-of-the-art long-context patterns:

- **Virtual memory / hierarchical memory**
  - MemGPT frames context as finite working memory with archival memory.
  - We apply this via a compacted summary + recent-window split.

- **Observation → reflection memory**
  - Generative Agents show stable behavior from compact reflections over event streams.
  - Our summary is a continually updated reflection over prior turns.

- **Retrieval-augmented long-term memory**
  - RAG-style systems avoid stuffing full history by retrieving relevant memory on demand.
  - v1 does not yet include semantic retrieval, but compaction establishes the base layer.

- **Position-aware long-context handling**
  - "Lost in the Middle" shows middle-context degradation.
  - We bias toward recent turns and condensed historical facts.

- **Provider-native context controls**
  - OpenAI and Anthropic recommend context budgeting/caching for long chats.
  - v1 adds explicit budgeting and compaction triggers.

## Configuration

`config.json` section:

```json
{
  "contextWindow": {
    "enabled": true,
    "maxInputTokens": 180000,
    "targetInputTokens": 110000,
    "compactThreshold": 0.8,
    "preserveRecentUserTurns": 8,
    "summaryMaxTokens": 1200,
    "chunkTokens": 12000
  }
}
```

## Memory Retrieval Pipeline

The memory system provides long-term recall by injecting relevant memories into the prompt before each model call. The retrieval pipeline runs through several stages:

### Pipeline Stages

1. **Multi-source retrieval** — Candidates are gathered from independent sources in parallel:
   - **Lexical search** (FTS5 on `memory_segment_fts`) — BM25-ranked full-text search.
   - **Semantic search** (Qdrant cosine similarity on embedded vectors) — Dense retrieval.
   - **Recency search** — Recent segments from the current conversation.
   - **Entity search** — Items linked to entities mentioned in the query.
   - **Direct item search** — LIKE-based matching on `memory_items` subject/statement.

2. **Reciprocal Rank Fusion (RRF)** — Candidates from all sources are deduplicated and scored via `1/(k+rank)` across each list, without assuming comparable score scales.

3. **Trust-aware ranking** — Item scores are modulated by `verification_state`:
   - `user_confirmed`: weight 1.0
   - `user_reported`: weight 0.9
   - `assistant_inferred`: weight 0.7
   - Default (unknown): weight 0.85

4. **Freshness decay** — Items past their kind-specific `maxAgeDays` window are down-ranked by `staleDecay` multiplier. Items with recent access within `reinforcementShieldDays` are protected. A background sweep marks deeply stale items (2x past window) as invalid.

5. **Scope filtering** — Each search source filters by `scope_id`. The `scopePolicy` setting controls cross-scope visibility:
   - `allow_global_fallback`: Include items from the requested scope and the `default` scope.
   - `strict`: Only include items from the requested scope.

6. **LLM re-ranking** (optional) — Top candidates are sent to a fast model (Haiku) for relevance scoring. Applied when at least 5 merged candidates exist.

7. **Attention-aware ordering** — Within injection sections, candidates are ordered using the "Lost in the Middle" pattern (highest-scored at beginning and end, lowest in the middle).

8. **Token budget trim** — Candidates are selected greedily until the `maxInjectTokens` budget is exhausted.

9. **Injection** — Selected memories are formatted and injected into the prompt via the configured `injectionStrategy`.

### Memory Configuration Reference

All memory settings live under the `memory` key in `config.json`:

```json
{
  "memory": {
    "enabled": true,

    "embeddings": {
      "required": true,
      "provider": "auto",
      "localModel": "Xenova/bge-small-en-v1.5",
      "openaiModel": "text-embedding-3-small",
      "geminiModel": "gemini-embedding-001",
      "ollamaModel": "nomic-embed-text"
    },

    "qdrant": {
      "url": "http://127.0.0.1:6333",
      "collection": "memory",
      "vectorSize": 384,
      "onDisk": true,
      "quantization": "scalar"
    },

    "retrieval": {
      "lexicalTopK": 80,
      "semanticTopK": 40,
      "maxInjectTokens": 10000,
      "injectionFormat": "markdown",
      "injectionStrategy": "prepend_user_block",

      "reranking": {
        "enabled": true,
        "model": "claude-haiku-4-5-20251001",
        "topK": 20
      },

      "freshness": {
        "enabled": true,
        "maxAgeDays": {
          "fact": 0,
          "preference": 0,
          "behavior": 90,
          "event": 30,
          "opinion": 60
        },
        "staleDecay": 0.5,
        "reinforcementShieldDays": 7
      },

      "scopePolicy": "allow_global_fallback"
    },

    "segmentation": {
      "targetTokens": 450,
      "overlapTokens": 60
    },

    "extraction": {
      "useLLM": true,
      "model": "claude-haiku-4-5-20251001",
      "extractFromAssistant": true
    },

    "summarization": {
      "useLLM": true,
      "model": "claude-haiku-4-5-20251001"
    },

    "entity": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001"
    },

    "jobs": {
      "workerConcurrency": 2
    },

    "retention": {
      "keepRawForever": true
    }
  }
}
```

### Key Configuration Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `memory.enabled` | boolean | `true` | Master toggle for the entire memory system. |
| `memory.embeddings.required` | boolean | `true` | If `true`, retrieval fails degraded when no embedding backend is available. If `false`, falls back to lexical-only. |
| `memory.embeddings.provider` | enum | `"auto"` | Embedding backend: `auto` (tries local, then falls back), `local`, `openai`, `gemini`, `ollama`. |
| `memory.retrieval.injectionFormat` | enum | `"markdown"` | Output format: `markdown` (grouped sections) or `structured_v1` (XML entries with explicit fields). |
| `memory.retrieval.injectionStrategy` | enum | `"prepend_user_block"` | How memories are placed in the prompt: `prepend_user_block` (inline) or `separate_context_message` (dedicated user+assistant pair). |
| `memory.retrieval.reranking.enabled` | boolean | `true` | Whether to apply LLM re-ranking on merged candidates. |
| `memory.retrieval.freshness.enabled` | boolean | `true` | Whether to apply per-kind freshness decay. |
| `memory.retrieval.freshness.maxAgeDays.*` | number | varies | Per-kind expiry window in days. `0` = never expires. |
| `memory.retrieval.freshness.staleDecay` | number | `0.5` | Score multiplier for items past their freshness window. Range [0, 1]. |
| `memory.retrieval.freshness.reinforcementShieldDays` | number | `7` | Grace period (days) after expiry for recently accessed items. |
| `memory.retrieval.scopePolicy` | enum | `"allow_global_fallback"` | Scope isolation: `allow_global_fallback` (include default scope) or `strict` (exact scope only). |
| `memory.extraction.useLLM` | boolean | `true` | Whether item extraction uses LLM or pattern-based heuristics. |
| `memory.extraction.extractFromAssistant` | boolean | `true` | Whether to extract memories from assistant messages (not just user). |
| `memory.entity.enabled` | boolean | `true` | Whether entity extraction and entity-based retrieval are active. |

### Rollout Order

When enabling memory features on a new deployment, follow this order to minimize risk:

1. **Enable metrics** — Set `memory.enabled: true` with `memory.embeddings.required: false`. Monitor retrieval latency and hit counts via logs.
2. **Enable embeddings** — Once the embedding backend is confirmed working, set `memory.embeddings.required: true`. This adds semantic search.
3. **Enable LLM re-ranking** — Set `memory.retrieval.reranking.enabled: true`. Adds latency but improves relevance.
4. **Enable structured injection** — Switch `memory.retrieval.injectionFormat` to `structured_v1` for better prompt safety. Test that model behavior is unaffected.
5. **Enable freshness decay** — Set `memory.retrieval.freshness.enabled: true`. Monitor for legitimate old memories being suppressed.
6. **Enable scope isolation** — Set `memory.retrieval.scopePolicy` to `strict` for multi-project deployments. Start with `allow_global_fallback` and verify no cross-scope leaks before switching.

### Troubleshooting

- **Empty recall despite populated database**: Check if `memory.embeddings.required` is `true` and the embedding backend is down. The entire retrieval pipeline fails when Qdrant/embeddings are unavailable and `required` is `true`. Set `required: false` to fall back to lexical-only.
- **Stale memories appearing**: Lower `memory.retrieval.freshness.maxAgeDays` for the relevant kind, or set `staleDecay` closer to 0.
- **Cross-project memory leaks**: Switch `scopePolicy` from `allow_global_fallback` to `strict`.
- **High latency**: Disable LLM re-ranking (`reranking.enabled: false`) or reduce `lexicalTopK`/`semanticTopK`.

## Next Steps

High-impact follow-ups for month/year sessions at very large scale:

1. ~~Add semantic retrieval over archived turns/tool outputs.~~ (Done: Qdrant-backed semantic search)
2. ~~Add hierarchical summaries (session, weekly, project-level).~~ (Done: conversation + weekly summaries)
3. ~~Add memory confidence/expiry and contradiction resolution.~~ (Done: trust-aware ranking + freshness decay)
4. Add compaction quality checks (fact retention tests).
5. Add cost-aware adaptive budgets per model/provider.
6. Add Qdrant-level scope filtering for semantic search (currently uses post-filter).

## References

- OpenAI conversation state + context windows: https://developers.openai.com/api/docs/guides/conversation-state
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Anthropic long-context tips: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/long-context-tips
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Lost in the Middle (TACL 2024): https://aclanthology.org/2024.tacl-1.9/
- MemGPT: https://research.memgpt.ai/
- RAG paper (Lewis et al., 2020): https://arxiv.org/abs/2005.11401
- Memorizing Transformers (Wu et al., 2022): https://arxiv.org/abs/2203.08913
- LongMem (Wang et al., 2023): https://arxiv.org/abs/2306.07174
- LoCoMo benchmark (2024): https://arxiv.org/abs/2402.17753
- Generative Agents (Park et al., 2023): https://research.google/pubs/generative-agents-interactive-simulacra-of-human-behavior/
