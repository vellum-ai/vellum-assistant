---
status: experimental
---

# cron-noop

Simulates a long-running cron conversation where every tick is a no-op.
Context grows via repeated polling results and "remember" notes until
compaction fires — and then re-fires on subsequent ticks because the
conservative compaction barely shrinks the conversation, while each pass
rewords the summary non-deterministically and invalidates the prompt-cache
prefix.

## How the threshold is reached

The default 200k context window would never be crossed by a handful of
ticks, so the `vellum-compaction-stress` profile shrinks it at setup:

    assistant config set llm.default.contextWindow.maxInputTokens 40000

This takes effect immediately — the daemon's `config_set` handler
invalidates the in-memory config cache and per-call resolution re-reads it
on the next turn, so no restart is needed.

The daemon's proactive-compaction gate fires when its token estimate crosses
`maxInputTokens × (1 − safetyMargin) × 0.85` (the `0.85` mid-loop yield ratio
in `assistant/src/agent/loop.ts`). `safetyMargin` defaults to `0.05` and
floors to `0.15` once history exceeds 50 messages. With `maxInputTokens =
40000` the threshold is ~32.3k tokens early and ~28.9k once the history is
long.

Crucially, the daemon's estimate INCLUDES the system prompt and the full
tool-definition catalog, not just message history — so the conversation
starts a few thousand tokens above empty. Each tick message is padded to
~2000 estimator-tokens of deterministic record-keeping filler, so a span of
seed ticks adds a large, predictable amount that dominates the (large but
not precisely known) base context and carries the conversation across the
threshold within the seed phase, then keeps it there for every observation
tick.

## Observables

- Compaction fires on most/every post-threshold tick (counted from the
  `assistant_activity_state` SSE event carrying `reason: "context_compacting"`)
- Per-tick context-window size (`contextWindowTokens` from `usage_update`)
  climbs toward, then hovers at, the threshold
- Cache-write tokens dominate (non-deterministic summary rewording
  invalidates the cached prefix). Cache-write/read counts come from the
  egress jail's recorded usage (`readUsageRecords()`), the cost/usage
  authority — the SSE wire carries no cache fields.
- Cost grows superlinearly once compaction thrash begins

## Success criteria (scored by metrics)

- `compaction-efficiency` > 0.3 (compaction actually frees significant context)
- `cache-write-ratio` < 0.5 (prompt cache stays warm)
- `compaction-pass-count` < 5 for 10 post-threshold ticks

A buggy/thrashing assistant fails these (low efficiency, high cache-write
ratio, many passes); the criteria document the fixed-behavior target.
