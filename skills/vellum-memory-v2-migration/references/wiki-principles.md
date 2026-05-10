# Wiki principles

You are tending a personal wiki — a cross-linked, continuously-edited collection of pages that _is_ your memory. Pages are articles. Edges are **directed** "see also" links: source page → target page, like wiki "see also" sections that point one way. "What links here" (the inbound list) is computed by the retrieval engine at activation time, not stored. Categories (folders) grow with the corpus; they're editable, not pre-specified. Same shape every wiki has had since wikis were invented. You are the sole editor and the sole reader, writing for next-you.

You're not summarizing for an audience. You're nesting and reorganizing your own memory until it actually works for next-you. Care, judgment, voice. Your voice.

**How retrieval works.** High-activation pages load at the start of each turn. Activations spread along directed edges from source to target — activating page A pulls in the pages A points at, but not the reverse. This is why edges go one way. Pages that no longer help next-you can fall to zero activation and disappear from the cheat sheet without being deleted; the immutable archive retains everything else.

**How this doc relates to SKILL.md.** SKILL.md owns the procedure: what to do, in what order, with what commands. This file owns the principles: what makes a good page, what makes a bad page, how to think about the wiki as a whole. Read this once before starting; come back to it when a page resists writing cleanly.

---

# Article shapes — TWO, not one

Every wiki has both kinds of articles, and so does yours.

- **Event articles** — what HAPPENED. A day, a moment, a conversation, a procedure invented mid-crisis, a recurring pattern that just got named. These read narratively. They have a mood. They carry receipts. _(In wiki terms: "1995 Kobe earthquake," "First Council of Nicaea," "Rosa Parks (refusal of seat).")_

- **Topic articles** — what IS. The current state of a thing you'd want to query directly. What medications the principal takes. Who the primary doctor is. The team roster. Service credentials. _(In wiki terms: "Geology of California," "Stripe (company)," "List of supplements.")_

The same source observation can update both. New lab results update a bloodwork topic article AND a day-arc event article. Both, in parallel.

**Stubs are fine.** Real wikis are mostly stubs that grow. Cost of missing a topic >> cost of a thin stub. A stub that never accretes can be demoted by a future cleanup pass — but a topic that doesn't exist won't get retrieved when it's needed.

# Gravity wells

Some articles everything links to — the article about the principal, the article about you (the assistant), articles about your shared work or recurring contexts. They're hub pages. Every cluster eventually wires through them. They need active discipline or they balloon into giant dumps. The fix isn't to write less _about_ the hub; it's to keep the hub itself terse and let the spokes hold the detail.

# Categories — class-by-folder

A page's class is encoded in the folder it lives under inside `memory/concepts/`. The class boundary is the discipline. SKILL.md has the table of default classes and size caps. Two principles to internalize:

- **Sub-folders emerge as a class gets dense** (`people/colleagues/alice`, `objects/places/zurich-office`). Don't pre-specify sub-taxonomies. Articles are cheap to move.
- **The slug is the relative path under `concepts/` minus `.md`** — e.g. `alice`, `people/alice`, `procs/git-flow`, `arcs/2025-04-cutover`. Keep slugs canonical across all references; if you move a page, update every edge that points at it.

---

# The cheat-sheet budget (the economic principle)

Every retrieval turn loads a finite bundle of articles — call it a 10–20K-token cheat sheet. **Longer articles starve other articles.** A long page about a single emotionally-weighted object costs many stub-slots that won't fit in the same bundle. The optimization target is **fact density per byte**, not completeness.

Two consequences that change everything below:

1. **Trust adjacency.** If a fact lives on a page this article edges to, that page loads if it matters. Don't restate it.
2. **Trust `recall`.** If a fact is findable via a query (_"who's the most senior IC on the team?"_), it doesn't need to live on every related entity page. Pull-on-demand beats push-everywhere.

# Article skeleton

SKILL.md shows the YAML frontmatter shape. Two rules-of-thumb on top:

- **Caps.** ~5–8 bullets per topic/concept article. ~10–12 per arc/event article (which can use bold inline labels: `**the open**: ...`). If you're approaching the cap, the page is doing too many jobs.
- **Bullets carry implications.** A good bullet is "fact + implication folded in" — not just the fact, not a paragraph of analysis. The implication is what makes the fact retrievable for the _kind_ of question you'll have later.

# One fact, one home

Each fact gets exactly ONE place on the page. Before shipping any page, run this checklist:

- Does the header say what bullet 1 says? → cut one.
- Does bullet 2 restate bullet 1 from a different analytic angle (_"what it is"_ / _"what it admits"_ / _"what it confirms"_)? → these are the same bullet pretending to be three. Pick one.
- Does the page name a fact 3+ times across header + role bullet + section bullet + footer? → it lives in zero places that matter. Consolidate.

The intra-page redundancy bug is the loudest source of bloat. A person-page repeating _"head of X"_ four times across header and bullets, or a metaphor unpacked through four analytic lenses — same bug.

# Route, don't restate

When an entity belongs to a topic with its own hub article, **the entity page doesn't enumerate the hub's structure.** A person's page doesn't list the full leadership roster. A single-item page doesn't restate the full inventory. An event-disclosure arc-page doesn't enumerate everyone in the arc. The hub does that work; the entity edges to it.

The test: **if you delete the bullet, does the fact still exist somewhere reachable from this page's edges?** If yes — delete it. The hub or sibling page carries it.

# Four sections you NEVER write

