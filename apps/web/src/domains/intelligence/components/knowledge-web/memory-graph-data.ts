/**
 * Mock MemoryV2 "wiki" graph for the activation memory-web visualization
 * (JARVIS-1112).
 *
 * Shaped to the REAL MemoryV2 concept-page model so the visualization is honest:
 *   - A memory node IS a `ConceptPage` — a wiki page identified by a slug
 *     (`people/maya`, `projects/fundraising`), with a short `summary`.
 *   - Edges are explicit, DIRECTED links stored in the page frontmatter
 *     (`edges`). They are UNNAMED in the real model, so the view draws them as
 *     plain links. `rel` here is documentation only (ignored by the view).
 *
 * `learnedAtMoment` (0–4) is spike-only, so we can show the graph growing across
 * the activation rail:
 *   0 Hatched       — just the user; the assistant knows nothing yet.
 *   1 Port          — a burst of profile context from the prior assistant.
 *   2 Propose       — the assistant proposes an outcome; this writes NO memory
 *                     (it's output, not learning), so no node is tagged moment 2.
 *   3 Run           — does the work; writes episodic results + discoveries.
 *   4 Follow-through— stands up a recurring job.
 * (Production writes pages via the async consolidation job, not live per-turn.)
 */

export interface WikiEdge {
  /** Target slug. */
  to: string;
  /** Relationship name — documentation only; concept-page edges are unnamed. */
  rel: string;
}

export interface WikiNode {
  /** Hierarchical slug, e.g. "people/maya". Top segment = category. */
  slug: string;
  /** 1-4 sentence description (the page's `summary` frontmatter field). */
  summary: string;
  /** Outgoing directed edges (the page's `edges` frontmatter field). */
  edges: WikiEdge[];
  /** Spike-only: which onboarding moment first wrote this page (0 = hatched). */
  learnedAtMoment: 0 | 1 | 2 | 3 | 4;
}

export interface PersonaMemoryGraph {
  personaKey: string;
  /** The wiki to focus first — the natural entry point into the graph. */
  startSlug: string;
  nodes: WikiNode[];
}

// ---------------------------------------------------------------------------
// Category styling, derived from the slug's top segment.
// ---------------------------------------------------------------------------

interface MemoryCategoryConfig {
  label: string;
  color: string;
}

const MEMORY_CATEGORY_CONFIG: Record<string, MemoryCategoryConfig> = {
  profile: { label: "Profile", color: "#6B8AE0" },
  people: { label: "People", color: "#DB4B77" },
  projects: { label: "Project", color: "#0E9B8B" },
  concepts: { label: "Concept", color: "#A665C9" },
  instructions: { label: "Instruction", color: "#E9C91A" },
  automations: { label: "Automation", color: "#4C9B50" },
  preferences: { label: "Preference", color: "#6366F1" },
  events: { label: "Event", color: "#EC8C2F" },
};

const DEFAULT_MEMORY_CATEGORY: MemoryCategoryConfig = {
  label: "Memory",
  color: "#8D99A5",
};

export function wikiCategory(slug: string): string {
  return slug.split("/")[0] ?? "";
}

export function wikiCategoryConfig(slug: string): MemoryCategoryConfig {
  return MEMORY_CATEGORY_CONFIG[wikiCategory(slug)] ?? DEFAULT_MEMORY_CATEGORY;
}

