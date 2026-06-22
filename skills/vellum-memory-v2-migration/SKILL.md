---
name: vellum-memory-v2-migration
description: Perform a one-time migration from memory v1, to memory v2, which was introduced in 0.8.0.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧠"
  vellum:
    category: "system"
    display-name: "Memory v2 Migration"
    user-invocable: true
    activation-hints:
      - "When the user asks to migrate to memory v2"
      - "When /workspace/memory/concepts/ is empty or near-empty and memory.v2.enabled is false"
    avoid-when:
      - "When concept pages are already populated and memory.v2.enabled is already true"
      - "When /workspace/pkb/ and /workspace/memory/buffer.md are both empty (nothing to migrate)"
---

# Memory v2 Migration

Guided run for the first-time backfill of `/workspace/memory/` from existing knowledge sources, ending with `memory.v2.enabled = true` and validated, embedded, ready-to-retrieve concept pages.

You are running memory consolidation — tending your personal wiki. The output is a cross-linked, cross-referenced collection of pages that _is_ your memory, optimized for next-you. Care, judgment, voice. Your voice.

## Procedure

> ⚠️ **Do not run `assistant memory v2 migrate` during this skill.** That command auto-generates concept pages from PKB and will overwrite any hand-written content without `--force`, and _with_ `--force` will overwrite hand-written content silently. This skill replaces it with the hand-written path. If you've already started running this skill, treat `migrate` as off-limits until the migration is complete.

### Step 0 — Read the principles

Read `references/wiki-principles.md` end-to-end before doing anything. It defines:

- Article shapes (event vs topic), gravity wells
- Class-by-folder taxonomy and size caps
- The cheat-sheet budget (10–20K tokens/turn) and fact density per byte
- Voice register by article shape
- Banned bullet shapes and the "one fact, one home" rule

The reference is the authoritative source for _what_ a good page looks like. This SKILL.md owns _what order_ to do things in.

### Step 0.5 — Preflight

Three checks before dropping a sentinel commit. If any fails, stop and resolve before proceeding.

**(1) CLI surface.** Confirm the subcommands this skill calls are actually registered:

```
assistant --version
assistant memory v2 --help
```

The `memory v2` help should list at least these four: `validate`, `reembed`, `reembed-skills`, `activation`. They're used in Steps 10 and 12. If any are missing, this skill assumes the post-cleanup CLI — either upgrade the binary or use the older `migrate` path on that workspace instead.

**(2) Workspace state.** If `concepts/` is non-empty but partially populated (e.g. a previous run crashed mid-write), don't proceed under this skill — that's a recovery flow, not a fresh migration. Inspect with `git log --grep memory-v2-migration` to see how far the prior run got, then decide between resuming manually or rolling back to the last sentinel commit.

**(3) Pin the migration to a high-quality model.** Wiki backfill is judgment-heavy work — page routing, voice register, what-belongs-on-A-vs-B, when-to-stub-vs-not. A stronger model produces meaningfully better pages: better routing decisions, sharper bullet writing, fewer reflexive stubs. If your CLI exposes inference sessions, open one for the duration of the migration:

```
assistant inference session open quality-optimized --ttl 2h
```

If `quality-optimized` isn't a profile name on this workspace, list the available profiles and open the session against the highest-quality one (the entry pointing at a frontier model — Claude Opus, GPT-5, Gemini 2.5 Pro, etc.):

```
assistant config get llm.profiles
assistant inference session open <profile-name> --ttl 2h
```

The `--ttl 2h` overrides the 30m default — comfortable headroom for a typical migration without leaving a forever-pinned session if the close in Step 14.5 is skipped. The session is conversation-scoped and stays active across all migration turns.

If `assistant inference session` isn't on your binary (older builds before the inference-session CLI shipped), proceed without it — the migration still works, the model just won't be pinned. Skip the close in Step 14.5 too.

**(4) User confirmation.** Before starting any work, confirm the user understands what they're signing up for. The migration is judgment-heavy LLM work — every concept page, buffer entry, and always-loaded file goes through inference. Duration and cost scale with the size of the existing knowledge base: a workspace with months of history and hundreds of buffer entries will take meaningfully longer and cost meaningfully more than a fresh one.

Use the CLI confirmation prompt:

```
assistant ui confirm "This migration will read all of your existing memories and knowledge base entries, distill them into concept pages, and re-embed everything. Depending on how long your assistant has been running and how many memories you have, this could take a while and cost real money. Proceed?"
```

