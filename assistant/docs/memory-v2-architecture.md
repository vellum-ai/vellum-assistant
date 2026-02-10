# Memory V2 Architecture

This document describes the daemon-side long-horizon memory system added in v2.

## Goals

- Preserve globally shared memory across sessions in `~/.vellum/data/assistant.db`.
- Support lexical + semantic recall for conversations that can span months/years.
- Keep recall injection bounded and deterministic for stable prompt cost.

## Data Model

Memory v2 adds:

- `memory_segments`: segmented message text for retrieval/indexing.
- `memory_segment_fts`: FTS5 index over segment text.
- `memory_items`: distilled facts/preferences/decisions.
- `memory_item_sources`: evidence links from items to messages.
- `memory_summaries`: conversation + periodic global summaries.
- `memory_embeddings`: vectors for segments/items/summaries.
- `memory_jobs`: persistent async queue.
- `memory_checkpoints`: resumable state for backfill/periodic tasks.

## Ingestion Pipeline

On each persisted message:

1. Extract text from stored content blocks.
2. Segment text with overlap.
3. Upsert segments (FTS synced via triggers).
4. Enqueue embedding + item extraction + summary jobs.

## Retrieval Pipeline

For each user turn:

1. Build query from user message + current context summary.
2. Compute query embedding (required by default).
3. Fetch lexical candidates from FTS.
4. Fetch semantic candidates from item/summary embeddings.
5. Fetch recency candidates from same-conversation segments.
6. Score using:
   - `0.50 * semantic + 0.25 * lexical + 0.15 * recency + 0.10 * confidence`.
7. Inject top items under token budget as an ephemeral `[Memory Recall v1]` message.

Injected memory is runtime-only and stripped from persisted history.

## Embedding Backends

Configured in `config.json` `memory.embeddings`:

- OpenAI
- Gemini
- Ollama (local)

`provider = "auto"` prefers `openai -> gemini -> ollama`.

If `required = true` and no backend is available, memory recall degrades safely while chat continues.

## Worker Jobs

Background worker handles:

- `embed_segment`, `embed_item`, `embed_summary`
- `extract_items`
- `build_conversation_summary`
- `refresh_weekly_summary`, `refresh_monthly_summary`
- `backfill`
- `rebuild_index`

Jobs are persistent and retry with backoff.

## CLI

New commands:

- `vellum memory status`
- `vellum memory backfill`
- `vellum memory query "<text>"`
- `vellum memory rebuild-index`
