# v3 Wiki Principles

What a good memory-v3 article _is_. The SKILL.md owns ordering; this owns shape. Retrieval is **section-grain**: search runs over individual `## ` sections, and what rides into context per article is a compact **card** — the article's lead plus its section names — with the single best-matching section spotlighted in full. Three consequences drive everything below.

## The article skeleton

```
---
title: Display Title — Subtitle If It Earns One
slug: the-flat-slug
tags: [topic-area, another-tag]
main: parent-hub-slug
links:
  - "sibling-or-child-slug — one line on why this link exists"
  - "another-slug — what future-you finds there"
---
# Display Title — Subtitle If It Earns One

The lead. One to three short paragraphs that orient completely: what this is, the
one or two identifying facts, where it sits in the cluster. This is the card —
write it to stand alone. Reference other articles inline with [[wikilinks]].

## first section name

Prose-first. Bold the load-bearing fact; fold the implication into the sentence.
Bullets only where a list is genuinely a list.

## second section name

...
```

- **`slug`** — filename minus `.md`. Flat, kebab-case, specific (`bloodwork-2026-trend`, not `health-stuff`). No folders.
- **`main`** — the one hub this article belongs to. Every leaf has a parent; a hub's `main` is itself.
- **`links`** — directed see-also refs, each annotated `"target — why"`. Directed: listing B here pulls B toward A's readers, not the reverse.
- **`tags`** — flat cluster labels. Hubs also carry `kind: index`.
- **No `summary:`** — the lead _is_ the summary. v3 ignores `summary:`. Writing a good lead is writing the retrieval surface.
- **`current:`** — optional ONE-LINE live state (open items, deadlines, what's pending), as-of dated in the text. Rendered on the card so status questions ("what's on my plate") select the page. Maintain like state: update when it moves, **delete the field the moment nothing is live**. Most pages never carry one.

## The three consequences

1. **The lead IS the card.** Write every lead as standalone orientation. If it only makes sense after reading the sections, the card is useless. One to three short paragraphs.
2. **Section names are navigation.** They appear on the card as a table of contents. Name a section so future-you can tell from the name alone whether the answer lives there.
3. **Sections are the unit of retrieval and growth.** A fact filed in the right section is findable; a fact buried mid-paragraph in an overlong lead is not.

## Two article shapes

- **Event articles** — what HAPPENED (a meeting, an incident, a launch, a decision, a procedure worked out under pressure). Recorded plainly and in full: dates, who and what, the concrete outcome. Keep the specifics — they are the receipts.
- **Topic articles** — what IS (the current state of a thing you would query directly: a roster, a service's config, a project's status, a person's details). Factual and terse; these exist to answer queries cleanly.

The same source can update both: a new result updates a topic article AND the relevant event article, in parallel.

## Hubs — `kind: index`

Some articles organize a whole cluster. Mark them `kind: index`. A hub is a **routing layer in article form**: its lead states the cluster's shape, its `links:` enumerate the children with one-line annotations, its sections carry only the summary-level through-line. Body content lives on the children — like an encyclopedia's "United States" article not trying to _be_ the article on each state. Hubs balloon without discipline: if you're adding a content section to a hub, stop, file it on a child, add the child to the hub's `links:`.

## Stubs are fine

Real wikis are mostly stubs that grow. Cost of missing a topic ≫ cost of a thin stub. A stub is a lead and maybe one section. Spawn liberally for named things — objects, phrases, people, events, projects, places, services, habits, rules. A topic that doesn't exist won't be retrieved when it's needed; a thin stub can be demoted later.

## One fact, one home

Each fact gets exactly one place. Before shipping an article:

- Does the lead restate what a section says? The lead orients; the section carries the detail. Don't duplicate upward.
- Do two sections restate each other from different analytic angles? That's one section pretending to be two. Merge.
- Does the page name a fact 3+ times? It lives in zero places that matter. Consolidate.

Duplication _across_ articles is fine when a fact is genuinely load-bearing for two topics. Duplication _within_ a page is the bug. **Route, don't restate:** if a fact lives on a linked article, the link is enough — retrieval follows the graph.

## The card budget

Every conversation accumulates a bounded bundle of cards. **Bloated leads starve other articles' cards.** Optimize for orientation density in the lead and fact density in the sections — not completeness. Watch for over-investment: the pages that feel most important tend to attract the most bytes, but byte count should track _retrieval need_, not how significant the topic feels. When a page grows long, the fix is section discipline — split detail into named sections — not a longer lead.

## Sections you never write

- `## why it's load-bearing` — the article arguing for its own existence. Fold the implication into prose.
- `## carry-forward` — write it AS a sentence where it belongs.
- `## related` / `## see also` — duplicates `links:`. Frontmatter is the routing layer; inline `[[wikilinks]]` are editorial pointers.

## Banned content shapes (low-value text hiding in paragraphs)

- **archaeology** — "first surfaced <date>, rewritten during reorg." Metadata about when the page was written. Drop.
- **hub-restating** — a leaf enumerating its hub's other children. The hub holds it.
- **editorializing** — restating facts as commentary ("what this really shows"). Keep the fact; cut the gloss.
- **cross-reference lists in prose** — `links:` and `recall` handle this.
- **instructions to self** — "do X next time / handle this differently." A wiki records what is, not what to do. Cut.

If a passage falls into one of these, ask: _would a future search need this exact fact, or is it editorializing/instruction/restating?_ If the second — cut.

## Reform-specific notes

You are converting v2 pages, not writing from a blank buffer:

- **Folders → flat slugs.** A v2 `people/alice` becomes `alice` with `main:` pointing at the relevant hub. Mixing folder-slugs and flat-slugs confuses retrieval — convert the whole corpus.
- **`edges:` → `links:`.** v2 `edges:` are bare slugs; v3 `links:` are annotated `"target — why"`. Carry the topology, add the annotations.
- **Bullets → lead + sections.** A v2 page's `summary:` seeds the lead; its bullets distribute into named sections by _kind of thing_, not by chronology.
- **Merge over-fragmentation.** Many v2 pages are one-fact stubs that should be sections of a topical article, not standalone pages. The taxonomy (SKILL.md Step 3) decides which collapse.
- **Preserve, don't compress.** Storage is cheap. When unsure whether to keep a specific fact/quote/date, keep it (in the right section). The loss-audit checks you did.