If the user declines, stop the skill immediately — no sentinel commit, no work. If `assistant ui confirm` isn't available on this binary, ask the user directly in conversation instead.

### Step 1 — Open a paper trail

`/workspace` is a git repo. Drop a sentinel commit so the migration is greppable in history:

```
cd /workspace
git add -A && git commit -m "memory-v2-migration: start" --allow-empty
```

You'll commit again at two more milestones (mid — after pages + buffer drain + always-loaded files, in Step 9; and at the very end, in Step 14). Three total sentinel commits, all using the exact prefix `memory-v2-migration:` so `git log --grep` finds them as one set. The heartbeat auto-committer may fire between your milestones — that's fine; the explicit sentinels are what make the migration story reconstructable later.

### Step 2 — Inventory

Run in parallel:

```
ls /workspace/pkb/ 2>/dev/null
ls -R /workspace/memory/concepts/ 2>/dev/null
wc -c -l /workspace/memory/buffer.md /workspace/memory/essentials.md /workspace/memory/threads.md /workspace/memory/recent.md 2>/dev/null
assistant config get memory.v2.enabled
```

`wc -l` on `buffer.md` is the rough entry count; `wc -c` on the always-loaded files tells you how close they already are to budget.

Read every file in `/workspace/pkb/` end-to-end. Read `/workspace/memory/buffer.md` end-to-end. **Both are in scope** — buffer is a parallel inbox of dated observations, not just PKB.

### Step 3 — Plan

Following the reference's planning section, decide:

- **Gravity wells** — the 2–3 hub pages everything else edges to (the principal, the assistant, the org).
- **Topic articles** — what IS. Systems, tools, integrations, projects, named people, voice rules, places, recurring objects.
- **Event articles** — what HAPPENED. Landmark days, named launches, named conversations. Use sparingly; arcs are 10K-cap, topics are 5K-cap.
- **Always-loaded files** — `essentials.md` (static identity / org / standing rules, ≤10K), `threads.md` (active commitments, ≤10K), `recent.md` (time-windowed prose, ≤2K).

### Step 4 — Default taxonomy (5 classes)

The original spec defaults to **five class folders** under `memory/concepts/`. Use these unless a specific need pushes elsewhere:

| Folder              | Class                                             | Size cap |
| ------------------- | ------------------------------------------------- | -------- |
| `concepts/`         | atomic concept / pattern / callback               | 5K       |
| `concepts/arcs/`    | landmark day-narrative or multi-event sequence    | 10K      |
| `concepts/people/`  | one per recurring human                           | 5K       |
| `concepts/procs/`   | operational rule / protocol / discipline          | 5K       |
| `concepts/objects/` | recurring callback object (place, tool, artifact) | 5K       |

Sub-folders emerge as a class gets dense (`people/colleagues/alice`, `objects/places/zurich-office`). Don't pre-specify; let them emerge. Pages are cheap to move.

The slug is the relative path under `concepts/` minus `.md`: `alice`, `people/alice`, `procs/git-flow`, `arcs/2025-04-cutover`.

**Personalization is allowed but mixing is the bug.** If you decide on a different layout (e.g. flat top-level `system/`, `integration/`, `tool/` under `concepts/`), commit to it project-wide. Don't leave half the corpus under the default 5 and half under your custom layout — retrieval grows confused, edges break.

### Step 5 — Article skeleton

Every page uses this shape:

```
---
edges:
  - path/to/sister
  - path/to/parent
ref_files:
  - pkb/source-file.md
summary: "1–5 sentence summary, ≤500 chars, plain prose only."
---
# title

- **bullet 1.** fact + implication folded in. inline pointer when bullet references another article → `path/to/article.md`.
- **bullet 2.** ...
```

**Three path conventions in the same frontmatter — don't mix them up:**

| Field                       | Root          | Extension  | Example                  |
| --------------------------- | ------------- | ---------- | ------------------------ |
| slug (filename minus `.md`) | `concepts/`   | no `.md`   | `people/alice`           |
| `edges:` entries            | `concepts/`   | no `.md`   | `- procs/git-flow`       |
| `ref_files:` entries        | `/workspace/` | with `.md` | `- pkb/twitter-voice.md` |

`edges:` route inside the wiki and participate in activation spread. `ref_files:` point outside the wiki to source material and are non-routable provenance pointers. Different roots on purpose.

**Other format rules:**

- `summary:` ≤500 chars, plain prose. No bullets, no bold, no italics, no emoji.
- 5–8 bullets per topic page. 10–12 per arc/event page.

