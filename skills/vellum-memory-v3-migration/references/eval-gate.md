# The eval gate

Before cutover you must prove the staged wiki retrieves **at least as well** as the current v2 corpus. Not by intuition — by a blind comparison on real historical turns. This gate exists because a plausible-looking reform can quietly lose retrieval: renamed slugs, leads that don't carry the card, sections that don't match.

## Why a blind content judge, not a recall metric

The obvious metric — "did the wiki retrieve the same page slugs the v2 corpus did?" — **structurally penalizes the reform**, because the wiki deliberately renames and merges pages. A page judged "missing" is often present under a new slug with the same content. So the gate is a **blind content judge**: for each turn, two memory sets (v2 vs wiki) are scored 0–10 on _"does this cover what the reply actually needed?"_, blind to which is which, coverage-dominant. The reply is the ground truth for what memory was needed (it was written with memory help). See `workflows.md` §3.

## Building the packets — `assistant memory v3 eval`

Workflow leaves have no embedding/retrieval tool, so retrieval happens **outside** the workflow. One command does the whole mechanical half — mine turns, embed both corpora, retrieve both sides per turn, blind, and write the packets:

```
assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval
```

It writes `.mv3/eval/packets.json` (per turn: `{turn, context, userMessage, reply, setA, setB}`, A/B order shuffled by a seeded PRNG) and `.mv3/eval/key.json` (the unblinding map the judge never sees). Under the hood:

- **Mines recent real user→assistant turns** from the message store, excluding scheduled/cron turns, capped per conversation.
- **Retrieves both sides identically** — a BM25F section needle unioned with dense cosine over freshly-embedded section vectors (the same section grain the live engine uses), top-`k` pages per corpus, rendered as the model sees them (card + matched section). Everything is in memory; the live lanes and Qdrant are untouched.
- **No time-gating is needed.** The staged wiki is a pure reorganization of the snapshot — both corpora hold the _same knowledge_, so a page encoding post-turn information is reachable in both and can't bias either side. The eval cleanly measures retrieval **shape**, which is exactly the question.

Use `--no-dense` for a fast lexical-only pass while iterating; the full run embeds every section of both corpora and can take a while on a large corpus.

## Iterate reproducibly — this is what makes the gate converge

The non-convergence to avoid is **comparing different things across runs and reading it as judge noise.** Three controls prevent it:

- **Pin the turn set.** The first run mines fresh recent turns and writes `eval-meta.json` (seed, k, dense, the resolved turn ids, and the embedding identity). On every later run pass `--turns-file .mv3/eval/key.json` so the re-judge measures the _same_ turns while only the staged corpus changes. Without pinning, each run re-mines by recency — a different turn set.
- **Exclude the migration's own conversation** with `--exclude-conversation <id>` (the conversation you're running in), or the eval judges turns from the very chat driving the migration.
- **Hold the retrieval mode and embedding fixed.** Don't compare a `--no-dense` run against a dense one (different lanes), and check `eval-meta.json`'s `embedding` is identical across runs — dense retrieval re-embeds both corpora with the live-configured provider, so a mid-migration model/dimension change makes runs incomparable.

## The gate — decide with `eval-tally`, never by hand

Run the blind-judge workflow (`workflows.md` §3) as a **panel** (default 3 judges/turn), write its verdicts to `.mv3/eval/verdicts.json`, and decide with:

```
assistant memory v3 eval-tally --verdicts .mv3/eval/verdicts.json --key .mv3/eval/key.json
```

`eval-tally` maps each verdict through `key.json` (A/B is shuffled **per turn** — a global A-vs-B count is wrong and flipped the result in the field), aggregates the panel by majority, and applies a two-sided sign test. Its `gate` field is the ship decision:

- **`pass`** — the wiki **wins or ties**. A within-noise difference (most turns decided by a single point of a 0–10 score) is a tie, not a loss. A tie means the reform didn't regress retrieval; proceeding is then a judgment call about whether the v3 _shape_ is worth it, not a retrieval win.
- **`fail`** — the snapshot beats the wiki by a **statistically significant** margin. Don't cut over. The losing turns name the clusters that under-retrieve — usually a thin lead (the card doesn't carry), an over-merged article (the matched section is buried), or a missing cross-link. Fix the staged articles, re-run `eval` **with the same `--turns-file`**, re-judge, and re-tally until `gate: pass`.

Heed the `confident` flag and `notes`: a single-vote panel or too few decided turns means re-judge with a larger panel before trusting the verdict. **Never hand-tally A-vs-B** — that is exactly what produced the divergent, non-converging numbers this gate is designed to prevent.

## Honesty caveats

- **The judge has variance** — which is why §3 runs a panel and `eval-tally` applies a sign test rather than trusting a raw win count. Don't ship on a one-vote margin or an unpinned re-run; the `confident` flag flags both.
- **This eval tests on-disk corpus shape, not the whole live engine.** It exercises the needle + dense lanes over the two corpora; it does not replicate every live lane (learned-edges, carry-forward accumulation, capability rows). It answers the reform's actual risk — _"does the reshaped corpus retrieve its own content at least as well?"_ — not _"is the live system byte-identical post-cutover."_
- **No eval, no cutover** is a hard rule (SKILL.md). An unrun gate is a failed gate.
