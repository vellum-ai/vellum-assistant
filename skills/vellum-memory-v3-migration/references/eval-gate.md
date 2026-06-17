# The eval gate

Before cutover you must prove the staged wiki retrieves **at least as well** as the current v2 corpus. Not by intuition — by a blind comparison on real historical turns. This gate exists because a plausible-looking reform can quietly lose retrieval: renamed slugs, leads that don't carry the card, sections that don't match.

## Why a blind content judge, not a recall metric

The obvious metric — "did the wiki retrieve the same page slugs the v2 corpus did?" — **structurally penalizes the reform**, because the wiki deliberately renames and merges pages. A page judged "missing" is often present under a new slug with the same content. So the gate is a **blind content judge**: for each turn, two memory sets (v2 vs wiki) are scored 0–10 on *"does this cover what the reply actually needed?"*, blind to which is which, coverage-dominant. The reply is the ground truth for what memory was needed (it was written with memory help). See `workflows.md` §3.

## Building the packets — `assistant memory v3 eval`

Workflow leaves have no embedding/retrieval tool, so retrieval happens **outside** the workflow. One command does the whole mechanical half — mine turns, embed both corpora, retrieve both sides per turn, blind, and write the packets:

```
assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval
```

It writes `.mv3/eval/packets.json` (per turn: `{turn, context, userMessage, reply, setA, setB}`, A/B order shuffled by a seeded PRNG) and `.mv3/eval/key.json` (the unblinding map the judge never sees). Under the hood:

- **Mines recent real user→assistant turns** from the message store, excluding scheduled/cron turns, capped per conversation.
- **Retrieves both sides identically** — a BM25F section needle unioned with dense cosine over freshly-embedded section vectors (the same section grain the live engine uses), top-`k` pages per corpus, rendered as the model sees them (card + matched section). Everything is in memory; the live lanes and Qdrant are untouched.
- **No time-gating is needed.** The staged wiki is a pure reorganization of the snapshot — both corpora hold the *same knowledge*, so a page encoding post-turn information is reachable in both and can't bias either side. The eval cleanly measures retrieval **shape**, which is exactly the question.

Use `--no-dense` for a fast lexical-only pass while iterating; the full run embeds every section of both corpora and can take a while on a large corpus. Re-run after fixing staged articles.

## The gate

Run the blind-judge workflow over the packets, map A/B back to v2/wiki via the key, and tally. **Ship only if the wiki wins or ties** across the set. If it loses:

- The losing turns name the clusters that under-retrieve. Read those packets — usually a thin lead (the card doesn't carry), an over-merged article (the matched section is buried), or a missing cross-link.
- Fix the staged articles, re-embed the changed ones, re-judge. Iterate until the gate is green.

## Honesty caveats

- **The judge has variance.** Run a small panel per turn, or repeat the set with different `--seed` values; don't ship on a one-vote margin.
- **This eval tests on-disk corpus shape, not the whole live engine.** It exercises the needle + dense lanes over the two corpora; it does not replicate every live lane (learned-edges, carry-forward accumulation, capability rows). It answers the reform's actual risk — *"does the reshaped corpus retrieve its own content at least as well?"* — not *"is the live system byte-identical post-cutover."*
- **No eval, no cutover** is a hard rule (SKILL.md). An unrun gate is a failed gate.
