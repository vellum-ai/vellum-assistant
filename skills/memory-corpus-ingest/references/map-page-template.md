# Map Page Template

A map page is a memory-v3 article whose only job is routing: it tells the model what a slice of the cold store contains, when it is from, and where the raw files live. It follows the standard v3 article shape (a lead that is the retrieval card, plus named `## ` sections), with corpus-specific frontmatter on top.

Retrieval is section-grain: the model sees a compact card per article, which is the page's lead (everything before the first `## `) plus a list of its section names. Two consequences:

1. **The `Raw data:` pointer must live in the lead.** A pointer in a section body is invisible at routing time; the model would select the card and still not know where the files are.
2. **Section names are navigation.** Name each section so the model can tell from the name alone whether the answer lives there.

## Frontmatter fields

| Field         | Value for a map page                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`       | Human title naming the corpus and the slice window                                                                                                                                                                                                                                               |
| `slug`        | Flat kebab-case, matching the staged filename minus `.md` (for example `fathom-recordings-2025-q1`)                                                                                                                                                                                              |
| `tags`        | Corpus name plus topic labels                                                                                                                                                                                                                                                                    |
| `main`        | The corpus index page's slug                                                                                                                                                                                                                                                                     |
| `links`       | Sibling slice pages plus the corpus index page, annotated                                                                                                                                                                                                                                        |
| `ref_files`   | The cold-store paths (files or directories) this slice covers, relative to the workspace root                                                                                                                                                                                                    |
| `source`      | `import:<provider>` (for example `import:fathom`); marks the page as ingested, not consolidated                                                                                                                                                                                                  |
| `origin_date` | ISO 8601 date of the slice's own content, such as the last meeting date in the slice. Never the import date. It drives the fresh lane's effective recency and the dated stamp on the card, so an archive slice from 2023 sorts as 2023 material instead of flooding the fresh lane on import day |

Note on `links:` entries: the format is `"<target-slug> — <one line on why>"` and the separator is literally space, em dash, space. That token is how the edge lane splits the target slug from the annotation, so reproduce it exactly. This is a deliberate, scoped exception to the repository's no-em-dash rule: the separator is frozen parser syntax consumed by the memory plugin's edge and card renderers, not prose punctuation, and changing it would break every existing page's authored links.

## Full example: a slice page

```markdown
---
title: Fathom Recordings 2025 Q1
slug: fathom-recordings-2025-q1
tags: [fathom, meetings, imports]
main: fathom-recordings-map
links:
  - "fathom-recordings-map — the corpus index for the whole Fathom archive"
  - "fathom-recordings-2025-q2 — the next quarter of the same archive"
ref_files:
  - imports/fathom/2025-01
  - imports/fathom/2025-02
  - imports/fathom/2025-03
source: import:fathom
origin_date: "2025-03-27"
---

# Fathom Recordings 2025 Q1

Map of the Fathom meeting archive for January through March 2025: 41 recorded
meetings, mostly the weekly product sync, six customer calls (Acme, Northwind,
and four prospects), and the three-session Q1 planning series that produced the
pricing revamp decision. Raw data: imports/fathom/2025-01 through
imports/fathom/2025-03 in the workspace (per-meeting transcripts and AI
summaries); drill in with the fathom-lookup skill.

## q1 planning series and decisions

Three sessions (Jan 14, Jan 21, Feb 4). Decided: ship the pricing revamp in Q2,
defer the enterprise tier, hire one more platform engineer. The Feb 4 session
holds the final pricing numbers and the dissent from finance.

## customer calls

Acme (Jan 9, Mar 12): renewal risk raised in January, resolved by March after
the SSO fix. Northwind (Feb 20): expansion interest, waiting on SOC 2. Four
prospect calls in March, all mid-market, common objection was onboarding time.

## recurring topics in the weekly sync

Release cadence complaints (every January sync), flaky CI (Jan through Feb,
resolved Feb 18), the analytics rewrite (ongoing all quarter, owner Dana).

## open threads at quarter end

Northwind expansion blocked on SOC 2. Analytics rewrite unscheduled for Q2.
Pricing revamp comms plan not yet drafted.
```

What makes this lead work as a card: it states scope (which archive, which window), density (41 meetings, what kinds), the one headline outcome, and the pointer. A model deciding where to look for "what did we tell Acme in March" can route from the card alone.

## The corpus index page

Write exactly one index page per corpus, marked `kind: index`. It is a routing layer: its lead describes the whole archive and names the cold-store root, and its `links:` enumerate every slice page. No body content beyond the summary-level through-line; detail lives on the slices.

```markdown
---
title: Fathom Recordings Map
slug: fathom-recordings-map
tags: [fathom, meetings, imports]
main: fathom-recordings-map
kind: index
links:
  - "fathom-recordings-2025-q1 — Jan to Mar 2025, planning series and Acme renewal"
  - "fathom-recordings-2025-q2 — Apr to Jun 2025, pricing revamp shipped"
ref_files:
  - imports/fathom
source: import:fathom
origin_date: "2025-06-30"
---

# Fathom Recordings Map

Index of the imported Fathom meeting archive: 83 recorded meetings from January
through June 2025, mapped as one page per quarter. Raw data: imports/fathom in
the workspace; drill in with the fathom-lookup skill. Slices are listed in
links with one-line summaries.

## how this archive is organized

One directory per month under imports/fathom, one map page per quarter, one
transcript plus one AI summary per meeting.
```

## Rules of thumb

- **Lead length**: one to three short paragraphs. The lead orients and points; sections carry the detail. A bloated lead starves other pages' cards.
- **What goes in sections**: decisions with dates, recurring topics with their arc, named people and what they own, open threads. Facts a future search would need to route or answer.
- **What stays cold**: verbatim transcript text, per-utterance timestamps, filler. The map records that content exists and where, not the content itself.
- **Slug discipline**: flat, kebab-case, specific, and stable across re-ingests (re-running with `--overwrite` updates the same page instead of creating a twin).
- **`ref_files` versus the `Raw data:` line**: both list the same cold-store paths. `ref_files` is the structured form for tooling; the lead line is the copy the model actually sees on the card. Keep them in sync.
- **`origin_date` per page**: each slice page carries its own slice's date, so the archive spreads across the timeline instead of stacking on one day. The index page carries the corpus's most recent content date.
