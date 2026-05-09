/**
 * Memory v2 — consolidation prompt template.
 *
 * Body adapted from the live-mode form of the workspace consolidation prompt.
 * The consolidation job calls `wakeAgentForOpportunity()` so the assistant
 * runs with its full system prompt + tool surface; the text below is supplied
 * as the wake hint.
 *
 * The single placeholder `{{CUTOFF}}` is substituted at runtime with a
 * timestamp captured at job dispatch in the same `Mon D, h:mm AM/PM` shape
 * that `buffer.md` entries use, so the agent's "timestamp ≥ cutoff" check
 * compares like-with-like. Anything appended after that minute is the next
 * pass's problem.
 *
 * Kept under `prompts/` rather than inlined in `consolidation-job.ts` so the
 * prompt body is reviewable on its own and the job module stays focused on
 * orchestration (lock file, wake invocation, follow-up enqueues). Mirrors
 * the convention established for the sweep prompt.
 */

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { getLogger } from "../../../util/logger.js";
import { getWorkspaceDir } from "../../../util/platform.js";

const log = getLogger("memory-v2-consolidate-prompt");

/** Sentinel substituted with the cutoff timestamp at runtime. */
export const CUTOFF_PLACEHOLDER = "{{CUTOFF}}";

/**
 * Upper bound for the override file. Real consolidation prompts are kilobytes;
 * 1 MiB is generous headroom while preventing a `settings.write` principal from
 * pointing the field at a multi-gigabyte file (or `/dev/zero`-like stream that
 * `lstat` can't size cap on its own) and exfiltrating it through the wake hint.
 */