/** "people/maya" -> "Maya"; "concepts/tcg-reimbursement" -> "Tcg Reimbursement". */
export function wikiLabel(slug: string): string {
  const leaf = slug.split("/").pop() ?? slug;
  return leaf
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Persona graph
// ---------------------------------------------------------------------------

const PORTER_GRAPH: PersonaMemoryGraph = {
  personaKey: "porter",
  startSlug: "profile/you",
  nodes: [
    // ── Hatched: only the user is here. ──
    {
      slug: "profile/you",
      summary:
        "You — the owner of this assistant. I'm brand new and don't know much about you yet.",
      edges: [
        { to: "profile/role", rel: "is" },
        { to: "people/maya", rel: "works with" },
        { to: "projects/fundraising", rel: "focused on" },
        { to: "preferences/comms", rel: "prefers" },
        { to: "concepts/acquisition-talks", rel: "handling discreetly" },
      ],
      learnedAtMoment: 0,
    },

    // ── Port: a burst of profile context from the prior assistant. ──
    {
      slug: "profile/role",
      summary: "Founder of an early-stage startup, currently raising a seed round.",
      edges: [{ to: "projects/fundraising", rel: "leading" }],
      learnedAtMoment: 1,
    },
    {
      slug: "people/maya",
      summary:
        "Maya (maya@example.com) — your exec assistant. Anything from her is protected.",
      edges: [{ to: "instructions/protect-maya", rel: "governed by" }],
      learnedAtMoment: 1,
    },
    {
      slug: "instructions/protect-maya",
      summary: "Never archive or auto-handle anything from Maya without asking first.",
      edges: [],
      learnedAtMoment: 1,
    },
    {
      slug: "projects/fundraising",
      summary: "Active seed raise — investor conversations are the current priority.",
      edges: [],
      learnedAtMoment: 1,
    },
    {
      slug: "preferences/comms",
      summary: "Prefers drafts over auto-sends; approve anything before it goes out.",
      edges: [],
      learnedAtMoment: 1,
    },
    {
      slug: "concepts/acquisition-talks",
      summary: "In early acquisition talks — not yet shared with the team.",
      edges: [],
      learnedAtMoment: 1,
    },

    // ── Propose writes no memory (it's output, not learning) — no moment-2 node. ──

    // ── Run: do the work, and learn from the results. ──
    {
      slug: "events/inbox-cleanup-run",
      summary:
        "Ran an inbox cleanup: archived 31 newsletters, labeled receipts, surfaced 2 investor replies.",
      edges: [
        { to: "projects/fundraising", rel: "serves" },
        { to: "instructions/protect-maya", rel: "respected" },
      ],
      learnedAtMoment: 3,
    },
    {
      slug: "concepts/tcg-reimbursement",
      summary:
        "Found an open reimbursement while triaging (TCG, ref 49747972) — flagged to chase.",
      edges: [{ to: "events/inbox-cleanup-run", rel: "found in" }],
      learnedAtMoment: 3,
    },

    // ── Follow-through: stand up a recurring job. ──
    {
      slug: "automations/morning-brief",
      summary:
        "Weekday 7:30 AM inbox brief — flags investor threads and replies you owe. Learning which angles you act on.",
      edges: [
        { to: "events/inbox-cleanup-run", rel: "extends" },
        { to: "projects/fundraising", rel: "serves" },
      ],
      learnedAtMoment: 4,
    },
  ],
};

export const PERSONA_MEMORY_GRAPHS: Record<string, PersonaMemoryGraph> = {
  porter: PORTER_GRAPH,
};

// ---------------------------------------------------------------------------
// Adapter to the node-link MemoryGraphView's generic shape.
// ---------------------------------------------------------------------------

export interface GraphViewNode {
  id: string;
  label: string;
  detail: string;
  color: string;
  /** Small category tag shown in the focus readout. */
  badge: string;
}

export interface GraphViewEdge {
  from: string;
  to: string;
}

export interface GraphViewData {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

/**
 * MemoryV2 concept pages as a node-link graph. Nodes are real ConceptPages
 * (slug + summary); edges are the real (unnamed) frontmatter links. Color comes
 * from the slug category.
 */
export function conceptPagesToGraph(
  graph: PersonaMemoryGraph,
  throughMoment: 0 | 1 | 2 | 3 | 4 = 4,
): GraphViewData {
  const revealed = graph.nodes.filter((n) => n.learnedAtMoment <= throughMoment);
  const revealedSlugs = new Set(revealed.map((n) => n.slug));
  return {
    nodes: revealed.map((n) => {
      const cfg = wikiCategoryConfig(n.slug);
      return {
        id: n.slug,
        label: wikiLabel(n.slug),
        detail: n.summary,
        color: cfg.color,
        badge: cfg.label,
      };
    }),
    edges: revealed.flatMap((n) =>
      n.edges
        .filter((e) => revealedSlugs.has(e.to))
        .map((e) => ({ from: n.slug, to: e.to })),
    ),
  };
}

/**
 * Slugs learned by a given onboarding moment. Pair with the FULL
 * `conceptPagesToGraph(graph)` and MemoryGraphView's `revealedIds` to show the
 * graph filling in over stable positions (rather than re-laying-out each step).
 */
export function conceptPageRevealedSlugs(
  graph: PersonaMemoryGraph,
  throughMoment: 0 | 1 | 2 | 3 | 4,
): Set<string> {
  return new Set(
    graph.nodes
      .filter((n) => n.learnedAtMoment <= throughMoment)
      .map((n) => n.slug),
  );
}
