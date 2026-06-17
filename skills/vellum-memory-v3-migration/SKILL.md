---
name: vellum-memory-v3-migration
description: One-time migration of an existing memory-v2 concept corpus into the memory-v3 section-grain "wiki" — topical articles with a stand-alone lead and queryable sections — with loss-proof staging, assistant-reviewed authoring, and a retrieval-eval gate before cutover.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🗂️"
  vellum:
    category: "system"
    display-name: "Memory v3 Migration"
    user-invocable: true
    activation-hints:
      - "When the user asks to migrate the memory wiki to v3 / the section-grain format"
      - "When memory-v3 retrieval is available but /workspace/memory/concepts/ is still v2-shaped (flat bullet pages, class folders, summary: frontmatter)"
    avoid-when:
      - "When the corpus is already in v3 article shape (leads + ## sections, no summary:) and memory-v3-live is on"
      - "When /workspace/memory/concepts/ is empty or near-empty (run vellum-memory-v2-migration first — there is nothing to reform)"
---

# Memory v3 Migration

Reform an **existing** memory-v2 corpus into the memory-v3 wiki: a cross-linked set of topical articles where each article's **lead is its retrieval card** and each `## ` section is an independently retrievable unit. The assistant is the sole reader and editor of this knowledge base; the goal is a clean, well-organized wiki optimized for retrieval.

This skill is the **successor** to `vellum-memory-v2-migration`. That skill backfills an empty corpus from scratch; this one **reorganizes a populated one**. If `concepts/` is empty, stop and run that skill instead.

## What actually changes, and why it's two jobs