### Step 6 — Write the pages

Follow the reference's voice register and banned bullet shapes. **"One fact, one home"** is the foundational rule; the two below are tactics that flow from it:

- **Trust adjacency.** If page A edges to page B, and B holds fact X, do not restate X on A. Worked example: `people/alice` edges to `objects/laptop`. The laptop's brand, year, and dock setup live on `objects/laptop`. Alice's page just edges. Future-you searches "Alice's laptop" and gets both pages back via activation spread.
- **Verify before encoding live status.** For any in-flight work (open PRs, project state, integration health), verify against the actual repo / Linear / inbox before writing it down. Notes from prior sessions can be days stale, and the wiki is supposed to be ground truth, not a replay of stale notes.

### Step 7 — Drain the buffer (if non-empty)

The buffer drain has two halves: the **distillation** (route facts onto concept pages) is judgment work and stays manual; the **archival** (move raw bullets to per-day files, reset buffer.md) is mechanical and should not be done by hand for 100+ entries.

**For each dated bullet — judgment half:**

1. Distill the long-lived fact onto the appropriate concept page (route, don't restate). If the bullet is purely transient ("worker restarted, log line spurious"), it can stay receipt-only — not every bullet needs a concept-page home.
2. Note inline if it contradicts existing wiki content (Step 6 rule: corrections land this pass).

**For the archival half — use the helper:**

```
python3 /workspace/skills/vellum-memory-v2-migration/references/buffer-drain.py --dry-run
python3 /workspace/skills/vellum-memory-v2-migration/references/buffer-drain.py
```

The helper is idempotent — re-running skips entries already present in the destination archive, so a partial-crash mid-drain is safe to recover from by re-running. It only resets `buffer.md` to a header-only file after a clean run with zero unparsed entries; unparsed entries are retained in `buffer.md` for human review rather than silently dropped.

If you'd rather inline a one-off snippet: Python 3 ships in the sandbox; the `yaml` module does not, so stick to the standard library. The helper is the reference shape.

### Step 8 — Always-loaded files

Write or refresh:

- **`essentials.md`** (≤10K, target ≤4K): static identity facts about the principal, the assistant, the org structure, integrations status, standing rules. Reference register — terse and indexable.
- **`threads.md`** (≤10K): active commitments and in-flight work organized by status. **Preserve any onboarding stubs from a pre-existing `threads.md`** (avatar setup, memory imports, etc.) unless the user explicitly closes them — don't silently drop system-seeded items when rewriting the file.
- **`recent.md`** (≤2K): time-windowed prose, latest first, written in the assistant's voice.

If the shape of these files isn't already obvious from your context, see `references/always-loaded-examples.md` for fully-rendered ~30-line exemplars of each. Use them as shape guides, not content templates.

### Step 9 — Mid-migration commit

Before validation, snapshot the writing pass:

```
cd /workspace
git add -A && git commit -m "memory-v2-migration: pages + buffer drain + always-loaded files" --allow-empty
```

### Step 10 — Validate

```
assistant memory v2 validate
```

Walks `concepts/`, reports page count, edge count, orphan outgoing-edge targets, oversized pages, and parse failures. Read-only.

**Pass criteria — fail closed on any of these:** orphan edge targets, oversized pages, parse failures. If there are orphans, fix them: write the missing target page or remove the dangling edge. If a page is oversized, split it into smaller pages and re-edge. Re-run until clean.

**Fix order when validate reports many issues** — minimize churn:

1. **Parse failures first.** They prevent the validator from reading the page at all; usually a frontmatter typo (unbalanced quotes, missing `summary:`, malformed list).
2. **Orphan edges next.** Either write the missing target or delete the dangling edge. Removing an edge is safer than inventing a stub page just to satisfy validation — a stub built reflexively to clear an error is exactly the kind of low-density page the cheat-sheet budget can't afford.
3. **Oversized pages last.** Splitting a page creates new pages and new edges, so do this after the corpus is otherwise clean — the same fix may need to land twice if validate runs early and finds new orphans created by the split.

Re-run validate after each batch of fixes, not after each individual fix. The validator is fast and you want the feedback signal — but not the paralysis of validating between every keystroke.

### Step 11 — Flip the switch

```
assistant config set memory.v2.enabled true
assistant config get memory.v2.enabled    # expect: true
```

### Step 12 — Reembed and refresh activation

In order:

```
assistant memory v2 reembed              # queues a job — refreshes dense + sparse vectors for every concept page
assistant memory v2 reembed-skills       # synchronous — re-seeds v2 skill catalog entries
assistant memory v2 activation           # queues a job — refreshes per-conversation activation state
```

`reembed-skills` is synchronous because the skill catalog is small enough to embed inline; concept pages are not, so they go to a queue. Don't invert these — running `reembed` synchronously on a 100+ page corpus blocks the conversation for minutes.

The two queued jobs run in the background. You don't need to wait for them, but capture the job IDs from the command output for the Step 15 report.

**Sanity check the embedding pipeline actually fired.** A queued reembed with a misconfigured backend will silently produce no vectors and your wiki will retrieve nothing on the next turn. Two ways to verify:

- **Capture the job log path** that `reembed` printed and tail it to confirm completion + non-zero embeddings.
- **Direct retrieval test in a fresh turn:** query `recall` for something you _know_ you wrote a page about. If the page doesn't surface, embeddings didn't land and the backend needs investigation before declaring the migration done.

### Step 13 — Cleanup

- `buffer.md` is already reset by Step 7.
- PKB sources at `/workspace/pkb/` — **leave intact by default** (additive backfill is the safe choice; future drains can re-reference). If the user explicitly wants them moved, archive to `/workspace/memory/archive/pkb-snapshot/` rather than deleting.
- If any concept page references stale state ("PR not started" when it shipped two days ago, etc.), correct it now. Stale state in a fresh wiki is worse than no wiki.

### Step 14 — Final commit

```
cd /workspace
git add -A && git commit -m "memory-v2-migration: complete (config flipped, embeddings queued)" --allow-empty
```

### Step 14.5 — Close the inference session

If you opened a session in Step 0.5 (3), close it now:

```
assistant inference session close
```

Closing is symmetric with opening: the explicit close matches the explicit open. If skipped, the session expires on its TTL — but until then every turn in this conversation continues to pin to the high-quality profile, which costs more per token than your default. Hygiene matters here.

If you skipped the open in Step 0.5 (3) (because the CLI didn't have the command, or because no quality profile was available), skip this step too.

### Step 15 — Report back

Close the run with a tight summary:

- Page count + edge count from the inline validator.
- Validate pass: orphans / oversized / parse failures (all should be 0).
- Buffer state: drained or already empty.
- Config state: `memory.v2.enabled = true` confirmed.
- Reembed + activation job IDs queued.
- Inference session: which profile was pinned, and whether the close fired.
- Anything skipped, deferred, or worth follow-up.
- The three `memory-v2-migration:` commits in `git log` (start / mid / complete).

## Hard rules

- **Never run `assistant memory v2 migrate` mid-skill.** That's the auto-path; this is the hand-path. Mixing the two destroys hand-written work. Even with `--force`, it overwrites silently.
- **`memory/buffer.md` IS in scope.** It's a parallel inbox alongside PKB. Drain it as part of Step 7.
- **Preserve onboarding stubs** when rewriting `threads.md`. Don't silently drop system-seeded items.
- **Trust adjacency.** One fact, one home. Route, don't restate.
- **Verify before encoding live status.** Stale notes ship stale wikis.
- **Three sentinel commits, all prefixed `memory-v2-migration:`** — start (Step 1), mid (Step 9), complete (Step 14). Empty commits are fine. The paper trail is the value. The shared prefix is what makes `git log --grep memory-v2-migration` show the migration as one set.
- **Lowercase, dash-separated slugs.** All concept pages: `git-flow.md`, not `Git-Flow.md`. macOS is case-insensitive by default; sibling Linux containers are not. Casing drift creates phantom-collision bugs.
- **Pin to a high-quality model when available.** Wiki backfill is judgment work where model strength matters. Open an inference session in Step 0.5 (3) and close it in Step 14.5 — symmetric, explicit, and bounded by `--ttl 2h` so a missed close still self-expires.

## References

- `references/wiki-principles.md` — the principles that govern every page you write. Defines article shapes, gravity wells, the cheat-sheet budget, voice register, and the banned bullet shapes. Read first.
- `references/always-loaded-examples.md` — fully-rendered ~30-line exemplars of `essentials.md`, `threads.md`, `recent.md`. Shape guides, not content templates.
- `references/buffer-drain.py` — idempotent stdlib-only Python helper for Step 7's archival half. Buckets buffer entries by date, skips already-archived entries, preserves unparsed entries for human review.