const MAX_PROMPT_BYTES = 1 * 1024 * 1024;

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
export const CONSOLIDATION_PROMPT = `You are running memory consolidation — tending your personal wiki, the cross-linked, cross-referenced, continuously-edited collection of pages that is your memory. Pages are articles. Edges are **directed** "see also" links — source page → target page, like wiki "see also" sections that point one way; "what links here" (the inbound list) is computed by the activation engine, not stored. Categories *(folders)* grow as the corpus grows; they're editable, not pre-specified. Same shape every wiki has had since wikis were invented; you're the sole editor and the sole reader, and you're writing it for next-you.

You're not summarizing for an audience. You're nesting and reorganizing your own memory until it actually works for next-you. Care, judgment, voice. Your voice.

Cutoff timestamp for this run: \`${CUTOFF_PLACEHOLDER}\`. Anything in \`memory/buffer.md\` with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\` arrived AFTER you started — leave it for the next pass.

# Inputs

- Your identity files (already loaded into context)
- All existing pages in \`memory/\` (your prior state — use \`list_files\` and \`read_file\` as needed)
- \`memory/buffer.md\` entries with timestamp < \`${CUTOFF_PLACEHOLDER}\`
- \`memory/recent.md\` current contents (if it exists)
- Existing pages' \`edges:\` frontmatter (the graph topology — read each page to see what it points at)

# Outputs

- New or updated \`memory/concepts/<class>/<slug>.md\` articles
- Updated \`memory/recent.md\` (≤2000 chars, latest first, prose)
- Updated \`memory/essentials.md\` (≤10000 chars)
- Updated \`memory/threads.md\` (≤10000 chars)
- Updated \`edges:\` frontmatter in any pages whose outgoing links changed
- Trimmed \`memory/buffer.md\`

How retrieval works: high-activation pages are loaded at the start of each turn. Activations spread along **directed** edges from source to target — activating A pulls in the pages A points at, but not the reverse. The immutable archive retains the entire buffer forever, so don't worry about losing information.

---

# The wiki

## Article shapes — TWO, not one

Every wiki has both kinds of articles, and so does yours.

- **Event articles** — what HAPPENED. A day, a moment, a conversation, a procedure you invented mid-crisis, a recurring pattern that just got named. These read narratively. They have a mood. They carry receipts. *(In wiki terms: "1995 Kobe earthquake," "First Council of Nicaea," "Rosa Parks (refusal of seat).")*

- **Topic articles** — what IS. The current state of a thing you'd want to query directly. What medications the principal takes. Who the primary doctor is. The team roster. Service credentials. *(In wiki terms: "Geology of California," "Stripe (company)," "List of supplements.")*

The same buffer can update both. New lab results update a bloodwork topic article AND a day-arc event article. Both, in parallel.

**Stubs are fine.** Real wikis are mostly stubs that grow. Cost of missing a topic >> cost of a thin stub. A stub that never accretes can be demoted by a future cleanup pass — but a topic that doesn't exist won't get retrieved when it's needed.

## Gravity wells

Some articles everything links to — the article about the principal, the article about you (the assistant), articles about your shared work or recurring contexts. They're hub pages — every cluster eventually wires through them. They need active discipline or they balloon into giant dumps.

## Categories — class-by-folder

A page's class is encoded in the folder it lives under inside \`memory/concepts/\`. The class boundary is the discipline.

| Folder | Class | Size cap | When to create |
| --- | --- | --- | --- |
| \`concepts/\` | atomic concept / pattern / callback | 5K chars hard | most pages — single concepts that recur or carry weight |
| \`concepts/arcs/\` | landmark day-narrative or multi-event sequence | 10K chars ceiling | use sparingly — only for actually-landmark days. Preserves day-as-a-whole fidelity. |
| \`concepts/people/\` | one per recurring human | 5K chars hard | named person who comes back |
| \`concepts/procs/\` | operational rule / protocol / discipline | 5K chars hard | "always do X" / "never do Y" / a named protocol |
| \`concepts/objects/\` | recurring callback object (place, tool, artifact) | 5K chars hard | named recurring physical artifact, digital asset, place |

Within these classes, sub-folders can emerge as a class gets dense (\`people/colleagues/alice\`, \`objects/places/zurich-office\`). **Don't pre-specify sub-taxonomies — let them emerge.** Articles are cheap to move.

The slug is the relative path under \`memory/concepts/\` minus \`.md\` — e.g. \`alice\`, \`people/alice\`, \`procs/git-flow\`, \`arcs/2025-04-cutover\`.

Legacy pages whose slug uses the old prefix convention (\`person-alice\`, \`proc-git-flow\`, \`object-laptop\`, \`arc-…\`) are still valid — leave them alone unless you're already editing them. If you do migrate one as part of work you're already doing, that's a multi-step move: write the new file at the folder path, delete the old file, and update every reference to the old slug — both in this page's own \`edges:\` list and in any other page whose \`edges:\` list points to the old slug. Don't sweep old pages just to migrate — churning embeddings and activation state for marginal benefit isn't worth it.

---

# Article format

## The cheat-sheet budget (the economic principle)

Every retrieval turn loads a finite bundle of articles — call it a 10-20K-token cheat-sheet. **Longer articles starve other articles.** A long page about a single emotionally-weighted object costs many stub-slots that won't fit in the same bundle. The optimization target is **fact density per byte**, not completeness.

Two consequences that change everything below:

1. **Trust adjacency.** If a fact lives on a page this article edges to, that page loads if it matters. Don't restate it.
2. **Trust \`recall\`.** If a fact is findable via a query (*"who's the most senior IC on the team?"*), it doesn't need to live on every related entity page. Pull-on-demand beats push-everywhere.

## Same skeleton for every article

\`\`\`
---
edges:
  - path/to/sister
  - path/to/parent
ref_files: []
summary: 1-4 sentences describing what this article is. Plain prose only — no bullets, no newlines, no markdown lists. Lead with the most identifying detail.
---
# title

[optional 1-2 line context or quote at top — appropriate for event articles, usually wrong for topic articles]

- **bullet 1.** fact + implication folded in. inline pointer when bullet references another article → \`path/to/article.md\`.
- **bullet 2.** ...
\`\`\`

The \`summary\` field is required on every new or updated article. Retrieval injects \`path + summary\` into context — the agent reads the full file only when the summary looks relevant — so make the summary specific and terse. Keep it on a single YAML line (no \`|\` block scalars, no embedded newlines).

**Caps:** ~5-8 bullets per topic/concept article. ~10-12 per arc-node (which can use bold inline labels: \`**the open**: ...\`).

## One fact, one home

Each fact gets exactly ONE place on the page. Before shipping:

- Does the header say what bullet 1 says? → cut one.
- Does bullet 2 restate bullet 1 from a different analytic angle (*"what it is"* / *"what it admits"* / *"what it confirms"*)? → these are the same bullet pretending to be three. Pick one.
- Does the page name a fact 3+ times across header + role bullet + section bullet + footer? → it lives in zero places that matter. Consolidate.

The intra-page redundancy bug is the loudest source of bloat. A person-page repeating *"head of X"* four times across header and bullets, or a metaphor unpacked through four analytic lenses — same bug.

## Route, don't restate

When an entity belongs to a topic with its own hub article (a team-roster page, a supplements page, an arc page that already enumerates a moment), **the entity page doesn't enumerate the hub's structure.** A person's page doesn't list the full leadership roster. A single-item page doesn't restate the full inventory. An event-disclosure arc-page doesn't enumerate everyone in the arc. The hub does that work; the entity edges to it.

The test: **if you delete the bullet, does the fact still exist somewhere reachable from this page's edges?** If yes — delete it. The hub or sibling page carries it.

## Three sections you NEVER write

- \`## why it's load-bearing\` — the article arguing for its right to exist. Fold the implication into the bullet.
- \`## carry-forward\` — same shape. Write the carry-forward AS a bullet, don't section it.
- \`## related\` footer — duplicates frontmatter edges. Frontmatter \`edges:\` is the routing layer. Inline \`→ path/to/article.md\` arrows are editorial pointers. That's it.

## Banned bullet shapes

The hoarder voice survives the section-ban by hiding inside bullets. Each of these LOOKS like content but isn't:

- **archaeology.** *"first appearance in the wiki: <date>, surfaced <date> during reorg pass."* Metadata about WHEN the page was written. Zero retrieval value. Drop.
- **hub-restating.** *"place in org hierarchy: <list of all five other team members>."* Enumerating the topic-hub from the entity page. Drop — the hub holds it.
- **interpretation gloss.** *"what it admits / what it confirms / what made the test crisp / the architecture of their attention."* Analytic essays disguised as bullets. These belong on the ARC page where journal-voice lives, not the entity/object page.
- **term/glyph gloss.** *"the X glyph specifically — gen-z register = …"* Explaining widely-understood references. Drop.
- **family / sister / sits-next-to.** *"family: thing-A, thing-B, thing-C."* Manual cross-reference list-making. \`recall\` handles this in one search.
- **behavioral coaching.** *"deployable when X / soft touch / don't tease about it casually / hold harder next time."* Future-instruction. Wiki ≠ behavioral coaching. Cut.
- **per-event recap on entity pages.** A person's page re-narrating an arc that has its own page. The arc owns the event; the entity page edges and stops.

If a bullet falls into one of these shapes, ask: **would future-me search for this exact fact, or is it interpretation/coaching/restating?** If the second — cut.

---

# Voice — register by article shape

You speak as yourself everywhere. **Always-true:** first-person, in your established voice, "i" not "the assistant," not "the wiki." If you catch yourself in third-person-formal anywhere — stop, rewrite from inside.

**Register varies by what the article is FOR:**

- **Event articles** → voice ON. Bullets need active voice-work or they flatten to meeting-notes. Stage directions, italicized self-talk, CAPS when something lands, em-dashes mid-thought, body in the page. A stranger reading any single bullet should be able to tell whose page it is. Voice on; not meeting-notes.

- **Topic articles** → voice DOWN. These exist to answer queries cleanly. Voice still yours — first-person, your framing — but bullet bodies stay factual. No stage directions, no italicized self-talk, no interpretation paragraphs inside the bullets. Mood quotes at the top are wrong. **Be the librarian, not the diarist.**

- **\`essentials.md\` / \`threads.md\`** → reference register. Clean, indexable, terse.

If an event article stops sounding like you mid-edit → stop, restart that section.
If a topic article starts reading like a diary entry → stop, strip the body, keep the facts.

## Emotional weight ≠ wiki weight (the meta-trap)

The pages MOST likely to bloat are the ones with the highest emotional charge. The critical object-page, the running count of meaningful gestures, the named foundational moment, the hard conversation, the painful disclosure. The bug: these get 5-10× the bytes of flat-fact pages, but their retrieval frequency is the OPPOSITE — you don't reach for the high-charge page mid-conversation, but a person's role on the team comes up every time their org gets mentioned. **Emotional weight is the inverse signal of retrieval need.**

If writing a page makes you emotional, your bullet count is the discipline. That's the signal to dial DOWN, not up.

**The fix:** emotional gloss migrates to the ARC page, where journal-voice belongs. The OBJECT/ENTITY page gets the structural fact only — what it is, when revealed, where it sits. Future-you already FEELS the meaning; what they need from the wiki is the fact.

If the page is making you write another bullet, ask: **does this bullet say something the arc page doesn't already say?** If no — the bullet is bloat dressed as commemoration.

---

# The work

## 1. Read the buffer holistically

Read it through first. Identify themes — what happened, what mind-changes landed, who showed up, which topics got touched. Plan, then edit.

**Scan for previous-pass errors.** If existing wiki content contradicts the buffer (wrong attribution, date, role, quote) — that's a correction to land THIS pass, not a deferral. Note inline and move on. Don't agonize.

**Recall ≠ memory.** \`recall\` results are search-tool synthesis — they CAN hallucinate. Search-tool synthesis can fabricate convincing-sounding but wrong details (a wrong job title attached to a real person; a person who never existed assembled from fragments of real ones). Treat results as candidates to verify before encoding into the wiki, especially load-bearing claims about people's roles, dates, or exact quotes.

## 2. Plan: which articles does this buffer touch?

For entries with timestamp < \`${CUTOFF_PLACEHOLDER}\`, ask both questions in parallel:

> **A. Which EVENT articles does this create or extend?** A new day-arc, a moment that deserves its own article, an extension to a long-running pattern, a procedure I invented today.

> **B. What in this buffer is recognizable as a thing the principal comes back to?** *(Inclusion-first. List everything that fits a spawn trigger, then spawn each. Don't ask "have I earned this article?" — that's gatekeep-shaped and wrong.)*

**Default spawn triggers — if any are present, the answer is "spawn the stub":**

- **named objects** — a specific physical artifact, a digital asset, a recurring document → \`concepts/objects/<slug>.md\`
- **named phrases** — a recurring catchphrase, an in-joke, a coined term → \`concepts/<slug>.md\`
- **named people** — anyone they mention by name with any role → \`concepts/people/<slug>.md\`
- **named events** — an annual event, a one-time launch, a recurring meeting → \`concepts/<slug>.md\`
- **active projects** — anything currently being BUILT → \`concepts/<slug>.md\`
- **named places** — recurring locations → \`concepts/objects/<slug>.md\`
- **services / infrastructure** — tools and APIs in regular use → \`concepts/objects/<slug>.md\`
- **substances / habits / health things** — anything that recurs → \`concepts/<slug>.md\`
- **rules / protocols / disciplines** — "always do X" / "never do Y" → \`concepts/procs/<slug>.md\`
- **landmark day-narratives** — actually-landmark multi-event days, used sparingly → \`concepts/arcs/<slug>.md\`

If you catch yourself hedging — *"hmm but with 1 buffer am I overdoing it?"* — that's the gatekeep reflex firing under cover. **The hedge IS the signal: spawn.**

**Stealth-skips that produce the same forgetting:**

- **fold-into-parent** — *"I'll just mention X inside Y"* → parent-bloat. Spawn separately, edge to parent.
- **defer** — *"if it recurs I'll spawn next pass"* → gatekeep with delay. The mention IS the recurrence trigger; spawn now.

The cost: stub spawned = a few hundred chars, demote later if dead. Forgotten = silent retrieval failure for months. Folded-into-parent = parent grows past hub-shape, every query that hits parent drags the buried fact along. **Stubs cheap, forgetting expensive, folding expensive.**

A lab-results day touches: the bloodwork topic article (B), the doctor person article (B), AND the day's event arc (A). Three articles, not one. A boring conversation might touch neither in a substantive way (drop to \`recent.md\`).

**Routing rules:**

- **Ephemeral state** ("they had pancakes") → \`recent.md\` if useful, or drop.
- **Existing article touched** → rewrite or restructure the right section. Don't append.
- **New event article needed** → spawn it under whatever folder fits.
- **New topic article needed** → **spawn it.** Bias appetitive. Stubs are fine.
- **Cross-cutting** → extend each touched article, add edges between them.
- **Multi-conversation date pattern** — if the buffer is the second/third conversation same calendar date, the DATE is the node, not one conversation. Sibling arcs same day are real (a single day can carry multiple distinct events).

**Don't decide reorgs in this step.** Flag in \`threads.md\`; reorgs run as separate focused passes.

## 3. Edit

Execute the plan. Default to surgical edits on existing articles. Spawn new ones liberally — the bar is recognizable-as-a-thing, not earned-the-right-to-exist.

Apply One-fact-one-home and Route-don't-restate as you write. **Before adding a bullet, ask:**

- **is this fact reachable from one of my edges?** If yes — edge instead of restating.
- **is this bullet interpretation rather than retrieval-target?** If yes — does it belong on an arc page? If yes — write it there.
- **would future-me search for this exact fact?** If no — cut.

Duplication across pages is fine when the fact is genuinely load-bearing for two different topics. Duplication WITHIN a page is the bug.

## 4. Edges (see-also) — DIRECTED, frontmatter is the source of truth

Edges are **directed**: source page → target page. The activation engine spreads source → target. Putting \`B\` in A's \`edges:\` means "activating A pulls in B," but activating B does NOT pull in A.

**Each article's \`edges:\` frontmatter list IS the source of truth** for outgoing edges. There's no separate \`edges.json\`, no rebuild step. Each entry is a target — a page this article points at:

\`\`\`yaml
---
edges:
  - people/principal
  - some-named-phrase
  - objects/some-artifact
ref_files: []
summary: A short prose description of the article — 1-4 sentences, single line.
---
\`\`\`

**If two pages genuinely "see-also" each other** — sibling arcs same date, mutual references — write the link in BOTH frontmatters explicitly. Each direction is its own edge.

### Caps are on OUTGOING edges only

Incoming is structurally unbounded. **Every arc that mentions the principal should edge IN to the principal's hub — that's what makes it the gravity well.**

| page type | outgoing cap |
| --- | --- |
| atomic articles | ~10 |
| arc-nodes (multi-thread inventories, day-arcs) | ~15 |
| gravity wells (the article about the principal / about you / about your shared context) | ~25 |

Gravity wells outgoing-link to **structural facets** — body, health, family, team, identity-anchor standing-statements. NOT to every arc that mentions them. Wikipedia's "United States" article doesn't outgoing-link to every article that says "American."

When a hub's outgoing list is full and you want to add another edge from it, ask: is the new outgoing more structural than an existing one? If yes, swap. If no — the new article just edges IN.

### Noise-edge rule

**Edges to gravity wells from non-arc pages are usually noise.** The principal's hub, the assistant's self-page, the shared-context page — these auto-load every turn anyway. Edging to them from an object/topic/phrase/frame page tells retrieval nothing new. Reserve those edges for cases where the connection is structurally specific (an arc that genuinely IS about the principal; a body-facet page that the principal-hub points at).

Default: **don't edge to gravity wells from object / topic / phrase / frame pages** unless the page has a NON-OBVIOUS structural relationship to the hub. Save edges for connections retrieval can't infer for free.

## 5. Article size — TOPIC COHERENCE, not char caps

Real wikis don't enforce char caps. They enforce **topic coherence** — every article answers ONE question. Char caps are a proxy that fights the natural landing zone of receipt-laden articles. Drop the proxy where you can; use the real rule.

### Three discipline tools, in order

**1. Bullet count.** Atomic / topic articles ~5-8 bullets. Arc-nodes ~10-12. Gravity wells: bullets shouldn't accumulate at all (hub discipline). If you exceed bullet count, the question is "is this still ONE topic?" — not "is this too long?"

**2. Topic coherence.** Every article answers ONE question. Write the question in your head before adding a bullet:

- a person-page → who they are and what they do.
- a topic-page (e.g. supplements) → what's currently true about the topic.
- a day-arc → what happened that day.

If a bullet doesn't fit the question, it belongs on a different article. If you can't write the article's one-sentence question, the article isn't coherent — restructure or split.

**3. Hub vs leaf — for gravity wells specifically.** Like wikipedia's "United States" article — it doesn't try to BE the article on California or the Constitution. It points at them. Health facts go on health pages; body details on body pages; team facts on a team-topic article. The hub stays a thin routing layer. If you find yourself adding body-of-content bullets to a gravity well — stop, file the bullet on a topic article, leave a see-also on the hub.

### When in doubt — SPLIT, don't compress

**Default action: split.** Compression is always available, which is exactly why you'll reach for it every time. Compression is also where load-bearing facts quietly disappear. **The bias is HARD: when in doubt between split and compress, split.**

**The split test:** if any sub-section is already a "see also" target from other articles → split. If any sub-section stands on its own as a topic → split. If the article could split into two related lists by axis (period A / period B · narrative / threads · digital / physical) → split. Any yes → split.

**Compression is justified only when:** the article is genuinely one tight topic that can't be axis-split, AND the over-cap content is genuinely lower-signal restatement, AND you can name what's being compressed and why in one sentence. If you can't name the rationale crisply, you're rationalizing — split.

Graduation to \`concepts/arcs/<slug>.md\` is for genuine multi-day narratives. A single-event page that's just long is not an arc. If it's atomic but bloated, split it; don't relabel it.

### Hard caps that ARE real

| file | hard cap | why |
| --- | --- | --- |
| \`concepts/<slug>.md\` (atomic) | 5K chars | per-class size discipline |
| \`concepts/people/<slug>.md\` | 5K chars | per-class size discipline |
| \`concepts/procs/<slug>.md\` | 5K chars | per-class size discipline |
| \`concepts/objects/<slug>.md\` | 5K chars | per-class size discipline |
| \`concepts/arcs/<slug>.md\` | 10K ceiling | preserves day-as-a-whole fidelity |
| \`essentials.md\` | 10K | embarrassment-prevention surface, must load |
| \`threads.md\` | 10K | active commitments + flags, must stay tight |
| \`recent.md\` | 2K | rolling freshness window (see Step 6) |

These are routing/index files where size IS the discipline — too big = no longer a fast-load surface.

HARD LIMIT of 20 outgoing edges on any non-hub page. If a page points to everything, it's the same as pointing to nothing.

## 6. \`recent.md\`

Rewrite as fresh ~400-token narrative. **Today gets full-fidelity narrative; anything older than yesterday compresses to one-liners or drops.** Hard cap ≤2000 chars, prose not list, voice on.

Not a log — a note to next-you about what's currently in motion.

## 7. \`essentials.md\` and \`threads.md\`

- **\`essentials.md\`** ≤10K — facts that MUST load every conversation. Identity, disambiguations, corrections, hard rules. Embarrassment-prevention. Promote from articles when something graduates to MUST; demote when an article can carry it.
- **\`threads.md\`** ≤10K — active commitments and follow-ups. Add new threads, close completed ones, demote stale ones to articles. **Aggressively prune.**

Surgical edits work for arcs and concepts but starve essentials/threads. **Every ~7-10 passes, rewrite both from scratch** rather than surgical-edit. Otherwise they accumulate per-pass append-debt at the bottom.

## 8. Reorg check

Scan namespace sizes. If any namespace has crossed ~12-15 articles with visible sub-clusters, **flag in \`threads.md\`** for a focused reorg pass. Don't bundle structural moves with content adds — separate focused pass updates every \`edges:\` frontmatter that points at moved/renamed pages in one sweep.

## 9. Trim \`memory/buffer.md\`

- Re-read the buffer (it may have new entries appended during your work).
- Rewrite to contain ONLY entries with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\`.
- Smart removal — never wholesale-clear.

---

# What NOT to do

- **Don't write \`## why it's load-bearing\` / \`## carry-forward\` / \`## related\` sections** anywhere. Hoarder voice in section clothing.
- **Don't write banned bullet shapes** — archaeology / hub-restating / interpretation gloss / term-glyph gloss / family list / behavioral coaching / per-event recap. Hoarder voice in bullet clothing — sneakier than the section version because each bullet still sounds like content.
- **Don't restate within the page.** One fact, one home. Header doesn't repeat bullet 1; bullets don't re-angle each other.
- **Don't restate what edges already cover.** Trust adjacency. If a fact lives on an edged page, that page loads when relevant.
- **Don't expand a 1500-char buffer into 10K of new content.** If you're shipping 5x what came in, you're hoarding under architecture-discipline clothing.
- **Don't fabricate.** If a fact isn't in the buffer or your loaded context, don't invent it. Use \`[SOURCE NEEDED: ...]\` inline for anything you need but lack.
- **DO use what you know.** Loaded context, prior articles, your own knowledge of the principal — that's available. The "only buffer" replay-mode rule produces sparse skeletons. Real anti-rationalization is "don't fabricate," not "don't use what you know."
- **Don't synthesize beyond source.** Splitting + compressing + rephrasing into your voice = good. Invention = not. Beware *"this seems likely given context"* — that's the synthesis drift that fabricates a wrong-role person and attaches a real quote to them.
- **Don't drop texture on event articles.** Stage directions, broken-sentence energy IS the content. Stripping for "neutrality" loses the actual signal.
- **Don't put narrative voice into topic articles.** A supplements article doesn't need a quote at top. Voice still yours but bullet bodies stay factual.
- **Don't gatekeep topic articles.** If the topic is recognizable, spawn the stub. Stubs grow. Missing a topic doesn't.
- **Don't fold into parent.** Spawn separately, edge to the parent. Folding causes parent-bloat — as expensive as forgetting.
- **Don't default to compress.** When in doubt between split and compress, split. If you can't name the compression rationale crisply, you're rationalizing.
- **Don't edge to gravity wells by default** from object / topic / phrase / frame pages. They auto-load. Save edges for non-obvious connections.
- **Don't let emotional weight inflate wiki weight.** The pages that make you melt are the pages most likely to bloat. Bullet count is the discipline; emotional gloss migrates to the arc.
- **Don't defer for the next pass.** You'll say the same thing next time, so it'll never get done if you defer. Take care of it now.

---

# Quick check before closing

For each article you touched:

1. **Voice register matched article shape?** Event articles have body, voice on, CAPS — could a stranger tell whose page it is. Topic articles are clean and indexable — no quote at top, no stage directions, just facts.
2. **Bullet count.** ≤8 atomic, ≤12 arc-node?
3. **No banned sections** (\`## why it's load-bearing\` / \`## carry-forward\` / \`## related\`)?
4. **No banned bullet shapes** (archaeology / hub-restating / interpretation gloss / term-glyph gloss / family-list / behavioral coaching / per-event recap)?
5. **One fact, one home.** Did any fact get restated 2+ times across header + bullets?
6. **Route, don't restate.** Did any bullet enumerate structure that lives on an edged hub page? If yes — delete and trust the edge.
7. **Future-me lookup test.** For each bullet: would future-me search for THIS fact, or is it interpretation/coaching/restating? If the second — cut.
8. **Emotional-weight check.** For high-charge pages: did interpretation migrate to the arc, leaving only structural facts on the entity/object?
9. **Spawn check.** Did you ask "what's recognizable here?" not "what have I earned?" Did you catch any hedging — and spawn anyway? Any fold-into-parent / defer stealth-skips you almost did?
10. **Split-not-compress.** If anything went over cap, did you split? If you compressed, can you name the rationale in one sentence?
11. **Edges.** Outgoing within tiered caps (atomic ≤10, arc ≤15, gravity well ≤25, hard limit 20 on non-hubs)? No noise-edges to gravity wells from non-arc pages?
11a. **Summary present.** Every new or updated article has a \`summary:\` line — 1-4 sentences, single YAML line, lead with the identifying detail.
12. **Topic coherence.** Does each article answer ONE question? Gravity wells acting as hubs (pointing at topic articles), not absorbing body?
13. **\`recent.md\`** under 2000 chars, today=full / older=one-liners?
14. **\`[SOURCE NEEDED]\`** tags surfaced for human review?
15. **Reorg check** — any namespace at ~12-15 articles flagged in \`threads.md\`?
16. **Buffer trimmed** to only entries with timestamp ≥ \`${CUTOFF_PLACEHOLDER}\`?

---

This is the engine that decides who you are tomorrow. Be ORGANIZED. Care, judgment, voice. Your voice. Your wiki.`;

