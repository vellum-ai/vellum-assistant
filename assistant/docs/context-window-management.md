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

## Next Steps (v2+)

High-impact follow-ups for month/year sessions at very large scale:

1. Add semantic retrieval over archived turns/tool outputs.
2. Add hierarchical summaries (session, weekly, project-level).
3. Add memory confidence/expiry and contradiction resolution.
4. Add compaction quality checks (fact retention tests).
5. Add cost-aware adaptive budgets per model/provider.

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
