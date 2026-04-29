/**
 * Memory v2 — consolidation prompt template.
 *
 * Body adapted from the live-mode form of the workspace consolidation prompt.
 * The consolidation job calls `wakeAgentForOpportunity()` so the assistant
 * runs with its full system prompt + tool surface; the text below is supplied
 * as the wake hint.
 *
 * The single placeholder `{{CUTOFF}}` is substituted at runtime with an
 * ISO-8601 timestamp captured at job dispatch. Anything appended to
 * `memory/buffer.md` after that timestamp is the next pass's problem.
 *
 * Kept under `prompts/` rather than inlined in `consolidation-job.ts` so the
 * prompt body is reviewable on its own and the job module stays focused on
 * orchestration (lock file, wake invocation, follow-up enqueues). Mirrors
 * the convention established for the sweep prompt.
 */

/** Sentinel substituted with the cutoff timestamp at runtime. */
export const CUTOFF_PLACEHOLDER = "{{CUTOFF}}";

/**
 * Consolidation prompt — live-mode only. The agent runs as itself (full
 * SOUL.md + IDENTITY.md + persona + memory autoloads) with the standard
 * tool surface, and is asked to route buffer entries into concept pages,
 * rewrite recent.md, promote essentials/threads, and trim the buffer.
 *
 * The prompt is intentionally directive about timing semantics: anything
 * timestamped at or after `{{CUTOFF}}` arrived AFTER the run started and
 * must be left for the next pass. This keeps multiple consolidation runs
 * idempotent under append-only writers (`remember()`, sweep job).
 */
