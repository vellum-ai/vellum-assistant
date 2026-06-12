export type Slug = string;

/**
 * Injection-block id for the v3 live `<memory>` block. Shared between the
 * producer (the v3 injector in `shadow-plugin.ts`) and the v2-suppression
 * consumer (`conversation-runtime-assembly.ts`), which keys off this id to
 * detect that v3 actually produced a block this turn. Keeping it in one place
 * makes a rename a compile error on both sides instead of a silent
 * suppression bypass.
 */
export const MEMORY_V3_BLOCK_ID = "memory-v3" as const;

/**
 * `meta` key under which the v3 cards block carries its attachment-commit
 * callback. The injector defers its everInjected-store write (and the
 * prune-valve schedule) into this callback; runtime assembly invokes it only
 * when the turn's tail is a user message — the same gate as metadata capture
 * — so a block that silently fails to attach never claims its cards in the
 * dedup store. Shared between the producer (`injector.ts`) and the consumer
 * (`conversation-runtime-assembly.ts`) so a rename is a compile error on both
 * sides instead of a silent never-commit.
 */
export const MEMORY_V3_COMMIT_META_KEY = "memoryV3Commit" as const;

/**
 * Injection-block id for the v3 ephemeral `<memory_spotlight>` block (the
 * current window's matched sections, re-rendered at the user tail each turn).
 * Distinct from {@link MEMORY_V3_BLOCK_ID}: the spotlight never participates
 * in v2 suppression and is never persisted to message metadata.
 */
export const MEMORY_V3_SPOTLIGHT_BLOCK_ID = "memory-v3-spotlight" as const;

/**
 * A single section of a page: the lead (text before the first `## heading`,
 * ordinal 0) or a heading-delimited block. Over-long sections are split into
 * multiple ordered `Section`s, each with its own consecutive `ordinal`, so each
 * fits a typical embedding window. `text` is prefixed with a
 * `${lastSlugSegment} — ${title}` head line for lexical/dense matching.
 */
export interface Section {
  article: Slug;
  title: string;
  text: string;
  ordinal: number;
}

/**
 * A flat, deterministic index of every page's sections plus an article→section
 * lookup. `byArticle` maps each article slug to the indices (into `sections`)
 * of that article's sections, in order.
 */
export interface SectionIndex {
  sections: Section[];
  byArticle: Map<Slug, number[]>;
}

/** A page selected from the candidate pool, with whether the turn centers on it. */
export interface SelectedPage {
  slug: Slug;
  pinned: boolean;
}

export interface MemoryRoutingTurn {
  conversationId: string;
  turnNumber: number;
  currentMessage: string;
  recentContext: string;
  /**
   * Optional situational signal — the current date plus the live NOW.md
   * scratchpad — so a leaf or page can be routed/selected on a date or
   * live-state cue the message itself never names (e.g. a person whose
   * anniversary is today). Omitted when unavailable; the router and selector
   * render nothing for an undefined value.
   */
  situationalContext?: string;
  /**
   * Tail of the assistant's previous reply (the message before
   * `currentMessage`), fed to the reply-query finder pass as its OWN needle +
   * dense queries — never concatenated onto `currentMessage`, which would
   * average two speakers' retrieval intents into a vector that matches
   * neither. The assistant's prose carries the threads it is actively
   * developing, which the user's next message often references without
   * naming. Omitted on a conversation's first turn (no prior reply) or when
   * the reply lane is disabled.
   */
  previousAssistantMessage?: string;
}

/**
 * Canonical ordered list of the lane sources recorded per selection. The
 * {@link SelectionSource} type is derived from this so a new lane is added in
 * exactly one place and the runtime list (used for telemetry roll-ups and
 * source validation) can never drift from the type.
 *
 * `core` / `hot` / `fresh` are the stable-prefix lanes (curated core set,
 * frecency hot set, modification-recency fresh set); `needle` / `dense` /
 * `edge` are the per-turn finder lanes over the user's message; `reply` marks
 * finder candidates first surfaced by the reply-query pass (needle + dense
 * re-run over the assistant's previous message); `learned` marks candidates
 * surfaced by the co-selection NPMI association graph.
 *
 * The `memory_v3_selections.source` column is free-text, so tightening this set
 * needs no migration: any historical rows with retired labels (e.g. the old
 * per-turn carry source) still read back fine via the permissive `z.string()`
 * row schema — they just don't aggregate into a named bucket.
 */
export const SELECTION_SOURCES = [
  "core",
  "hot",
  "fresh",
  "needle",
  "dense",
  "edge",
  "reply",
  "learned",
] as const;

export type SelectionSource = (typeof SELECTION_SOURCES)[number];

/**
 * The per-turn finder lanes — the strict subset of {@link SelectionSource} a
 * finder candidate can be tagged with at pool-build time. (`core` / `hot` /
 * `fresh` are assigned by stable-prefix membership, not by a finder.) Defined
 * via `Exclude` so it can never drift from {@link SELECTION_SOURCES}: adding a
 * finder lane there widens this automatically.
 */
export type FinderLane = Exclude<SelectionSource, "core" | "hot" | "fresh">;