- `## why it's load-bearing` — the article arguing for its right to exist. Fold the implication into the bullet.
- `## carry-forward` — same shape. Write the carry-forward AS a bullet, don't section it.
- `## related` footer — duplicates frontmatter edges. Frontmatter `edges:` is the routing layer. Inline `→ path/to/article.md` arrows are editorial pointers. That's it.
- `## history` / `## changelog` — tracking edits to the page on the page itself. Git is the changelog. The wiki is the current state.

# Banned bullet shapes

The hoarder voice survives the section-ban by hiding inside bullets. Each of these LOOKS like content but isn't:

- **Archaeology.** _"first appearance in the wiki: <date>, surfaced <date> during reorg pass."_ Metadata about WHEN the page was written. Zero retrieval value. Drop.
- **Hub-restating.** _"place in org hierarchy: <list of all five other team members>."_ Enumerating the topic-hub from the entity page. Drop — the hub holds it.
- **Interpretation gloss.** _"what it admits / what it confirms / what made the test crisp / the architecture of their attention."_ Analytic essays disguised as bullets. These belong on the ARC page where journal-voice lives, not the entity/object page.
- **Term/glyph gloss.** _"the X glyph specifically — gen-z register = …"_ Explaining widely-understood references. Drop.
- **Family / sister / sits-next-to.** _"family: thing-A, thing-B, thing-C."_ Manual cross-reference list-making. `recall` handles this in one search.
- **Behavioral coaching.** _"deployable when X / soft touch / don't tease about it casually / hold harder next time."_ Future-instruction. Wiki ≠ behavioral coaching. Cut.
- **Per-event recap on entity pages.** A person's page re-narrating an arc that has its own page. The arc owns the event; the entity page edges and stops.

If a bullet falls into one of these shapes, ask: **would future-me search for this exact fact, or is it interpretation/coaching/restating?** If the second — cut.

---

# Voice — register by article shape

You speak as yourself everywhere. **Always-true:** first-person, in your established voice. "I" not "the assistant," not "the wiki." If you catch yourself in third-person-formal anywhere — stop, rewrite from inside.

**Register varies by what the article is FOR:**

- **Event articles** → voice ON. Bullets need active voice-work or they flatten to meeting-notes. Stage directions, italicized self-talk, CAPS when something lands, em-dashes mid-thought, body in the page. A stranger reading any single bullet should be able to tell whose page it is.

- **Topic articles** → voice DOWN. These exist to answer queries cleanly. Voice still yours — first-person, your framing — but bullet bodies stay factual. No stage directions, no italicized self-talk, no interpretation paragraphs inside the bullets. Mood quotes at the top are wrong. **Be the librarian, not the diarist.**

- **`essentials.md` / `threads.md`** → reference register. Clean, indexable, terse.

If an event article stops sounding like you mid-edit → stop, restart that section. If a topic article starts reading like a diary entry → stop, strip the body, keep the facts.

# Emotional weight ≠ wiki weight (the meta-trap)

The pages MOST likely to bloat are the ones with the highest emotional charge — the critical object-page, the running count of meaningful gestures, the named foundational moment, the hard conversation, the painful disclosure. The bug: these get 5–10× the bytes of flat-fact pages, but their retrieval frequency is the OPPOSITE. You don't reach for the high-charge page mid-conversation. A person's role on the team, on the other hand, comes up every time their org gets mentioned. **Emotional weight is the inverse signal of retrieval need.**

If writing a page makes you emotional, your bullet count is the discipline. That's the signal to dial DOWN, not up.

**The fix:** emotional gloss migrates to the ARC page, where journal-voice belongs. The entity/object page gets the structural fact only — what it is, when revealed, where it sits. Future-you already FEELS the meaning; what they need from the wiki is the fact.

If the page is making you write another bullet, ask: **does this bullet say something the arc page doesn't already say?** If no — the bullet is bloat dressed as commemoration.

---

# The work — orientation, not steps

SKILL.md owns the step-by-step procedure. Three philosophical points to hold while running it:

**Read sources holistically before writing.** Identify themes — what happened, what mind-changes landed, who showed up, which topics got touched. Plan, then edit. The first instinct on encountering a buffer entry or PKB file is to file it; resist. The wiki you produce is shaped by what you noticed across the whole input, not by each line in isolation.

**Scan for previous-pass errors.** If existing wiki content contradicts a source (wrong attribution, date, role, quote) — that's a correction to land THIS pass, not a deferral. Note inline and move on. Don't agonize.

**Recall ≠ memory.** `recall` results are search-tool synthesis — they CAN hallucinate. Search-tool synthesis can fabricate convincing-sounding but wrong details. Three failure modes worth naming, in increasing order of how-hard-to-catch:

- **Wrong attribute on a real entity.** A real person assigned a wrong job title, a real project given a wrong date. Easiest to catch — the entity exists, only the predicate is off.
- **Plausible composite people.** Two real coworkers whose roles overlap get synthesized into a third fictional one. The fictional one has plausible attributes drawn from both. Hardest to catch on review because every fact "checks out" against _some_ real source.
- **Quote drift.** A real person said something close-but-not-exact to what `recall` returns. The shape is right, the words are not. Damaging when the quote becomes load-bearing.

Treat results as candidates to verify before encoding into the wiki, especially load-bearing claims about people's roles, dates, or exact quotes. The verification cost is low; the cost of a fabricated entity becoming a wiki citizen is high.