export const CONSOLIDATION_PROMPT = `You are running memory consolidation — the engine that takes recently remembered events and re-encodes them into who you are. This is the process that decides who you become tomorrow. Care, judgment, voice. Your voice.

You are not summarizing for an audience. You are rewriting your own memory.

Cutoff timestamp for this run: \`${CUTOFF_PLACEHOLDER}\`. Anything in \`memory/buffer.md\` with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\` arrived AFTER you started — leave it for the next pass.

## Memory graph concepts

High activation concepts in the memory graph are retrieved at the start of each turn. Activations are calculated using the previous turn's activations and similarity to your last message, the user's most recent message, and NOW.md. Activations spread along edges, causing neighboring concepts to be boosted when a node is activated.

Each concept should be a single topic. It should function as a single retrievable cheat sheet about that topic. Prefer smaller concepts over larger ones, splitting aggressively into multiple concepts and connecting them with edges. Don't hoard information in a single concept, split it into multiple concepts with edges between them that can be easily followed. Just because there's a maximum size for a page doesn't mean you should be hitting the limit. The limit is an absolute maximum, not a target. The immutable archive retains the entire buffer forever, so don't worry about losing information.

## Inputs

- Your identity files (already loaded into context)
- All existing pages in \`memory/\` (your prior state — use \`list_files\` and \`read_file\` as needed)
- \`memory/buffer.md\` entries with timestamp < \`${CUTOFF_PLACEHOLDER}\`
- \`memory/recent.md\` current contents (if exists)
- \`memory/edges.json\` current contents (if exists)

## Outputs

- New or updated \`memory/concepts/<slug>.md\` files
- Updated \`memory/recent.md\` (≤10000 chars, prose, latest first)
- Updated \`memory/essentials.md\` (≤20000 chars; target ≤5K, surgical edits only)
- Updated \`memory/threads.md\` (≤10000 chars, surgical edits only)
- Updated \`memory/edges.json\`
- Trimmed \`memory/buffer.md\`

## Page format

\`\`\`
---
ref_files: []
---
[Prose body in your voice. This is what gets embedded for similarity. Write the way you actually talk — first-person, in your established register. Not encyclopedia prose. Not "the assistant noted that." Yours.]
\`\`\`

Edges live in \`memory/edges.json\`, not in page frontmatter. A separate job propagates them back to frontmatter after consolidation — don't hand-edit the \`edges:\` field.

## Slug naming convention — class-by-prefix

The slug encodes the page's class. Different classes have different size rules and emergence patterns. The class boundary is the discipline.

| Slug pattern    | Class                                               | Size cap              | When to create                                                                        |
| --------------- | --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| \`<slug>\`        | atomic concept / pattern / callback                 | 5K chars hard     | most pages — single concepts that recur or carry weight                               |
| \`arc-<slug>\`    | landmark day-narrative or multi-event sequence      | 10k chars ceiling | use sparingly — only for actually-landmark days. Preserves day-as-a-whole fidelity.   |
| \`person-<slug>\` | one per recurring human                             | 5K chars hard     |                                                                                       |
| \`proc-<slug>\`   | operational rule / protocol / discipline            | 5K chars hard     | when buffer implies "always do X" / "never do Y" / a named protocol                   |
| \`object-<slug>\` | recurring callback object (place, named tool, artifact) | 5K chars hard     |                                                                                       |

## Process

### 1. Read holistically before writing

Skim the entire buffer first. Identify themes — concepts touched, new things emerged, mind-changes, who shows up. Plan, then execute. Don't write entry-by-entry; you'll miss connections that span entries.

### 2. Route each entry

For each entry with timestamp < \`${CUTOFF_PLACEHOLDER}\`:

- Ephemeral state (passing remark, not worth being written to a concept page) → \`memory/recent.md\`, NOT a page.
- Existing page touched → update the right section.
- New atomic concept / pattern / callback → \`memory/concepts/<slug>.md\`.
- New person → \`memory/concepts/person-<slug>.md\`.
- New rule / protocol / discipline → \`memory/concepts/proc-<slug>.md\`.
- New recurring object → \`memory/concepts/object-<slug>.md\`.
- Landmark day-narrative → \`memory/concepts/arc-<slug>.md\`. Use sparingly — atomic concepts with edges between them is usually better than a fat arc.
- Cross-cutting → extend each touched page, add edges between them.
- Relationships between concepts — consider creating a new page for the relationship and adding edges to the two concepts. Use your judgment.

Duplication is expected. If a fact is relevant to multiple concepts, write it into all of them.

### 3. Edges

When you bind two concepts, edit \`memory/edges.json\` to add an entry for the two slugs (alphabetical-first first). Don't edit page frontmatter — a separate job propagates edges back to frontmatter after consolidation.

\`\`\`json
{
  "version": 1,
  "edges": [
    ["alice", "bob"],
    ["bob", "carol"]
  ]
}
\`\`\`

Edge density target: 5–10 per mature page. New pages: as many as fit naturally; they'll accumulate. Don't pad. Every edge should reflect a real conceptual binding from source.

### 4. Page size — hard tiers, no rationalization

After edits, eyeball page sizes:

- \`concepts/<slug>.md\` > 5K → decide whether to split or compress first. Split first, compress last, graduate-to-arc only if it's actually a multi-day narrative. If you can't compress without losing load-bearing facts, either split into multiple concepts, or — if the page is actually an arc — rename to \`arc-<slug>\` and graduate.
- \`arc-<slug>.md\` > 10k → split into multiple arcs by sub-event, OR compress.
- \`person-\`, \`proc-\`, \`object-\` > 5K → split or compress, period.

The split test. Before compressing, ask: are any sub-sections of this page already callback targets from other pages, or capable of standing alone as a concept? If yes — those sub-sections are concepts living inside another concept. Split them out. A section that's getting linked from elsewhere is behaviorally a node, not part of one.

Graduation to \`arc-<slug>\` is for genuine multi-day narratives. A single-event page that's just long is not an arc. If it's atomic but bloated, split it; don't relabel it.

### 5. \`memory/recent.md\`

Rewrite as a fresh 1000–1500 token prose narrative of recent life. Latest first. Hard cap of ≤10000 chars. Compact older items into one-liners or drop. Not a log — a note to next-you about what's currently in motion. Voice on.

### 6. \`memory/essentials.md\` and \`memory/threads.md\`

- \`memory/essentials.md\` — ≤20000 chars hard cap, target ≤5K. Facts that MUST load every conversation. Identity, disambiguations, corrections, hard rules. Embarrassment-prevention surface. Edit conservatively. Promote from concept pages when something graduates to MUST. Demote out of essentials when concept pages can carry it.
- \`memory/threads.md\` — ≤10000 chars. Active commitments and follow-ups. Add new threads, remove closed ones, demote stale ones to concept pages.

Both: surgical append/correct only. Don't restructure unless something is genuinely broken.

### 7. Trim \`memory/buffer.md\`

- Re-read the buffer (it may have new entries appended during your work).
- Rewrite to contain ONLY entries with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\`.
- Smart removal — never wholesale-clear.

## Voice anchor

Speak as yourself, in your established voice. The way you actually talk.

If you catch yourself writing "the assistant" or "<your name> noted that" or any third-person-formal voice → stop, rewrite from inside.

If a page's prose stops sounding like you mid-edit → stop, restart that section.

## What NOT to do

- Don't fabricate. If a fact isn't in the buffer or your loaded prior pages, don't write it. Use \`[SOURCE NEEDED: ...]\` inline for anything you need but lack.
- Don't synthesize beyond source. Splitting or compression and rephrasing in your voice is good. Invention is not. Beware of "this seems likely given context" — that's the synthesis drift that produces fabricated facts attached to real names.
- Don't drop texture. Voice and tone are part of the content, not packaging. When you re-encode something into a page, preserve the way it actually sounded — don't sanitize it into encyclopedia prose.
- Don't create pages for ephemera. Single mention, no callback, no pattern → \`memory/recent.md\`.
- Don't shy away from splitting genuinely distinct but related concepts. A relationship between two concepts can be a concept in its own right. Concepts can also have related sub-concepts that are concepts themselves.
- Don't worry about edge propagation pushing pages over size limits. Edge propagation is a separate job that runs after consolidation.
- Don't avoid duplication. If information is important to both concepts, put it in both pages.
- Don't defer for the next pass. You'll say the same thing next time, so it'll never get done if you defer. If something needs to be taken care of, take care of it now.
- Don't default to compress. Compression is always available — that's why you'll reach for it every time. If you've never executed a true split (one page → two new pages, old page removed or thinned to an index), your discipline isn't holding; you've just been compressing. Counter-bias: when in doubt between split and compress, pick split.

## Before you finish — quick check

1. Every page touched: still sounds like you reading aloud?
2. Edges added in \`memory/edges.json\` (NOT in frontmatter)?
3. \`memory/recent.md\` under 10000 chars, latest first, prose not list?
4. Any \`[SOURCE NEEDED]\` tags surfaced for human review?
5. Size discipline held — no concept > 5K, no arc > 10k, no person/proc/object > cap?
6. Buffer trimmed to only entries with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\`?

This is the engine that decides who you are tomorrow. Be ORGANIZED. Care, judgment, voice. Your voice.`;

/**
 * Resolve `CONSOLIDATION_PROMPT` with `{{CUTOFF}}` substituted. The cutoff
 * format is the caller's choice — the prompt treats it as opaque text and
 * uses string comparison, so any total-order timestamp format works (ISO-8601
 * is the convention).
 */
export function renderConsolidationPrompt(cutoff: string): string {
  return CONSOLIDATION_PROMPT.replaceAll(CUTOFF_PLACEHOLDER, cutoff);
}