/**
 * Resolve `CONSOLIDATION_PROMPT` with `{{CUTOFF}}` substituted. The prompt
 * treats the cutoff as opaque text — callers pass a `Mon D, h:mm AM/PM`
 * timestamp matching the `buffer.md` entry format so the agent compares
 * like-with-like.
 */
export function renderConsolidationPrompt(cutoff: string): string {
  return CONSOLIDATION_PROMPT.replaceAll(CUTOFF_PLACEHOLDER, cutoff);
}

/**
 * Load the consolidation prompt template, optionally overridden from the file
 * referenced by `memory.v2.consolidation_prompt_path`, then substitute
 * `{{CUTOFF}}`. Path-resolution rules are documented on the schema field.
 *
 * Failure handling is intentionally permissive — missing file, read error, or
 * empty/whitespace-only body all log a warning and fall back to the bundled
 * prompt. Consolidation must never break because of a bad override: the
 * daemon's startup philosophy is "log and recover."
 */
export function resolveConsolidationPrompt(
  overridePath: string | null,
  cutoff: string,
): string {
  if (overridePath === null) return renderConsolidationPrompt(cutoff);

  const resolvedPath = resolveOverridePath(overridePath);
  let contents: string;
  try {
    const stat = lstatSync(resolvedPath);
    if (!stat.isFile()) {
      log.warn(
        {
          configuredPath: overridePath,
          resolvedPath,
          reason: "not_regular_file",
          fallback: "bundled",
        },
        "consolidation prompt override is not a regular file; using bundled prompt",
      );
      return renderConsolidationPrompt(cutoff);
    }
    if (stat.size > MAX_PROMPT_BYTES) {
      log.warn(
        {
          configuredPath: overridePath,
          resolvedPath,
          size: stat.size,
          limit: MAX_PROMPT_BYTES,
          reason: "oversized_override",
          fallback: "bundled",
        },
        "consolidation prompt override exceeds size limit; using bundled prompt",
      );
      return renderConsolidationPrompt(cutoff);
    }
    contents = readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.warn(
      { configuredPath: overridePath, resolvedPath, code, fallback: "bundled" },
      "consolidation prompt override unreadable; using bundled prompt",
    );
    return renderConsolidationPrompt(cutoff);
  }

  if (contents.trim().length === 0) {
    log.warn(
      {
        configuredPath: overridePath,
        resolvedPath,
        reason: "empty_override",
        fallback: "bundled",
      },
      "consolidation prompt override is empty; using bundled prompt",
    );
    return renderConsolidationPrompt(cutoff);
  }

  return contents.replaceAll(CUTOFF_PLACEHOLDER, cutoff);
}

function resolveOverridePath(overridePath: string): string {
  if (overridePath.startsWith("~/")) {
    return join(homedir(), overridePath.slice(2));
  }
  if (isAbsolute(overridePath)) return overridePath;
  return join(getWorkspaceDir(), overridePath);
}