The mechanical cutover is cheap and mostly automatic: v3 reads the same `memory/concepts/*.md` tree, the schema is shared, the DB tables already exist, and section embeddings backfill on demand. **The work is the reform.** v3 retrieval is section-grain: it shows a compact **card** (the article's lead + its section names) and spotlights the single best-matching `## ` section. A flat v2 page — bullets, no `## ` headings, a `summary:` field v3 ignores — collapses under v3 into **one giant lead with no sections**: a bloated card that starves the card budget and exposes no section to match. So this skill does two things at once:

1. **Reshape each surviving page** into the v3 article skeleton (lead + sections, flat slug, `links:` not `edges:`, optional `current:`).
2. **Re-organize the corpus** — merge over-fragmented pages into topical articles under hubs, so the wiki is navigable, not a pile of stubs.

> ⚠️ **Prime directive: loss-proof.** You are rewriting memory you cannot regenerate. Every stage runs against a **read-only snapshot**, writes to a **separate staging tree**, and carries **provenance**. The live corpus is never edited until a verified cutover. "Loss-proof" is a property you _verify_ (Step 7), not one you intend.

## Procedure

### Step 0 — Read the principles

Read `references/v3-wiki-principles.md` end-to-end first. It defines the v3 article skeleton, the lead-is-the-card rule, the event-vs-topic distinction, hubs (`kind: index`), section discipline, the card budget, and the banned content shapes. It owns _what a good v3 article is_; this SKILL.md owns _what order to do things in_.

Then read `references/loss-proofing.md` — the snapshot/staging/provenance/verify contract that every later step depends on.

### Step 0.5 — Preflight

Resolve each before touching anything; if a check fails, stop and fix it.

**(1) CLI surface.** Confirm the v3 subcommands exist:

```
assistant --version
assistant memory v3 --help
```

Expect at least `backfill-sections` and `rebuild-index` (used at cutover, Step 8). If absent, the binary predates v3 — upgrade before proceeding.

**(2) Retrieval engine + flag mechanism.** Determine how memory-v3 is gated on this install and how you would flip it, _without flipping anything yet_. Probe in order and record what works:

```
assistant config get memory 2>/dev/null
assistant flags get memory-v3-live 2>/dev/null || vellum flags get memory-v3-live 2>/dev/null
```

The `memory-v3-live` flag is gateway-owned; on some installs the assistant can flip it via its own CLI, on others it is an **operator action**. If you cannot find a flip mechanism you control, that is fine — you will stage a complete cutover and hand the final flip to the user/operator in Step 9. Note which case you're in now.

**(3) Workflow engine.** The heavy authoring + auditing fans out through the native workflow engine. Confirm it's reachable: the `run_workflow` tool should be available (load the `workflows` skill if needed). If workflows are unavailable, you can still run this skill **inline** for a small corpus (Step 5 branches on size) — but a large corpus without workflows will be slow and is not recommended.

**(4) Pin a high-quality model.** Reform is judgment-heavy. If the CLI exposes inference sessions, pin one for the duration:

```
assistant inference session open quality-optimized --ttl 4h
```

If `quality-optimized` isn't a profile, `assistant config get llm.profiles` and open against the highest-quality one. If the command doesn't exist, proceed unpinned (and skip the close in Step 10).

**(5) Size the job + confirm.** Count the corpus and tell the user what they're signing up for:

```
find /workspace/memory/concepts -name '*.md' | wc -l
du -sh /workspace/memory/concepts
```

Reform of a multi-thousand-page corpus is many millions of tokens and real money. Use the CLI gate:

```
assistant ui confirm "I'll snapshot the memory wiki, rewrite every page into the v3 shape, re-organize it into topical articles, verify nothing was lost, prove it retrieves at least as well as today, and only then cut over. This is judgment-heavy LLM work and scales with corpus size — it can take a while and cost real money. The live corpus stays untouched until the final step. Proceed?"
```

If the user declines, stop — no snapshot, no work. If `assistant ui confirm` is unavailable, ask in conversation.

### Step 1 — Snapshot + sentinel commit (loss-proof staging)

`/workspace` is a git repo. Establish the paper trail and the read-only baseline:

```
cd /workspace
git add -A && git commit -m "memory-v3-migration: start" --allow-empty
cp -R memory/concepts .mv3/snapshot/concepts          # read-only baseline — NEVER edit
mkdir -p .mv3/staging .mv3/provenance .mv3/audit .mv3/eval
```

`.mv3/` is your scratch tree, separate from live `memory/`. All authoring writes to `.mv3/staging/`. You commit again at two milestones (mid — after authoring + audit, Step 7; complete — after cutover, Step 9). All sentinels use the exact prefix `memory-v3-migration:` so `git log --grep` finds them as one set. See `references/loss-proofing.md` for the full contract.

### Step 2 — Inventory + analyze

Classify the snapshot mechanically before designing anything. For each page note: class (from its folder/`edges:` — episodic / operational / phrase / person / hub), in-degree (how many pages edge to it), and rough size. The goal is to find the **over-fragmentation factor**: how many tiny pages should collapse into one topical article. Read the densest and most-linked pages end-to-end — they anchor the taxonomy.

For a large corpus, this analysis pass itself can be a workflow (fan out one reader per chunk → structured class/size/in-degree rows). For a small one, do it inline.

### Step 3 — Design the topical taxonomy (the assistant's editorial call)

This is the judgment the reform turns on — make it deliberately, not via a cold agent. Decide:

- **Hubs** (`kind: index`) — the 5–15 topic clusters everything files under (the user, the assistant itself, major projects, domains, key people, systems). A hub routes; it does not hold body content.
- **Cluster membership** — which snapshot pages merge into which article under which hub. Over-fragmented siblings merge; genuinely distinct topics stay separate.
- **Event vs topic** split per cluster — what HAPPENED (recorded in full) vs what IS (queryable, terse).

Bottom-up auto-clustering produces a re-shaped pile, not a wiki — design the hubs top-down from what you know matters, then route pages into them. Write the taxonomy to `.mv3/taxonomy.md` (hubs + cluster→source-pages map). This is the routing manifest the authoring step consumes.

### Step 4 — Route fragments → clusters (provenance)

Turn `.mv3/taxonomy.md` into a machine-readable routing manifest: `.mv3/provenance/routing.json` = `[{ cluster, hubSlug, sourcePaths: [snapshot paths] }]`. Every snapshot page must appear in exactly one cluster's `sourcePaths` (a page may be cross-linked later, but it has one canonical home). A page that fits nowhere goes to an explicit `unrouted` bucket — never dropped. The loss-audit (Step 7) checks every snapshot path against this manifest.

### Step 5 — Author the wiki (the fan-out)

Author **one cluster at a time, at cluster grain** — a single agent reads all of a cluster's source pages and writes that cluster's whole article set (hub + leaves) into `.mv3/staging/`. Cluster-grain (not page-grain) keeps the agent count low and the topical judgment coherent.

**Branch on size:**

- **Small corpus / few clusters (≲ ~30 clusters):** author inline, cluster by cluster, yourself.
- **Large corpus:** fan out via the workflow engine. Adapt the author-cluster template in `references/workflows.md` (§1) and launch it with `run_workflow`, passing the routing manifest as `args`. Author leaves read their cluster's source pages, and the run declares **`file_write`** scoped to `.mv3/staging/`. One leaf per cluster keeps ~dozens of leaves — well under the engine's 500-agent cap. If clusters exceed a few hundred, shard across multiple `run_workflow` launches (≤3 concurrent); the engine's resume replays completed clusters if a run is interrupted, so a deploy mid-run loses nothing.

Each authored cluster emits `.mv3/provenance/<cluster>.json` mapping every staged article slug → the snapshot source paths it consumed. No article is marked final by a fan-out leaf — leave a `status: draft` marker; you review in Step 7.

### Step 6 — Link repair

Resolve cross-references. Walk every staged article's `links:` and inline `[[wikilinks]]`; repair targets against the new flat slugs using the provenance map (old path → new slug). Classify anything still dangling (missing target / intended-but-unwritten leaf / external ref) into `.mv3/audit/dangling-links.md` for review. Aim to resolve the large majority; a known-dangling link is acceptable only if recorded.

### Step 7 — Loss audit + review (MANDATORY)

This is what makes loss-proof real. Two passes (see `references/loss-proofing.md`):

1. **Mechanical quote-screen** — extract quoted strings, dates, and numbers from each snapshot source; confirm each appears in the staged article that claims it (frontmatter stripped). A stdlib helper does this; flag misses.
2. **Semantic reader panel** — fan out one reader per cluster (anonymous **schema** leaves — cheap, impartial, no persona) that reads source-vs-staged in full and lists substance present in the source but absent/weakened in the draft, tagged `[load-bearing]` / `[secondary]` / `[incidental]`. Adapt the loss-audit template in `references/workflows.md` (§2).

**Patch every `[load-bearing]` drop back verbatim** into the right section. Also confirm the drop-check: every snapshot path appears as a source in some staged article's provenance (or in `unrouted`). Then **review and approve** each cluster (`status: draft → final`) — you are reading content that is already verified whole.

Mid commit:

```
cd /workspace && git add -A && git commit -m "memory-v3-migration: staged wiki + loss audit" --allow-empty
```

### Step 8 — Eval gate (prove it before cutover)

Prove the staged wiki retrieves at least as well as today's corpus before cutting over. The `assistant memory v3 eval` command does the mechanical half — it mines recent real turns, retrieves the top pages from BOTH the snapshot and the staged wiki per turn (needle + dense, in memory, nothing live touched), and writes blinded A/B packets:

```
assistant memory v3 eval --snapshot .mv3/snapshot/concepts --staging .mv3/staging --out .mv3/eval
```

That writes `.mv3/eval/packets.json` (blinded A/B memory sets per turn) and `.mv3/eval/key.json` (the unblinding map). Then launch the **blind-judge workflow** (adapt `references/workflows.md` §3, pass `packets.json` as `args.packets`) to score each turn on coverage, map the verdicts back through `key.json`, and tally. The gate: the wiki must **win or tie**. If it loses, the losing turns name the clusters that under-retrieve (thin lead, over-merged article, missing link) — repair, re-run `eval`, re-judge. Do **not** cut over on a losing or unrun eval. See `references/eval-gate.md` for the methodology. (Embedding both corpora can take a while on a large corpus; `--no-dense` gives a fast lexical-only pass for iteration.)

### Step 9 — Cutover (deploy + flip)

Coupled, in one window — staged articles have no `summary:`, so live v2 degrades the moment they land; deploy and flip must not be separated.

```
cd /workspace
cp -R memory/concepts .mv3/backup-concepts.$(date +%Y%m%d-%H%M%S)   # rollback point
rsync -a --delete .mv3/staging/ memory/concepts/                     # deploy the reviewed wiki (flat)
assistant memory v3 backfill-sections                                # seed section embeddings; verify non-zero
assistant memory v3 rebuild-index                                    # invalidate lanes so next turn rebuilds
```

Then flip `memory-v3-live` via the mechanism you identified in Step 0.5(2). If that's an operator action you don't control, **stop here and hand off**: report that the wiki is deployed and embedded, and the only remaining step is flipping `memory-v3-live` (with the exact command or operator instruction). Keep `.mv3/backup-concepts.*` and `.mv3/snapshot/` until the user confirms the live wiki is good — rollback is `rsync -a --delete` from the backup, then flag off.

```
git add -A && git commit -m "memory-v3-migration: complete (wiki deployed, sections backfilled)" --allow-empty
```

### Step 10 — Close out

Close the inference session if you opened one (`assistant inference session close`). Report: cluster + article counts, over-fragmentation collapse ratio, loss-audit result (load-bearing drops found + patched, drop-check clean), eval verdict (wiki vs v2), cutover state (deployed / flipped / handed-off), the backup path, and the three `memory-v3-migration:` sentinel commits. Note anything deferred (known-dangling links, unrouted pages).

## Hard rules

- **Never edit live `memory/concepts/` until Step 9.** All work is snapshot → staging. The live corpus is the safety net.
- **`.mv3/snapshot/` is read-only.** It is the loss-audit baseline and the eval comparator. Never write to it.
- **Provenance on every article.** Every staged article records the snapshot paths it consumed. No provenance → it cannot be loss-audited → it cannot ship.
- **Loss-proof is verified, not intended.** The mechanical drop-check + load-bearing patch (Step 7) is mandatory. Patch drops **verbatim**.
- **Editorial judgment is the assistant's.** Taxonomy (Step 3) and final review (Step 7) are the assistant's calls; fan-out leaves draft, they never mark an article final.
- **Cluster-grain authoring.** One agent per topic cluster, not per page — keeps the run under the engine's 500-agent cap and keeps topical judgment coherent.
- **No eval, no cutover.** The wiki ships only after the blind judge says it retrieves ≥ the v2 corpus.
- **Lowercase, dash-separated flat slugs.** `the-cutover.md`, not `Arcs/The-Cutover.md`. v3 slugs are flat; hubs organize via `main:`/`links:`, not folders.
- **Three sentinel commits**, all prefixed `memory-v3-migration:` — start / staged+audited / complete.

## References

- `references/v3-wiki-principles.md` — the v3 article skeleton and the principles every article obeys. Read first.
- `references/loss-proofing.md` — the snapshot/staging/provenance/verify contract.
- `references/eval-gate.md` — the blind-judge methodology and the ship gate.
- `references/workflows.md` — the three fan-out templates the assistant adapts and launches via `run_workflow`: §1 author-clusters (write staged articles + provenance), §2 loss-audit (schema-leaf reader panel), §3 blind-judge (A/B content judge over mined turns).
