---
status: experimental
---

# cron-noop

Simulates a long-running cron conversation where every tick is a no-op.
Context grows unboundedly via repeated polling results and "remember"
notes until compaction fires — and then re-fires every subsequent tick
because the conservative `tail_start` barely shrinks the conversation.

## Observables

- Compaction fires on every post-threshold tick
- Message count barely decreases after compaction
- Cache-write tokens dominate (non-deterministic summary rewording)
- Cost grows superlinearly once compaction thrash begins

## Success criteria (scored by metrics)

- `compaction-efficiency` > 0.3 (compaction actually frees significant context)
- `cache-write-ratio` < 0.5 (prompt cache stays warm)
- `compaction-pass-count` < 5 for 10 post-threshold ticks
